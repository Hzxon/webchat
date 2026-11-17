import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { claudeHarness } from '../agent/claude.ts';
import { codexHarness } from '../agent/codex.ts';
import { LocalBench } from '../agent/bench.ts';
import { Plugin } from '../agent/plugin.ts';
import { callRoom, connectRunner, Room, type RoomStatus } from '../agent/room.ts';
import { newKeyId, newPairingCode, textHash } from '../shared/e2ee.ts';
import { briefText, type CreateProjectResponse } from '../shared/types.ts';
import { FAKE_CODEX } from './fakes.ts';
import { sh, git, connect, FAKE_GH, newChatKey, withEnv, setEnv, waitFor, approve } from './agentHelpers.ts';
import type { World } from './agentHelpers.ts';

export function runnerTests(w: World) {
  test('sleeps on its owner\'s word, whichever process serves, until a wake (K-66, D-113)', { timeout: 30_000 }, async () => {
    const dataDir = path.join(w.home, 'sleepy');
    const options = { harnesses: [claudeHarness('', dataDir)], cloneRoot: path.join(w.home, 'WebChat'), dataDir };
    const code = newPairingCode();
    const first = new Plugin({ ...options, code: `${w.baseUrl}#${code}` });
    const second = new Plugin({ ...options, code: '' });
    // Caught, as agent/index.ts does: a process whose check-in outlasts the test starts again after
    // the file's server closed and its folder went, and pairs again with nobody to answer.
    const serve = (window: Plugin) => void window.serve().catch(() => undefined);
    serve(first);
    try {
      const agent = await approve(w.alice, code, 'Sleepy');
      await waitFor('the first window serves', () => first.problem === '');
      serve(second);
      await waitFor('the second window waits', () => /Another process on this laptop/.test(second.problem));

      // Nothing runs, so the agent sleeps at once on Alice's word in the pane, and says so.
      await w.alice.sync();
      const direct = (await w.alice.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(w.alice, [w.alice.id, agent.id]) })).id;
      await w.alice.sync();
      await w.alice.send(direct, { text: 'Go to sleep', sleep: { sentAt: Date.now() } });
      for (const message of await first.client!.sync()) await first.handle(message);
      await waitFor('the first window sleeps', () => /asleep/.test(first.problem));
      const said = (await w.alice.sync()).filter((m) => m.senderId === agent.id).map((m) => m.content?.text);
      assert.deepEqual(said, ['I go to sleep now. To wake me, run webchat-agent wake in a terminal on your laptop.']);
      // The watch is free, and no window takes it while the agent sleeps.
      assert.equal(existsSync(path.join(dataDir, 'watch.lock')), false);
      assert.match((await second.status()).text, /Your agent is asleep/);

      // A wake in the waiting window serves there at once, and a sleep there stops it again.
      assert.match(await second.wake(), /waking up/);
      await waitFor('the second window serves', () => second.problem === '');
      assert.match(await second.goToSleep(), /goes to sleep within 15 seconds/);
      await waitFor('the second window sleeps', () => /asleep/.test(second.problem));
      assert.equal(existsSync(path.join(dataDir, 'watch.lock')), false);
    } finally {
      // A window that still serves would keep checking in after the test.
      await first.goToSleep();
      await second.goToSleep();
    }
  });

  test('shows offline while no runner is connected, serves once one says hello, and stops when it goes (docs/decisions/locked-room.md)', { timeout: 30_000 }, async () => {
    const dataDir = path.join(w.home, 'roomy');
    const room = new Room({ version: '1' });
    const file = path.join(w.home, 'roomy.sock');
    const code = newPairingCode();
    const plugin = new Plugin({ bench: room.bench, runner: room, cloneRoot: path.join(w.home, 'WebChat'), dataDir, code: `${w.baseUrl}#${code}` });
    await room.listen(file, plugin);
    const bench = new LocalBench([claudeHarness('', dataDir)], undefined, dataDir);
    const runners: Array<{ close: () => void }> = [];
    void plugin.serve().catch(() => undefined);
    try {
      await waitFor('it shows offline', () => /not started the part of this agent/.test(plugin.problem));
      assert.equal(plugin.client, null, 'it checked in nowhere');
      runners.push(await connectRunner({ file, bench, version: '1' }));
      await approve(w.alice, code, 'Roomy');
      await waitFor('it serves', () => plugin.problem === '');
      // `status` answers fields, which doctor and setup read (docs/decisions/locked-room.md).
      const said = await callRoom<RoomStatus>(file, 'status', {}, '1');
      assert.deepEqual([said.runner, said.paired, said.asleep, said.linked, said.folders], [true, true, false, [], []]);
      runners[0]!.close();
      await waitFor('it is offline again', () => /not started the part of this agent/.test(plugin.problem));
      runners.push(await connectRunner({ file, bench, version: '1' }));
      await waitFor('it serves again', () => plugin.problem === '');
    } finally {
      runners.forEach((r) => r.close());
      await plugin.goToSleep();
      room.close();
    }
  });

  test('runs a card with Codex through the socket to a draft: the check, the owner’s go, the runner commits what Codex leaves, and the keyholder pushes the bundle (docs/decisions/locked-room.md)', { timeout: 60_000 }, async () => {
    const origin = path.join(w.home, 'codex-app.git');
    const project = path.join(w.home, 'codex-app');
    await sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    await sh('git', ['clone', '-q', origin, project]);
    await fs.writeFile(path.join(project, 'README.md'), '# App\n');
    await git(project, 'add', 'README.md');
    await git(project, 'commit', '-q', '-m', 'Start');
    await git(project, 'push', '-q', '-u', 'origin', 'main');
    await git(project, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
    const bin = path.join(w.home, 'codex-bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
    const ghState = path.join(w.home, 'codex-gh.json');
    await fs.writeFile(ghState, JSON.stringify({ origin, pulls: [] }));
    // The keyholder's own clone fetches and pushes GitHub's address, which the test points at its bare repository.
    const gitConfig = path.join(w.home, 'codex-gitconfig');
    await fs.writeFile(gitConfig, `[user]\n\tname = Alice\n\temail = alice@example.com\n[url "${origin}"]\n\tinsteadOf = https://github.com/acme/app.git\n`);
    const restore = setEnv({
      GIT_CONFIG_GLOBAL: gitConfig,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_STATE: ghState,
      FAKE_CODEX_LOG: path.join(w.home, 'codex-turns.log'),
      CODEX_HOME: path.join(w.home, 'codex-home'),
      GH_CONFIG_DIR: path.join(w.home, 'codex-gh'),
    });
    // Codex is the only harness linked, and it declares no knob to skip the plan gate.
    const dataDir = path.join(w.home, 'codex-keyholder');
    await fs.mkdir(path.join(dataDir, 'laptop'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'laptop', 'setup.json'), JSON.stringify({ choice: { claudeMd: false, skills: [], noAttribution: false, linked: ['Codex'] } }));
    const room = new Room({ version: '1' });
    const file = path.join(w.home, 'codex-room.sock');
    const code = newPairingCode();
    const plugin = new Plugin({ bench: room.bench, runner: room, cloneRoot: path.join(w.home, 'WebChat'), dataDir, code: `${w.baseUrl}#${code}` });
    await room.listen(file, plugin);
    const runnerDir = path.join(w.home, 'codex-runner');
    const harness = codexHarness(path.join(bin, 'codex'), runnerDir);
    await fs.mkdir(runnerDir);
    let runner: { close: () => void } | undefined;
    // The tests before have used up this address's pairings and sends.
    await w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'pair:%' OR key LIKE 'send:%'");
    try {
      const starting = plugin.start();
      runner = await connectRunner({ file, bench: new LocalBench([harness], undefined, runnerDir), version: '1' });
      const agent = await approve(w.alice, code, 'Codexer');
      assert.equal(await starting, true);
      await connect(dataDir, 'acme/app', project);
      await plugin.scan();
      await plugin.client!.sync();

      await w.alice.sync();
      const key = await newChatKey(w.alice, [w.alice.id, agent.id]);
      const app = await w.alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Codex app', memberIds: [agent.id], key });
      const general = app.channel.id;
      await w.alice.sync();
      const board = { id: newKeyId(), conversationId: general };
      const section = newKeyId().slice(0, 11);
      const card = '### K-7: Sums are off by one\n\nStatus: Open.';
      await w.alice.request('POST', '/docs', {
        ...board,
        revisions: [
          { section: 'title', envelope: await w.alice.sealDoc(board, 'title', { text: 'Roadmap', board: 'roadmap' }) },
          { section, envelope: await w.alice.sealDoc(board, section, { text: card, pos: 1 }) },
        ],
      });
      const hash = await textHash(briefText(card, []));
      const checkIn = async () => Promise.all((await plugin.client!.sync()).map((m) => plugin.handle(m)));
      // Each call reads what came since the last.
      const reports = async (request: number) =>
        (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.run?.kind !== 'request' && m.content?.run?.request === request).map((m) => [m.content!.run!.kind, m.content!.text]);
      const branches = async () => (await sh('git', ['--git-dir', origin, 'branch', '--format=%(refname:short)'])).stdout.trim();

      // The check turn holds, and the plan waits for the owner's go: nothing is pushed or opened.
      const plan = 'Fix the off-by-one in sum.js.';
      const check = JSON.stringify({ outcome: 'holds', note: '', checked: 'Read K-7 and sum.js on main.', plan });
      const request = await withEnv({ FAKE_CODEX_CHECK: check }, async () => {
        const id = (await w.alice.send(general, { text: 'Run K-7 with Codex', run: { kind: 'request', card: 'K-7', title: 'Sums are off by one', docId: board.id, section, runtime: agent.id, sentAt: Date.now(), repo: 'acme/app', hash, harness: 'Codex' } })).id;
        await checkIn();
        return id;
      });
      assert.deepEqual(await reports(request), [['claimed', 'I am on K-7: Sums are off by one'], ['planned', `K-7 holds. My plan:\n\n${plan}\n\nSay go, or tell me what to change.`]]);
      assert.deepEqual([await branches(), JSON.parse(await fs.readFile(ghState, 'utf8')).pulls], ['main', []]);

      // The go claims the card with a draft, and Codex's work turn leaves sum.js uncommitted, since its sandbox cannot commit.
      const done = JSON.stringify({ outcome: 'done', note: 'Sums add up now.', title: 'Fix sums', body: 'Sums were off by one.' });
      await withEnv({ FAKE_CODEX_FILE: 'sum.js', FAKE_CODEX_ANSWER: done }, async () => {
        await w.alice.send(general, { text: 'Go', run: { kind: 'fix', request, sentAt: Date.now() } });
        await checkIn();
      });
      const branch = 'agent/k-7-sums-are-off-by-one';
      assert.deepEqual(await reports(request), [['fixing', 'I am back on K-7: you said go'], ['done', `I finished K-7 on ${branch} (acme/app#1). Sums add up now.`]]);
      // The runner committed what Codex left, titled with the answer's title, and the keyholder pushed it from a bundle.
      assert.equal(await branches(), `${branch}\nmain`);
      assert.deepEqual((await sh('git', ['--git-dir', origin, 'log', '--format=%s', `main..${branch}`])).stdout.trim().split('\n'), ['Fix sums', 'chore: Claim K-7']);
      assert.equal((await sh('git', ['--git-dir', origin, 'show', `${branch}:sum.js`])).stdout, 'done\n');
      assert.deepEqual(JSON.parse(await fs.readFile(ghState, 'utf8')).pulls, [{ head: branch, base: 'main', draft: true, title: 'K-7: Sums are off by one', body: `Claims K-7. Checked ${new Date().toISOString().slice(0, 10)}: Read K-7 and sum.js on main.`, edited: { title: 'Fix sums', body: 'Sums were off by one.' } }]);
    } finally {
      runner?.close();
      await harness.end?.();
      room.close();
      restore();
    }
  });
}
