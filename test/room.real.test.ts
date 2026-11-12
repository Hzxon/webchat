// The locked room on a real machine (docs/roadmap/new-locked-room.md, docs/decisions/locked-room.md).
// It makes a real role account, `_webchattest`, with its groups, folders and system service, runs
// the keyholder as it and the runner as the user who runs this test, and shows what the room is
// for: a harness turn of the owner's reads the agent's account file and gets Permission denied, and
// another user cannot open the socket. Then it uninstalls and finds nothing left. It needs
// passwordless sudo and the single file from `npm run build:agent`, so it runs only in CI (the
// `room` job) or on a machine you can spare, with WEBCHAT_REAL_ROOM=1.
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { claudeHarness } from '../agent/claude.ts';
import { sha256 } from '../agent/keep.ts';
import { ghOf, inspectRoom, layoutFor, programOf, putAs, realRoot, runAll, servicePlan, socketOf, uninstallPlan } from '../agent/lockroom.ts';
import { buildRoom, read, uninstall } from '../agent/setup.ts';

const sh = promisify(execFile);
const real = process.env.WEBCHAT_REAL_ROOM === '1';

/** Stands in for the harness's `claude`: for each turn it tries to read the file it was told of, and answers with what the system said. */
const fakeClaude = (canary: string) => `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.300 (Claude Code)');
  process.exit(0);
}
const id = args[args.indexOf('--session-id') + 1];
for await (const line of readline.createInterface({ input: process.stdin })) {
  let note;
  try {
    note = 'READ ' + execFileSync('cat', [${JSON.stringify(canary)}], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    note = String(error.stderr);
  }
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: id, structured_output: { note } }));
}
`;

