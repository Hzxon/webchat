// The socket between the keyholder, which holds the agent's keys, and the runner, which works in the
// owner's folders (docs/decisions/locked-room.md). Lines of JSON-RPC over a Unix socket, through
// `Peer`: the keyholder serves it and asks the one runner that connected, and the runner asks back
// for the owner's answer to a question. Bundles, which can be large, go over a side connection each.
//
// Nothing secret crosses this socket, and nothing on it carries authority. Whoever the owner runs
// can connect, so every reply is checked as data, never obeyed: harness names against the supported
// list, branches and worktrees against the request, answers against their schema, bundles by `Keep`.
// Pairing never crosses it: a code from another account would make that account the agent's owner.
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRepoName, LIMITS, SKILL_NAME, type SetupChoice } from '../shared/types.ts';
import { fits } from './answer.ts';
import { NO_RUNNER, PrerequisitesMissing, type Bench, type Folder, type HarnessInfo, type LocalBench, type Permit, type TurnJob } from './bench.ts';
import type { Ask, Reply } from './harness.ts';
import { SUPPORTED } from './harnesses.ts';
import type { AgentStatus } from './plugin.ts';
import { Quiet } from './runner.ts';
import { Peer, RpcError } from './rpc.ts';

/** The longest line either side reads, so a peer cannot fill memory with one that never ends. */
export const LINE_MAX = 4 * 1024 * 1024;
/** The most a bundle may weigh, as `Keep` allows. */
const BUNDLE_MAX = 512 * 1024 * 1024;
const TRANSFER_MS = 10 * 60_000;
const RETRY_MS = 5_000;

const BUSY = -32001;
const VERSION = -32002;
const FIRST = -32003;
const PREREQUISITES = -32010;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];

/** What the keyholder does for the commands. The `Plugin` is one. */
export interface Handlers {
  goToSleep(): Promise<string>;
  wake(): Promise<string>;
  status(): Promise<AgentStatus>;
  /** The cards and questions that a restart would cut short. */
  working(): Promise<string[]>;
  requestLink(harness: string): Promise<string>;
  requestConnect(dir: string, repo: string): Promise<string>;
  requestCard(repo: string, file: string, text: string): Promise<{ text: string; card?: string }>;
}

/** What `status` answers: the agent's own, and whether a runner is connected. */
export type RoomStatus = AgentStatus & { runner: boolean };

type Hello = { role: 'runner' | 'cli' | 'updater'; version: string; uid: number; user: string; home: string };

const mismatch = () => new Error('The runner sent something that does not fit, so I did not use it.');
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const strings = (value: unknown, max: number) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, max) : []);
const text = (value: unknown, max = 500) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/** Ends the stream, with an error, once a line passes the cap. */
class Cap extends Transform {
  private run = 0;
  _transform(chunk: Buffer, _encoding: string, done: (error?: Error | null, data?: Buffer) => void) {
    let start = 0;
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
      if (this.run + i - start > LINE_MAX) return done(new Error('line too long'));
      this.run = 0;
      start = i + 1;
    }
    this.run += chunk.length - start;
    done(this.run > LINE_MAX ? new Error('line too long') : null, chunk);
  }
}

/** A socket's lines, which end the socket when one is too long; every stream here gets an error handler, as Linux resets one that ends with output unread. */
function linesOf(socket: net.Socket) {
  const capped = socket.pipe(new Cap());
  capped.on('error', () => socket.destroy());
  return capped;
}

/** Reads a socket up to its first line, which says whether it is a side connection; the bytes go back for the `Peer`. */
function head(socket: net.Socket) {
  return new Promise<{ line: string; rest: Buffer; all: Buffer } | null>((resolve) => {
    let all = Buffer.alloc(0);
    const onClose = () => resolve(null);
    const onData = (chunk: Buffer) => {
      all = Buffer.concat([all, chunk]);
      const end = all.indexOf(10);
      if (end < 0 && all.length <= LINE_MAX) return;
      socket.off('data', onData).off('close', onClose).pause();
      if (end < 0) {
        socket.destroy();
        return resolve(null);
      }
      resolve({ line: all.subarray(0, end).toString(), rest: all.subarray(end + 1), all });
    };
    socket.on('data', onData).once('close', onClose);
  });
}

