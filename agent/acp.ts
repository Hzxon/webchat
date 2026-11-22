// The harness adapter for any agent that speaks the Agent Client Protocol (docs/decisions/acp-adapter.md).
// It starts the agent at a session's first turn and keeps the process, and the ACP session in it,
// for the session's later turns, each a `session/prompt`; the prompt goes over the protocol and
// never in arguments, which `ps` shows (D-097). The agent ends each turn by calling `submit_answer`
// on an MCP server of ours (answer.ts). Its permission requests get the rulebook's answer, and the
// owner's when the rulebook cannot decide and the owner's page can show a question.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { HARNESS_WARNING, type SessionAboutDTO, type SessionEventDTO } from '../shared/types.ts';
import type { AcpAgent } from './acp-agents.ts';
import { listenForAnswers } from './answer.ts';
import { cutStep, isCredential, olderThan, planLine, secretDirs, shownPath, type Harness, type Turn } from './harness.ts';
import { Peer, RpcError } from './rpc.ts';
import { IDLE_MS, Quiet, watchdog } from './runner.ts';
import { judge, type Action } from './rulebook.ts';

const exec = promisify(execFile);

export const TIMING = {
  /** An agent with no turn for this long is ended; the next turn starts it again and resumes the session. */
  keep: 10 * 60_000,
  /** An agent that says nothing for this long during a turn is stuck. */
  idle: IDLE_MS,
  /** The agent has this long to start and open its session, which a wrong flag would otherwise hide for hours. */
  start: 60_000,
  /** After the answer, the agent has this long to end its prompt, so it can save its session. */
  grace: 15_000,
  /** After a cancel, and after its input closes, it has this long before it is killed. */
  stop: 5_000,
};

const CANCELLED = 'the owner cancelled the run.';
const NUDGES = 2;

/** Every agent still running, so none outlives the daemon. */
const running = new Set<ChildProcess>();
process.on('exit', () => running.forEach((child) => child.kill()));

/** Whether `promise` settled within `ms`. */
const ended = (promise: Promise<unknown>, ms: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(resolve, ms, false);
    promise.then(() => resolve(true), () => resolve(true)).finally(() => clearTimeout(timer));
  });

/** What an agent's tool call touches, as the rulebook reads it. */
interface ToolCall {
  name?: string;
  title?: string;
  kind?: Action['kind'];
  locations?: { path: string }[];
  content?: { type?: string; path?: string }[];
  rawInput?: Record<string, unknown>;
}

function actionOf(call: ToolCall, cwd: string): Action {
  const input = call.rawInput ?? {};
  const named = [input.path, input.file_path, input.filePath, ...(Array.isArray(input.paths) ? input.paths : [])];
  const paths = [...(call.locations ?? []).map((l) => l.path), ...(call.content ?? []).map((c) => c.path), ...named].filter((p): p is string => typeof p === 'string');
  return { tool: call.name ?? call.title, kind: call.kind ?? 'other', paths: paths.map((p) => path.resolve(cwd, p)) };
}

type ConfigOption = { category?: string; currentValue?: unknown };
type Update = {
  sessionUpdate?: string;
  kind?: Action['kind'];
  status?: string;
  locations?: { path: string }[];
  /** A message chunk's one block, or a tool call's list, in which a diff names a file it changed. */
  content?: { text?: string } | { type?: string; path?: string; oldText?: string | null; newText?: string }[];
  entries?: { content?: string; status?: string }[];
  used?: number;
  configOptions?: ConfigOption[];
  availableCommands?: { name?: string }[];
};

/** The model a session's config options pick, which ACP gives as the option of the `model` category. */
const modelOf = (options?: ConfigOption[]) => {
  const value = options?.find((o) => o.category === 'model')?.currentValue;
  return typeof value === 'string' ? value : undefined;
};

/** What an update says the session runs with (R-072): its model, the context it fills and its slash commands. */
export function acpAbout(update: Update): SessionAboutDTO | undefined {
  if (update.sessionUpdate === 'usage_update' && Number.isInteger(update.used)) return { context: update.used! };
  const model = update.sessionUpdate === 'config_option_update' ? modelOf(update.configOptions) : undefined;
  if (model) return { model };
  if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) return { commands: update.availableCommands.map((c) => c.name).filter((n): n is string => typeof n === 'string') };
}

