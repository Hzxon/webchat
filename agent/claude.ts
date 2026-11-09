// The plugin's background Claude (R-035, D-097): a `claude -p` the plugin starts for each turn of a
// conversation, apart from the owner's own sessions. It runs restricted, so it reads only managed
// settings and the plugin's settings file: none of the owner's settings, and none of the
// repository's settings, hooks or .mcp.json, which a -p run otherwise loads without asking. The
// message goes on stdin, since arguments show in `ps`, and the turn ends with a JSON answer. This
// is the plugin's harness adapter for Claude Code (harness.ts).
import { execFile } from 'node:child_process';
import { constants, readlinkSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { secretDirs, type Harness } from './harness.ts';
import { line, Plugin, type PluginOptions } from './plugin.ts';
import { start, type Final } from './runner.ts';

const exec = promisify(execFile);

/** The only host the shell reaches, for installs (D-097). */
const REGISTRY = 'registry.npmjs.org';

/** Its tools. A restricted run has only those it names, and keeps its file tools in its folder. */
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/** Whether a variable holds a credential: by its name, by a known token's prefix, or by a password in a URL. */
const isCredential = ([name, value = '']: [string, string | undefined]) =>
  /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH/i.test(name) ||
  /^(gh[opsur]_|github_pat_|npm_|sk-|xox[abprs]-|glpat-|AKIA)|:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);

/**
 * The plugin's settings file for it. The shell never runs outside the sandbox, not even where the
 * sandbox cannot start. It reads nothing outside its working directories but what toolchains need:
 * not the secrets, and not the macOS keychain, where gh keeps the owner's token (K-54). npm reads
 * no config of the owner's, which may hold a publish token, and keeps a cache of its own: the
 * sandbox cannot write the owner's, and a shared one would let it poison the owner's installs. Web
 * search and reading run outside the sandbox, as Claude Code's own tools. The shell gets no variable
 * of `env`, the environment it starts with, that holds a credential, while Claude Code keeps them for
 * its own login. The guard hook keeps the file tools from the secrets, and Claude Code refuses a
 * write through a link out of the folder. When the owner chose no AI attribution, empty lines hide
 * the ones Claude Code adds to commits and pull requests (R-039).
 */
export function claudeSettings({ secrets, npmCache, guard, env, noAttribution }: { secrets: string[]; npmCache: string; guard: string; env: NodeJS.ProcessEnv; noAttribution?: boolean }) {
  return {
    // Only the object form: older Claude Code rejects `false` here, and a -p run drops a whole
    // settings file that fails validation, the sandbox with it (D-097).
    ...(noAttribution && { attribution: { commit: '', pr: '' } }),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: secrets, allowWrite: [npmCache] },
      network: { allowedDomains: [REGISTRY] },
      // Named one by one: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB makes every sandboxed command ask first,
      // and nobody is there to answer.
      credentials: { envVars: Object.entries(env).filter(isCredential).map(([name]) => ({ name, mode: 'deny' })) },
    },
    permissions: { allow: ['WebSearch', 'WebFetch'], blockReadsOutsideWorkingDirectories: true },
    env: { npm_config_cache: npmCache, npm_config_userconfig: '/dev/null' },
    hooks: { PreToolUse: [{ matcher: '^(Read|Edit|Write|Glob|Grep)$', hooks: [{ type: 'command', command: guard }] }] },
  };
}

/**
 * One turn's arguments: the first starts the session under its id, a later one resumes it. With
 * the owner's choice (R-039), their CLAUDE.md goes in as a system prompt, and `skills` is a plugin
 * folder made for the turn, which holds only copies of their skills. It is also a working
 * directory, so a skill's scripts and references can be read there.
 */
