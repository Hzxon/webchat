// The plugin's background Claude (R-035, D-097): a `claude -p` the plugin keeps for each session of
// a run or conversation, apart from the owner's own sessions, with each turn written to its stdin
// as one stream-json line and ended by a `result` line with a JSON answer. It runs restricted, so it
// reads only managed settings and the plugin's settings file: none of the owner's settings, and none
// of the repository's settings, hooks or .mcp.json, which a -p run otherwise loads without asking.
// It never reads the message from arguments, which show in `ps`. Where the owner's page can show a
// question, it asks before an action through its permission prompt tool (approve.ts). This is the
// plugin's harness adapter for Claude Code (harness.ts).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { fits } from './answer.ts';
import { APPROVE_TOOL, openApprover, TOOL_TIMEOUT_MS, type Call } from './approve.ts';
import { isCredential, olderThan, secretDirs, type Ask, type Harness, type Turn } from './harness.ts';
import { line } from './plugin.ts';
import { shellPaths, within } from './rulebook.ts';
import { hold, IDLE_MS, keep, Quiet, watchdog, type Final } from './runner.ts';

const exec = promisify(execFile);

/** The only host the shell reaches, for installs (D-097). */
const REGISTRY = 'registry.npmjs.org';

/** Its tools. A restricted run has only those it names, and keeps its file tools in its folder. */
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/**
 * The plugin's settings file for it. The shell never runs outside the sandbox, not even where the
 * sandbox cannot start. It reads nothing outside its working directories but what toolchains need:
 * not the secrets, and not the macOS keychain, where gh keeps the owner's token (K-54). npm reads
 * no config of the owner's, which may hold a publish token, and keeps a cache of its own: the
 * sandbox cannot write the owner's, and a shared one would let it poison the owner's installs. Web
 * search and reading run outside the sandbox, as Claude Code's own tools. The shell gets no variable
 * of `env`, the environment it starts with, that holds a credential, while Claude Code keeps them for
 * its own login. Claude Code refuses a write through a link out of the folder. When the owner chose no AI attribution, empty lines hide
 * the ones Claude Code adds to commits and pull requests (R-039).
 */
export function claudeSettings({ secrets, npmCache, env, noAttribution }: { secrets: string[]; npmCache: string; env: NodeJS.ProcessEnv; noAttribution?: boolean }) {
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
  };
}

/**
 * A process's arguments: the first starts the session under its id, one that follows an ended
 * process resumes it. The turns come on stdin. With the owner's choice (R-039), their CLAUDE.md
 * goes in as a system prompt, and `skills` is a plugin folder made for the session, which holds only
 * copies of their skills. It is also a working directory, so a skill's scripts and references can be
 * read there. `schema` is fixed for the process, so it fits every turn of the session. With `mcp`,
 * the config file of the approval endpoint, an action Claude Code would ask about is asked of the
 * owner; without it, it is refused.
 */
export function claudeArgs({ settings, session, resume, schema, claudeMd, skills, mcp, own }: { settings: string; session: string; resume: boolean; schema: object; claudeMd?: string; skills?: string; mcp?: string; own?: boolean }) {
  const tail = [
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(schema),
    resume ? '--resume' : '--session-id',
    session,
  ];
  const asking = mcp ? ['--mcp-config', mcp, '--permission-prompt-tool', APPROVE_TOOL, '--disallowedTools', APPROVE_TOOL] : ['--permission-prompts', 'none'];
  // The owner's own setup, as their terminal runs it: their settings, hooks, plugins, MCP servers,
  // permission mode and rules load, and WebChat's endpoint only joins them to ask (D-157).
  if (own) return ['-p', '--input-format', 'stream-json', ...asking, ...tail];
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--restricted',
    '--tools',
    [...TOOLS, ...(skills ? ['Skill'] : [])].join(','),
    '--settings',
    settings,
    ...(claudeMd ? ['--append-system-prompt-file', claudeMd] : []),
    ...(skills ? ['--plugin-dir', skills, '--add-dir', skills] : []),
    // No MCP server but WebChat's own approval endpoint, not even those of the owner's plugins.
    '--strict-mcp-config',
    // Edits in its folder pass, but not to Claude Code's own files there, such as .claude/settings.json:
    // those ask the owner, or are refused when the owner's page cannot show a question.
    '--permission-mode',
    'acceptEdits',
    // The tool is hidden from the model, which must not call it for itself.
    ...asking,
    ...tail,
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

const ASK_KINDS: Record<string, Ask['kind']> = { Bash: 'execute', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Read: 'read', Glob: 'read', Grep: 'read', WebFetch: 'fetch', WebSearch: 'fetch' };

/**
 * What the permission prompt tool's call asks, for the rulebook and the owner: the tool's own
 * fields, never the model's description.
 */
export function claudeAsk({ tool_name: tool, input }: Call, cwd: string): Ask {
  const kind = ASK_KINDS[tool] ?? 'other';
  const text = (name: string) => (typeof input[name] === 'string' ? (input[name] as string) : undefined);
  // Every argument named for a path, such as the browser's `filePath`, `filePaths` and `sourcePath` (R-046).
  const named = Object.entries(input)
    .filter(([name]) => /paths?$/i.test(name))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((p): p is string => typeof p === 'string' && !!p);
  const paths = [...named.map((p) => path.resolve(cwd, p)), ...shellPaths(text('command') ?? '', cwd)];
  const target = text('command') ?? named[0] ?? text('url') ?? text('query') ?? text('pattern') ?? '';
  const url = text('url');
  return { tool, kind, paths, urls: url ? [url] : [], detail: kind === 'execute' ? target : kind === 'other' ? `${tool} ${JSON.stringify(input)}` : `${tool} ${target}` };
}

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[] };

