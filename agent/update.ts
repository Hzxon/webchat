// The root-owned updater (docs/roadmap/new-agent-self-update.md, docs/decisions/agent-self-update.md).
// `webchat-agent update` runs as root from the installed program, every 15 minutes: a LaunchDaemon or
// a systemd timer that setup installs. It asks the server for its release and moves the program to
// that release's file from GitHub, forward only. It trusts only what root owns: `update.json` that
// setup wrote, the program it runs from, and the pinned release address in `shared/types.ts`. The
// keyholder never writes its program, and the server only names a version.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { setTimeout as sleep } from 'node:timers/promises';
import pkg from '../package.json' with { type: 'json' };
import { AGENT_RELEASES, type ConfigDTO } from '../shared/types.ts';
import { Api } from './api.ts';
import { cleanupPlan, layoutFor, programOf, put, RELEASE, restartPlan, rollbackPlan, runAll, selfRoot, servicePlan, socketOf, stagedOf, stagePlan, stateOf, swapPlan, unitText, updateConfigOf, type Cmd, type Layout, type Root } from './lockroom.ts';
import { askUpdater } from './room.ts';
import { messageOf } from './runs.ts';

const DAY_MS = 24 * 60 * 60_000;
/** The longest a download may take, and the most a program may weigh. A real one is under 100 MiB. */
const DOWNLOAD_MS = 10 * 60_000;
const FILE_MAX = 256 * 1024 * 1024;
const HEALTH_MS = 2 * 60_000;

export type Outcome = 'no-server' | 'bad-config' | 'offline' | 'bad-release' | 'older' | 'current' | 'skipped' | 'refused' | 'bad-checksum' | 'bad-file' | 'waiting' | 'updated' | 'rolled-back' | 'stuck';

/** What the last check found, in a file `doctor` and `status` read. */
export interface UpdateState {
  outcome: Outcome;
  /** When this check ran, and since when the same outcome for the same release has held. */
  at: number;
  since: number;
  /** The server's release, when it gave one, and the program's own. */
  release?: string;
  version: string;
  detail?: string;
  /** Releases whose program did not start: they are skipped until a newer one. */
  bad: string[];
}

export interface Config {
  server?: string;
  releases: string;
  suffix: string;
}

/** Three numbers against three: negative when `a` is the older release. Both must match `RELEASE`. */
export function compareReleases(a: string, b: string) {
  const [x, y] = [a, b].map((release) => release.split('.').map(Number));
  return x!.map((n, i) => n - y![i]!).find(Boolean) ?? 0;
}

/** The hash a release's `.sha256` file gives for `asset`: two fields, a 64-digit hash and the asset's name, as `shasum` writes them. */
export function readSum(text: string, asset: string) {
  const [hash, name, ...rest] = text.trim().split(/\s+/);
  return !rest.length && /^[0-9a-f]{64}$/.test(hash ?? '') && name?.replace(/^\*/, '') === asset ? hash : undefined;
}

/** The settings setup wrote, and only if root owns the file and nobody else writes it. */
export async function readConfig(file: string, rootUid: number): Promise<Config> {
  const stat = await fs.stat(file);
  if (stat.uid !== rootUid || stat.mode & 0o022) throw new Error(`${file} is not owned by root alone.`);
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  const [server, releases, suffix = ''] = ['server', 'releases', 'suffix'].map((key) => (typeof raw[key] === 'string' ? raw[key] : undefined));
  // The same rule as any request of the agent's: https, or this machine.
  for (const url of [server, releases]) if (url) new Api(url);
  if (!/^[a-z]*$/.test(suffix)) throw new Error(`${file} names a suffix that is not letters.`);
  return { ...(server && { server }), releases: (releases ?? AGENT_RELEASES).replace(/\/+$/, ''), suffix };
}

export async function readState(l: Layout) {
  try {
    const state = JSON.parse(await fs.readFile(stateOf(l), 'utf8')) as UpdateState;
    return typeof state.outcome === 'string' && Array.isArray(state.bad) ? state : undefined;
  } catch {
    return undefined;
  }
}

