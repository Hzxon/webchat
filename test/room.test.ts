// The socket between the keyholder and the runner (docs/decisions/locked-room.md), over a temporary
// socket: an in-process keyholder and runner, as `dev` runs them.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { LocalBench, PrerequisitesMissing, type Permit } from '../agent/bench.ts';
import type { Ask, Harness, Turn } from '../agent/harness.ts';
import { Quiet } from '../agent/runner.ts';
import { callRoom, connectRunner, LINE_MAX, Room, type Handlers } from '../agent/room.ts';

const sh = promisify(execFile);
const VERSION = '1.2.3';
const SCHEMA = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything a connection sends and gets, for the checks on what crosses. */
async function recorder(to: string, file: string) {
  const seen: Buffer[] = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(to);
    for (const s of [client, upstream]) s.on('error', () => undefined).on('data', (d: Buffer) => seen.push(d));
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(file, resolve));
  return { server, all: () => Buffer.concat(seen) };
}

/** What a socket answers to what it is sent, up to its close; a number is a pause in milliseconds. */
function talk(file: string, ...writes: Array<Buffer | string | number>) {
  return new Promise<Buffer>((resolve) => {
    const socket = net.connect(file);
    const got: Buffer[] = [];
    socket.on('error', () => undefined).on('data', (d: Buffer) => got.push(d)).on('close', () => resolve(Buffer.concat(got)));
    socket.on('connect', async () => {
      for (const w of writes) await (typeof w === 'number' ? wait(w) : new Promise((done) => socket.write(w, done)));
      setTimeout(() => socket.end(), 300).unref();
    });
  });
}

