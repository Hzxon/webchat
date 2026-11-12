// The plugin's harness adapter for OpenAI's Codex CLI (harness.ts): a `codex app-server` for each
// session, which speaks JSON-RPC over its stdio and takes the session's turns one after another.
// Where the owner's page can show a question, Codex asks before a command or a file change outside
// its sandbox, and the owner answers from WebChat. Codex's sandbox lets the shell read every folder,
// the secret ones among them, so Codex answers questions and takes no cards
// (docs/decisions/new-harness-isolation-proof.md, docs/decisions/harness-approvals.md).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { fits } from './answer.ts';
import type { Ask, Harness, Turn } from './harness.ts';
import { Peer } from './rpc.ts';
import { shellPaths } from './rulebook.ts';
import { hold, IDLE_MS, keep, Quiet, watchdog } from './runner.ts';

const exec = promisify(execFile);

/** Why Codex takes no cards, which Settings shows on its row. */
export const CODEX_GAP = 'Codex’s sandbox lets its shell read every folder, your GitHub login among them, so Codex answers questions and takes no cards.';

/** An idle Codex is ended after this long without a turn; the next turn starts it again and resumes the thread. */
export const CODEX_KEEP_MS = 10 * 60_000;

const CANCELLED = 'the owner cancelled the run.';

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema };

/**
 * The schema as OpenAI's strict structured output takes it: every property required, the optional
 * ones nullable, and no others. The answer's nulls are dropped again when it is read.
 */
function strictSchema(schema: Schema): object {
  if (schema.type === 'array' && schema.items) return { ...schema, items: strictSchema(schema.items) };
  if (schema.type !== 'object' || !schema.properties) return schema;
  const required = new Set(schema.required);
  const properties = Object.entries(schema.properties).map(([name, s]) => [name, required.has(name) ? strictSchema(s) : { anyOf: [strictSchema(s), { type: 'null' }] }]);
  return { ...schema, properties: Object.fromEntries(properties), required: Object.keys(schema.properties), additionalProperties: false };
}

/** The names of the MCP servers a Codex config lists, from its table headers: `[mcp_servers.name]`. */
export const mcpServerNames = (config: string) => [...new Set([...config.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([\w-]+))/gm)].map((m) => (m[1] ?? m[2])!))];

/**
 * The server's arguments. The owner's hooks and MCP servers stay off, as for Claude Code (D-115):
 * `-c` overrides merge into the owner's config and never replace it, so each server is turned off by
 * name. Their execpolicy `.rules` cannot be turned off from app-server and keep applying, which the
 * owner accepted. The shell gets only the core environment variables, none of the owner's tokens.
 */
export const codexArgs = (servers: string[]) => [
  'app-server',
  '-c',
  'shell_environment_policy.inherit="core"',
  '-c',
  'features.hooks=false',
  ...servers.flatMap((name) => ['-c', `mcp_servers.${/^[\w-]+$/.test(name) ? name : JSON.stringify(name)}.enabled=false`]),
];

/** One Codex process, which takes the turns of one session. */
interface Live {
  child: ChildProcess;
  peer: Peer;
  session: string;
  key: string;
  thread: string;
  /** The files a file change names, by item id: its approval request does not. */
  changes: Map<string, string[]>;
  turn?: { id?: string; cwd: string; ask?: Turn['ask']; note: (method: string, params: any) => void; fail: (error: Error) => void };
  timer?: NodeJS.Timeout;
}

/**
 * The adapter: Codex in `program`. Codex names its own threads, so the thread of each of the
 * plugin's sessions is kept in `dataDir`, where a restart still finds it.
 */
