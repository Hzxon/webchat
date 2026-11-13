// Moves an agent's account into the keyholder's folder without a new pairing (docs/decisions/locked-room.md):
// from the Claude Code plugin's data folder or the daemon's `~/.webchat/laptop`, which are laid out the same.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { putAs, type Layout, type Root } from './lockroom.ts';

/** What the keyholder keeps, from a folder as the plugin and the daemon laid it out. The lock, the old asks and Claude's settings stay behind. */
const KEPT = ['account.json', 'asleep', ...['account', 'setup', 'pulls', 'plans', 'boards', 'conversations'].map((name) => `laptop/${name}.json`)];

export interface Source {
  dir: string;
  /** The plugin's folders have a lock a live Claude Code window holds; the daemon's belongs to the service setup stops first. */
  plugin: boolean;
  cursor: number;
  server?: string;
  /** The process that holds the watch, when it runs. */
  holder?: number;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process answers EPERM, and runs.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The folders that hold an account: the plugin's, in Claude Code's config folder, and the daemon's. */
export async function sources(daemon: string, env = process.env, home = os.homedir()): Promise<Source[]> {
  const plugins = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'plugins', 'data');
  const dirs = [...(await fs.readdir(plugins).catch(() => [] as string[])).sort().map((name) => ({ dir: path.join(plugins, name), plugin: true })), { dir: daemon, plugin: false }];
  const found = await Promise.all(
    dirs.map(async ({ dir, plugin }) => {
      const account = await fs.readFile(path.join(dir, 'account.json'), 'utf8').then((text) => JSON.parse(text) as { cursor?: unknown; server?: string }, () => null);
      if (!account) return undefined;
      const pid = Number(await fs.readFile(path.join(dir, 'watch.lock'), 'utf8').catch(() => ''));
      return { dir, plugin, cursor: Number(account.cursor) || 0, server: account.server, ...(pid > 0 && alive(pid) && { holder: pid }) } satisfies Source;
    }),
  );
  return found.filter((s) => !!s);
}

/** The account to move: the one that saw the most, since it ran last. */
export const newest = (found: Source[]) => found.reduce<Source | undefined>((best, s) => (!best || s.cursor > best.cursor ? s : best), undefined);

/** Copies the account into the keyholder's folder, as the role account, and the runner's own files into `runnerDir`. Returns the originals, which `finishMove` deletes. */
export async function moveAccount(root: Root, l: Layout, from: Source, runnerDir: string) {
  const moved: string[] = [];
  const repos = (await fs.readdir(path.join(from.dir, 'repos')).catch(() => [] as string[])).map((name) => path.join('repos', name, 'connected'));
  for (const rel of [...KEPT, ...repos]) {
    const bytes = await fs.readFile(path.join(from.dir, rel)).catch(() => undefined);
    if (!bytes) continue;
    await root(putAs(l, path.join(l.data, 'laptop', rel), bytes));
    moved.push(path.join(from.dir, rel));
  }
  await fs.mkdir(runnerDir, { recursive: true, mode: 0o700 });
  for (const name of (await fs.readdir(from.dir)).filter((n) => n === 'codex-threads.json' || /^acp-[\w-]+\.json$/.test(n))) {
    await fs.copyFile(path.join(from.dir, name), path.join(runnerDir, name));
    moved.push(path.join(from.dir, name));
  }
  return moved;
}

/** Deletes the originals, once the keyholder runs the same agent. */
export const finishMove = (moved: string[]) => Promise.all(moved.map((file) => fs.rm(file, { force: true })));
