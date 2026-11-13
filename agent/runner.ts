// What the plugin's runs and conversations share (R-035, D-097): a worktree of the project's
// repository on a branch named after the card, the fetch of origin, and a background Claude started
// headless, with its final word read from its output.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
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
export const IDLE_MS = 2 *60 * 60_000;

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

/**
 * Starts the agent in the worktree, with `input`, if any, on its stdin, and waits for its final word,
 * as `read` finds it in its output lines, or for it to go quiet for too long, or for the owner to cancel.
 * `seen` gets each output line as it comes.
 */
export function start(command: string, args: string[], cwd: string, signal: AbortSignal, read: (line: string) => Final | undefined, input?: string, seen?: (line: string) => void) {
  return new Promise<Final>((resolve, reject) => {
    // A cancel that came while the worktree was being made has aborted already, and fires no event.
    if (signal.aborted) return reject(new Error('the owner cancelled the run.'));
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    // An agent that exits before it reads its input closes the pipe; its exit says why.
    child.stdin.on('error', () => undefined).end(input);
    signal.addEventListener('abort', () => (child.kill(), reject(new Error('the owner cancelled the run.'))), { once: true });
    let last: Final | undefined;
    let timer: NodeJS.Timeout;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`the agent printed nothing for ${IDLE_MS / 60_000} minutes.`));
      }, IDLE_MS);
    };
    arm();
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      arm();
      last = read(line) ?? last;
      seen?.(line);
    });
    child.on('error', (error) => (clearTimeout(timer), reject(error)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (last) resolve(last);
      else reject(new Error(`the agent exited with code ${code} and no result.`));
    });
  });
}