/** The state in words for `doctor`, `status` and the log. A `fix` means the owner should look: at once for some outcomes, after a day for the ones that clear themselves. */
export function describeState(s: UpdateState, now: number): { text: string; fix?: string } {
  const r = s.release ?? 'unknown';
  const line = `release ${r}`;
  const table: Record<Outcome, { text: string; fix?: string; soon?: true }> = {
    'no-server': { text: 'not paired yet, so there is no server to follow' },
    'bad-config': { text: `its settings file is unusable: ${s.detail}`, fix: 'Run `webchat-agent setup` again.', soon: true },
    offline: { text: `could not reach the server (${s.detail})`, fix: 'Check the network.' },
    'bad-release': { text: `the server named a release it cannot use (${s.detail})`, fix: 'Ask whoever runs the server.' },
    current: { text: `follows the server, on release ${r}` },
    updated: { text: `moved from ${s.version} to ${r}` },
    waiting: { text: `${line} is ready, and waits until no card runs (${s.detail})` },
    older: { text: `the server runs ${line}, older than this agent's ${s.version}, and the updater moves forward only`, fix: 'Going back takes the line in WebChat’s Connect dialog.', soon: true },
    refused: { text: `${line} is out, but its file was refused (${s.detail}): it may still be building, or the release files are private`, fix: 'Until the files are public, update with the line in WebChat’s Connect dialog.' },
    'bad-checksum': { text: `${line} did not match its checksum, so the agent keeps ${s.version}`, fix: 'Update with the line in WebChat’s Connect dialog, or wait for the next release.' },
    'bad-file': { text: `${line} would not start (${s.detail}), so the agent keeps ${s.version}`, fix: 'Update with the line in WebChat’s Connect dialog, or wait for the next release.', soon: true },
    skipped: { text: `${line} did not start before, so the agent keeps ${s.version} until a newer one`, fix: 'Update with the line in WebChat’s Connect dialog, or wait for the next release.', soon: true },
    stuck: { text: `a command as root failed on ${line} (${s.detail})`, fix: 'Run `webchat-agent setup` again.', soon: true },
    'rolled-back': { text: `${line} did not start, so the agent went back to ${s.version} (${s.detail})`, fix: 'Update with the line in WebChat’s Connect dialog, or wait for the next release.', soon: true },
  };
  const { text, fix, soon } = table[s.outcome];
  return { text, ...(fix && (soon || now - s.since > DAY_MS) && { fix }) };
}

/** Why a check stopped, as the state records it. */
class Failure extends Error {
  constructor(
    readonly outcome: Outcome,
    message: string,
  ) {
    super(message);
  }
}

const exists = (file: string) => fs.stat(file).then(() => true, () => false);