test('builds the room for real: a harness cannot read the agent’s account, nobody else opens the socket, and uninstall leaves nothing', { skip: real ? false : 'set WEBCHAT_REAL_ROOM=1 on a machine with passwordless sudo, after `npm run build:agent`', timeout: 240_000 }, async () => {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const layout = layoutFor(platform, 'test');
  const owner = os.userInfo().username;
  const source = path.resolve('dist/agent/webchat-agent');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-room-'));
  const socket = socketOf(layout);
  // Run as the owner, in the socket's group, which a session that began before setup is not in yet on Linux.
  const asOwner = (...command: string[]) => ['sudo', ['-n', '-u', owner, '-g', layout.ipcGroup, 'env', `WEBCHAT_SOCKET=${socket}`, `WEBCHAT_AGENT_HOME=${path.join(tmp, 'agent')}`, `HOME=${tmp}`, programOf(layout), ...command]] as const;
  const room = async () => JSON.stringify(await inspectRoom(layout, read));
  const none = JSON.stringify({ user: 'none', group: 'none', ipc: 'none', members: [] });
  assert.equal(await room(), none, `an account named ${layout.user} is on this machine already, and this test never touches one it did not make`);
  let runner: ChildProcess | undefined;
  const outputs: string[] = [];
  const home = process.env.HOME;
  let exited = true;
  const stopRunner = async () => {
    if (exited) return;
    runner!.kill('SIGTERM');
    await new Promise((resolve) => runner!.once('exit', resolve));
  };
  try {
    await buildRoom(realRoot, layout, { owner, program: source, hash: await sha256(source) });
    await runAll(realRoot, servicePlan(layout, programOf(layout)));

    // The files are root's, the account's folder is its own alone, and the system accepts the service's file.
    for (const file of [programOf(layout), ghOf(layout), layout.unit]) {
      const stat = await fs.stat(file);
      assert.deepEqual([file, stat.uid, stat.mode & 0o022], [file, 0, 0]);
    }
    const uid = Number((await sh('id', ['-u', layout.user])).stdout);
    const [data, ipc] = [await fs.stat(layout.data), await fs.stat(layout.ipc)];
    assert.deepEqual([data.uid, data.mode & 0o7777, ipc.uid, ipc.mode & 0o7777], [uid, 0o700, uid, 0o2750]);
    if (platform === 'darwin') await sh('plutil', ['-lint', layout.unit]);
    else await sh('systemd-analyze', ['verify', layout.unit]);
    assert.match((await sh(ghOf(layout), ['--version'])).stdout, /^gh version 2\.104\.0 /);

    // The keyholder runs as the account and answers the owner on the socket.
    const status = async () => (await sh(...asOwner('status'), { timeout: 20_000 }).catch(() => ({ stdout: '' }))).stdout;
    for (let tries = 0; !/^Runner: /m.test(await status()); tries++) {
      if (tries >= 30) {
        // What the service said, for the log of a failed run.
        const said = platform === 'darwin' ? await fs.readFile(layout.log, 'utf8').catch(() => '') : (await sh('journalctl', ['-u', layout.label, '--no-pager', '-n', '30']).catch(() => ({ stdout: '' }))).stdout;
        assert.fail(`the keyholder never answered on its socket. ${said}`);
      }
      await sleep(1000);
    }
    await sh('pgrep', ['-u', layout.user, '-f', 'keyholder']);

    // Nobody else opens it: the folder's mode and group decide.
    await assert.rejects(sh('sudo', ['-n', '-u', 'nobody', 'env', `WEBCHAT_SOCKET=${socket}`, 'HOME=/tmp', programOf(layout), 'wake']), /EACCES|permission denied|not running/i);

    // The owner's runner connects, in the group.
    runner = spawn(...asOwner('runner'), { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [runner.stdout, runner.stderr]) stream?.on('data', (chunk: Buffer) => outputs.push(String(chunk))).on('error', () => undefined);
    exited = false;
    runner.on('error', () => undefined).once('exit', () => (exited = true));
    for (let tries = 0; !/^Runner: connected/m.test(await status()); tries++) {
      assert.ok(tries < 30, `the runner never connected. ${outputs.join('')}`);
      await sleep(1000);
    }

    // The point of the room (done check 1): a harness turn, as the owner, reads the account file and is refused.
    await realRoot(putAs(layout, path.join(layout.data, 'laptop', 'account.json'), 'secret keys'));
    await fs.mkdir(path.join(tmp, 'data', 'laptop'), { recursive: true });
    const claude = path.join(tmp, 'claude');
    await fs.writeFile(claude, fakeClaude(path.join(layout.data, 'laptop', 'account.json')), { mode: 0o755 });
    const harness = claudeHarness(claude, path.join(tmp, 'data'));
    const schema = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] };
    const answer = (await harness.turn({ cwd: tmp, session: 's-1', resume: false, message: 'Read it', schema, setup: {}, signal: AbortSignal.timeout(30_000) })) as { note: string };
    await harness.end?.();
    assert.match(answer.note, /Permission denied/);
    assert.doesNotMatch(answer.note, /secret keys/);

    // Uninstall, as `webchat-agent uninstall` does, with a home of its own so it touches nothing of this machine's.
    await stopRunner();
    process.env.HOME = tmp;
    await uninstall(path.join(tmp, 'agent'), async () => true, { layout });
    assert.equal(await room(), none, 'no account or group is left');
    for (const file of [layout.data, layout.ipc, layout.programDir, layout.unit, ...(layout.log ? [path.dirname(layout.log)] : [])]) assert.equal(await fs.stat(file).then(() => true, () => false), false, `${file} is gone`);
    const [service, args] = platform === 'darwin' ? ['launchctl', ['print', `system/${layout.label}`]] : ['systemctl', ['cat', layout.label]];
    await assert.rejects(sh(service!, args!), 'the service is gone');
  } finally {
    // What a failed run leaves is this test's own, so it goes even when the steps above did not run.
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    await stopRunner();
    await runAll(realRoot, uninstallPlan(layout, (await inspectRoom(layout, read)).user === 'ours'));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