/** The steps the session's details show from an update: the plan, and each file a finished tool call changed (R-072). */
export function acpSteps(update: Update, cwd: string): SessionEventDTO[] {
  const at = Date.now();
  if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) return [cutStep({ kind: 'plan', title: 'Plan', detail: update.entries.map((e) => planLine(e.status, e.content ?? '')).join('\n'), at })];
  // A tool call's content is a list; only its diffs name a file it changed, once the call has finished.
  if ((update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') || update.status !== 'completed' || !Array.isArray(update.content)) return [];
  return update.content.filter((c) => c.type === 'diff' && c.path).map((c) => cutStep({ kind: 'edit', title: shownPath(cwd, c.path!), detail: `${c.oldText ? `- ${c.oldText}\n` : ''}+ ${c.newText ?? ''}`, at }));
}

/** How progress reads for each kind of tool call: a sentence of ours, never the agent's own words. */
const WORDS: Partial<Record<Action['kind'], string>> = { read: 'Reading', edit: 'Editing', delete: 'Deleting', move: 'Moving', search: 'Searching', fetch: 'Reading the web', execute: 'Running a command' };

interface Live {
  child: ChildProcess;
  peer: Peer;
  listener: Awaited<ReturnType<typeof listenForAnswers>>;
  /** Settles when the process ends. */
  exited: Promise<string>;
  /** Rejects with why the process ended. */
  gone: Promise<never>;
  /** The agent's own id of the session. */
  acp: string;
  cwd: string;
  /** Ends the process after `TIMING.keep` without a turn. */
  timer?: NodeJS.Timeout;
  /** Marks that the agent said something, for the idle watch of the turn. */
  touch?: () => void;
  turn?: { progress?: (sentence: string) => void; events?: Turn['events']; about?: Turn['about']; ask?: Turn['ask']; cwd: string; done: boolean; last: string; denied?: string; fail?: (error: Error) => void };
  /** What the session runs with, as the agent said it, which can come between turns, given to each turn. */
  about: SessionAboutDTO;
}

export interface AcpOptions {
  agent: AcpAgent;
  /** The agent's absolute path, or empty when the laptop lacks it. */
  program: string;
  /** The argv that runs this program again, to which `answer` goes. */
  self: string[];
  dataDir: string;
  timing?: Partial<typeof TIMING>;
}

export function acpHarness({ agent, program, self, dataDir, timing }: AcpOptions): Harness {
  const time = { ...TIMING, ...timing };
  const { name } = agent;
  const file = path.join(dataDir, `acp-${agent.id}.json`);
  const lives = new Map<string, Live>();
  // The agent's own id of each of the plugin's sessions, which a restart still finds.
  const sessions = () => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {});
  // One `--version` read, since `refusal()` runs on every request and the finder builds a new adapter when the program changes.
  let version: Promise<string | undefined> | undefined;
  const versionOf = () => (version ??= exec(program, agent.version ?? ['--version'], { timeout: 10_000 }).then((r) => /\d+(\.\d+)+[\w.-]*/.exec(r.stdout)?.[0], () => undefined));

  /** What the agent's shell inherits: no credential but those its own sign-in keeps. */
  const environment = () => ({
    ...Object.fromEntries(Object.entries(process.env).filter((entry) => !isCredential(entry) || agent.login?.includes(entry[0]))),
    ...agent.isolation?.env,
  });

  async function close(live: Live) {
    clearTimeout(live.timer);
    for (const [session, other] of lives) if (other === live) lives.delete(session);
    live.child.stdin?.end();
    if (!(await ended(live.exited, time.stop))) live.child.kill();
    await live.listener.close();
  }

  /**
   * The agent's answer to its own permission request: the rulebook's, and the owner's where the
   * rulebook cannot decide and the owner's page can show a question. Only a no or a yes, once, never
   * a standing rule: "for this run" is WebChat's own grant, so the agent is never told `allow_always`.
   */
  async function permission(live: Live, params: { toolCall: ToolCall; options?: { optionId: string; kind: string }[] }) {
    const cancelled = { outcome: { outcome: 'cancelled' } };
    const { turn } = live;
    if (!turn || turn.done) return cancelled;
    const action = actionOf(params.toolCall, turn.cwd);
    const verdict = judge(action, { folders: [turn.cwd], secrets: secretDirs(dataDir), tools: ['submit_answer'] });
    let allow = verdict.allow;
    if (!verdict.allow) {
      turn.denied = verdict.why;
      if (verdict.ask && turn.ask) {
        const call = params.toolCall;
        const detail = String(call.rawInput?.command ?? call.title ?? action.paths.join('\n'));
        const reply = await turn.ask({ ...action, detail }).catch((error: unknown) => {
          turn.fail?.(error as Error);
          return { allow: false as const, message: '' };
        });
        allow = reply.allow;
      }
    }
    const option = params.options?.find((o) => o.kind === (allow ? 'allow_once' : 'reject_once'));
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled;
  }

  function onRequest(live: Live, method: string, params: any) {
    // File and terminal methods were not offered, and neither was a form for the owner.
    if (method === 'session/request_permission') return permission(live, params);
    return Promise.reject(new Error(`${method} is not offered.`));
  }

  function onNote(live: Live, method: string, params: { update?: Update }) {
    const { turn } = live;
    const update = params.update;
    if (method !== 'session/update' || !update) return;
    const more = acpAbout(update);
    if (more) {
      live.about = { ...live.about, ...more };
      turn?.about?.(more);
    }
    // What an agent replays on `session/load` comes between turns, and is dropped here.
    if (!turn) return;
    if (turn.events) for (const step of acpSteps(update, turn.cwd)) turn.events(step);
    if (update.sessionUpdate === 'agent_message_chunk') turn.last = (turn.last + ((!Array.isArray(update.content) && update.content?.text) || '')).slice(-2000);
    const word = update.kind && WORDS[update.kind];
    if (update.sessionUpdate === 'tool_call' && word && !turn.done) {
      // Hermes reports the path its tool was given, which may be relative to the working folder.
      const where = update.locations?.[0]?.path && path.relative(turn.cwd, path.resolve(turn.cwd, update.locations[0].path));
      turn.progress?.(where ? `${word} ${where}` : word);
    }
  }

  /** Starts the agent and opens its session for `t`: a new one, or the one it kept. */
  async function open(t: Turn): Promise<Live> {
    const listener = await listenForAnswers();
    const home = path.join(dataDir, agent.id);
    const isolation = (agent.isolation?.args ?? []).map((arg) => arg.replaceAll('{data}', home));
    if (agent.isolation?.args.some((arg) => arg.includes('{data}'))) mkdirSync(home, { recursive: true });
    const child = spawn(program, [...agent.args, ...isolation], { cwd: t.cwd, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
    running.add(child);
    // Kept for the error text, and never forwarded.
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => (stderr = (stderr + data).slice(-2000))).on('error', () => undefined);
    const exited = new Promise<string>((resolve) => {
      child.on('error', (error) => resolve(`${name} did not start: ${error.message}`));
      child.on('close', (code) => {
        running.delete(child);
        resolve(`${name} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}.`);
      });
    });
    const gone = exited.then((why) => {
      throw new Error(why);
    });
    gone.catch(() => undefined);
    const peer = new Peer({ input: child.stdout, output: child.stdin, handle: (method, params) => onRequest(live, method, params), notified: (method, params) => onNote(live, method, params) });
    exited.then((why) => peer.fail(new Error(why)));
    const live: Live = { child, peer, listener, exited, gone, acp: '', cwd: t.cwd, about: {} };
    child.stdout.on('data', () => live.touch?.());
    const start = new Promise<never>((_, reject) => setTimeout(reject, time.start, new Error(`${name} did not start in ACP mode. Check that "${path.basename(program)} ${agent.args.join(' ')}" runs on its own.`)).unref());
    start.catch(() => undefined);
    try {
      await Promise.race([setup(live, t), gone, start]);
    } catch (error) {
      await close(live);
      throw error;
    }
    return live;
  }

  async function setup(live: Live, { session, resume }: Turn) {
    const init = await live.peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'webchat', title: 'WebChat agent', version: pkg.version },
    });
    if (init.protocolVersion !== 1) throw new Error(`${name} speaks ACP version ${init.protocolVersion}, and I speak 1.`);
    const mcpServers = [{ name: 'webchat', command: self[0], args: [...self.slice(1), 'answer'], env: live.listener.env }];
    const stored = sessions()[session];
    let method = 'session/new';
    let params: object = { cwd: live.cwd, mcpServers };
    if (resume) {
      if (!stored) throw new Error('I no longer have that session.');
      const can = init.agentCapabilities;
      if (!can?.sessionCapabilities?.resume && !can?.loadSession) throw new Error(`${name} cannot resume a session.`);
      method = can.sessionCapabilities?.resume ? 'session/resume' : 'session/load';
      params = { sessionId: stored, cwd: live.cwd, mcpServers };
    }
    let result: { sessionId?: string; configOptions?: ConfigOption[] } | undefined;
    try {
      result = await live.peer.request(method, params);
    } catch (error) {
      // -32000: it wants a sign-in. Only a method the agent runs itself, once; a terminal one is the owner's to do.
      if (!(error instanceof RpcError && error.code === -32000)) throw error;
      const methodId = (init.authMethods as { id: string; type?: string }[] | undefined)?.find((m) => !m.type || m.type === 'agent')?.id;
      if (!methodId) throw new Error(`${name} needs you to sign in: run ${path.basename(program)} on your laptop once.`);
      await live.peer.request('authenticate', { methodId });
      result = await live.peer.request(method, params);
    }
    live.acp = result?.sessionId ?? stored;
    const model = modelOf(result?.configOptions);
    if (model) live.about = { ...live.about, model };
    if (!resume) writeFileSync(file, JSON.stringify({ ...sessions(), [session]: live.acp }));
  }

  /** What the agent is told on each turn: how to end it, and the shape of its answer. */
  const brief = (schema: object) =>
    `End this turn by calling the submit_answer tool of the webchat MCP server once, with an answer shaped like this JSON schema: ${JSON.stringify(schema)}. Write no answer as text. Stay in the working folder and run no shell commands.\n\n`;

  async function converse(live: Live, t: Turn, turn: NonNullable<Live['turn']>) {
    const answered = live.listener.ask(t.schema);
    let got: { value: unknown } | undefined;
    answered.then((value) => ((got = { value }), (turn.done = true)), () => undefined);
    let dog!: ReturnType<typeof watchdog>;
    const stalled = new Promise<never>((_, reject) => {
      dog = watchdog(time.idle, t.quiet ?? new Quiet(), () => reject(new Error(`the agent printed nothing for ${Math.round(time.idle / 60_000)} minutes.`)));
      live.touch = dog.arm;
    });
    // A question nobody answered in 7 days ends the turn, with the reason the owner reads.
    const broken = new Promise<never>((_, reject) => (turn.fail = reject));
    broken.catch(() => undefined);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => t.signal.addEventListener('abort', (onAbort = () => reject(new Error(CANCELLED))), { once: true }));
    stalled.catch(() => undefined);
    aborted.catch(() => undefined);
    try {
      let text = brief(t.schema) + t.message;
      for (let nudges = 0; ; nudges++) {
        const prompt = live.peer.request<{ stopReason?: string }>('session/prompt', { sessionId: live.acp, prompt: [{ type: 'text', text }] });
        prompt.catch(() => undefined);
        const result = await Promise.race([prompt, answered, live.gone, aborted, stalled, broken]);
        if (got) {
          // Its prompt ends soon after, which a later prompt must wait for; an agent that will not is cancelled, then ended.
          if (!(await ended(prompt, time.grace))) {
            live.peer.notify('session/cancel', { sessionId: live.acp });
            if (!(await ended(prompt, time.stop))) await close(live);
          }
          return got.value;
        }
        const stop = (result as { stopReason?: string }).stopReason;
        if (stop === 'end_turn' && nudges < NUDGES) {
          text = 'You ended your turn without calling submit_answer. Call it now with your answer.';
          continue;
        }
        if (stop === 'cancelled') throw new Error(CANCELLED);
        const why = stop === 'end_turn' ? turn.last.trim().slice(-500) : `${name} stopped: ${stop}.`;
        throw new Error([why || `${name} stopped without an answer.`, turn.denied && `WebChat refused it: ${turn.denied}`].filter(Boolean).join(' '));
      }
    } finally {
      dog.stop();
      live.touch = undefined;
      t.signal.removeEventListener('abort', onAbort);
      live.listener.rest();
    }
  }

  return {
    name,
    asks: true,
    async refusal() {
      if (!program) return `I cannot find ${name} on this laptop.`;
      const old = olderThan(name, await versionOf(), agent.min);
      if (old) return old;
    },
    async warning() {
      return HARNESS_WARNING[name];
    },
    // ACP has no switch for the owner's instructions, skills or any knob, and D-115 lets an adapter declare only what it honors.
    offers: () => ({ knobs: [] }),
    async found() {
      return program ? { path: program, version: await versionOf() } : {};
    },
    async apply() {},
    async turn(t) {
      if (t.signal.aborted) throw new Error(CANCELLED);
      // Checked on every turn: the agent reads such a file again for its next turn.
      const unsafe = agent.refuseFiles?.find((file) => existsSync(path.join(t.cwd, file)));
      if (unsafe) throw new Error(`${name} would run the commands in ${unsafe} outside its sandbox, so I do not run it in a folder that has one. Remove it, or pick another coding agent.`);
      let live = lives.get(t.session);
      if (live?.turn) throw new Error('a turn of this session is running already.');
      // A session that starts over, or moves to another folder, cannot keep its process.
      if (live && (!t.resume || live.cwd !== t.cwd)) {
        await close(live);
        live = undefined;
      }
      if (live) clearTimeout(live.timer);
      else lives.set(t.session, (live = await open(t)));
      const turn = (live.turn = { progress: t.progress, events: t.events, about: t.about, ask: t.ask, cwd: t.cwd, done: false, last: '' });
      t.about?.(live.about);
      try {
        return await converse(live, t, turn);
      } catch (error) {
        // The agent keeps its session; the next turn starts it again and resumes.
        live.peer.notify('session/cancel', { sessionId: live.acp });
        await close(live);
        throw error;
      } finally {
        live.turn = undefined;
        if (lives.get(t.session) === live) live.timer = setTimeout(() => void close(live), time.keep).unref();
      }
    },
    async end(session) {
      await Promise.all([...lives].filter(([id]) => !session || id === session).map(([, live]) => close(live)));
    },
  };
}