/**
 * The one schema a process is started with, for every schema its session's turns use: all their
 * properties, with the values of one that several name joined, and required only what all require.
 * Each turn's own schema is checked on its answer.
 */
export function mergeSchemas(schemas: Schema[]): Schema {
  if (schemas.length === 1) return schemas[0]!;
  const properties: Record<string, Schema> = {};
  for (const { properties: own = {} } of schemas) {
    for (const [name, property] of Object.entries(own)) {
      const seen = properties[name];
      properties[name] = seen?.enum && property.enum ? { ...seen, enum: [...new Set([...seen.enum, ...property.enum])] } : (seen ?? property);
    }
  }
  const required = (schemas[0]!.required ?? []).filter((name) => schemas.every((s) => s.required?.includes(name)));
  return { type: 'object', properties, ...(required.length && { required }) };
}

/** An idle Claude is ended after this long without a turn; the next turn starts it again and resumes the session. */
export const CLAUDE_KEEP_MS = 10 * 60_000;

const CANCELLED = 'the owner cancelled the run.';

/** One Claude process, which takes the turns of one session. */
interface Live {
  child: ChildProcess;
  /** What it was started for: another folder, setup, schema or question mode starts a new one. */
  key: string;
  session: string;
  turn?: { ask?: Turn['ask']; shot?: Turn['shot']; cwd: string; line: (line: string) => void; fail: (error: Error) => void };
  /** Ends the process after `CLAUDE_KEEP_MS` without a turn. */
  timer?: NodeJS.Timeout;
  approver?: Awaited<ReturnType<typeof openApprover>>;
}

/** The owner's Claude Code folder, `~/.claude` unless they moved it. */
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');

/**
 * The secret folders, and Claude Code's `session-env`: it keeps there the environment SessionStart
 * hooks leave, tokens and all, and lets a sandboxed shell read it.
 */
export const claudeSecrets = (dataDir: string) => [...secretDirs(dataDir), path.join(claudeHome(), 'session-env')];

/** The first release with `--permission-prompts`, which a turn with no way to ask passes (claude.ts `claudeArgs`; Claude Code's changelog, 2.1.259). */
export const CLAUDE_MIN_VERSION = '2.1.259';

