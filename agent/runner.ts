// What the plugin's runs and conversations share (R-035, D-097): a worktree of the project's
// repository on a branch named after the card, the fetch of origin, and the silence timer of a
// background agent's turn.
import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { RunRequest } from '../shared/types.ts';

const run = promisify(execFile);

/** An agent's final word: its text, its session, and the answer its schema asked for. */
export interface Final {
  text: string;
  error: boolean;
  session?: string;
  answer?: unknown;
}

/** An agent that prints nothing for this long is stuck, and its run fails. */
export const IDLE_MS = 2 * 60 * 60_000;

/**
 * Holds a turn's silence timer while the owner is asked: an agent that waits for an answer prints
 * nothing, and is not stuck. The timer starts again, whole, when the last question is answered.
 */
export class Quiet {
  private holds = 0;
  /** Set by the turn's watchdog. */
  release?: () => void;

  get held() {
    return this.holds > 0;
  }

  async during<T>(work: Promise<T>) {
    this.holds++;
    try {
      return await work;
    } finally {
      if (--this.holds === 0) this.release?.();
    }
  }
}

/** Every agent process kept for a session, so none outlives the daemon. */
const kept = new Set<ChildProcess>();
process.on('exit', () => kept.forEach((child) => child.kill()));

/** Notes a process kept for a session, which is dropped when it ends. */
export function keep(child: ChildProcess) {
  kept.add(child);
  child.on('close', () => kept.delete(child));
}

/** An idle process must not keep the daemon, or a test, from ending; one in a turn must. */
export const hold = (child: ChildProcess, on: boolean) => ([child, child.stdin, child.stdout] as unknown as Array<{ ref(): void; unref(): void }>).forEach((h) => (on ? h.ref() : h.unref()));

/**
 * The silence timer of one turn: `arm` on every sign of life, `stop` when the turn ends. While
 * `quiet` holds it, it does not run.
 */
export function watchdog(ms: number, quiet: Quiet, stalled: () => void) {
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = quiet.held ? undefined : setTimeout(stalled, ms);
  };
  quiet.release = arm;
  arm();
  return {
    arm,
    stop() {
      clearTimeout(timer);
      quiet.release = undefined;
    },
  };
}

const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

/**
 * Adds a git worktree of `repo` for a run, under `runsDir`, on a new branch named after the card
 * from origin's default branch, fetched first. Returns the branch, the folder and that base.
 */
export async function addWorktree(repo: string, request: RunRequest, runsDir: string) {
  const git = (...args: string[]) => run('git', ['-C', repo, ...args]);
  const base = await fetchOrigin(repo);
  const slug = slugOf(`${request.card}-${request.title}`);
  // A card run again gets a branch of its own, next to the one its earlier run left, here or on origin.
  let branch = `agent/${slug}`;
  for (let n = 2; await git('show-ref', '--quiet', `refs/heads/${branch}`, `refs/remotes/origin/${branch}`).then(() => true, () => false); n++) branch = `agent/${slug}-${n}`;
  const dir = path.join(runsDir, `${slug}-${Date.now().toString(36)}`);
  await fs.mkdir(runsDir, { recursive: true });
  await git('worktree', 'add', '-q', '-b', branch, dir, base);
  return { branch, dir, base };
}

/** Fetches origin, and returns its default branch, such as `origin/main`. */
export async function fetchOrigin(repo: string) {
  // Two fetches at once in one repository fail one of them on a ref lock; a second try gets through.
  await run('git', ['-C', repo, 'fetch', '-q', 'origin']).catch(async () => {
    await sleep(1_000);
    await run('git', ['-C', repo, 'fetch', '-q', 'origin']);
  });
  return run('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).then((r) => r.stdout.trim(), () => 'origin/main');
}