describe('the room', () => {
  let root: string;
  let file: string;
  let room: Room;
  let keys: string;
  let calls: string[];
  let closers: Array<() => void>;
  /** What the fake harness does in its turn. */
  let work: (turn: Turn) => Promise<unknown>;
  const handlers: Handlers = {
    call: async (name) => (calls.push(name), `${name} done`),
    requestLink: async (harness) => (calls.push(`link ${harness}`), `Asked to link ${harness}.`),
    requestConnect: async (dir, repo) => (calls.push(`connect ${repo} ${dir}`), `Asked to connect ${repo}.`),
  };
  const harness = {
    name: 'Claude Code',
    asks: true,
    commits: true,
    refusal: async () => undefined,
    offers: () => ({ knobs: ['noAttribution'] }),
    found: async () => ({ path: '/usr/bin/claude', version: '2.1.0', signedIn: true }),
    apply: async () => undefined,
    turn: (turn: Turn) => work(turn),
    end: async () => undefined,
  } as unknown as Harness;
  const job = (cwd: string, schema: object = SCHEMA) => ({ harness: 'Claude Code', cwd, session: 's-1', resume: false, message: 'Do the card. canary-message', schema, schemas: [schema], setup: { claudeMd: false, skills: [], noAttribution: false } });
  const run = (bench: Room['bench'], cwd: string, permit?: () => Permit, schema?: object) => bench.turn(job(cwd, schema), { signal: new AbortController().signal, permit });
  const runner = async (to = file) => {
    const connected = await connectRunner({ file: to, bench: new LocalBench([harness], undefined, keys), version: VERSION });
    closers.push(connected.close);
    return connected;
  };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-room-')));
    keys = path.join(root, 'keys');
    await fs.mkdir(keys);
    file = path.join(root, 'k.sock');
    calls = [];
    closers = [];
    work = async () => ({ note: 'done' });
    room = new Room({ version: VERSION, transferMs: 200 });
    await room.listen(file, handlers);
  });
  afterEach(async () => {
    closers.forEach((close) => close());
    room.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test('says hello, and checks the harnesses it reports against the supported list', async () => {
    const waiting = room.up();
    await runner();
    assert.ok((await waiting).aborted === false);
    assert.equal(room.runner?.hello.home, os.homedir());
    assert.deepEqual(await room.bench.harnesses(), [{ name: 'Claude Code', path: '/usr/bin/claude', version: '2.1.0', signedIn: true, offers: { instructions: undefined, skills: undefined, knobs: ['noAttribution'] }, asks: true, commits: true }]);
    const other = { ...harness, name: 'Not supported' } as Harness;
    closers.pop()!();
    await wait(50);
    closers.push((await connectRunner({ file, bench: new LocalBench([harness, other]), version: VERSION })).close);
    assert.deepEqual((await room.bench.harnesses()).map((h) => h.name), ['Claude Code'], 'a name WebChat does not support is not one');
  });

  test('refuses a second runner while the first is open, and a runner of another version', async () => {
    await runner();
    await assert.rejects(runner(), /Another runner is connected/);
    closers.pop()!();
    await assert.rejects(connectRunner({ file, bench: new LocalBench([]), version: '9.9.9' }), /version/);
    // The first one dropped, so the next may come.
    await wait(50);
    await runner();
    assert.ok(room.runner);
  });

  test('fails at once while no runner is connected', async () => {
    await assert.rejects(room.bench.harnesses(), /not started the part of this agent/);
  });

  test('runs a turn: progress comes back, the rulebook answers here, and only the rest reaches the keyholder', async () => {
    const work_ = path.join(root, 'work');
    await fs.mkdir(work_);
    const sentences: string[] = [];
    const asked: Ask[] = [];
    work = async (turn) => {
      turn.progress?.('Reading');
      const replies = await Promise.all([
        turn.ask!({ tool: 'Read', kind: 'read', paths: ['/elsewhere/x'], detail: 'Read /elsewhere/x' }),
        turn.ask!({ tool: 'Read', kind: 'read', paths: [path.join(work_, 'a.js')], detail: 'Read a.js' }),
      ]);
      assert.deepEqual(replies.map((r) => r.allow), [false, true]);
      return { note: 'done' };
    };
    await runner();
    const permit = () => ({ ask: async (ask: Ask) => (asked.push(ask), { allow: true as const }), quiet: new Quiet(), done: () => calls.push('done') });
    const result = await room.bench.turn(job(work_), { signal: new AbortController().signal, progress: (s) => sentences.push(s), permit });
    assert.deepEqual(result, { answer: { note: 'done' }, applied: { claudeMd: false, skills: [], noAttribution: false } });
    assert.deepEqual(sentences, ['Reading']);
    assert.deepEqual(asked, [{ tool: 'Read', kind: 'read', paths: [path.join(work_, 'a.js')], detail: 'Read a.js' }]);
    assert.deepEqual(calls, ['done'], 'the permit is done once the turn ends');
    assert.equal(room.turns.size, 0);
  });

  test('refuses an answer that does not fit its schema', async () => {
    work = async () => ({ note: 7 });
    await runner();
    await assert.rejects(run(room.bench, root), /does not fit/);
  });

  test('a cancel reaches the turn, and a runner that drops fails it', async () => {
    let aborted = false;
    work = (turn) => new Promise(() => turn.signal.addEventListener('abort', () => (aborted = true)));
    const first = await runner();
    const controller = new AbortController();
    const cancelled = room.bench.turn(job(root), { signal: controller.signal });
    await wait(100);
    controller.abort();
    await wait(100);
    assert.ok(aborted, 'the harness is told to stop');
    first.close();
    await assert.rejects(cancelled, /runner went away/);

    work = () => new Promise(() => undefined);
    const gone = room.up();
    await runner();
    const signal = await gone;
    const turn = run(room.bench, root);
    await wait(100);
    closers.pop()!();
    await assert.rejects(turn, /runner went away/);
    assert.ok(signal.aborted, 'what waits on the runner learns it is gone');
  });

  test('the command line asks through the socket: connect, link, sleep, wake and status', async () => {
    assert.deepEqual(await callRoom(file, 'request', { kind: 'connect', repo: 'acme/app', dir: '/home/o/app' }, VERSION), { text: 'Asked to connect acme/app.' });
    assert.deepEqual(await callRoom(file, 'request', { kind: 'link', harness: 'Codex' }, VERSION), { text: 'Asked to link Codex.' });
    assert.deepEqual(await callRoom(file, 'sleep', {}, VERSION), { text: 'sleep done' });
    assert.deepEqual(await callRoom(file, 'wake', {}, VERSION), { text: 'wake done' });
    assert.deepEqual(await callRoom(file, 'status', {}, VERSION), { text: 'status done', runner: false });
    assert.deepEqual(calls, ['connect acme/app /home/o/app', 'link Codex', 'sleep', 'wake', 'status']);
    for (const bad of [{ kind: 'link', harness: 'Mystery' }, { kind: 'connect', repo: 'not a repo', dir: '/x' }, { kind: 'connect', repo: 'acme/app', dir: 'relative' }, { kind: 'other' }]) {
      await assert.rejects(callRoom(file, 'request', bad, VERSION), /./, JSON.stringify(bad));
    }
    await assert.rejects(callRoom(file, 'turn', {}, VERSION), /Unknown command/);
    assert.equal(calls.length, 5, 'what was refused did nothing');
  });

  test('a command may not use a runner\'s calls, and nobody speaks before hello, though lines come in one read', async () => {
    await runner();
    const turnId = 'x';
    room.turns.set(turnId, { permit: { ask: async () => ({ allow: true }), quiet: new Quiet(), done: () => undefined } });
    const line = (id: number, method: string, params: object) => `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    const ask = { id: turnId, ask: { kind: 'read', paths: [], detail: 'x' } };
    // As a command: approve is refused. Before hello: everything is. Both, and hello's answer, in one write.
    const hello = { role: 'cli', version: VERSION, uid: 1, user: 'u', home: '/h' };
    const answers = (await talk(file, line(1, 'approve', ask) + line(2, 'hello', hello) + line(3, 'approve', ask) + line(4, 'sleep', {}))).toString().trim().split('\n').map((l) => JSON.parse(l) as { id: number; result?: unknown; error?: { message: string } });
    assert.match(answers[0]!.error!.message, /hello first/);
    assert.deepEqual(answers[1]!.result, { version: VERSION });
    assert.match(answers[2]!.error!.message, /Unknown/, 'a command is no runner');
    assert.deepEqual(answers[3]!.result, { text: 'sleep done' });
  });

  test('cuts a line that passes the cap, and goes on serving', async () => {
    const closed = await talk(file, Buffer.alloc(LINE_MAX + 1024, 97));
    assert.equal(closed.length, 0);
    // Past the cap after a first line too.
    const second = await talk(file, `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { role: 'cli', version: VERSION } })}\n`, 100, Buffer.alloc(LINE_MAX + 1024, 97));
    assert.match(second.toString(), /"version":"1.2.3"/);
    assert.deepEqual(await callRoom(file, 'sleep', {}, VERSION), { text: 'sleep done' });
  });

  test('a transfer is good once, for a little while, and a bundle comes in at mode 600 and no larger than it said', async () => {
    const source = path.join(root, 'out.bundle');
    await fs.writeFile(source, 'bundle bytes');
    const get = (id: string) => talk(file, `${JSON.stringify({ transfer: id, op: 'get' })}\n`);
    const id = room.transfer(source, 'get');
    assert.equal((await get(id)).toString(), 'bundle bytes');
    assert.equal((await get(id)).length, 0, 'used twice');
    const late = room.transfer(source, 'get');
    await wait(300);
    assert.equal((await get(late)).length, 0, 'too late');
    assert.equal((await get('0'.repeat(32))).length, 0, 'never minted');
    assert.equal((await talk(file, `${JSON.stringify({ transfer: room.transfer(source, 'put'), op: 'get' })}\n`)).length, 0, 'the other way round');

    const into = path.join(root, 'in.bundle');
    const put = (id: string, size: number, body: string) => talk(file, `${JSON.stringify({ transfer: id, op: 'put', size })}\n${body}`);
    assert.equal((await put(room.transfer(into, 'put'), 5, 'hello')).toString(), 'ok\n');
    assert.equal(await fs.readFile(into, 'utf8'), 'hello');
    assert.equal((await fs.stat(into)).mode & 0o777, 0o600);
    const over = path.join(root, 'over.bundle');
    assert.equal((await put(room.transfer(over, 'put'), 3, 'hello')).length, 0, 'more than it said');
    await wait(50);
    assert.equal(await fs.stat(over).then(() => true, () => false), false, 'and nothing is left of it');
  });

  describe('with git', () => {
    const git = (dir: string, ...args: string[]) => sh('git', ['-C', dir, ...args]).then((r) => r.stdout.trim());
    const env = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' };
    const was = Object.keys(env).map((k) => process.env[k]);
    beforeEach(() => Object.assign(process.env, env));
    afterEach(() => Object.keys(env).forEach((k, i) => (was[i] === undefined ? delete process.env[k] : (process.env[k] = was[i]))));

    test('crosses as bundles both ways, with the replies checked, and no secret on the wire', async () => {
      const canaries = ['canary-authKey-9f3', 'canary-cookie-77a', 'canary-privatekey-b21', 'ghp_canarytoken0123456789'];
      // What the keyholder keeps, and its environment: the room reads neither, and the recorder shows it.
      await fs.writeFile(path.join(keys, 'account.json'), JSON.stringify({ authKey: canaries[0], cookie: canaries[1], secrets: { privateKey: canaries[2] } }));
      process.env.GH_TOKEN = canaries[3];
      const tap = await recorder(file, path.join(root, 'tap.sock'));
      try {
        await runner(path.join(root, 'tap.sock'));
        const source = path.join(root, 'source');
        await sh('git', ['init', '-q', '-b', 'main', source]);
        await fs.writeFile(path.join(source, 'README.md'), '# App\n');
        await git(source, 'add', '.');
        await git(source, 'commit', '-q', '-m', 'Start');
        const first = await git(source, 'rev-parse', 'main');
        await git(source, 'update-ref', 'refs/remotes/origin/main', 'main');
        const base = path.join(root, 'base.bundle');
        await git(source, 'bundle', 'create', '-q', base, 'refs/remotes/origin/main');

        const dir = path.join(root, 'checkout');
        await room.bench.clone(dir, 'acme/app', base, 'origin/main');
        assert.equal(await git(dir, 'rev-parse', 'HEAD'), first);
        assert.deepEqual(await room.bench.checkout(dir), { exists: true, repo: 'acme/app' });
        assert.deepEqual(await room.bench.folders([{ repo: 'ACME/app', dir }, { repo: 'acme/other', dir }]), [{ repo: 'acme/app', dir, origin: 'https://github.com/acme/app.git' }], 'only a folder asked about, under the name it was marked with');

        await fs.writeFile(path.join(source, 'two.txt'), 'two\n');
        await git(source, 'add', '.');
        await git(source, 'commit', '-q', '-m', 'Two');
        await git(source, 'update-ref', 'refs/remotes/origin/main', 'main');
        const next = path.join(root, 'next.bundle');
        await git(source, 'bundle', 'create', '-q', next, 'refs/remotes/origin/main', `^${first}`);
        const other = path.join(root, 'other');
        await sh('git', ['init', '-q', '-b', 'main', other]);
        await assert.rejects(room.bench.take(other, next, 'origin/main'), PrerequisitesMissing);
        await room.bench.take(dir, next, 'origin/main');
        const tip = await git(dir, 'rev-parse', 'origin/main');

        const { branch, worktree } = await room.bench.prepare({ dir, slug: 'k-7', taken: [], tip });
        assert.equal(branch, 'agent/k-7');
        const head = await room.bench.commit({ worktree, message: 'chore: Claim K-7', allowEmpty: true });
        const out = path.join(root, 'work.bundle');
        const made = await room.bench.bundle({ worktree, branch, since: tip, file: out });
        assert.equal(made?.head, head);
        assert.equal((await fs.stat(out)).size, made?.bytes);
        assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
        assert.equal(await room.bench.bundle({ worktree, branch, since: head, file: path.join(root, 'none.bundle') }), undefined, 'nothing new');

        // A turn with the card's text goes through the same recorder.
        await run(room.bench, worktree);
        const seen = tap.all();
        assert.ok(seen.includes('canary-message'), 'the recorder sees the turn');
        assert.ok(seen.includes('"method":"bundle"'), 'and the requests');
        for (const canary of canaries) assert.equal(seen.includes(canary), false, `${canary} crossed`);
      } finally {
        delete process.env.GH_TOKEN;
        tap.server.close();
      }
    });
  });
});