export function claudeArgs({ settings, session, resume, answer, claudeMd, skills }: { settings: string; session: string; resume: boolean; answer: object; claudeMd?: string; skills?: string }) {
  return [
    '-p',
    'Do what the message on stdin asks.',
    '--restricted',
    '--tools',
    [...TOOLS, ...(skills ? ['Skill'] : [])].join(','),
    '--settings',
    settings,
    ...(claudeMd ? ['--append-system-prompt-file', claudeMd] : []),
    ...(skills ? ['--plugin-dir', skills, '--add-dir', skills] : []),
    // No MCP server at all, not even those of the owner's plugins.
    '--strict-mcp-config',
    // Edits in its folder pass, but not to Claude Code's own files there, such as .claude/settings.json:
    // those ask, and anything that would ask is refused, since nobody is there to answer.
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(answer),
    resume ? '--resume' : '--session-id',
    session,
  ];
}

/** Claude Code's final word, from the line of its stream-json output that holds it (D-097). */
export function claudeResult(line: string): Final | undefined {
  let event: { type?: string; result?: string; is_error?: boolean; session_id?: string; structured_output?: unknown } | null;
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return undefined;
  }
  if (event?.type !== 'result') return undefined;
  return { text: String(event.result ?? ''), error: event.is_error === true, session: event.session_id, answer: event.structured_output };
}

/** A content block of a stream-json `assistant` event: the model's words, or a tool it calls. */
interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * What Claude Code does now, in a sentence, from one line of its stream-json output: the tool it
 * calls, with the file as the worktree knows it, or the first line of what it says. Undefined for
 * every other line.
 */
export function claudeProgress(output: string, cwd: string): string | undefined {
  // A tool's result can run to hundreds of kilobytes; only an assistant event is worth parsing.
  if (!output.includes('"type":"assistant"')) return undefined;
  let event: { type?: string; message?: { content?: Block[] } } | null;
  try {
    event = JSON.parse(output) as typeof event;
  } catch {
    return undefined;
  }
  if (event?.type !== 'assistant') return undefined;
  const block = event.message?.content?.at(-1);
  if (!block) return undefined;
  const input = block.input ?? {};
  const field = (name: string) => String(input[name] ?? '');
  const file = typeof input.file_path === 'string' ? path.relative(cwd, input.file_path) : '';
  const words: Record<string, string | undefined> = {
    Bash: typeof input.description === 'string' ? input.description : `Running ${field('command')}`,
    Read: `Reading ${file}`,
    Edit: `Editing ${file}`,
    Write: `Writing ${file}`,
    Glob: `Looking for ${field('pattern')}`,
    Grep: `Searching for ${field('pattern')}`,
    WebSearch: `Searching the web for ${field('query')}`,
    WebFetch: `Reading ${field('url')}`,
    Skill: `Using the ${field('skill')} skill`,
  };
  const said = block.type === 'tool_use' ? words[block.name ?? ''] : block.type === 'text' ? block.text?.trim().split('\n')[0] : undefined;
  return line(said, 200) || undefined;
}

/** The owner's Claude Code folder, `~/.claude` unless they moved it. */
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');

/**
 * The secret folders, and Claude Code's `session-env`: it keeps there the environment SessionStart
 * hooks leave, tokens and all, and lets a sandboxed shell read it.
 */
export const claudeSecrets = (dataDir: string) => [...secretDirs(dataDir), path.join(claudeHome(), 'session-env')];