/** A release file, with no login, whatever GitHub says: a refusal is how a private repository answers, and the old program stays. */
async function get(fetcher: typeof fetch, url: string, max: number) {
  let res: Response;
  try {
    res = await fetcher(url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
  } catch {
    throw new Failure('offline', 'cannot reach the release files');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Failure('refused', `answered ${res.status}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > max) throw new Failure('bad-file', 'the file is too large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    throw error instanceof Failure ? error : new Failure('offline', 'the download broke off');
  }
  return Buffer.concat(chunks);
}

/** The release's gzip, checked in memory against the checksum the release publishes beside it. */
async function download(fetcher: typeof fetch, base: string, asset: string) {
  const sum = readSum((await get(fetcher, `${base}.sha256`, 4096)).toString(), asset);
  if (!sum) throw new Failure('bad-checksum', 'the checksum file does not name this file');
  const gz = await get(fetcher, base, FILE_MAX);
  if (createHash('sha256').update(gz).digest('hex') !== sum) throw new Failure('bad-checksum', 'the file does not match its checksum');
  return gz;
}

export interface TickOptions {
  layout: Layout;
  root: Root;
  /** The program's own release, which tests set. */
  version?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  arch?: string;
  /** How long a new keyholder has to answer as the new release, and how long cards may hold the swap back. */
  healthMs?: number;
  waitMs?: number;
  pollMs?: number;
}

/**
 * One check. It follows the server's release forward, never back: an older or equal release changes
 * nothing, and a release that is not three numbers is refused before any command is built. A file
 * that fails its checksum or its `--version` probe never reaches the program's place. The swap waits
 * for the keyholder to report nothing running, and goes ahead after a day of cards; then the keyholder
 * restarts, and if it does not answer as the new release in time, the old program comes back and that
 * release is skipped until a newer one.
 */
export async function tick({ layout: l, root, version = pkg.version, fetcher = fetch, now = Date.now, arch = os.arch(), healthMs = HEALTH_MS, waitMs = DAY_MS, pollMs = 1000 }: TickOptions) {
  const before = await readState(l);
  const record = async (outcome: Outcome, release?: string, detail?: string, bad = before?.bad ?? []) => {
    const at = now();
    const same = before?.outcome === outcome && before.release === release;
    const state: UpdateState = { outcome, at, since: same ? before.since : at, version, ...(release && { release }), ...(detail && { detail: detail.replace(/[^ -~]/g, '?').slice(0, 200) }), bad };
    await root(put(stateOf(l), '644', JSON.stringify(state)));
    // Only a change is worth a line: the log would otherwise gain four a hour.
    if (!same) console.log(`${new Date(at).toISOString()} ${describeState(state, at).text}`);
    return state;
  };

  // A root command that fails says why in the state, which `doctor` shows, not only in the log.
  const asRoot = (cmds: Cmd[], release: string) => runAll(root, cmds).then(() => undefined, (error: unknown) => record('stuck', release, messageOf(error)));

  let config: Config;
  try {
    config = await readConfig(updateConfigOf(l), l.rootUid);
  } catch (error) {
    return record('bad-config', undefined, messageOf(error));
  }
  if (!config.server) return record('no-server');
  let release: unknown;
  try {
    ({ release } = await new Api(config.server).request<ConfigDTO>('GET', '/config'));
  } catch (error) {
    return record('offline', undefined, messageOf(error));
  }
  if (typeof release !== 'string' || !RELEASE.test(release)) return record('bad-release', undefined, String(release));
  const order = compareReleases(release, version);
  if (order < 0) return record('older', release);
  if (order === 0) {
    const left = await Promise.all(['.staged', 'webchat-agent.previous'].map((name) => exists(path.join(l.programDir, name))));
    const failed = left.some(Boolean) && (await asRoot(cleanupPlan(l), release));
    if (failed) return failed;
    // A release may change the keyholder's own service file: write it, when nothing runs, with the same plan setup uses.
    const wanted = unitText(l, programOf(l));
    const stale = (await fs.readFile(l.unit, 'utf8').catch(() => wanted)) !== wanted && !(await askUpdater(socketOf(l)))?.busy.length;
    return (stale && (await asRoot(servicePlan(l, programOf(l)), release))) || record('current', release);
  }
  if (before?.bad.includes(release)) return record('skipped', release);

  if (!(await exists(stagedOf(l, release)))) {
    const asset = `webchat-agent-${l.platform}-${arch}.gz`;
    let gz: Buffer;
    try {
      gz = await download(fetcher, `${config.releases}/v${release}/${asset}`, asset);
    } catch (error) {
      if (error instanceof Failure) return record(error.outcome, release, error.message);
      throw error;
    }
    try {
      await root(stagePlan(l, release, gz));
    } catch (error) {
      return record('bad-file', release, messageOf(error));
    }
  }

  const busy = (await askUpdater(socketOf(l)))?.busy ?? [];
  // A restart fails the cards it cuts short, so wait for none, up to a day. A keyholder that does not answer has none to cut.
  if (busy.length && now() - (before?.outcome === 'waiting' && before.release === release ? before.since : now()) < waitMs) return record('waiting', release, busy.join(', '));

  try {
    await runAll(root, [...swapPlan(l, release), ...restartPlan(l)]);
    let started: boolean;
    const end = Date.now() + healthMs;
    while (!(started = (await askUpdater(socketOf(l)))?.version === release) && Date.now() < end) await sleep(pollMs);
    if (!started) throw new Error(`the keyholder did not answer as ${release} within ${Math.round(healthMs / 1000)} seconds`);
  } catch (error) {
    await runAll(root, rollbackPlan(l));
    return record('rolled-back', release, messageOf(error), [...(before?.bad ?? []), release]);
  }
  return (await asRoot(cleanupPlan(l), release)) || record('updated', release);
}

/** `webchat-agent update`: the layout comes from the settings file next to the program, which only root could have written. */
export async function runUpdate() {
  const program = process.execPath;
  if (!isSea() || process.getuid?.() !== 0) throw new Error('The updater runs as root from the installed program: `webchat-agent setup` installs it.');
  const { suffix } = await readConfig(path.join(path.dirname(program), 'update.json'), 0);
  const layout = layoutFor(process.platform === 'darwin' ? 'darwin' : 'linux', suffix);
  if (programOf(layout) !== program) throw new Error(`${program} is not the program in ${layout.programDir}.`);
  await tick({ layout, root: selfRoot });
}