/** The adapter: turns in `program`, restricted, under the plugin's settings file. */
export function claudeHarness(program: string, dataDir: string): Harness {
  const secrets = claudeSecrets(dataDir);
  // Beside the laptop's copy of the account, where it always was.
  const settings = path.join(dataDir, 'laptop', 'claude.json');
  const npmCache = path.join(os.tmpdir(), 'webchat-npm', 'laptop');
  // The version is read once: `refusal()` runs on every request, and the finder builds a new adapter when the program changes.
  let version: Promise<string | undefined> | undefined;
  const versionOf = () => (version ??= exec(program, ['--version'], { timeout: 10_000 }).then((r) => /^\d[\w.-]*/.exec(r.stdout.trim())?.[0], () => undefined));
  const lives = new Map<string, Live>();
  let attribution = false;
  const writeSettings = async () => {
    await fs.mkdir(path.dirname(settings), { recursive: true });
    await fs.writeFile(settings, JSON.stringify(claudeSettings({ secrets, npmCache, env: process.env, noAttribution: attribution })));
  };
  // The config files of the approval endpoint, which only the plugin reads (approve.ts).
  const approveDir = path.join(dataDir, 'laptop', 'approve');

  // Closes still removing their token files, which `end` waits for: a failed turn closes its process without waiting.
  const closing = new Set<Promise<void>>();

  function close(live: Live) {
    clearTimeout(live.timer);
    if (lives.get(live.session) === live) lives.delete(live.session);
    live.child.kill();
    const done = Promise.resolve(live.approver?.close()).finally(() => closing.delete(done));
    closing.add(done);
    return done;
  }

  /** Starts the process for a session's first turn here: a new session, or the one a process that ended kept. */
  async function open(t: Turn, schema: Schema, key: string): Promise<Live> {
    const live = { key, session: t.session } as Live;
    // The call names no turn, so it goes to the one that runs now.
    live.approver = t.ask
      ? await openApprover(approveDir, async (call) => {
          const turn = live.turn;
          if (!turn?.ask) return { allow: false, message: 'No question is open.' };
          return turn.ask(claudeAsk(call, turn.cwd)).catch((error: unknown) => {
            turn.fail(error as Error);
            throw error;
          });
        }, t.lab && {
          start: (command) => (live.turn ? t.lab!.start(command, live.turn.cwd) : Promise.reject(new Error('No turn runs.'))),
          ...(t.shot && { shot: (file: string, caption: string) => (live.turn?.shot ? live.turn.shot(path.resolve(live.turn.cwd, file), caption) : Promise.reject(new Error('No turn runs.'))) }),
          server: t.lab.mcpServer(t.cwd),
        })
      : undefined;
    // The skills' copies load as a plugin, which holds only `skills/`.
    const args = claudeArgs({ settings, session: t.session, resume: t.resume, schema, claudeMd: t.setup.instructions, skills: t.setup.skills && path.dirname(t.setup.skills), mcp: live.approver?.file, own: t.own });
    const child = (live.child = spawn(program, args, { cwd: t.cwd, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...(live.approver && { MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_MS) }) } }));
    keep(child);
    // A process that exits before it reads closes the pipe; its exit says why.
    child.stdin.on('error', () => undefined);
    // On Linux a process that exits with output unread resets its pipe, which its exit already reports.
    readline.createInterface({ input: child.stdout }).on('line', (output) => live.turn?.line(output)).on('error', () => undefined);
    child.on('error', (error) => live.turn?.fail(error));
    child.on('close', (code) => {
      live.turn?.fail(new Error(`the agent exited with code ${code} and no result.`));
      void close(live);
    });
    return live;
  }

  /** Writes one turn to the process, and waits for the `result` line that ends it. */
  function converse(live: Live, t: Turn) {
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      const dog = watchdog(IDLE_MS, t.quiet ?? new Quiet(), () => finish(new Error(`the agent printed nothing for ${IDLE_MS / 60_000} minutes.`)));
      const onAbort = () => finish(new Error(CANCELLED));
      function finish(error?: Error, answer?: unknown) {
        if (done) return;
        done = true;
        dog.stop();
        t.signal.removeEventListener('abort', onAbort);
        live.turn = undefined;
        // A process that failed a turn is ended: the next turn starts it again and resumes.
        if (error) void close(live);
        else {
          hold(live.child, false);
          live.timer = setTimeout(() => void close(live), CLAUDE_KEEP_MS).unref();
        }
        if (error) reject(error);
        else resolve(answer);
      }
      t.signal.addEventListener('abort', onAbort, { once: true });
      live.turn = {
        ask: t.ask,
        shot: t.shot,
        cwd: t.cwd,
        fail: finish,
        line(output) {
          dog.arm();
          const result = claudeResult(output);
          if (!result) {
            const said = t.progress && claudeProgress(output, t.cwd);
            if (said) t.progress!(said);
            return;
          }
          const problem = result.error || !result.answer ? undefined : fits(t.schema, result.answer);
          if (result.error || !result.answer) finish(new Error(result.text.trim().slice(0, 500) || 'Claude stopped without an answer.'));
          else if (problem) finish(new Error(`Claude’s answer did not fit: ${problem}.`));
          else finish(undefined, result.answer);
        },
      };
      hold(live.child, true);
      // Claude Code keeps its last structured answer when a turn gives none, so each turn says to write it afresh.
      const fresh = `\n\nAnswer this message only: write the structured answer afresh, and keep nothing of an earlier answer.${(t.schemas?.length ?? 1) > 1 ? ` It must fit this schema: ${JSON.stringify(t.schema)}` : ''}`;
      live.child.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: t.message + fresh } })}\n`);
    });
  }

  return {
    name: 'Claude Code',
    asks: true,
    secrets,
    async refusal() {
      if (process.platform === 'win32') return 'Claude Code’s sandbox does not run on Windows, so I cannot work here. It runs in WSL2.';
      if (!program) return 'I cannot find Claude Code on this laptop.';
      return olderThan('Claude Code', await versionOf(), CLAUDE_MIN_VERSION);
    },
    // The settings are the plugin's own, so a managed setting is all that can undo them: a warning only, since the room keeps the secrets from the shell (docs/decisions/locked-room.md).
    // Nothing to check before the first `apply` writes the file.
    warning: async () => ((await fs.access(settings).then(() => true, () => false)) ? sandboxProblem(path.join(os.homedir(), 'WebChat'), secrets, restrictedSettings(settings)) : undefined),
    sandboxed: async () => !(await sandboxProblem(path.join(os.homedir(), 'WebChat'), secrets, restrictedSettings(settings))),
    offers: () => ({ instructions: path.join(claudeHome(), 'CLAUDE.md'), skills: path.join(claudeHome(), 'skills'), knobs: ['noAttribution', 'noPlan', 'own'] }),
    async found() {
      if (!program) return {};
      // `auth status` prints its JSON and exits 1 when signed out.
      const status = await exec(program, ['auth', 'status'], { timeout: 10_000 }).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? '');
      const loggedIn = /"loggedIn":\s*(true|false)/.exec(status)?.[1];
      return { path: program, version: await versionOf(), ...(loggedIn && { signedIn: loggedIn === 'true' }) };
    },
    // The turn runs under the plugin's settings alone, so the owner's do not count (D-097).
    async apply({ noAttribution }) {
      attribution = !!noAttribution;
      await fs.mkdir(npmCache, { recursive: true });
      // A crash leaves config files, each with a token that names nothing now.
      if (!lives.size) await fs.rm(approveDir, { recursive: true, force: true });
      await writeSettings();
    },
    async turn(t) {
      if (t.signal.aborted) throw new Error(CANCELLED);
      const schema = mergeSchemas((t.schemas ?? [t.schema]) as Schema[]);
      const key = JSON.stringify([t.cwd, !!t.ask, t.setup, schema, t.lab?.proxy, !!t.own]);
      let live = lives.get(t.session);
      if (live?.turn) throw new Error('a turn of this session is running already.');
      // A session that starts over, or needs other arguments, cannot keep its process.
      if (live && (!t.resume || live.key !== key)) {
        await close(live);
        live = undefined;
      }
      if (live) clearTimeout(live.timer);
      else {
        // The file sits in the owner's folder now, which the model's shell may reach: write it again before each process starts.
        await writeSettings();
        lives.set(t.session, (live = await open(t, schema, key)));
      }
      return converse(live, t);
    },
    async end(session) {
      await Promise.all([...[...lives].filter(([id]) => !session || id === session).map(([, live]) => close(live)), ...closing]);
    },
  };
}

/** The absolute folders of the PATH only, since the background Claude starts in a worktree whose files the model writes. */
export const pathDirs = () => (process.env.PATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d));

/** A program's absolute path, from `dirs`, or empty when there is none. */
export async function onPath(name: string, dirs = pathDirs()) {
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (await fs.access(file, constants.X_OK).then(() => true, () => false)) return file;
  }
  return '';
}

interface Settings {
  sandbox?: { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean; excludedCommands?: string[]; filesystem?: { denyRead?: string[]; allowRead?: string[] } };
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
  // The owner is not asked about a sandboxed command, so none may leave the sandbox (docs/decisions/harness-rulebook.md).
  if (first((s) => s.sandbox?.allowUnsandboxedCommands) !== false || settings.some((s) => s.json.sandbox?.excludedCommands?.length)) return 'Claude Code’s managed settings let my shell run commands outside its sandbox.';
}
