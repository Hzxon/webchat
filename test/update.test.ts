// The root-owned updater (docs/decisions/agent-self-update.md) against a fake server and a fake
// release folder on this machine, a real keyholder `Room` on a temporary socket, and a root that runs
// the `sh` plans for real in a temporary folder. Nothing here needs root. The same swap on a real
// system service is in test/room.real.test.ts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { programOf, socketOf, stagedOf, unitText, updateConfigOf, type Cmd } from '../agent/lockroom.ts';
import { askUpdater, Room, type Handlers } from '../agent/room.ts';
import { compareReleases, describeState, readConfig, readState, readSum, tick } from '../agent/update.ts';
import { AGENT_RELEASES } from '../shared/types.ts';
import { scriptRoot, testLayout } from './fakeRoom.ts';

const sh = promisify(execFile);
const ARCH = 'x64';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** A program that prints its version, as the real one does for `--version`. */
const program = (version: string) => `#!/bin/sh\ntest "$1" = --version && echo ${version}\n`;

describe('the updater', () => {
  let dir: string;
  const layout = () => testLayout(dir);
  let release: string;
  let busy: string[];
  /** Whether the keyholder started again after its restart. */
  let starts: boolean;
  let room: Room | undefined;
  let server: http.Server;
  let files: Map<string, Buffer | string | number>;
  let requests: string[];
  let log: Cmd[];
  let root: ReturnType<typeof scriptRoot>['root'];

  const installed = async () => (await sh(programOf(layout()), ['--version'])).stdout.trim();
  /** The keyholder, at the version of the program file, as launchd would start it. */
  const keyholder = async () => {
    room?.close();
    room = undefined;
    if (!starts) return;
    room = new Room({ version: await installed() });
    await room.listen(socketOf(layout()), { working: async () => busy } as Handlers);
  };
  const publish = (version: string, { content = program(version), sum, status }: { content?: string; sum?: string; status?: number } = {}) => {
    const asset = `webchat-agent-${layout().platform}-${ARCH}.gz`;
    const gz = gzipSync(content);
    const base = `/releases/download/v${version}/${asset}`;
    files.set(base, status ?? gz);
    files.set(`${base}.sha256`, `${sum ?? sha(gz)}  ${asset}\n`);
  };
  /** One check, as the program that is installed now: the updater runs from the file it may replace. */
  const run = async (options: Partial<Parameters<typeof tick>[0]> = {}) => tick({ layout: layout(), root, version: await installed(), arch: ARCH, healthMs: 400, pollMs: 20, ...options });
  const askVersion = async () => (await askUpdater(socketOf(layout())))?.version;
  const words = () => log.map((cmd) => cmd.argv.join(' '));
  const restarts = () => words().filter((line) => /kickstart|systemctl restart/.test(line));
  const downloads = () => requests.filter((url) => url.endsWith('.gz'));

  beforeEach(async () => {
    mock.method(console, 'log', () => undefined);
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-update-')));
    release = '0.9.0';
    busy = [];
    starts = true;
    files = new Map();
    requests = [];
    server = http.createServer((req, res) => {
      requests.push(req.url!);
      if (req.url === '/api/config') return void res.setHeader('content-type', 'application/json').end(JSON.stringify({ vapidPublicKey: '', kdfSalt: '', release }));
      const file = files.get(req.url!);
      if (typeof file === 'number' || file === undefined) return void res.writeHead(file ?? 404).end();
      res.end(file);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const l = layout();
    await fs.mkdir(l.programDir, { recursive: true });
    await fs.writeFile(programOf(l), program('0.9.0'), { mode: 0o755 });
    await fs.writeFile(updateConfigOf(l), JSON.stringify({ server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, releases: `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases/download` }));
    ({ root, log } = scriptRoot(keyholder));
    await keyholder();
  });
  afterEach(async () => {
    room?.close();
    server.close();
    server.closeAllConnections();
    mock.restoreAll();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('moves to the server’s release after the server does, with nobody at the laptop', async () => {
    assert.equal((await run()).outcome, 'current');
    assert.deepEqual(requests, ['/api/config'], 'nothing is downloaded while the release is the running one');
    publish('0.11.0');
    release = '0.11.0';
    const state = await run();
    assert.deepEqual([state.outcome, state.release, state.version], ['updated', '0.11.0', '0.9.0']);
    assert.equal(await installed(), '0.11.0');
    assert.equal(restarts().length, 1);
    assert.equal(await askVersion(), '0.11.0');
    const left = await Promise.all(['.staged', 'webchat-agent.previous'].map((name) => fs.stat(path.join(layout().programDir, name)).then(() => true, () => false)));
    assert.deepEqual(left, [false, false], 'the kept program and the staged file are gone');
    // No password, no terminal, no other account: a check runs as itself.
    assert.ok(log.every((cmd) => !cmd.as && cmd.stdio !== 'tty' && cmd.argv[0] !== 'sudo'));
    assert.deepEqual((await readState(layout()))?.outcome, 'updated');
    assert.equal((await run()).outcome, 'current', 'the next check finds nothing to do');
  });

  test('waits while a card runs, keeps the file it staged, and goes ahead once nothing runs or after a day', async () => {
    publish('0.11.0');
    release = '0.11.0';
    busy = ['K-1'];
    const waiting = await run();
    assert.deepEqual([waiting.outcome, waiting.detail], ['waiting', 'K-1']);
    assert.deepEqual([await installed(), restarts().length, downloads().length], ['0.9.0', 0, 1]);
    assert.ok(await fs.stat(stagedOf(layout(), '0.11.0')));
    assert.equal((await run()).outcome, 'waiting');
    busy = [];
    assert.equal((await run()).outcome, 'updated');
    assert.deepEqual([await installed(), downloads().length], ['0.11.0', 1], 'the staged file was used, not fetched again');

    // A card that never ends cannot hold a release back for ever.
    publish('0.12.0');
    release = '0.12.0';
    busy = ['K-2'];
    assert.equal((await run()).outcome, 'waiting');
    const later = await run({ now: () => Date.now() + 25 * 60 * 60_000 });
    assert.equal(later.outcome, 'updated');
    assert.equal(await installed(), '0.12.0');
  });

  test('refuses a release older than the running one, and one that is not three numbers, before any command is built', async () => {
    release = '0.8.0';
    const older = await run();
    assert.deepEqual([older.outcome, downloads().length, await installed()], ['older', 0, '0.9.0']);
    for (const bad of ['0.10.0; rm -rf /', 'v1.0.0', '1.0', '1.0.0-rc1', '1.0.0\n', '']) {
      release = bad;
      assert.equal((await run()).outcome, 'bad-release', bad);
    }
    assert.deepEqual(requests.filter((url) => url !== '/api/config'), [], 'nothing was asked of the release files');
    assert.ok(log.every((cmd) => cmd.argv.at(-1)?.endsWith('update-state.json')), 'the only commands wrote the state');
  });

  test('a checksum that does not fit leaves the old program running and restarts nothing', async () => {
    release = '0.11.0';
    for (const [name, sum] of [['another hash', 'a'.repeat(64)], ['a hash that is not one', 'xyz']]) {
      publish('0.11.0', { sum });
      assert.equal((await run()).outcome, 'bad-checksum', name);
    }
    // The right hash for another file's name.
    const asset = `webchat-agent-${layout().platform}-${ARCH}.gz`;
    publish('0.11.0');
    files.set(`/releases/download/v0.11.0/${asset}.sha256`, `${sha(gzipSync(program('0.11.0')))}  webchat-agent-other.gz\n`);
    assert.equal((await run()).outcome, 'bad-checksum');
    assert.deepEqual([await installed(), restarts().length], ['0.9.0', 0]);
    assert.equal(await fs.stat(path.join(layout().programDir, '.staged')).then(() => true, () => false), false, 'nothing was staged');
  });

  test('a file that does not print its release is never moved into place', async () => {
    release = '0.11.0';
    publish('0.11.0', { content: program('0.12.0') });
    const state = await run();
    assert.equal(state.outcome, 'bad-file');
    publish('0.11.0', { content: '#!/bin/sh\nexit 1\n' });
    assert.equal((await run()).outcome, 'bad-file');
    assert.deepEqual([await installed(), restarts().length], ['0.9.0', 0]);
    assert.deepEqual(await fs.readdir(path.join(layout().programDir, '.staged')), [], 'the probe’s folder went with it');
  });

  test('a refusal, such as a private repository gives, keeps the old program and is tried again at the next check', async () => {
    release = '0.11.0';
    const first = await run();
    assert.deepEqual([first.outcome, first.detail, await installed()], ['refused', 'answered 404', '0.9.0']);
    publish('0.11.0');
    files.set(`/releases/download/v0.11.0/webchat-agent-${layout().platform}-${ARCH}.gz`, 401);
    const second = await run({ now: () => first.at + 60_000 });
    assert.deepEqual([second.outcome, second.detail, second.since], ['refused', 'answered 401', first.since]);
    assert.ok(requests.filter((url) => url.endsWith('.sha256')).length >= 2, 'it asked again');
    assert.equal(restarts().length, 0);
    assert.ok(describeState(second, first.at + 25 * 60 * 60_000).fix, 'doctor warns after a day');
    assert.equal(describeState(second, first.at + 60 * 60_000).fix, undefined);
    files.delete(`/releases/download/v0.11.0/webchat-agent-${layout().platform}-${ARCH}.gz`);
    publish('0.11.0');
    assert.equal((await run()).outcome, 'updated', 'once the files are there, it goes');
  });

  test('a keyholder that does not start as the new release is put back, and that release is skipped until a newer one', async () => {
    publish('0.11.0');
    release = '0.11.0';
    let restart = 0;
    ({ root, log } = scriptRoot(async () => {
      starts = ++restart > 1;
      await keyholder();
    }));
    const state = await run();
    assert.deepEqual([state.outcome, state.bad, await installed(), restart], ['rolled-back', ['0.11.0'], '0.9.0', 2]);
    assert.equal(await askVersion(), '0.9.0', 'the old program runs again');
    const asked = requests.length;
    assert.equal((await run()).outcome, 'skipped');
    assert.equal(requests.length, asked + 1, 'only the server was asked');
    publish('0.12.0');
    release = '0.12.0';
    assert.equal((await run()).outcome, 'updated');
    assert.equal(await installed(), '0.12.0');
  });

  test('a swap that fails before the rename leaves no staged file behind', async () => {
    publish('0.11.0');
    release = '0.11.0';
    const real = root;
    root = async (cmd) => (cmd.argv[2]?.includes(' ln ') ? Promise.reject(new Error('ln: not here')) : real(cmd));
    const state = await run();
    assert.deepEqual([state.outcome, await installed()], ['rolled-back', '0.9.0']);
    assert.equal(await fs.stat(path.join(layout().programDir, '.staged')).then(() => true, () => false), false);
  });

  test('records a root command that fails, rather than stop with nothing said', async () => {
    const l = layout();
    await fs.writeFile(l.unit, 'the unit of an older release');
    const real = root;
    root = async (cmd) => (cmd.argv.at(-1) === l.unit ? Promise.reject(new Error('Read-only file system')) : real(cmd));
    const state = await run();
    assert.deepEqual([state.outcome, state.release], ['stuck', '0.9.0']);
    assert.match(state.detail ?? '', /Read-only file system/);
    assert.equal((await readState(l))?.outcome, 'stuck');
  });

  test('writes the keyholder’s service file again when a release changes it, and only while nothing runs', async () => {
    const l = layout();
    await fs.writeFile(l.unit, 'the unit of an older release');
    busy = ['K-1'];
    await run();
    assert.equal(await fs.readFile(l.unit, 'utf8'), 'the unit of an older release');
    busy = [];
    await run();
    assert.equal(await fs.readFile(l.unit, 'utf8'), unitText(l, programOf(l)));
    const loads = () => words().filter((line) => /launchctl bootstrap|systemctl restart/.test(line));
    assert.equal(loads().length, 1, 'the new file takes effect when the service loads again');
    await run();
    assert.equal(loads().length, 1, 'and only once');
  });

  test('reads its settings only when root alone owns them, and takes only the server’s https address or this machine', async () => {
    const file = updateConfigOf(layout());
    const me = process.getuid!();
    assert.equal((await readConfig(file, me)).releases, `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases/download`);
    await assert.rejects(readConfig(file, me + 1), /not owned by root alone/);
    await fs.chmod(file, 0o664);
    await assert.rejects(readConfig(file, me), /not owned by root alone/);
    await fs.chmod(file, 0o644);
    for (const config of [{ server: 'http://example.com' }, { releases: 'ftp://x' }, { suffix: 'A/..' }]) {
      await fs.writeFile(file, JSON.stringify(config));
      await assert.rejects(readConfig(file, me), config.suffix ? /suffix/ : /https|Invalid URL/);
      assert.equal((await run()).outcome, 'bad-config');
    }
    await fs.writeFile(file, '{}');
    assert.deepEqual(await readConfig(file, me), { releases: AGENT_RELEASES, suffix: '' });
    assert.equal((await run()).outcome, 'no-server');
  });

  test('orders releases by their numbers, and reads a checksum only as a hash and the asset’s own name', () => {
    assert.deepEqual([['0.9.0', '0.10.0'], ['0.10.0', '0.9.0'], ['1.0.0', '1.0.0'], ['0.9.9', '1.0.0']].map(([a, b]) => Math.sign(compareReleases(a!, b!))), [-1, 1, 0, -1]);
    const hash = 'ab'.repeat(32);
    assert.equal(readSum(`${hash}  webchat-agent-linux-x64.gz\n`, 'webchat-agent-linux-x64.gz'), hash);
    assert.equal(readSum(`${hash} *webchat-agent-linux-x64.gz`, 'webchat-agent-linux-x64.gz'), hash);
    for (const bad of ['', hash, `${hash}  other.gz`, `${hash.slice(1)}  webchat-agent-linux-x64.gz`, `${hash.toUpperCase()}  webchat-agent-linux-x64.gz`, `${hash}  webchat-agent-linux-x64.gz  extra`]) {
      assert.equal(readSum(bad, 'webchat-agent-linux-x64.gz'), undefined, bad);
    }
  });
});
