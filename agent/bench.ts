// What the agent does in the owner's folders, apart from what it does with its keys (docs/decisions/locked-room.md):
// finding the coding agents, the owner's setup, their checkouts, worktrees and commits, and the
// harness turns that run there. `Plugin` asks a `Bench` for all of it and never runs git in those
// folders itself; git crosses between the two only as bundles, which `Keep` checks. `LocalBench` does
// it in this process; a later one speaks to a process of the owner's over a socket.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isRepoName, LIMITS, SKILL_NAME, type PermissionMode, type SessionAboutDTO, type SessionEventDTO, type SetupChoice, type TerminalSessionDTO } from '../shared/types.ts';
import { Lab } from './browser.ts';
import { secretDirs, type Ask, type Harness, type Reply } from './harness.ts';
import { sha256 } from './keep.ts';
import { SHOT } from './permits.ts';
import { judge } from './rulebook.ts';
import type { Quiet } from './runner.ts';

const exec = promisify(execFile);

/** For git in the owner's folders: the files there, hooks and all, are what the model wrote. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** What the laptop has of a harness, and what it declares of itself. */
export interface HarnessInfo {
  name: string;
  path?: string;
  version?: string;
  signedIn?: boolean;
  offers: ReturnType<Harness['offers']>;
  /** Whether it asks the owner before an action. */
  asks: boolean;
  /** What its sandbox lets its shell read of the owner's secrets, which the owner should know and which stops nothing. */
  warning?: string;
  /** Whether it commits its own work: one that cannot, under a sandbox that keeps `.git` read-only, has its leftovers committed for it. */
  commits: boolean;
}

/** A folder the laptop has for a repository, as its mark names it (R-036, D-101). */
export interface Folder {
  /** As origin names it, such as "acme/app". */
  repo: string;
  dir: string;
  /** Origin's address as configured, which the background Claude's shell can read in `.git`. */
  origin: string;
}

/** What one turn gets for its questions: the answer to each action the rulebook leaves to the owner, the silence timer's hold, and the end of it all. */
export interface Permit {
  ask: (ask: Ask) => Promise<Reply>;
  /** Sends a screenshot's bytes to the owner, and says what became of it in a fixed sentence (R-046). */
  shot?: (png: Uint8Array<ArrayBuffer>, caption: string) => Promise<string>;
  quiet: Quiet;
  done: () => void;
}

/** What the keyholder says while no runner is connected: the agent shows offline. */
export const NO_RUNNER = 'Your laptop has not started the part of this agent that works in your folders, so the agent shows offline. It comes back when you log in.';

/** The base a bundle was cut from is missing in the folder it was sent to, so it must be sent whole. */
export class PrerequisitesMissing extends Error {
  constructor() {
    super('The folder lacks the commits the bundle builds on.');
  }
}