export function codexHarness(program: string, dataDir: string): Harness {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const file = path.join(dataDir, 'codex-threads.json');
  let threads: Record<string, string> | undefined;
  const lives = new Map<string, Live>();

  async function close(live: Live) {
    clearTimeout(live.timer);
    if (lives.get(live.session) === live) lives.delete(live.session);
    live.child.kill();
  }

  /** Starts the server, and opens the session's thread: a new one, or the one an earlier process kept. */
  async function open(t: Turn, key: string): Promise<Live> {
    const servers = mcpServerNames(await fs.readFile(path.join(home, 'config.toml'), 'utf8').catch(() => ''));
    const child = spawn(program, codexArgs(servers), { cwd: t.cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    keep(child);
    const live = { child, session: t.session, key, changes: new Map() } as Live;
    live.peer = new Peer({
      input: child.stdout,
      output: child.stdin,
      handle: (method, params) => approval(live, method, params),
      notified: (method, params) => {
        if (method === 'item/started' && params.item?.type === 'fileChange') live.changes.set(params.item.id, (params.item.changes ?? []).map((c: { path: string }) => c.path));
        live.turn?.note(method, params);
      },
    });
    child.on('error', (error) => live.turn?.fail(error));
    child.on('close', (code) => {
      live.peer.fail(new Error(`the agent exited with code ${code} and no result.`));
      live.turn?.fail(new Error(`the agent exited with code ${code} and no result.`));
      void close(live);
    });
    try {
      await live.peer.request('initialize', { clientInfo: { name: 'webchat', title: 'WebChat agent', version: pkg.version } });
      live.peer.notify('initialized');
      threads ??= existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
      // Only a question has Codex ask; with none, it never does, and what it would ask is refused.
      const settings = { cwd: t.cwd, approvalPolicy: t.ask ? 'on-request' : 'never', sandbox: 'workspace-write' };
      const stored = t.resume ? threads[t.session] : undefined;
      const opened = await live.peer.request<{ thread: { id: string } }>(stored ? 'thread/resume' : 'thread/start', stored ? { threadId: stored, ...settings } : settings);
      live.thread = opened.thread.id;
      if (threads[t.session] !== live.thread) {
        threads[t.session] = live.thread;
        // At once, so two sessions that start together cannot interleave their writes.
        writeFileSync(file, JSON.stringify(threads));
      }
    } catch (error) {
      await close(live);
      throw error;
    }
    return live;
  }

  /** What Codex asks of the client: to run a command, or to change files outside its sandbox. Only accept or decline, never a decision that outlives this one. */
  async function approval(live: Live, method: string, params: { command?: string; itemId?: string; grantRoot?: string | null }) {
    // Other requests, such as a grant of permissions or a form, have answers that are not a decision, and get an error.
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') throw new Error('WebChat answers only the approval of a command or a file change.');
    const turn = live.turn;
    const decline = { decision: 'decline' };
    if (!turn?.ask) return decline;
    const command = method === 'item/commandExecution/requestApproval';
    const files = (live.changes.get(params.itemId ?? '') ?? []).map((p) => path.resolve(turn.cwd, p));
    // A file change that asks for a whole folder is not one file the owner can read.
    if (!command && (params.grantRoot || !files.length)) return decline;
    const ask: Ask = command
      ? { tool: 'shell', kind: 'execute', paths: shellPaths(params.command ?? '', turn.cwd), detail: params.command ?? '' }
      : { tool: 'apply_patch', kind: 'edit', paths: files, detail: files.join('\n') };
    const reply = await turn.ask(ask).catch((error: unknown) => {
      turn.fail(error as Error);
      return { allow: false as const };
    });
    return { decision: reply.allow ? 'accept' : 'decline' };
  }

  /** Starts one turn, and waits for the notification that ends it. */
  function converse(live: Live, t: Turn) {
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      let text = '';
      const dog = watchdog(IDLE_MS, t.quiet ?? new Quiet(), () => finish(new Error(`the agent printed nothing for ${IDLE_MS / 60_000} minutes.`)));
      const onAbort = () => finish(new Error(CANCELLED));
      function finish(error?: Error, answer?: unknown) {
        if (done) return;
        done = true;
        dog.stop();
        t.signal.removeEventListener('abort', onAbort);
        live.turn = undefined;
        // A process that failed a turn is ended: the next turn starts it again and resumes the thread.
        if (error) void close(live);
        else {
          hold(live.child, false);
          live.timer = setTimeout(() => void close(live), CODEX_KEEP_MS).unref();
        }
        if (error) reject(error);
        else resolve(answer);
      }
      t.signal.addEventListener('abort', onAbort, { once: true });
      const turn: NonNullable<Live['turn']> = (live.turn = {
        cwd: t.cwd,
        ask: t.ask,
        fail: finish,
        note(method, params: { turn?: { id?: string; status?: string; error?: { message?: string } }; item?: { type?: string; text?: string; phase?: string } }) {
          dog.arm();
          // The last message of the turn is its answer, the final one if Codex marks it.
          if (method === 'item/completed' && params.item?.type === 'agentMessage' && (params.item.phase === 'final_answer' || !text)) text = params.item.text ?? '';
          if (method !== 'turn/completed' || params.turn?.id !== turn.id) return;
          if (params.turn?.status === 'failed') return finish(new Error(params.turn.error?.message || 'Codex stopped without an answer.'));
          if (params.turn?.status === 'interrupted') return finish(new Error(CANCELLED));
          try {
            const answer = JSON.parse(text, (_key, value: unknown) => (value === null ? undefined : value)) as unknown;
            const problem = fits(t.schema, answer);
            if (problem) finish(new Error(`Codex’s answer did not fit: ${problem}.`));
            else finish(undefined, answer);
          } catch {
            finish(new Error(text.trim().slice(0, 500) || 'Codex stopped without an answer.'));
          }
        },
      });
      hold(live.child, true);
      live.peer
        .request<{ turn: { id: string } }>('turn/start', { threadId: live.thread, input: [{ type: 'text', text: t.message }], outputSchema: strictSchema(t.schema as Schema) })
        .then((started) => (turn.id = started.turn.id), finish);
    });
  }

  return {
    name: 'Codex',
    asks: true,
    async refusal(dir, purpose) {
      if (!program) return 'I cannot find Codex on this laptop.';
      if (dir && purpose !== 'answers') return CODEX_GAP;
    },
    // Codex reads both on every turn, whatever the owner chose: its config has no switch for them.
    offers: () => ({ instructions: path.join(home, 'AGENTS.md'), skills: path.join(os.homedir(), '.agents', 'skills'), knobs: [] }),
    async found() {
      if (!program) return {};
      const [version, signedIn] = await Promise.all([
        exec(program, ['--version'], { timeout: 10_000 }).then((r) => /\d[\w.-]*/.exec(r.stdout)?.[0], () => undefined),
        // It exits 0 when credentials are present.
        exec(program, ['login', 'status'], { timeout: 10_000 }).then(() => true, () => false),
      ]);
      return { path: program, version, signedIn };
    },
    async apply() {},
    async turn(t) {
      if (t.signal.aborted) throw new Error(CANCELLED);
      const key = JSON.stringify([t.cwd, !!t.ask]);
      let live = lives.get(t.session);
      if (live?.turn) throw new Error('a turn of this session is running already.');
      if (live && (!t.resume || live.key !== key)) {
        await close(live);
        live = undefined;
      }
      if (live) clearTimeout(live.timer);
      else lives.set(t.session, (live = await open(t, key)));
      return converse(live, t);
    },
    async end(session) {
      await Promise.all([...lives].filter(([id]) => !session || id === session).map(([, live]) => close(live)));
    },
  };
}