/** The adapter: turns in `program`, restricted, under the plugin's settings file, which the guard hook `hook` completes. */
export function claudeHarness(program: string, hook: string, dataDir: string): Harness {
  const secrets = claudeSecrets(dataDir);
  // Beside the laptop's copy of the account, where it always was.
  const settings = path.join(dataDir, 'laptop', 'claude.json');
  const npmCache = path.join(os.tmpdir(), 'webchat-npm', 'laptop');
  return {
    name: 'Claude Code',
    async refusal(dir) {
      if (dir) return sandboxProblem(dir, secrets, restrictedSettings(settings));
      if (process.platform === 'win32') return 'Claude Code’s sandbox does not run on Windows, so I cannot work here. It runs in WSL2.';
      if (!program) return 'I cannot find Claude Code on this laptop.';
    },
    offers: () => ({ instructions: path.join(claudeHome(), 'CLAUDE.md'), skills: path.join(claudeHome(), 'skills'), knobs: ['noAttribution'] }),
    async found() {
      if (!program) return {};
      // `auth status` prints its JSON and exits 1 when signed out.
      const stdout = (args: string[]) => exec(program, args, { timeout: 10_000 }).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? '');
      const [version, status] = await Promise.all([stdout(['--version']), stdout(['auth', 'status'])]);
      const loggedIn = /"loggedIn":\s*(true|false)/.exec(status)?.[1];
      return { version: /^\d[\w.-]*/.exec(version.trim())?.[0], ...(loggedIn && { signedIn: loggedIn === 'true' }) };
    },
    // The turn runs under the plugin's settings alone, so the owner's do not count (D-097).
    async apply({ noAttribution }) {
      await fs.mkdir(npmCache, { recursive: true });
      await fs.writeFile(settings, JSON.stringify(claudeSettings({ secrets, npmCache, guard: hook, env: process.env, noAttribution })));
    },
    async turn({ cwd, session, resume, message, schema, setup, signal, progress }) {
      // The skills' copies load as a plugin, which holds only `skills/`.
      const args = claudeArgs({ settings, session, resume, answer: schema, claudeMd: setup.instructions, skills: setup.skills && path.dirname(setup.skills) });
      const seen = progress && ((line: string) => {
        const said = claudeProgress(line, cwd);
        if (said) progress(said);
      });
      const turn = await start(program, args, cwd, signal, claudeResult, message, seen);
      if (turn.error || !turn.answer) throw new Error(turn.text.trim().slice(0, 500) || 'Claude stopped without an answer.');
      return turn.answer;
    },
  };
}

/**
 * The session's own `claude`, by its absolute path: this server's parent, which the desktop app keeps
 * outside the PATH. Else the first on the PATH, from absolute folders only, since the background
 * Claude starts in a worktree whose files the model writes. Empty when there is none (D-097).
 */
export async function claudeProgram() {
  const parent =
    process.platform === 'linux'
      ? await fs.readlink(`/proc/${process.ppid}/exe`).catch(() => '')
      : await promisify(execFile)('ps', ['-o', 'comm=', '-p', String(process.ppid)]).then((r) => r.stdout.trim(), () => '');
  if (path.isAbsolute(parent) && path.basename(parent) === 'claude') return parent;
  return onPath('claude');
}

/** A program's absolute path, from the absolute folders of the PATH only, or empty when there is none. */
export async function onPath(name: string) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const file = path.join(dir, name);
    if (await fs.access(file, constants.X_OK).then(() => true, () => false)) return file;
  }
  return '';
}

/** The plugin as Claude Code hosts it: its turns run in the session's own `claude`, with the guard hook `guard`. */
export class ClaudePlugin extends Plugin {
  constructor({ claude, guard: hook, others = [], ...options }: Omit<PluginOptions, 'harnesses'> & { claude: string; guard: string; others?: Harness[] }) {
    super({ ...options, harnesses: [claudeHarness(claude, hook, options.dataDir), ...others] });
  }
}

const within = (file: string, dir: string) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The real path of a file that may not exist yet: its nearest existing folder's, then the rest. A
 * link to a file not made yet counts as its target, where a write through it lands (K-55).
 */
function real(file: string, hops = 0): string {
  try {
    // Unlike Node's own, the native call resolves as the kernel does: `..` after a link goes up from
    // the link's target, and on macOS a name in other letter case is the same folder.
    return realpathSync.native(file);
  } catch {
    const parent = path.dirname(file);
    if (parent === file) return file;
    const dir = real(parent, hops);
    const here = path.join(dir, path.basename(file));
    let target: string;
    try {
      target = readlinkSync(here);
    } catch {
      return here;
    }
    // Not path.resolve, which applies `..` before the links. A kernel follows at most 40 links, so
    // this stops there too, which also ends a loop.
    return hops < 40 ? real(path.isAbsolute(target) ? target : `${dir}${path.sep}${target}`, hops + 1) : here;
  }
}