export interface Bench {
  /** The harnesses the laptop has, found again: each with what it is, offers and declares. */
  harnesses(): Promise<HarnessInfo[]>;
  /** Why a harness cannot run its turns, or undefined. */
  refusal(harness: string): Promise<string | undefined>;
  /** Hands every harness the owner's choice, and each one found later. */
  apply(choice: SetupChoice): Promise<void>;
  /** What the owner's setup offers a run (R-039): whether the instructions file is there, and each skill with its description. */
  ownerSetup(): Promise<{ claudeMd: boolean; skills: Array<{ name: string; description: string }> }>;
  /** Each mark's folder that is still a checkout of the repository it names. */
  folders(marks: Array<{ repo: string; dir: string }>): Promise<Folder[]>;
  /** Whether a folder exists, and the GitHub repository it pushes to, from origin's address as configured. */
  checkout(dir: string): Promise<{ exists: boolean; repo: string | null }>;
  /**
   * Takes a bundle of a remote branch, `base` such as `origin/main`, into a checkout. It becomes
   * origin's default branch unless `other` says it is another branch, such as one a run stacks on.
   */
  take(dir: string, file: string, base: string, other?: boolean): Promise<void>;
  /** Makes a checkout at `dir` from a bundle of the default branch. */
  clone(dir: string, repo: string, file: string, base: string): Promise<void>;
  /** Adds a worktree on a new branch named after the card, apart from `taken` and the checkout's own, from `tip`. */
  prepare(job: { dir: string; slug: string; taken: string[]; tip: string }): Promise<{ branch: string; worktree: string }>;
  /** Adds a worktree that went missing back, on its branch. */
  reopen(job: { dir: string; worktree: string; branch: string }): Promise<void>;
  /** Commits in a worktree: an empty commit, or what a harness that cannot commit left. Returns the head. */
  commit(job: { worktree: string; message: string; allowEmpty?: true; leftovers?: true }): Promise<string>;
  /** Writes a worktree's commits after `since` as a bundle of its branch alone, or undefined when it has none. */
  bundle(job: { worktree: string; branch: string; since: string; file: string }): Promise<{ head: string; bytes: number; sha256: string } | undefined>;
  /** Makes or moves a conversation's scratch copy to `tip` of a checkout's `base`, or an empty one with no checkout. */
  scratch(job: { scratch?: string; dir?: string; base?: string; tip?: string; fetched?: string }): Promise<{ scratch: string; fetched?: string }>;
  /** Removes a scratch copy. */
  drop(scratch: string): Promise<void>;
  /** Runs one turn, and returns its answer for the schema with what it loaded of the owner's setup (D-097). */
  turn(turn: TurnJob, options: { signal: AbortSignal; progress?: (sentence: string) => void; events?: (event: SessionEventDTO) => void; about?: (about: SessionAboutDTO) => void; permit?: () => Permit | undefined }): Promise<{ answer: unknown; applied: { claudeMd: boolean; skills: string[]; noAttribution: boolean; own?: string[] } }>;
  /** Ends what a harness keeps running for a session, or for all. */
  end(session?: string): Promise<void>;
  /** The newest sessions the owner's terminal started with a harness in a folder (R-072). */
  sessions(harness: string, dir: string): Promise<TerminalSessionDTO[]>;
}

export interface TurnJob {
  harness: string;
  cwd: string;
  session: string;
  resume: boolean;
  message: string;
  schema: object;
  schemas: object[];
  setup: SetupChoice;
  /** Runs in the owner's own setup (D-157); the plugin sets it only for a conversation its owner started in their words. */
  own?: boolean;
  /** The session's controls (R-072): a model the harness offers, and a permission mode, which counts only with `own`. */
  model?: string;
  mode?: PermissionMode;
}

/**
 * This server's git in a worktree under `<checkout>/.claude/worktrees`, with hooks off. It names
 * the worktree's git folder from the checkout's list, never from the worktree's `.git` file, which
 * the model could point at a folder whose config runs a command, such as `core.fsmonitor`. A
 * submodule the model stages has such a `.git` file too: status and diff skip submodules here,
 * and `git add` of a whole folder still opens them, so the plugin adds files by name only.
 */
export const worktreeGit = async (worktree: string, ...args: string[]) => (await worktreeGitRaw(worktree, ...args)).trim();

/** As `worktreeGit`, with the output as it came: a status line starts with a space. */
async function worktreeGitRaw(worktree: string, ...args: string[]) {
  const checkout = path.resolve(worktree, '..', '..', '..');
  const common = path.resolve(checkout, (await exec('git', ['-C', checkout, 'rev-parse', '--git-common-dir'])).stdout.trim());
  const dotGit = path.join(await fs.realpath(worktree), '.git');
  const admins = path.join(common, 'worktrees');
  let gitDir: string | undefined;
  for (const name of await fs.readdir(admins)) {
    const pointer = await fs.readFile(path.join(admins, name, 'gitdir'), 'utf8').catch(() => '');
    // A relative pointer goes through the checkout's path as given, which can hold a link.
    const target = path.resolve(admins, name, pointer.trim());
    if (pointer && path.join(await fs.realpath(path.dirname(target)).catch(() => ''), '.git') === dotGit) {
      gitDir = path.join(admins, name);
      break;
    }
  }
  if (!gitDir) throw new Error(`${worktree} is no worktree of ${checkout}.`);
  return (await exec('git', [`--git-dir=${gitDir}`, `--work-tree=${worktree}`, ...NO_HOOKS, '-c', 'diff.ignoreSubmodules=all', ...args])).stdout;
}

