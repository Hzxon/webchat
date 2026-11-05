// Runs one card with a coding agent on this machine (R-027, D-087). Each run gets a git worktree
// of the project's repository on a branch named after the card, a brief written outside the
// repository, and the agent's command line started headless in that worktree. The agent is asked
// to end with a draft pull request; the run reports the branch it left and the pull request it
// finds there.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type { RunRequest } from '../shared/types.ts';
import type { AgentClient } from './client.ts';
import type { Runner, RunResult } from './runs.ts';

const run = promisify(execFile);

/** What `config.json` next to the account file holds. */
export interface RunnerConfig {
  /** Which coding agent to start: "claude", "codex" or "hermes". Claude Code by default. */
  agent?: keyof typeof ADAPTERS;
  /** The agent's executable, when it is not on the PATH under its usual name. */
  command?: string;
  /** The local repository of each project, by project name. */
  projects: Record<string, string>;
}

/** The agent's final word. */
interface Final {
  text: string;
  error: boolean;
}

/** How a coding agent is started headless, given the file its brief is in, and how its last line is read. */
interface Adapter {
  command: string;
  args(briefPath: string): string[];
  /** The agent's final word from one line of its output, if that line is the final one. */
  result(line: string): Final | undefined;
}

const parse = (line: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Each one started headless in the worktree, with edits allowed and the final word read from its JSON lines. */
export const ADAPTERS = {
  claude: {
    command: 'claude',
    // The brief goes by file, not by argument: it can be long, and arguments show in `ps`. Edits need
    // no approval in the worktree; the shell is open for git, pull requests and npm scripts.
    args: (briefPath) => [
      '-p',
      `Read the brief in ${briefPath} and do what it says.`,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(git:*)',
      'Bash(gh pr:*)',
      'Bash(npm run:*)',
      'Bash(npm test:*)',
      'Bash(npm ci:*)',
      'Bash(npm install:*)',
      'Edit',
      'Write',
      'Read',
      'Glob',
      'Grep',
    ],
    result: (line) => {
      const event = parse(line) as { type?: string; result?: string; is_error?: boolean } | null;
      return event?.type === 'result' ? { text: String(event.result ?? ''), error: event.is_error === true } : undefined;
    },
  } satisfies Adapter,
  codex: {
    command: 'codex',
    // Codex's own sandbox keeps writes inside the worktree; the network is open so it can push.
    args: (briefPath) => [
      'exec',
      '--json',
      '--ask-for-approval',
      'never',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      `Read the brief in ${briefPath} and do what it says.`,
    ],
    // The last message the agent wrote is its final word, unless the turn failed.
    result: (line) => {
      const event = parse(line) as { type?: string; item?: { type?: string; text?: string }; error?: { message?: string } } | null;
      if (event?.type === 'turn.failed') return { text: String(event.error?.message ?? ''), error: true };
      if (event?.type === 'item.completed' && event.item?.type === 'agent_message') return { text: String(event.item.text ?? ''), error: false };
      return undefined;
    },
  } satisfies Adapter,
  hermes: {
    command: 'hermes',
    // One answer and exit, with its approval prompts off, since nobody is there to answer them.
    args: (briefPath) => ['chat', '--oneshot', '--quiet', '--yolo', '--format', 'stream-json', '--query-file', briefPath],
    result: (line) => {
      const event = parse(line) as { type?: string; text?: string; exit_code?: number } | null;
      return event?.type === 'result' ? { text: String(event.text ?? ''), error: event.exit_code !== 0 } : undefined;
    },
  } satisfies Adapter,
};

/** An agent that prints nothing for this long is stuck, and its run fails. */
const IDLE_MS = 2 * 60 * 60_000;

const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export async function loadRunnerConfig(dir: string): Promise<RunnerConfig> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as RunnerConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { projects: {} };
  }
}

/**
 * Adds a git worktree of `repo` for a run, under `runsDir`, on a new branch named after the card
 * from origin's default branch, fetched first. Returns the branch, the folder and that base.
 */