interface Settings {
  sandbox?: { enabled?: boolean; failIfUnavailable?: boolean; filesystem?: { denyRead?: string[]; allowRead?: string[] } };
  permissions?: { blockReadsOutsideWorkingDirectories?: boolean };
}

/** A settings file Claude Code reads, and the folder a relative path in it counts from. */
type SettingsFile = [file: string, base: string];

const MANAGED =
  process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
      : '/etc/claude-code/managed-settings.json';

/** The files a `claude -p --restricted` run reads: managed settings, then the one it got with --settings (D-097). */
export const restrictedSettings = (file: string): SettingsFile[] => [
  [MANAGED, path.dirname(MANAGED)],
  [file, path.dirname(file)],
];

/**
 * Why the background Claude's shell could read a secret, from the settings files it runs with, or
 * undefined when it cannot. Only managed settings can undo the plugin's own (D-097).
 */
export async function sandboxProblem(projectDir: string, secrets: string[], sources: SettingsFile[]) {
  const home = os.homedir();
  const settings = await Promise.all(
    sources.map(async ([file, base]) => ({ base, json: (JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}')) ?? {}) as Settings })),
  );
  const first = <T>(pick: (s: Settings) => T | undefined) => settings.map((s) => pick(s.json)).find((value) => value !== undefined);
  if (first((s) => s.sandbox?.enabled) !== true) return 'Claude Code’s managed settings turn its sandbox off on my machine.';
  const resolve = (base: string, rule: string) => (rule === '~' || rule.startsWith('~/') ? path.join(home, rule.slice(1)) : path.resolve(base, rule));
  const rules = settings.flatMap(({ base, json }) => [
    ...(json.sandbox?.filesystem?.denyRead ?? []).map((rule) => ({ dir: resolve(base, rule), deny: true })),
    ...(json.sandbox?.filesystem?.allowRead ?? []).map((rule) => ({ dir: resolve(base, rule), deny: false })),
  ]);
  const outsideBlocked = first((s) => s.permissions?.blockReadsOutsideWorkingDirectories) === true;
  for (const secret of secrets) {
    // The narrowest rule that covers the folder decides, as in Claude Code; a deny wins a tie.
    const rule = rules.filter((r) => within(secret, r.dir)).sort((a, b) => b.dir.length - a.dir.length || Number(b.deny) - Number(a.deny))[0];
    if (rule ? !rule.deny : !(outsideBlocked && !within(secret, projectDir))) {
      return `My sandboxed shell could read ${secret}, as Claude Code’s managed settings allow.`;
    }
  }
  // Where the sandbox cannot start, Claude Code would run the shell without it (K-53).
  if (first((s) => s.sandbox?.failIfUnavailable) !== true) return 'Claude Code’s managed settings would let my shell run unsandboxed if its sandbox failed to start.';
}

/** A tool call, as Claude Code hands it to a PreToolUse hook. */
export interface ToolUse {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Glob', 'Grep']);

/**
 * Why the guard hook denies a tool call, or undefined. File tools never touch the secret folders,
 * since they run outside the sandbox (D-092), in the background Claude and in every other session.
 */
export function guard(use: ToolUse, secrets: string[]): string | undefined {
  const input = use.tool_input;
  const named = input.file_path ?? input.notebook_path ?? (use.tool_name === 'Glob' || use.tool_name === 'Grep' ? (input.path ?? use.cwd) : undefined);
  const target = FILE_TOOLS.has(use.tool_name) && typeof named === 'string' ? real(path.resolve(use.cwd, named)) : undefined;
  if (target && secrets.some((dir) => within(target, real(dir)))) return 'That folder holds secrets the WebChat plugin keeps from the model.';
}