function connect(file: string) {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(file);
    socket.once('error', (error: NodeJS.ErrnoException) => reject(['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '') ? new Error(`The agent is not running: nothing listens on ${file}.`) : error));
    socket.once('connect', () => {
      socket.removeAllListeners('error').on('error', () => undefined);
      resolve(socket);
    });
  });
}

/** Opens a connection and says hello. */
async function dial(file: string, role: Hello['role'], version: string, handle?: ConstructorParameters<typeof Peer>[0]['handle'], notified?: ConstructorParameters<typeof Peer>[0]['notified']) {
  const socket = await connect(file);
  const peer = new Peer({ input: linesOf(socket), output: socket, handle, notified });
  const gone = new Promise<void>((resolve) => socket.once('close', () => (peer.fail(new Error('The keyholder went away.')), resolve())));
  const { username } = os.userInfo();
  const { version: keyholder } = await peer.request<{ version: string }>('hello', { role, version, uid: process.getuid?.() ?? -1, user: username, home: os.homedir() } satisfies Hello).catch((error: unknown) => (socket.destroy(), Promise.reject(error)));
  return { peer, socket, gone, version: keyholder };
}

/** What a command asks of the keyholder, in one connection. */
export async function callRoom<T = { text: string }>(file: string, method: string, params: object, version: string) {
  const { peer, socket } = await dial(file, 'cli', version);
  try {
    return await peer.request<T>(method, params);
  } finally {
    socket.destroy();
  }
}

/**
 * What the root-owned updater asks: the keyholder's version and what runs, or undefined when nothing
 * answers. Its hello skips the version check, since the updater meets a keyholder of another version
 * by design, and may ask only `busy` (docs/decisions/agent-self-update.md).
 */
export async function askUpdater(file: string) {
  try {
    const { peer, socket, version } = await dial(file, 'updater', '');
    try {
      return { version, busy: strings((await peer.request<{ busy: unknown }>('busy', {})).busy, 100) };
    } finally {
      socket.destroy();
    }
  } catch {
    return undefined;
  }
}

interface Turn {
  progress?: (sentence: string) => void;
  permit?: Permit;
  /** The screenshots the runner was let put, by transfer id: the file each lands in (R-046). */
  uploads: Map<string, string>;
}

/** The keyholder's end: the socket, and the one runner that holds it. */
export class Room {
  private server?: net.Server;
  /** The runner that said hello first: a second is refused while this one is open. */
  runner?: { peer: Peer; gone: AbortController; hello: Hello };
  private readonly waiting: Array<(signal: AbortSignal) => void> = [];
  private readonly transfers = new Map<string, { file: string; op: 'get' | 'put'; at: number; max: number }>();
  readonly turns = new Map<string, Turn>();
  readonly bench = new SocketBench(this);
  private handlers?: Handlers;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly options: { version: string; transferMs?: number }) {}

  /** Resolves with a signal that aborts when the runner goes, once one is connected. */
  up() {
    return this.runner ? Promise.resolve(this.runner.gone.signal) : new Promise<AbortSignal>((resolve) => this.waiting.push(resolve));
  }

  async listen(file: string, handlers: Handlers) {
    this.handlers = handlers;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // A socket nobody answers is stale; one that answers is another keyholder, which this must not unseat.
    if (await connect(file).then((s) => (s.destroy(), true), () => false)) throw new Error(`Another keyholder already listens on ${file}.`);
    await fs.rm(file, { force: true });
    this.server = net.createServer((socket) => void this.accept(socket));
    await new Promise<void>((resolve, reject) => this.server!.once('error', reject).listen(file, resolve));
    // The folder's mode and group decide who may connect; the owner's own processes can, which is why nothing here is trusted.
    await fs.chmod(file, 0o770);
  }

  close() {
    this.server?.close();
    this.sockets.forEach((socket) => socket.destroy());
  }

  /** Lets one side connection fetch or put `file`, once, soon, and put at most `max` bytes. */
  transfer(file: string, op: 'get' | 'put', max = BUNDLE_MAX) {
    const now = Date.now();
    for (const [id, t] of this.transfers) if (now - t.at > (this.options.transferMs ?? TRANSFER_MS)) this.transfers.delete(id);
    const id = randomBytes(16).toString('hex');
    this.transfers.set(id, { file, op, at: now, max });
    return id;
  }

  private async accept(socket: net.Socket) {
    socket.on('error', () => undefined);
    this.sockets.add(socket.once('close', () => this.sockets.delete(socket)));
    const first = await head(socket);
    if (!first) return;
    const header = (() => {
      try {
        return record(JSON.parse(first.line));
      } catch {
        return {};
      }
    })();
    if (typeof header.transfer === 'string') return this.side(socket, header, first.rest);
    // Back into the stream, whole, for the `Peer`.
    socket.unshift(first.all);
    this.serve(socket);
  }

  /** A side connection: the bytes of one bundle, either way. An id is good once, for 10 minutes. */
  private side(socket: net.Socket, header: Record<string, unknown>, rest: Buffer) {
    const id = String(header.transfer);
    const t = this.transfers.get(id);
    this.transfers.delete(id);
    if (!t || t.op !== header.op || Date.now() - t.at > (this.options.transferMs ?? TRANSFER_MS)) return void socket.destroy();
    if (t.op === 'get') return void pipeline(createReadStream(t.file), socket).catch(() => socket.destroy());
    const size = Number(header.size);
    if (!Number.isInteger(size) || size < 1 || size > t.max) return void socket.destroy();
    // Mode 600, and a file of its own: a bundle is the owner's work, not for other accounts.
    const out = createWriteStream(t.file, { mode: 0o600 }).on('error', () => socket.destroy());
    let got = 0;
    const fail = () => (socket.destroy(), out.once('close', () => void fs.rm(t.file, { force: true })), out.destroy());
    const take = (chunk: Buffer) => {
      got += chunk.length;
      if (got > size) return fail();
      // Waits for the disk, so a bundle of up to 512 MiB never sits whole in memory.
      if (!out.write(chunk)) {
        socket.pause();
        out.once('drain', () => socket.resume());
      }
      if (got === size) {
        socket.off('data', take);
        out.end(() => socket.end('ok\n'));
      }
    };
    // `head` paused it.
    socket.on('data', take).once('close', () => got < size && fail()).resume();
    if (rest.length) take(rest);
  }

  private serve(socket: net.Socket) {
    let role: Hello['role'] | undefined;
    let mine: NonNullable<Room['runner']> | undefined;
    const peer = new Peer({
      input: linesOf(socket),
      output: socket,
      handle: async (method, params) => {
        if (method === 'hello') return this.hello(peer, record(params), (r, m) => ((role = r), (mine = m)));
        if (role === 'runner') return this.fromRunner(method, record(params));
        if (role === 'cli') return this.fromCli(method, record(params));
        if (role === 'updater') return this.fromUpdater(method);
        throw new RpcError(FIRST, 'Say hello first.');
      },
      notified: (method, params) => {
        const { id, sentence } = record(params);
        if (role === 'runner' && method === 'progress') this.turns.get(String(id))?.progress?.(text(sentence, 500) ?? '');
      },
    });
    socket.once('close', () => {
      if (!mine || this.runner !== mine) return;
      this.runner = undefined;
      // Fails the turns and requests waiting on it, which settles what they left open.
      peer.fail(new Error('The runner went away.'));
      mine.gone.abort();
    });
  }

  private hello(peer: Peer, params: Record<string, unknown>, set: (role: Hello['role'], runner?: NonNullable<Room['runner']>) => void) {
    const { role, version, uid, user, home } = params;
    if (role !== 'runner' && role !== 'cli' && role !== 'updater') throw new RpcError(FIRST, 'Say who you are.');
    if (role !== 'updater' && version !== this.options.version) throw new RpcError(VERSION, `The keyholder is version ${this.options.version} and you are ${String(version)}. Update the older one.`);
    if (role === 'runner') {
      if (this.runner) throw new RpcError(BUSY, 'Another runner is connected.');
      const gone = new AbortController();
      const runner = { peer, gone, hello: { role: 'runner' as const, version: this.options.version, uid: Number(uid), user: text(user, 100) ?? '', home: text(home, 1000) ?? '' } };
      this.runner = runner;
      set(role, runner);
      for (const resolve of this.waiting.splice(0)) resolve(gone.signal);
    } else set(role);
    return { version: this.options.version };
  }

  private async fromRunner(method: string, params: Record<string, unknown>) {
    const turn = this.turns.get(String(params.id));
    // A screenshot comes as bytes on a side connection, then as a `shot` that names it, for a live turn only (R-046).
    if (method === 'upload' && turn?.permit?.shot) {
      const file = path.join(os.tmpdir(), `webchat-shot-${randomUUID()}`);
      const transfer = this.transfer(file, 'put', LIMITS.fileBytes);
      turn.uploads.set(transfer, file);
      return { transfer };
    }
    if (method === 'shot' && turn?.permit?.shot) {
      const file = turn.uploads.get(String(params.transfer));
      if (!file) throw mismatch();
      turn.uploads.delete(String(params.transfer));
      const png = await fs.readFile(file).finally(() => fs.rm(file, { force: true }));
      return turn.permit.shot(new Uint8Array(png), text(params.caption) ?? '');
    }
    if (method !== 'approve' || !turn?.permit) throw new RpcError(-32601, `The runner may not ask ${method} now.`);
    const ask = record(params.ask);
    if (!KINDS.includes(String(ask.kind)) || typeof ask.detail !== 'string') throw mismatch();
    return turn.permit.ask({ ...(typeof ask.tool === 'string' && { tool: ask.tool.slice(0, 200) }), kind: ask.kind as Ask['kind'], paths: strings(ask.paths, 100), detail: ask.detail });
  }

  private async fromUpdater(method: string) {
    if (method !== 'busy') throw new RpcError(-32601, `The updater may ask only busy, not ${method}.`);
    return { busy: await this.handlers!.working() };
  }

  private async fromCli(method: string, params: Record<string, unknown>) {
    const handlers = this.handlers!;
    switch (method) {
      case 'request': {
        const { kind, harness, repo, dir, file, text: card } = params;
        if (kind === 'card') {
          if (typeof repo !== 'string' || !isRepoName(repo) || typeof file !== 'string' || !/^docs\/(roadmap|decisions)\/[^/]+\.md$/.test(file) || typeof card !== 'string') throw new Error('Name a repository and a file under docs/roadmap/ or docs/decisions/.');
          return handlers.requestCard(repo, file, card);
        }
        if (kind === 'link') {
          const named = SUPPORTED.find((s) => s.name === harness);
          if (!named) throw new Error('That is no harness WebChat supports.');
          return { text: await handlers.requestLink(named.name) };
        }
        // Only the names are taken; the keyholder asks the runner about the folder again before it asks the owner.
        if (kind !== 'connect' || typeof repo !== 'string' || !isRepoName(repo) || typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Name a repository and the folder it is in.');
        return { text: await handlers.requestConnect(dir, repo) };
      }
      case 'sleep':
        return { text: await handlers.goToSleep() };
      case 'wake':
        return { text: await handlers.wake() };
      case 'status':
        return { ...(await handlers.status()), runner: !!this.runner };
      default:
        throw new RpcError(-32601, `Unknown command ${method}.`);
    }
  }
}

/** The keyholder's view of the owner's folders: what `LocalBench` does, asked of the runner and checked on the way back. */
export class SocketBench implements Bench {
  constructor(private readonly room: Room) {}

  private call<T = unknown>(method: string, params: object) {
    const runner = this.room.runner;
    if (!runner) return Promise.reject(new Error(NO_RUNNER));
    return runner.peer.request<T>(method, params);
  }

  async harnesses() {
    const list = await this.call<unknown>('harnesses', {});
    if (!Array.isArray(list)) throw mismatch();
    // A name that is not on the supported list is not one.
    return list.flatMap((value): HarnessInfo[] => {
      const h = record(value);
      const offers = record(h.offers);
      if (!SUPPORTED.some((s) => s.name === h.name)) return [];
      return [{ name: h.name as string, path: text(h.path, 1000), version: text(h.version, 100), signedIn: typeof h.signedIn === 'boolean' ? h.signedIn : undefined, offers: { instructions: text(offers.instructions, 1000), skills: text(offers.skills, 1000), knobs: strings(offers.knobs, 20) }, asks: h.asks === true, commits: h.commits !== false, ...(typeof h.warning === 'string' && { warning: h.warning.slice(0, 1000) }) }];
    });
  }

  async refusal(harness: string) {
    return text(await this.call('refusal', { harness })) ?? undefined;
  }

  async apply(choice: SetupChoice) {
    await this.call('apply', { choice });
  }

  async ownerSetup() {
    const { claudeMd, skills } = record(await this.call('ownerSetup', {}));
    if (typeof claudeMd !== 'boolean' || !Array.isArray(skills)) throw mismatch();
    return {
      claudeMd,
      skills: skills.slice(0, LIMITS.setupSkills).flatMap((value) => {
        const { name, description } = record(value);
        return typeof name === 'string' && SKILL_NAME.test(name) ? [{ name, description: text(description, LIMITS.skillDescriptionLength) ?? '' }] : [];
      }),
    };
  }

  async folders(marks: Array<{ repo: string; dir: string }>) {
    const found = await this.call<unknown>('folders', { marks });
    if (!Array.isArray(found)) throw mismatch();
    // Only a folder that was asked about, under the repository it was marked with.
    return found.flatMap((value): Folder[] => {
      const { repo, dir, origin } = record(value);
      const asked = marks.some((m) => m.dir === dir && m.repo.toLowerCase() === String(repo).toLowerCase());
      return asked && typeof repo === 'string' && isRepoName(repo) && typeof dir === 'string' ? [{ repo, dir, origin: text(origin, 1000) ?? '' }] : [];
    });
  }

  async checkout(dir: string) {
    const { exists, repo } = record(await this.call('checkout', { dir }));
    if (typeof exists !== 'boolean' || (repo !== null && !(typeof repo === 'string' && isRepoName(repo)))) throw mismatch();
    return { exists, repo };
  }

  /** Sends a bundle of the keyholder's, which the runner fetches by the id it is given. */
  private async sent(file: string, send: (transfer: string) => Promise<unknown>) {
    await send(this.room.transfer(file, 'get')).catch((error: unknown) => {
      throw error instanceof RpcError && error.code === PREREQUISITES ? new PrerequisitesMissing() : error;
    });
  }

  take(dir: string, file: string, base: string) {
    return this.sent(file, (transfer) => this.call('take', { dir, transfer, base }));
  }

  clone(dir: string, repo: string, file: string, base: string) {
    return this.sent(file, (transfer) => this.call('clone', { dir, repo, transfer, base }));
  }

  async prepare(job: { dir: string; slug: string; taken: string[]; tip: string }) {
    const { branch, worktree } = record(await this.call('prepare', job));
    const runs = path.join(job.dir, '.claude', 'worktrees') + path.sep;
    const rest = typeof branch === 'string' && branch.startsWith(`agent/${job.slug}`) ? branch.slice(`agent/${job.slug}`.length) : undefined;
    if (rest === undefined || !/^(-\d+)?$/.test(rest) || job.taken.includes(branch as string)) throw mismatch();
    if (typeof worktree !== 'string' || !worktree.startsWith(runs) || path.resolve(worktree) !== worktree) throw mismatch();
    return { branch: branch as string, worktree };
  }

  async reopen(job: { dir: string; worktree: string; branch: string }) {
    await this.call('reopen', job);
  }

  async commit(job: { worktree: string; message: string; allowEmpty?: true; leftovers?: true }) {
    const head = await this.call<unknown>('commit', job);
    if (typeof head !== 'string' || !SHA.test(head)) throw mismatch();
    return head;
  }

  async bundle({ file, ...job }: { worktree: string; branch: string; since: string; file: string }) {
    const made = record(await this.call('bundle', { ...job, transfer: this.room.transfer(file, 'put') }));
    if (made.empty === true) return;
    // The bytes are checked against these, and the bundle by `Keep`, before anything is pushed.
    const { head, bytes, sha256 } = made;
    if (typeof head !== 'string' || !SHA.test(head) || !Number.isInteger(bytes) || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw mismatch();
    return { head, bytes: bytes as number, sha256 };
  }

  async scratch(job: { scratch?: string; dir?: string; base?: string; tip?: string; fetched?: string }) {
    const { scratch, fetched } = record(await this.call('scratch', job));
    if (typeof scratch !== 'string' || !path.isAbsolute(scratch) || (fetched !== undefined && typeof fetched !== 'string')) throw mismatch();
    return { scratch, fetched };
  }

  async drop(scratch: string) {
    await this.call('drop', { scratch });
  }

  async turn(job: TurnJob, { signal, progress, permit }: Parameters<Bench['turn']>[1]) {
    const id = randomUUID();
    const asked = permit?.();
    // Before the request goes, so no line the runner sends for it comes first.
    this.room.turns.set(id, { progress, permit: asked, uploads: new Map() });
    const cancel = () => this.room.runner?.peer.notify('cancel', { id });
    signal.aborted ? cancel() : signal.addEventListener('abort', cancel, { once: true });
    try {
      const { answer, applied } = record(await this.call('turn', { ...job, id, asks: !!asked }));
      const misfit = fits(job.schema, answer);
      const { claudeMd, skills, noAttribution } = record(applied);
      if (misfit || typeof claudeMd !== 'boolean' || typeof noAttribution !== 'boolean') throw new Error(`The runner's answer does not fit: ${misfit ?? 'what it loaded'}.`);
      return { answer, applied: { claudeMd, skills: strings(skills, LIMITS.setupSkills).filter((n) => SKILL_NAME.test(n)), noAttribution } };
    } finally {
      signal.removeEventListener('abort', cancel);
      for (const file of this.room.turns.get(id)!.uploads.values()) await fs.rm(file, { force: true });
      this.room.turns.delete(id);
      asked?.done();
    }
  }

  async end(session?: string) {
    // Nothing runs when no runner does.
    if (this.room.runner) await this.call('end', { session });
  }
}

/** The runner's end: serves what the keyholder asks with a `LocalBench`, and asks it for the owner's answers. */
export async function connectRunner({ file, bench, version }: { file: string; bench: LocalBench; version: string }) {
  const turns = new Map<string, AbortController>();
  /** A bundle of the keyholder's, in a folder of its own that goes afterwards. */
  const fetched = async (transfer: string, use: (bundle: string) => Promise<unknown>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-transfer-'));
    try {
      const bundle = path.join(dir, 'in.bundle');
      const socket = await connect(file);
      socket.write(`${JSON.stringify({ transfer, op: 'get' })}\n`);
      await pipeline(socket, createWriteStream(bundle, { mode: 0o600 }));
      if (!(await fs.stat(bundle)).size) throw new Error('The keyholder would not send the bundle.');
      await use(bundle);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
  /** Puts bytes on a side connection, under a transfer id the keyholder gave, and waits for its `ok`. */
  const put = async (transfer: unknown, size: number, bytes: NodeJS.ReadableStream) => {
    const socket = await connect(file);
    socket.write(`${JSON.stringify({ transfer, op: 'put', size })}\n`);
    const answered = new Promise<string>((resolve, reject) => socket.once('data', (d: Buffer) => resolve(d.toString())).once('close', () => reject(new Error('The keyholder did not take the bytes.'))));
    await pipeline(bytes, socket, { end: false });
    if ((await answered).trim() !== 'ok') throw new Error('The keyholder did not take the bytes.');
    socket.destroy();
  };
  const { peer, gone, socket } = await dial(
    file,
    'runner',
    version,
    async (method, p) => {
      const params = record(p);
      switch (method) {
        case 'harnesses':
          return bench.harnesses();
        case 'refusal':
          return bench.refusal(String(params.harness));
        case 'apply':
          return bench.apply(params.choice as SetupChoice);
        case 'ownerSetup':
          return bench.ownerSetup();
        case 'folders':
          return bench.folders(params.marks as Array<{ repo: string; dir: string }>);
        case 'checkout':
          return bench.checkout(String(params.dir));
        case 'take':
        case 'clone':
          return fetched(String(params.transfer), async (bundle) => {
            try {
              if (method === 'take') await bench.take(String(params.dir), bundle, String(params.base));
              else await bench.clone(String(params.dir), String(params.repo), bundle, String(params.base));
            } catch (error) {
              throw error instanceof PrerequisitesMissing ? new RpcError(PREREQUISITES, error.message) : error;
            }
          });
        case 'prepare':
          return bench.prepare(params as Parameters<Bench['prepare']>[0]);
        case 'reopen':
          return bench.reopen(params as Parameters<Bench['reopen']>[0]);
        case 'commit':
          return bench.commit(params as Parameters<Bench['commit']>[0]);
        case 'bundle': {
          const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-transfer-'));
          try {
            const file_ = path.join(dir, 'out.bundle');
            const made = await bench.bundle({ worktree: String(params.worktree), branch: String(params.branch), since: String(params.since), file: file_ });
            if (!made) return { empty: true };
            await put(params.transfer, made.bytes, createReadStream(file_));
            return made;
          } finally {
            await fs.rm(dir, { recursive: true, force: true });
          }
        }
        case 'scratch':
          return bench.scratch(params);
        case 'drop':
          return bench.drop(String(params.scratch));
        case 'turn': {
          // Registered before anything awaits, so a cancel that arrives in the same read finds it.
          const id = String(params.id);
          const controller = new AbortController();
          turns.set(id, controller);
          const permit = params.asks
            ? () => {
                const quiet = new Quiet();
                const shot = async (png: Uint8Array<ArrayBuffer>, caption: string) => {
                  const { transfer } = record(await peer.request('upload', { id }));
                  await put(transfer, png.length, Readable.from([png]));
                  return String(await peer.request('shot', { id, transfer, caption }));
                };
                return { quiet, ask: (ask: Ask) => quiet.during(peer.request<Reply>('approve', { id, ask })), done: () => undefined, shot };
              }
            : undefined;
          try {
            return await bench.turn(params as unknown as TurnJob, { signal: controller.signal, progress: (sentence) => peer.notify('progress', { id, sentence }), permit });
          } finally {
            turns.delete(id);
          }
        }
        case 'end':
          return bench.end(params.session as string | undefined);
        default:
          throw new RpcError(-32601, `Unknown method ${method}.`);
      }
    },
    (method, p) => {
      if (method === 'cancel') turns.get(String(record(p).id))?.abort();
    },
  );
  // A keyholder that is gone ends its turns: nobody is left to push what they make.
  void gone.then(() => turns.forEach((c) => c.abort()));
  return { closed: gone, close: () => socket.destroy() };
}

/**
 * Connects, and again every 5 seconds after the keyholder goes or refuses, until `signal` aborts.
 * Returns `stale` when the keyholder refuses this version and `changed` says the program's own file
 * was replaced: the login service then starts the new file, which a loop here never would.
 */
export async function runRunner(options: Parameters<typeof connectRunner>[0] & { signal?: AbortSignal; say?: (message: string) => void; changed?: () => boolean }) {
  while (!options.signal?.aborted) {
    try {
      await (await connectRunner(options)).closed;
    } catch (error) {
      if (error instanceof RpcError && error.code === VERSION && options.changed?.()) return 'stale';
      options.say?.(error instanceof Error ? error.message : String(error));
    }
    await sleep(RETRY_MS, undefined, { signal: options.signal }).catch(() => undefined);
  }
}