/** Origin's address as a checkout configures it, or '' for none. */
const originUrl = (dir: string) => exec('git', ['-C', dir, 'config', '--get', 'remote.origin.url']).then((r) => r.stdout.trim(), () => '');

/** The GitHub repository an address names, as "owner/name", or null. */
function repoOfUrl(url: string) {
  const name = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1];
  return name && isRepoName(name) ? name : null;
}

export class LocalBench implements Bench {
  private list: Harness[];
  private choice?: SetupChoice;
  /** Each session's lab, for a harness that browses (R-046): its proxy lasts the session, its dev server a turn. */
  private labs = new Map<string, Promise<Lab | undefined>>();

  /** `find` finds the harnesses again, so one installed later shows (docs/decisions/harness-linking.md). */
  constructor(harnesses: Harness[], private readonly find?: () => Promise<Harness[]>, private readonly dataDir = '') {
    this.list = harnesses;
  }

  private harness(name: string) {
    const harness = this.list.find((h) => h.name === name);
    if (!harness) throw new Error(`I have no ${name} on this laptop.`);
    return harness;
  }

  async harnesses() {
    if (this.find) {
      const next = await this.find();
      const fresh = next.filter((h) => !this.list.includes(h));
      this.list = next;
      if (this.choice) await Promise.all(fresh.map((h) => h.apply(this.choice!)));
    }
    return Promise.all(
      this.list.map(async (h): Promise<HarnessInfo> => {
        const warning = await h.warning?.();
        return { name: h.name, ...(await h.found()), offers: h.offers(), asks: h.asks, commits: h.commits !== false, ...(warning && { warning }) };
      }),
    );
  }

  refusal(harness: string) {
    return this.harness(harness).refusal();
  }

  async apply(choice: SetupChoice) {
    this.choice = choice;
    await Promise.all(this.list.map((h) => h.apply(choice)));
  }