export async function addWorktree(repo: string, request: RunRequest, runsDir: string) {
  const git = (...args: string[]) => run('git', ['-C', repo, ...args]);
  await git('fetch', '-q', 'origin');
  const base = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').then((r) => r.stdout.trim(), () => 'origin/main');
  const slug = slugOf(`${request.card}-${request.title}`);
  // A card run again gets a branch of its own, next to the one its earlier run left, here or on origin.
  let branch = `agent/${slug}`;
  for (let n = 2; await git('show-ref', '--quiet', `refs/heads/${branch}`, `refs/remotes/origin/${branch}`).then(() => true, () => false); n++) branch = `agent/${slug}-${n}`;
  const dir = path.join(runsDir, `${slug}-${Date.now().toString(36)}`);
  await fs.mkdir(runsDir, { recursive: true });
  await git('worktree', 'add', '-q', '-b', branch, dir, base);
  return { branch, dir, base };
}

/** Every member's decisions on the project's board, as Markdown: they are the team's, and the owner runs cards in this team (D-089). */
export async function decisionsOf(client: AgentClient, projectId: number) {
  const { decisions } = await client.boardDocs(projectId);
  return decisions ? (await client.sections(decisions)).map((s) => s.text.trim()).join('\n\n') : '';
}

/** The runner for this machine. Runs go under `runsDir`, one folder each, which stay for a look afterwards. */
export function createRunner(config: RunnerConfig, client: AgentClient, runsDir: string): Runner {
  const adapter = ADAPTERS[config.agent ?? 'claude'];
  const command = config.command ?? adapter.command;

  return async ({ request, card, projectId, signal }) => {
    const project = client.projects.find((p) => p.id === projectId);
    const repo = project && config.projects[project.name];
    if (!repo) throw new Error(`no repository is set for ${project?.name ?? 'this project'} in config.json.`);
    const { branch, dir, base } = await addWorktree(repo, request, runsDir);

    const briefPath = `${dir}.brief.md`;
    await fs.writeFile(briefPath, briefFor(request.card, card, await decisionsOf(client, projectId), branch));
    const last = await start(command, adapter, briefPath, dir, signal);
    if (last.error) throw new Error(last.text || 'the agent stopped with an error.');

    const commits = (await run('git', ['-C', dir, 'log', '--oneline', `${base}..HEAD`])).stdout.trim();
    if (!commits) throw new Error('the agent left no commits.');
    // The agent's closing sentence, which the brief asks for last.
    const result: RunResult = { branch, note: last.text.trim().split('\n').at(-1)?.slice(0, 200) };
    const pull = await run('gh', ['pr', 'view', '--json', 'number,url'], { cwd: dir }).catch(() => null);
    if (pull) {
      const { number, url } = JSON.parse(pull.stdout) as { number: number; url: string };
      const repoName = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1];
      if (repoName) result.pull = { repo: repoName, number };
    }
    return result;
  };
}

/** Starts the agent in the worktree and waits for its final word, or for it to go quiet for too long, or for the owner to cancel. */
function start(command: string, adapter: Adapter, briefPath: string, cwd: string, signal: AbortSignal) {
  return new Promise<Final>((resolve, reject) => {
    const child = spawn(command, adapter.args(briefPath), { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
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
      last = adapter.result(line) ?? last;
    });
    child.on('error', (error) => (clearTimeout(timer), reject(error)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (last) resolve(last);
      else reject(new Error(`the agent exited with code ${code} and no result.`));
    });
  });
}

/** What the agent is told: the card, the project's decisions, and how to finish. */
function briefFor(cardId: string, card: string, decisions: string, branch: string) {
  return [
    `You are working on card ${cardId} from the team's board. Implement or fix what it describes.`,
    'Read AGENTS.md or CLAUDE.md in this repository first if there is one, and follow it.',
    '',
    '## The card',
    '',
    card.trim(),
    '',
    ...(decisions ? ['## The decisions the team made', '', decisions, ''] : []),
    '## How to finish',
    '',
    `- You are on branch \`${branch}\` in a worktree of your own. Commit there, in small commits with clear messages.`,
    '- Never push to main. When the work is done and its checks pass, push the branch and open a draft pull',
    '  request with `gh pr create --draft`, with a title and body that say what changed and why.',
    '- If you cannot finish, say what blocks you as your last message and open no pull request.',
    '- End with one or two sentences on what you did, as your final message.',
  ].join('\n');
}
