import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeResult } from '../agent/claude.ts';
import { AgentClient } from '../agent/client.ts';
import type { Harness, Turn } from '../agent/harness.ts';
import { LocalBench } from '../agent/bench.ts';
import { Permits, SHOT } from '../agent/permits.ts';
import { connectRunner, Room } from '../agent/room.ts';
import type { Final } from '../agent/runner.ts';
import { REQUEST_TTL_MS, Runs, type Runner } from '../agent/runs.ts';
import { decryptFile, keyFingerprint, newKeyId } from '../shared/e2ee.ts';
import { LIMITS, type DocDTO, type RunDTO } from '../shared/types.ts';
import { sh, newChatKey } from './agentHelpers.ts';
import type { World } from './agentHelpers.ts';

export function runTests(w: World) {
  test('edits a board card under the section lock', async () => {
    const doc = { id: newKeyId(), conversationId: w.generalId };
    const card = (w.cardId = newKeyId().slice(0, 11));
    const text = w.cardText;
    await w.alice.request('POST', '/docs', {
      ...doc,
      revisions: [
        { section: 'title', envelope: await w.alice.sealDoc(doc, 'title', { text: 'Roadmap', board: 'roadmap' }) },
        { section: card, envelope: await w.alice.sealDoc(doc, card, { text, pos: 1 }) },
      ],
    });

    await w.bot.sync();
    const boards = await w.bot.boardDocs(w.projectId);
    assert.equal(boards.roadmap?.id, doc.id);
    assert.equal(boards.decisions, undefined);
    w.roadmap = boards.roadmap as DocDTO;
    assert.deepEqual(await w.bot.sections(w.roadmap), [{ id: card, text, pos: 1, authorId: w.alice.id }]);

    const edited = text.replace('Status: Open.', 'Status: In progress on branch agent/k1-bad-keys.');
    await w.bot.editSection(w.roadmap, card, () => ({ text: edited, pos: 1 }));
    await w.alice.sync();
    assert.deepEqual((await w.alice.sections(w.roadmap)).map((s) => s.text), [edited]);
    // The lock is free again: Alice can edit the card in turn.
    await w.alice.editSection(w.roadmap, card, () => ({ text, pos: 1 }));
    assert.deepEqual((await w.bot.sections(w.roadmap)).map((s) => s.text), [text]);
  });

  test('runs a card its owner hands to it, whoever wrote the card, and reports in #general', async () => {
    const jobs: Parameters<Runner>[0][] = [];
    const runs = new Runs(w.bot, async (job) => {
      jobs.push(job);
      return { branch: 'agent/k1-bad-keys', pull: { repo: 'acme/app', number: 9 }, note: 'Two files changed.' };
    });
    const ask = async (from: AgentClient, run: RunDTO) => {
      const id = (await from.send(w.generalId, { text: 'Run K-1 with Bot', run })).id;
      for (const m of await w.bot.sync()) await runs.handle(m);
      const heard = await w.alice.sync();
      return heard.filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id).map((m) => [m.content?.run?.kind, m.content?.text]);
    };
    // Carol saved the card last. Alice still runs it: she chose to.
    const written = `${w.cardText}\n\nAlso on a tablet.`;
    await w.carol.sync();
    await w.carol.editSection(w.roadmap, w.cardId, () => ({ text: written, pos: 1 }));

    assert.deepEqual(await ask(w.carol, await w.runOf()), [['failed', 'I could not run K-1: Only Alice hands cards to me.']]);
    const stale = [['failed', 'I could not run K-1: I got this more than 10 minutes after you sent it. Open the card again and press Start.']];
    // Without the time the page signed, as from a page before D-089, or with an old one.
    assert.deepEqual(await ask(w.alice, await w.runOf({ sentAt: 0 })), stale);
    assert.deepEqual(await ask(w.alice, await w.runOf({ sentAt: Date.now() - REQUEST_TTL_MS - 1000 })), stale);
    assert.equal(jobs.length, 0);

    assert.deepEqual(await ask(w.alice, await w.runOf()), [
      ['claimed', 'I am on K-1: Pushes with bad keys'],
      ['done', 'I finished K-1 on agent/k1-bad-keys (acme/app#9). Two files changed.'],
    ]);
    assert.deepEqual(jobs.map((j) => [j.request.card, j.card, j.projectId]), [['K-1', written, w.projectId]]);
    assert.deepEqual(runs.running, []);
    // The run leaves the card as it was: the reports in #general are its status (D-089).
    assert.deepEqual((await w.alice.sections(w.roadmap)).map((s) => s.text), [written]);
    await w.alice.editSection(w.roadmap, w.cardId, () => ({ text: w.cardText, pos: 1 }));
  });

  test('runs a card once when two requests for it come in one check-in', async () => {
    const reports = async () => (await w.alice.sync()).filter((m) => m.content?.run?.kind !== 'request').map((m) => m.content?.text);
    let jobs = 0;
    const runs = new Runs(w.bot, async () => {
      jobs++;
      return { branch: 'agent/k1' };
    });
    // Two requests in one check-in.
    await w.alice.send(w.generalId, { text: 'Run K-1 with Bot', run: await w.runOf() });
    await w.alice.send(w.generalId, { text: 'Run K-1 with Bot again', run: await w.runOf() });
    await Promise.all((await w.bot.sync()).map((m) => runs.handle(m)));
    assert.deepEqual((await reports()).sort(), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: K-1 is already running.', 'I finished K-1 on agent/k1.']);
    assert.equal(jobs, 1);
  });

  test('refuses a second request for the card it runs, however late it comes, runs another card beside it, and runs the card again once it ended (K-51, R-037)', async () => {
    w.k2 = newKeyId().slice(0, 11);
    await w.alice.editSection(w.roadmap, w.k2, () => ({ text: w.k2Text, pos: 2 }));
    let end!: () => void;
    const gate = new Promise<void>((resolve) => (end = resolve));
    const jobs: string[] = [];
    const runs = new Runs(w.bot, async ({ request }) => {
      jobs.push(request.card);
      await gate;
      throw new Error('Not today.');
    });
    const ask = async (run: RunDTO) => (await w.alice.send(w.generalId, { text: `Run ${run.kind === 'request' ? run.card : ''} with Bot`, run })).id;
    const handle = async () => {
      for (const m of await w.bot.sync()) await runs.handle(m);
    };
    const first = await ask(await w.runOf());
    const handled = Promise.all((await w.bot.sync()).map((m) => runs.handle(m)));
    while (!jobs.length) await sleep(10);
    // Another tab or device sent these before it saw the first request's reports, a check-in later.
    const twice = await ask(await w.runOf());
    const elsewhere = await ask(await w.runOfK2());
    const beside = Promise.all((await w.bot.sync()).map((m) => runs.handle(m)));
    while (jobs.length < 2) await sleep(10);
    assert.deepEqual(runs.running.map((r) => r.card), ['K-1', 'K-2'], 'both cards run at once');
    end();
    await Promise.all([handled, beside]);
    // The run failed, so the owner runs the card again.
    const again = await ask(await w.runOf());
    await handle();

    const heard = await w.alice.sync();
    const on = (id: number) => heard.filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id).map((m) => m.content?.text);
    assert.deepEqual(on(first), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: Not today.']);
    assert.deepEqual(on(twice), ['I could not run K-1: K-1 is already running.']);
    assert.deepEqual(on(elsewhere), ['I am on K-2: Sums are off', 'I could not run K-2: Not today.']);
    assert.deepEqual(on(again), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: Not today.']);
    assert.deepEqual(jobs, ['K-1', 'K-2', 'K-1']);
  });

  test('runs a request once, however often the server posts it (K-47)', async () => {
    let jobs = 0;
    const runs = new Runs(w.bot, async () => (jobs++, { branch: 'agent/k1' }));
    await w.alice.send(w.generalId, { text: 'Run K-1 with Bot', run: await w.runOf() });
    const [request] = await w.bot.sync();
    await runs.handle(request!);
    // The same signed message under a new id, as a server that keeps no promises could post it.
    await runs.handle({ ...request!, id: request!.id + 1000 });
    // A daemon started again remembers it too.
    await new Runs(await AgentClient.load(w.botFile), async () => (jobs++, { branch: 'agent/k1' })).handle({ ...request!, id: request!.id + 2000 });
    assert.equal(jobs, 1);
    const reports = (await w.alice.sync()).filter((m) => m.content?.run?.kind !== 'request').map((m) => m.content?.text);
    assert.deepEqual(reports, ['I am on K-1: Pushes with bad keys', 'I finished K-1 on agent/k1.']);
  });

  test('pins the keys its owner checked, so a card a teammate with new keys wrote runs (K-57, D-110)', async () => {
    // The bot pinned other keys for Carol than the server shows, as when her keys changed.
    await fs.writeFile(w.botFile, JSON.stringify({ ...JSON.parse(await fs.readFile(w.botFile, 'utf8')), pins: { [w.alice.id]: await keyFingerprint(w.alice.identity.publicKeys), [w.carol.id]: 'old' } }));
    w.bot = await AgentClient.load(w.botFile);
    await w.bot.sync();
    assert.equal(w.bot.keysOf(w.carol.id), null);
    const written = `${w.cardText}\n\nCarol saw it too.`;
    await w.carol.editSection(w.roadmap, w.cardId, () => ({ text: written, pos: 1 }));
    // Alice's page opens Carol's text, since Alice checked her code, and hashes it into the brief.
    const runs = new Runs(w.bot, async () => ({ branch: 'agent/k1' }));
    const start = async () => {
      const id = (await w.alice.send(w.generalId, { text: 'Run K-1 with Bot', run: await w.runOf() })).id;
      for (const m of await w.bot.sync()) await runs.handle(m);
      return (await w.alice.sync()).filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id).map((m) => m.content?.text);
    };
    assert.deepEqual(await start(), ['I could not run K-1: I can’t find that card on the board anymore. Open it again and press Start.']);

    const direct = (await w.alice.request<{ id: number }>('POST', '/conversations/direct', { userId: w.bot.id, key: await newChatKey(w.alice, [w.alice.id, w.bot.id]) })).id;
    const fingerprint = await keyFingerprint(w.carol.identity.publicKeys);
    const trust = (from: AgentClient, chat: number, trusted: { fingerprint?: string; sentAt?: number } = {}) =>
      from.send(chat, { text: 'I checked Carol’s security code.', trust: { user: w.carol.id, fingerprint, sentAt: Date.now(), ...trusted } });
    // Nobody but the owner, in their direct chat, and only for the keys the server shows now.
    await w.alice.sync();
    await w.carol.sync();
    await trust(w.carol, w.generalId);
    await trust(w.alice, w.generalId);
    await trust(w.alice, direct, { fingerprint: 'other' });
    await w.bot.sync();
    assert.equal(w.bot.keysOf(w.carol.id), null);

    // However late it comes: Claude Code may have been closed when Alice checked the code.
    const sentAt = Date.now() - REQUEST_TTL_MS - 1000;
    const checked = await trust(w.alice, direct, { sentAt });
    await w.bot.sync();
    assert.deepEqual(w.bot.keysOf(w.carol.id), w.carol.identity.publicKeys);
    assert.equal(JSON.parse(await fs.readFile(w.botFile, 'utf8')).pins[w.carol.id], fingerprint);
    assert.deepEqual(await start(), ['I am on K-1: Pushes with bad keys', 'I finished K-1 on agent/k1.']);

    // A check older than the one it pinned, played again, pins nothing.
    await fs.writeFile(w.botFile, JSON.stringify({ ...JSON.parse(await fs.readFile(w.botFile, 'utf8')), pins: { [w.alice.id]: await keyFingerprint(w.alice.identity.publicKeys), [w.carol.id]: 'old' } }));
    const older = await trust(w.alice, direct, { sentAt: sentAt - 1 });
    w.bot = await AgentClient.load(w.botFile);
    await w.bot.sync();
    assert.ok(older.id > checked.id);
    assert.equal(w.bot.keysOf(w.carol.id), null);
    await w.alice.editSection(w.roadmap, w.cardId, () => ({ text: w.cardText, pos: 1 }));
    await trust(w.alice, direct);
    await w.bot.sync();
  });

  test("sends a run's screenshots to its owner through the socket, sealed, as photos in the run's thread (R-046)", { timeout: 30_000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(w.home, 'shots-')));
    const work = path.join(root, 'work');
    await fs.mkdir(work);
    // A PNG as a browser writes one, 1 by 1 pixel.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const wide = Buffer.from(png);
    wide.writeUInt32BE(LIMITS.photoPixels + 1, 16);
    await fs.writeFile(path.join(work, 'desktop.png'), png);
    await fs.writeFile(path.join(work, 'wide.png'), wide);
    await fs.writeFile(path.join(work, 'photo.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
    await fs.writeFile(path.join(root, 'outside.png'), png);
    await fs.writeFile(path.join(work, 'huge.png'), png);
    await fs.truncate(path.join(work, 'huge.png'), LIMITS.fileBytes + 1);
    const shots: Array<[string, string]> = [['desktop.png', 'Desktop'], ['photo.png', 'A JPEG'], ['wide.png', 'Too wide'], ['huge.png', 'Too large'], [path.join(root, 'outside.png'), 'Outside']];
    const harness = {
      name: 'Claude Code',
      asks: true,
      refusal: async () => undefined,
      offers: () => ({ knobs: [] }),
      found: async () => ({}),
      apply: async () => undefined,
      turn: async (t: Turn) => ({ replies: await Promise.all(shots.map(([file, caption]) => t.shot!(path.resolve(t.cwd, file), caption))) }),
    } as unknown as Harness;
    const room = new Room({ version: pkg.version });
    const file = path.join(root, 'k.sock');
    await room.listen(file, {} as Parameters<Room['listen']>[1]);
    const runner = await connectRunner({ file, bench: new LocalBench([harness], undefined, path.join(root, 'keys')), version: pkg.version });
    try {
      const direct = (await w.alice.request<{ id: number }>('POST', '/conversations/direct', { userId: w.bot.id, key: await newChatKey(w.alice, [w.alice.id, w.bot.id]) })).id;
      await w.bot.sync();
      const permits = new Permits(w.bot, () => false);
      const schema = { type: 'object', properties: { replies: { type: 'array' } }, required: ['replies'] };
      const job = { harness: 'Claude Code', cwd: work, session: 'shots', resume: false, message: 'Check the page.', schema, schemas: [schema], setup: { claudeMd: false, skills: [], noAttribution: false } };
      const { answer } = await room.bench.turn(job, { signal: new AbortController().signal, permit: () => permits.forTurn({ session: 'shots', chat: direct, thread: { request: 4242 } }) });
      assert.deepEqual((answer as { replies: string[] }).replies, [SHOT.sent, SHOT.type, SHOT.size, SHOT.size, 'That path is outside the working folder.']);

      // Alice's page gets one sealed photo in the run's thread, and it opens to the same bytes.
      const photos = (await w.alice.sync()).filter((m) => m.senderId === w.bot.id && m.content?.file);
      assert.equal(photos.length, 1);
      const { file: sent, run, text } = photos[0]!.content!;
      assert.deepEqual([run, text, sent!.name, sent!.type, sent!.size, sent!.width, sent!.height], [{ kind: 'note', request: 4242 }, '📷 Screenshot: Desktop', 'screenshot.png', 'image/png', png.length, 1, 1]);
      const { url } = await w.alice.request<{ url: string }>('GET', `/files/${sent!.id}`);
      const sealed = new Uint8Array(await (await fetch(new URL(url, w.baseUrl))).arrayBuffer());
      assert.deepEqual(Buffer.from(await decryptFile(sent!.key, sealed)), png);
      // The store and the server hold neither the bytes nor the name, the key or the caption.
      const stored = Buffer.concat(await Promise.all((await fs.readdir(path.join(w.home, 'files'))).map((f) => fs.readFile(path.join(w.home, 'files', f)))));
      assert.ok(!stored.includes(png.subarray(8, 24)), 'the store holds ciphertext');
      const rows = JSON.stringify([await w.instance.sql.query('SELECT * FROM webchat.files'), await w.instance.sql.query('SELECT * FROM webchat.messages WHERE id = $1', [photos[0]!.id])]);
      for (const secret of ['screenshot.png', sent!.key, 'Desktop', 'IHDR']) assert.ok(!rows.includes(secret), secret);
    } finally {
      runner.close();
      room.close();
    }
  });

  test('stops a run when its owner cancels it, and for nobody else (R-030)', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const runs = new Runs(w.bot, ({ signal }) => {
      started();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('the owner cancelled the run.'))));
    });
    const id = (await w.alice.send(w.generalId, { text: 'Run K-1 with Bot', run: await w.runOf() })).id;
    const handled = Promise.all((await w.bot.sync()).map((m) => runs.handle(m)));
    await running;
    await w.carol.send(w.generalId, { text: 'Cancel K-1 with Bot', run: { kind: 'cancel', request: id } });
    for (const m of await w.bot.sync()) await runs.handle(m);
    assert.deepEqual(runs.running.map((r) => r.card), ['K-1'], "a teammate's cancel stops nothing");
    await w.alice.send(w.generalId, { text: 'Cancel K-1 with Bot', run: { kind: 'cancel', request: id } });
    for (const m of await w.bot.sync()) await runs.handle(m);
    await handled;
    // Its next check-in says it is idle again.
    await w.bot.sync();
    const reports = (await w.alice.sync()).filter((m) => m.senderId === w.bot.id).map((m) => m.content?.text);
    assert.deepEqual(reports, ['I am on K-1: Pushes with bad keys', 'I could not run K-1: the owner cancelled the run.']);
  });

  test('reports each run that a restart cut short as failed (K-46, R-037)', async () => {
    const ids = [
      (await w.alice.send(w.generalId, { text: 'Run K-1 with Bot', run: await w.runOf() })).id,
      (await w.alice.send(w.generalId, { text: 'Run K-2 with Bot', run: await w.runOfK2() })).id,
    ];
    // The daemon stops mid-run: its runners never return.
    let started = 0;
    const runs = new Runs(w.bot, () => (started++, new Promise(() => {})));
    for (const m of await w.bot.sync()) void runs.handle(m);
    while (started < 2) await sleep(10);
    const saved = async () => JSON.parse(await fs.readFile(w.botFile, 'utf8')).running;
    assert.deepEqual(await saved(), [
      { message: ids[0], conversation: w.generalId, card: 'K-1' },
      { message: ids[1], conversation: w.generalId, card: 'K-2' },
    ]);

    // Started again from its file, it no longer sees the requests: the cursor is past them.
    w.bot = await AgentClient.load(w.botFile);
    assert.deepEqual(await w.bot.sync(), []);
    const restarted = new Runs(w.bot, async () => ({ branch: 'agent/k1' }));
    await restarted.recover();
    assert.deepEqual(await saved(), []);
    await restarted.recover();
    const heard = await w.alice.sync();
    const on = (id: number) => heard.filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id).map((m) => [m.content?.run?.kind, m.content?.text]);
    assert.deepEqual(on(ids[0]!), [
      ['claimed', 'I am on K-1: Pushes with bad keys'],
      ['failed', 'I could not run K-1: The daemon stopped during the run.'],
    ]);
    assert.deepEqual(on(ids[1]!), [
      ['claimed', 'I am on K-2: Sums are off'],
      ['failed', 'I could not run K-2: The daemon stopped during the run.'],
    ]);
  });

  test('reads the one run that a file from before R-037 kept', async () => {
    const old = path.join(w.home, 'old-account.json');
    const taken = { message: 1, conversation: w.generalId, card: 'K-1' };
    await fs.writeFile(old, JSON.stringify({ ...JSON.parse(await fs.readFile(w.botFile, 'utf8')), running: taken }));
    assert.deepEqual((await AgentClient.load(old)).running, [taken]);
  });

  test("names each run's branch after its card, apart from the branches here and on origin", async () => {
    // A repository with a remote, as a student's checkout has.
    const origin = path.join(w.home, 'origin.git');
    const repo = path.join(w.home, 'repo');
    await sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    await sh('git', ['clone', '-q', origin, repo]);
    await fs.writeFile(path.join(repo, 'README.md'), '# Capstone\n');
    const git = (...args: string[]) => sh('git', ['-C', repo, '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', ...args]);
    await git('add', 'README.md');
    await git('commit', '-q', '-m', 'Start');
    await git('push', '-q', '-u', 'origin', 'main');
    const bench = new LocalBench([]);
    const tip = (await git('rev-parse', 'HEAD')).stdout.trim();
    const branchOf = async (taken: string[] = []) => (await bench.prepare({ dir: repo, slug: 'k-1-pushes-with-bad-keys', taken, tip })).branch;
    const branches = [await branchOf(), await branchOf()];
    // A branch pushed from another machine is taken too, which the agent's own clone says.
    branches.push(await branchOf(['agent/k-1-pushes-with-bad-keys-3']));
    assert.deepEqual(branches, ['agent/k-1-pushes-with-bad-keys', 'agent/k-1-pushes-with-bad-keys-2', 'agent/k-1-pushes-with-bad-keys-4']);
  });

  test("reads Claude Code's final word from its output lines", () => {
    const last = (lines: string[]) => lines.reduce<Final | undefined>((kept, line) => claudeResult(line) ?? kept, undefined);
    assert.deepEqual(last(['not json', '{"type":"system"}', '{"type":"result","result":"Done.","is_error":false,"session_id":"s-1","structured_output":{"reply":"Hi"}}']), {
      text: 'Done.',
      error: false,
      session: 's-1',
      answer: { reply: 'Hi' },
    });
  });

  test('starts again from its file, and signs in again when its session ends', async () => {
    const again = await AgentClient.load(w.botFile);
    assert.equal(again.id, w.bot.id);
    await w.alice.send(w.generalId, { text: 'Still there?' });
    assert.deepEqual((await again.sync()).map((m) => m.content?.text), ['Still there?']);

    await again.api.request('POST', '/auth/logout');
    await w.alice.send(w.generalId, { text: 'And now?' });
    assert.deepEqual((await again.sync()).map((m) => m.content?.text), ['And now?']);
    const file = JSON.parse(await fs.readFile(w.botFile, 'utf8')) as { cookie: string };
    assert.equal(file.cookie, again.api.cookie, 'the new session is on disk');
  });
}