  /** The owner's setup, which one choice serves for every harness (D-115): the first adapter's files stand for what the laptop offers, as they depend on paths only. */
  async ownerSetup() {
    const { instructions, skills: dir } = this.list[0]!.offers();
    const names = (dir ? await fs.readdir(dir).catch(() => [] as string[]) : []).filter((name) => SKILL_NAME.test(name)).sort();
    const skills: Array<{ name: string; description: string }> = [];
    for (const name of names.slice(0, LIMITS.setupSkills)) {
      const text = await fs.readFile(path.join(dir!, name, 'SKILL.md'), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const description = skillDescription(text);
      const max = LIMITS.skillDescriptionLength;
      skills.push({ name, description: description.length > max ? `${description.slice(0, max - 1)}…` : description });
    }
    return { claudeMd: !!instructions && existsSync(instructions), skills };
  }

  async folders(marks: Array<{ repo: string; dir: string }>) {
    const found = await Promise.all(
      marks.map(async ({ repo: named, dir }): Promise<Folder | null> => {
        const origin = dir && (await originUrl(dir));
        const repo = repoOfUrl(origin);
        // A folder moved, deleted, or now pushing to another repository serves nothing.
        return repo?.toLowerCase() === named.toLowerCase() ? { repo, dir, origin } : null;
      }),
    );
    return found.filter((f) => f !== null);
  }

  async checkout(dir: string) {
    return { exists: existsSync(dir), repo: repoOfUrl(await originUrl(dir)) };
  }

  async take(dir: string, file: string, base: string, other = false) {
    const git = (...args: string[]) => exec('git', ['-C', dir, ...NO_HOOKS, ...args]);
    await git('bundle', 'verify', file).catch((error: { stderr?: string }) => {
      throw /prerequisite/i.test(error.stderr ?? '') ? new PrerequisitesMissing() : error;
    });
    await git('fetch', '-q', file, `+refs/remotes/${base}:refs/remotes/${base}`);
    if (!other) await git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/${base}`);
  }

  async clone(dir: string, repo: string, file: string, base: string) {
    const git = (...args: string[]) => exec('git', ['-C', dir, ...NO_HOOKS, ...args]);
    const branch = base.replace(/^origin\//, '');
    try {
      await exec('git', ['init', '-q', '-b', branch, '--template=', dir]);
      // The address GitHub has, so the checkout pushes there as any clone does; this process never fetches from it.
      await git('remote', 'add', 'origin', `https://github.com/${repo}.git`);
      await this.take(dir, file, base);
      await git('checkout', '-q', '-B', branch, base);
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async prepare({ dir, slug, taken, tip }: { dir: string; slug: string; taken: string[]; tip: string }) {
    const git = (...args: string[]) => exec('git', ['-C', dir, ...NO_HOOKS, ...args]);
    // A card run again gets a branch of its own, next to the one its earlier run left, here or on origin.
    let branch = `agent/${slug}`;
    for (let n = 2; taken.includes(branch) || (await git('show-ref', '--quiet', `refs/heads/${branch}`).then(() => true, () => false)); n++) branch = `agent/${slug}-${n}`;
    const runs = path.join(dir, '.claude', 'worktrees');
    const worktree = path.join(runs, `${slug}-${Date.now().toString(36)}`);
    await fs.mkdir(runs, { recursive: true });
    await git('worktree', 'add', '-q', '-b', branch, worktree, tip);
    return { branch, worktree };
  }

  async reopen({ dir, worktree, branch }: { dir: string; worktree: string; branch: string }) {
    if (!existsSync(worktree)) await exec('git', ['-C', dir, ...NO_HOOKS, 'worktree', 'add', '-q', worktree, branch]);
  }

  async commit({ worktree, message, allowEmpty, leftovers }: { worktree: string; message: string; allowEmpty?: true; leftovers?: true }) {
    const git = (...args: string[]) => worktreeGit(worktree, ...args);
    if (allowEmpty) await git('commit', '-q', '--allow-empty', '-m', message);
    if (leftovers) {
      // Files by name, never a folder: a submodule the model staged would open one.
      const status = await worktreeGitRaw(worktree, 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all');
      const files = status.split('\0').filter(Boolean).map((entry) => entry.slice(3));
      for (let i = 0; i < files.length; i += 200) await git('add', '--all', '--', ...files.slice(i, i + 200));
      if (files.length && (await git('diff', '--cached', '--quiet').then(() => false, () => true))) await git('commit', '-q', '-m', message);
    }
    return git('rev-parse', 'HEAD');
  }

  async bundle({ worktree, branch, since, file }: { worktree: string; branch: string; since: string; file: string }) {
    const git = (...args: string[]) => worktreeGit(worktree, ...args);
    if ((await git('symbolic-ref', '--short', 'HEAD').catch(() => '')) !== branch) throw new Error(`The work is not on ${branch}, the branch the worktree started on.`);
    if (!(await git('log', '--oneline', `${since}..HEAD`))) return;
    await git('bundle', 'create', '-q', file, `refs/heads/${branch}`, `^${since}`);
    return { head: await git('rev-parse', 'HEAD'), bytes: (await fs.stat(file)).size, sha256: await sha256(file) };
  }

  async scratch({ scratch, dir, base, tip, fetched }: { scratch?: string; dir?: string; base?: string; tip?: string; fetched?: string }) {
    // A link swapped in for the folder would lead the turn elsewhere, so only a real folder counts.
    if (!scratch || !(await fs.lstat(scratch).then((s) => s.isDirectory(), () => false))) {
      scratch = path.join(os.tmpdir(), 'webchat-scratch', randomUUID());
      await fs.mkdir(scratch, { recursive: true });
      if (dir) await exec('git', ['init', '-q', scratch]);
      fetched = undefined;
    }
    if (dir && tip !== fetched) {
      await exec('git', ['-C', scratch, 'fetch', '-q', '--depth', '1', dir, `refs/remotes/${base}`]);
      // Forced: the copy's changes are never kept, and the brief said so.
      await exec('git', ['-C', scratch, ...NO_HOOKS, 'checkout', '-q', '-f', '--detach', 'FETCH_HEAD']);
      fetched = tip;
    }
    return { scratch, fetched };
  }

  drop(scratch: string) {
    return fs.rm(scratch, { recursive: true, force: true });
  }

  /**
   * What a run or turn loads of the owner's setup, as they chose (R-039): the instructions file the
   * harness reads, and copies of their chosen skills in a folder made for it, `owner/skills`.
   * Copies, since a run edits the files of its folders. A skill gone since is left out.
   */
  private async loadSetup(session: string, harness: Harness, choice: SetupChoice) {
    const offer = harness.offers();
    const instructions = choice.claudeMd && offer.instructions && existsSync(offer.instructions) ? offer.instructions : undefined;
    // The same folder for every turn of a session, which the system prompt names as a working
    // directory, and named "owner", so a skill shows to the model as owner:<name>.
    const folder = path.join(os.tmpdir(), 'webchat-skills', session, 'owner', 'skills');
    const skills: string[] = [];
    for (const name of offer.skills ? choice.skills : []) {
      const from = path.join(offer.skills!, name);
      if (!existsSync(path.join(from, 'SKILL.md'))) continue;
      // Through a link to the skill's folder, but not through links in it, which could lead to secrets.
      await fs.cp(await fs.realpath(from), path.join(folder, name), { recursive: true, filter: async (file) => !(await fs.lstat(file)).isSymbolicLink() });
      skills.push(name);
    }
    return { instructions, skills: skills.length ? folder : undefined, applied: { claudeMd: !!instructions, skills, noAttribution: choice.noAttribution } };
  }

  async turn({ harness: name, cwd, session, resume, message, schema, schemas, setup: choice, own, model: picked, mode }: TurnJob, { signal, progress, events, about, permit }: Parameters<Bench['turn']>[1]) {
    const harness = this.harness(name);
    // Only a model the harness offers, as data from the keyholder (R-072).
    const model = picked && harness.offers().models?.includes(picked) ? picked : undefined;
    // A restricted run loads none of the owner's hooks (D-097).
    if (!own) about?.({ hooks: 0 });
    if (own) {
      if (!harness.offers().knobs.includes('own')) throw new Error(`${name} cannot run in your own setup.`);
      // Their own rules decide; what they would ask about goes to the owner as it is, with no rulebook (D-157).
      about?.({ hooks: await hookCount(cwd) });
      const asked = permit?.();
      try {
        const answer = await harness.turn({ cwd, session, resume, message, schema, schemas, setup: {}, own, model, ...(mode && { mode }), signal, progress, events, about, ...(asked && { ask: asked.ask, quiet: asked.quiet }) });
        return { answer, applied: { claudeMd: false, skills: [], noAttribution: false, own: [name] } };
      } finally {
        asked?.done();
      }
    }
    const { instructions, skills, applied } = await this.loadSetup(session, harness, choice);
    const asked = permit?.();
    // The rulebook runs here, where the owner's paths are; the owner's folders never reach the keyholder (docs/decisions/harness-rulebook.md).
    const roots = [cwd, ...(skills ? [skills] : [])];
    const sandboxed = !!asked && !!(await harness.sandboxed?.());
    // Only a turn that can ask has the MCP servers the browser needs.
    if (asked && harness.secrets && !this.labs.has(session)) this.labs.set(session, Lab.open([...harness.secrets, ...secretDirs(this.dataDir)]));
    const lab = asked && (await this.labs.get(session));
    const ask = asked && (async (action: Ask): Promise<Reply> => {
      const verdict = judge(action, { folders: roots, secrets: secretDirs(this.dataDir), tools: lab ? ['dev_server', 'send_screenshot'] : [], ports: lab?.ports });
      if (!verdict.allow && !verdict.ask) return { allow: false, message: verdict.why };
      // What `judge` allows of kind `other` is WebChat's own tool or the browser's, whose arguments it checked.
      if (verdict.allow && action.kind === 'other') return { allow: true };
      // It refuses or asks, but for a command the sandbox holds: the owner could not judge it better, and the paths it names passed above.
      return sandboxed && action.kind === 'execute' ? { allow: true } : asked.ask(action);
    });
    // The path is judged here again, so the bytes sent are only a file the run may read; the keyholder checks them as data.
    const shot = asked && asked.shot && (async (file: string, caption: string) => {
      const verdict = judge({ tool: 'send_screenshot', kind: 'read', paths: [file] }, { folders: roots, secrets: secretDirs(this.dataDir), tools: [] });
      if (!verdict.allow) return verdict.why;
      try {
        if ((await fs.stat(file)).size > LIMITS.fileBytes) return SHOT.size;
        return await asked.shot!(new Uint8Array(await fs.readFile(file)), caption);
      } catch {
        return SHOT.failed;
      }
    });
    try {
      const answer = await harness.turn({ cwd, session, resume, message, schema, schemas, setup: { instructions, skills }, model, signal, progress, events, about, ask, quiet: asked?.quiet, ...(lab && { lab }), ...(shot && { shot }) });
      return { answer, applied };
    } finally {
      asked?.done();
      if (lab) lab.stop();
      if (skills) await fs.rm(path.join(os.tmpdir(), 'webchat-skills', session), { recursive: true, force: true });
    }
  }

  async sessions(harness: string, dir: string) {
    return (await this.harness(harness).sessions?.(dir)) ?? [];
  }

  async end(session?: string) {
    await Promise.all(this.list.map((h) => h.end?.(session)));
    for (const [id, lab] of this.labs) {
      if (session && id !== session) continue;
      this.labs.delete(id);
      await (await lab)?.close();
    }
  }
}

/** The hooks the owner's Claude Code settings and the folder's own load, as a session in their own setup runs them (R-072). */
async function hookCount(cwd: string) {
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const files = [path.join(home, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
  let count = 0;
  for (const file of files) {
    // A file that is missing or does not parse loads no hooks.
    const text = await fs.readFile(file, 'utf8').catch(() => '{}');
    let hooks: Record<string, Array<{ hooks?: unknown[] }>> = {};
    try {
      hooks = (JSON.parse(text) as { hooks?: typeof hooks }).hooks ?? {};
    } catch {
      continue;
    }
    for (const matchers of Object.values(hooks)) for (const m of Array.isArray(matchers) ? matchers : []) count += Array.isArray(m?.hooks) ? m.hooks.length : 0;
  }
  return count;
}

/** A SKILL.md's description, from its front matter: one line, or the indented lines a block scalar folds. */
function skillDescription(text: string) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const value = /^description:[ \t]*(?:[>|][+-]?[ \t]*$)?(.*(?:\r?\n[ \t]+.*)*)/m.exec(front)?.[1] ?? '';
  return value.replace(/\s+/g, ' ').trim().replace(/^(["'])(.*)\1$/, '$2');
}
