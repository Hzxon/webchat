import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Api } from '../agent/api.ts';
import { claudeArgs, claudeHarness, claudeResult, claudeSettings, pathDirs, guard, restrictedSettings, sandboxProblem } from '../agent/claude.ts';
import { AgentClient, type OpenedMessage } from '../agent/client.ts';
import { CODEX_GAP, codexHarness } from '../agent/codex.ts';
import type { Ask, Harness, Reply, Turn } from '../agent/harness.ts';
import { Conversations, parts, type Answerer } from '../agent/conversations.ts';
import { LocalBench, worktreeGit } from '../agent/bench.ts';
import { Plugin } from '../agent/plugin.ts';
import { callRoom, connectRunner, Room } from '../agent/room.ts';
import { doctor, linksFrom, setup, uninstall } from '../agent/setup.ts';
import { harnessFinder, supported, supportedList } from '../agent/harnesses.ts';
import { versionAtLeast } from '../agent/harness.ts';
import type { Final } from '../agent/runner.ts';
import { REQUEST_TTL_MS, Runs, type Runner } from '../agent/runs.ts';
import { createApp, type WebChatApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { openDb, toUserDTO } from '../server/db.ts';
import { createIdentity, keyFingerprint, newChatKeyBytes, newKeyId, newPairingCode, pairingId, pairingProof, openPicks, sealPicks, textHash, permitHash, wrapChatKey, type MessageContent } from '../shared/e2ee.ts';
import { briefText, harnessRow, type AskDTO, type RunReport, type ConversationDTO, type CreateProjectResponse, type FirstChatKeyInput, type DocDTO, type PairingDTO, type PermitDTO, type RunDTO, type PromptDTO, type RunRequest, type SetupChoice, type UserDTO } from '../shared/types.ts';
import { copyOf, readCard } from '../shared/board.ts';
import { FAKE_CLAUDE, FAKE_CODEX } from './fakes.ts';

// The server never sees how the login key was derived, so fewer PBKDF2 rounds keep tests fast.
const KDF_ROUNDS = 1000;
const sh = promisify(execFile);
const git = (dir: string, ...args: string[]) => sh('git', ['-C', dir, '-c', 'user.name=Claude', '-c', 'user.email=claude@example.com', ...args]);

/**
 * Stands in for GitHub's command line: opens pull requests into a JSON file, and answers for them
 * with what the test put there, the head commit read from the bare repository.
 */
const FAKE_GH = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args[0] === 'pr' && args[1] === 'create') {
  state.pulls.push({ head: flag('--head'), base: flag('--base'), draft: args.includes('--draft'), title: flag('--title'), body: flag('--body') });
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
  console.log('https://github.com/' + flag('--repo') + '/pull/' + state.pulls.length);
} else if (args[0] === 'pr' && (args[1] === 'edit' || args[1] === 'close')) {
  // What the plugin changed later, beside what it opened the pull request with.
  const pull = state.pulls[Number(args[2]) - 1];
  if (args[1] === 'close') pull.closed = flag('--comment');
  else pull.edited = { title: flag('--title'), body: flag('--body') };
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
} else if (args[0] === 'pr' && args[1] === 'view') {
  const pull = state.pulls[Number(args[2]) - 1];
  const head = execFileSync('git', ['--git-dir', state.origin, 'rev-parse', 'refs/heads/' + pull.head], { encoding: 'utf8' }).trim();
  console.log(JSON.stringify({ state: 'OPEN', isDraft: true, headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: [], reviews: [], comments: [], ...pull.view }));
} else if (args[0] === 'pr' && args[1] === 'list') {
  // The pull requests the test opened, and the drafts the plugin opened, each on its head.
  const all = [...(state.open ?? []), ...state.pulls.map((p, i) => ({ number: i + 1, title: '', headRefName: p.head }))];
  console.log(JSON.stringify(all.filter((p) => !args.includes('--head') || p.headRefName === flag('--head'))));
} else if (args[0] === 'run') {
  console.log('FAIL test/sum.test.js: expected 3, got 4');
} else if (args[0] === 'api') {
  console.log(args[1].endsWith('/permission') ? '{"permission":"write"}' : '[]');
}
`;
const PASSWORD = 'correct horse battery';

/** A fresh chat key, wrapped by this client for each member, as a browser does when it makes a project. */
async function newChatKey(client: AgentClient, memberIds: number[]): Promise<FirstChatKeyInput> {
  const raw = newChatKeyBytes();
  const keyId = newKeyId();
  const { id: conversationId } = await client.request<{ id: number }>('POST', '/conversations/ids');
  const me = { id: client.id, identity: client.identity };
  const wrappedKeys = await Promise.all(
    memberIds.map(async (id) => ({ id, ...(await wrapChatKey(raw, me, { id, dh: client.keysOf(id)!.dh }, keyId, conversationId)) })),
  ).then((keys) => keys.map(({ id, ...k }) => ({ userId: id, ...k })));
  return { conversationId, keyId, wrappedKeys };
}

/** One turn of the real `claude` with the adapter's arguments: its stream-json line on stdin, then the end of stdin, which ends the process. */
async function runClaude(args: string[], cwd: string, input: string, seen: (line: string) => void = () => undefined) {
  const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'inherit'], signal: AbortSignal.timeout(5 * 60_000) });
  child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: input } })}\n`);
  let last: Final | undefined;
  for await (const line of readline.createInterface({ input: child.stdout })) {
    seen(line);
    last = claudeResult(line) ?? last;
  }
  assert.ok(last, 'the turn ends with a result');
  return last;
}

/** Does `work` with these environment variables set, then puts back what was there. */
async function withEnv<T>(vars: Record<string, string>, work: () => Promise<T>) {
  const restore = setEnv(vars);
  try {
    return await work();
  } finally {
    restore();
  }
}

// The fake harnesses are processes the plugin keeps for a session, so they read what a test sets per turn from this file.
process.env.FAKE_ENV_FILE = path.join(os.tmpdir(), `webchat-fake-env-${process.pid}.json`);
const syncFakes = () => writeFileSync(process.env.FAKE_ENV_FILE!, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('FAKE_')))));

/** Sets environment variables, and returns how to put back what was there. */
function setEnv(vars: Record<string, string>) {
  const saved = Object.entries(vars).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, vars);
  syncFakes();
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    syncFakes();
  };
}

/** Waits up to 10 seconds for something the plugin does on its own, then checks it. */
async function waitFor(what: string, done: () => boolean | Promise<boolean>) {
  for (let tries = 0; tries < 1000 && !(await done()); tries++) await sleep(10);
  assert.ok(await done(), what);
}

/**
 * Plays the owner's page in a pairing: waits for the agent's half, checks its keys against the
 * code, and approves with the owner's keys bound to the code, as AgentDialog does.
 */
async function approve(owner: AgentClient, code: string, displayName: string, proof?: string) {
  const id = await pairingId(code);
  let pairing: PairingDTO | undefined;
  while (!(pairing = await owner.api.request<PairingDTO | undefined>('GET', `/pairings/${id}`))) await sleep(10);
  assert.equal(pairing.proof, await pairingProof(code, pairing.keys), 'the keys came with the code');
  proof ??= await pairingProof(code, pairing.keys, { id: owner.id, keys: owner.identity.publicKeys });
  return owner.request<UserDTO>('POST', `/pairings/${id}/approve`, { displayName, proof });
}

describe('agent client (R-027)', () => {
  let instance: WebChatApp;
  let server: http.Server;
  let baseUrl: string;
  let home: string;
  let alice: AgentClient;
  let bot: AgentClient;
  let carol: AgentClient;
  let botFile: string;
  let projectId: number;
  let generalId: number;
  let roadmap: DocDTO;
  let cardId: string;
  const cardText = '### K-1: Pushes with bad keys\n\nStatus: Open.\n\nSeen: on a phone.';
  /** A request for K-1, as the owner's page sends it. */
  // The hash of the brief the owner saw: the card as it is now, and this board has no decisions (D-105).
  const runOf = async (extra: Partial<RunRequest> = {}): Promise<RunDTO> => ({
    kind: 'request',
    card: 'K-1',
    title: 'Pushes with bad keys',
    docId: roadmap.id,
    section: cardId,
    runtime: bot.id,
    sentAt: Date.now(),
    hash: await textHash(briefText((await alice.sections(roadmap)).find((c) => c.id === cardId)?.text ?? '', [])),
    ...extra,
  });
  /** A second card, which the K-51 test puts on the board, to run beside K-1 (R-037). */
  let k2 = '';
  const k2Text = '### K-2: Sums are off\n\nStatus: Open.';
  const runOfK2 = async () => runOf({ card: 'K-2', title: 'Sums are off', section: k2, hash: await textHash(briefText(k2Text, [])) });

  before(async () => {
    const config = loadConfig({ PGLITE_DIR: ':memory:', INVITE_CODE: 'friends-only', GITHUB_POLL_SECONDS: '0', SESSION_DAYS: '1' });
    instance = await createApp({ ...config, logger: { info() {}, warn() {}, error() {} } });
    server = http.createServer(instance.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-agent-'));
    botFile = path.join(home, 'bot', 'account.json');
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await instance?.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  test('pairs with its owner through a one-time code, and keeps its keys in a file only its owner can read (R-030)', async () => {
    // A person, who signs up in a browser; the client stands in for the page here.
    alice = await AgentClient.signUp(path.join(home, 'alice.json'), { server: baseUrl, username: 'alice', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Alice', 'friends-only');
    const code = newPairingCode();
    // However it is pasted, it is the same code.
    assert.equal(await pairingId(code.toUpperCase().replace(/-/g, ' ')), await pairingId(code));
    const pairing = AgentClient.pair(botFile, baseUrl, code, 10);
    const approved = await approve(alice, code, 'Bot');
    bot = await pairing;
    assert.equal(bot.id, approved.id);
    assert.equal(bot.owner, alice.id);
    assert.equal((await fs.stat(botFile)).mode & 0o777, 0o600);
    const file = JSON.parse(await fs.readFile(botFile, 'utf8'));
    assert.deepEqual(Object.keys(file).sort(), ['authKey', 'cookie', 'cursor', 'owner', 'pairing', 'pins', 'secrets', 'server', 'userId', 'username']);
    // The owner's keys came with the code, so they are pinned before any check-in.
    assert.deepEqual(file.pins, { [alice.id]: await keyFingerprint(alice.identity.publicKeys) });
    // Alice's board offers the bot, as hers.
    await alice.sync();
    assert.equal(alice.users.get(bot.id)?.agentOwner, alice.id);

    // A code works once.
    const keys = bot.identity.publicKeys;
    const again = { id: await pairingId(code), keys, proof: await pairingProof(code, keys), authKey: 'x'.repeat(43) };
    await assert.rejects(new Api(baseUrl).request('POST', '/pairings', again), { status: 409 });
    // An approval that the code does not prove, as from a server that swapped the owner's keys, pairs nothing.
    const other = newPairingCode();
    const forged = AgentClient.pair(path.join(home, 'forged.json'), baseUrl, other, 10);
    await approve(alice, other, 'Forged', await pairingProof(newPairingCode(), keys, { id: alice.id, keys: alice.identity.publicKeys }));
    await assert.rejects(forged, /does not match the pairing code/);
    // The agent's login key never travels in the clear, except on this machine, whatever its name (K-48).
    assert.throws(() => new Api('http://chat.example.com'), /https/);
    assert.throws(() => new Api('http://localhost.example.com'), /https/);
    for (const local of ['http://localhost:5173', 'http://alice.localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:3000']) new Api(local);
  });

  test('a pairing carries the sealed picks, within the limits, and the page reads them back', async () => {
    await instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'pair:%'");
    const code = newPairingCode();
    const { publicKeys: keys } = await createIdentity();
    const picks = await sealPicks(code, keys, [{ name: 'Codex', signedIn: false }]);
    const half = async (extra: object) => ({ id: await pairingId(newPairingCode()), keys, proof: await pairingProof(code, keys), authKey: 'x'.repeat(43), ...extra });
    for (const bad of ['', 'not base64!', 'a'.repeat(4097), 'short']) {
      await assert.rejects(new Api(baseUrl).request('POST', '/pairings', await half({ picks: bad })), { status: 400 }, `picks ${bad.slice(0, 12)}`);
    }
    const input = { ...(await half({ picks })), id: await pairingId(code) };
    await new Api(baseUrl).request('POST', '/pairings', input);
    const read = await new Api(baseUrl).request<PairingDTO>('GET', `/pairings/${input.id}`);
    assert.deepEqual(await openPicks(code, read.keys, read.picks!), [{ name: 'Codex', signedIn: false }]);
    // A pairing with none, as an agent from before linking files it, reads as before.
    const plain = await half({});
    await new Api(baseUrl).request('POST', '/pairings', plain);
    assert.equal((await new Api(baseUrl).request<PairingDTO>('GET', `/pairings/${plain.id}`)).picks, undefined);
    // The tests after this one pair too, and the limit is per address.
    await instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'pair:%'");
  });

  test('reads and answers in a project it was added to', async () => {
    // A teammate the bot takes no cards from.
    carol = await AgentClient.signUp(path.join(home, 'carol.json'), { server: baseUrl, username: 'carol', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Carol', 'friends-only');
    await alice.sync();
    const key = await newChatKey(alice, [alice.id, bot.id, carol.id]);
    const created = await alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Capstone', memberIds: [bot.id, carol.id], key });
    projectId = created.project.id;
    generalId = created.channel.id;
    await alice.sync();
    await alice.send(generalId, { text: 'Hello bot' });

    const heard = await bot.sync();
    assert.equal(bot.conversations.get(generalId)?.projectId, projectId);
    assert.deepEqual(
      heard.map((m) => [m.senderId, m.security, m.content?.text]),
      [[alice.id, 'encrypted', 'Hello bot']],
    );

    await bot.send(generalId, { text: 'Hi Alice' });
    assert.deepEqual((await alice.sync()).map((m) => [m.senderId, m.content?.text]), [[bot.id, 'Hi Alice']]);
    // Its own message, and the overlap of the check-in before, come back as nothing new.
    assert.deepEqual(await bot.sync(), []);
  });

  test('never owns a project or group, since it cannot remove, hand back or delete (K-67)', async () => {
    await assert.rejects(alice.request('PUT', `/projects/${projectId}/owner`, { userId: bot.id }), { status: 400 });
    const key = await newChatKey(alice, [alice.id, bot.id]);
    const group = await alice.request<ConversationDTO>('POST', '/conversations/group', { title: 'Pair', memberIds: [bot.id], key });
    await assert.rejects(alice.request('PUT', `/conversations/${group.id}/owner`, { userId: bot.id }), { status: 400 });
  });

  test('edits a board card under the section lock', async () => {
    const doc = { id: newKeyId(), conversationId: generalId };
    const card = (cardId = newKeyId().slice(0, 11));
    const text = cardText;
    await alice.request('POST', '/docs', {
      ...doc,
      revisions: [
        { section: 'title', envelope: await alice.sealDoc(doc, 'title', { text: 'Roadmap', board: 'roadmap' }) },
        { section: card, envelope: await alice.sealDoc(doc, card, { text, pos: 1 }) },
      ],
    });

    await bot.sync();
    const boards = await bot.boardDocs(projectId);
    assert.equal(boards.roadmap?.id, doc.id);
    assert.equal(boards.decisions, undefined);
    roadmap = boards.roadmap as DocDTO;
    assert.deepEqual(await bot.sections(roadmap), [{ id: card, text, pos: 1, authorId: alice.id }]);

    const edited = text.replace('Status: Open.', 'Status: In progress on branch agent/k1-bad-keys.');
    await bot.editSection(roadmap, card, () => ({ text: edited, pos: 1 }));
    await alice.sync();
    assert.deepEqual((await alice.sections(roadmap)).map((s) => s.text), [edited]);
    // The lock is free again: Alice can edit the card in turn.
    await alice.editSection(roadmap, card, () => ({ text, pos: 1 }));
    assert.deepEqual((await bot.sections(roadmap)).map((s) => s.text), [text]);
  });

  test('runs a card its owner hands to it, whoever wrote the card, and reports in #general', async () => {
    const jobs: Parameters<Runner>[0][] = [];
    const runs = new Runs(bot, async (job) => {
      jobs.push(job);
      return { branch: 'agent/k1-bad-keys', pull: { repo: 'acme/app', number: 9 }, note: 'Two files changed.' };
    });
    const ask = async (from: AgentClient, run: RunDTO) => {
      const id = (await from.send(generalId, { text: 'Run K-1 with Bot', run })).id;
      for (const m of await bot.sync()) await runs.handle(m);
      const heard = await alice.sync();
      return heard.filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id).map((m) => [m.content?.run?.kind, m.content?.text]);
    };
    // Carol saved the card last. Alice still runs it: she chose to.
    const written = `${cardText}\n\nAlso on a tablet.`;
    await carol.sync();
    await carol.editSection(roadmap, cardId, () => ({ text: written, pos: 1 }));

    assert.deepEqual(await ask(carol, await runOf()), [['failed', 'I could not run K-1: Only Alice hands cards to me.']]);
    const stale = [['failed', 'I could not run K-1: I got this more than 10 minutes after you sent it. Open the card again and press Start.']];
    // Without the time the page signed, as from a page before D-089, or with an old one.
    assert.deepEqual(await ask(alice, await runOf({ sentAt: 0 })), stale);
    assert.deepEqual(await ask(alice, await runOf({ sentAt: Date.now() - REQUEST_TTL_MS - 1000 })), stale);
    assert.equal(jobs.length, 0);

    assert.deepEqual(await ask(alice, await runOf()), [
      ['claimed', 'I am on K-1: Pushes with bad keys'],
      ['done', 'I finished K-1 on agent/k1-bad-keys (acme/app#9). Two files changed.'],
    ]);
    assert.deepEqual(jobs.map((j) => [j.request.card, j.card, j.projectId]), [['K-1', written, projectId]]);
    assert.deepEqual(runs.running, []);
    // The run leaves the card as it was: the reports in #general are its status (D-089).
    assert.deepEqual((await alice.sections(roadmap)).map((s) => s.text), [written]);
    await alice.editSection(roadmap, cardId, () => ({ text: cardText, pos: 1 }));
  });

  test('runs a card once when two requests for it come in one check-in', async () => {
    const reports = async () => (await alice.sync()).filter((m) => m.content?.run?.kind !== 'request').map((m) => m.content?.text);
    let jobs = 0;
    const runs = new Runs(bot, async () => {
      jobs++;
      return { branch: 'agent/k1' };
    });
    // Two requests in one check-in.
    await alice.send(generalId, { text: 'Run K-1 with Bot', run: await runOf() });
    await alice.send(generalId, { text: 'Run K-1 with Bot again', run: await runOf() });
    await Promise.all((await bot.sync()).map((m) => runs.handle(m)));
    assert.deepEqual((await reports()).sort(), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: K-1 is already running.', 'I finished K-1 on agent/k1.']);
    assert.equal(jobs, 1);
  });

  test('refuses a second request for the card it runs, however late it comes, runs another card beside it, and runs the card again once it ended (K-51, R-037)', async () => {
    k2 = newKeyId().slice(0, 11);
    await alice.editSection(roadmap, k2, () => ({ text: k2Text, pos: 2 }));
    let end!: () => void;
    const gate = new Promise<void>((resolve) => (end = resolve));
    const jobs: string[] = [];
    const runs = new Runs(bot, async ({ request }) => {
      jobs.push(request.card);
      await gate;
      throw new Error('Not today.');
    });
    const ask = async (run: RunDTO) => (await alice.send(generalId, { text: `Run ${run.kind === 'request' ? run.card : ''} with Bot`, run })).id;
    const handle = async () => {
      for (const m of await bot.sync()) await runs.handle(m);
    };
    const first = await ask(await runOf());
    const handled = Promise.all((await bot.sync()).map((m) => runs.handle(m)));
    while (!jobs.length) await sleep(10);
    // Another tab or device sent these before it saw the first request's reports, a check-in later.
    const twice = await ask(await runOf());
    const elsewhere = await ask(await runOfK2());
    const beside = Promise.all((await bot.sync()).map((m) => runs.handle(m)));
    while (jobs.length < 2) await sleep(10);
    assert.deepEqual(runs.running.map((r) => r.card), ['K-1', 'K-2'], 'both cards run at once');
    end();
    await Promise.all([handled, beside]);
    // The run failed, so the owner runs the card again.
    const again = await ask(await runOf());
    await handle();

    const heard = await alice.sync();
    const on = (id: number) => heard.filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id).map((m) => m.content?.text);
    assert.deepEqual(on(first), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: Not today.']);
    assert.deepEqual(on(twice), ['I could not run K-1: K-1 is already running.']);
    assert.deepEqual(on(elsewhere), ['I am on K-2: Sums are off', 'I could not run K-2: Not today.']);
    assert.deepEqual(on(again), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: Not today.']);
    assert.deepEqual(jobs, ['K-1', 'K-2', 'K-1']);
  });

  test('runs a request once, however often the server posts it (K-47)', async () => {
    let jobs = 0;
    const runs = new Runs(bot, async () => (jobs++, { branch: 'agent/k1' }));
    await alice.send(generalId, { text: 'Run K-1 with Bot', run: await runOf() });
    const [request] = await bot.sync();
    await runs.handle(request!);
    // The same signed message under a new id, as a server that keeps no promises could post it.
    await runs.handle({ ...request!, id: request!.id + 1000 });
    // A daemon started again remembers it too.
    await new Runs(await AgentClient.load(botFile), async () => (jobs++, { branch: 'agent/k1' })).handle({ ...request!, id: request!.id + 2000 });
    assert.equal(jobs, 1);
    const reports = (await alice.sync()).filter((m) => m.content?.run?.kind !== 'request').map((m) => m.content?.text);
    assert.deepEqual(reports, ['I am on K-1: Pushes with bad keys', 'I finished K-1 on agent/k1.']);
  });

  test('pins the keys its owner checked, so a card a teammate with new keys wrote runs (K-57, D-110)', async () => {
    // The bot pinned other keys for Carol than the server shows, as when her keys changed.
    await fs.writeFile(botFile, JSON.stringify({ ...JSON.parse(await fs.readFile(botFile, 'utf8')), pins: { [alice.id]: await keyFingerprint(alice.identity.publicKeys), [carol.id]: 'old' } }));
    bot = await AgentClient.load(botFile);
    await bot.sync();
    assert.equal(bot.keysOf(carol.id), null);
    const written = `${cardText}\n\nCarol saw it too.`;
    await carol.editSection(roadmap, cardId, () => ({ text: written, pos: 1 }));
    // Alice's page opens Carol's text, since Alice checked her code, and hashes it into the brief.
    const runs = new Runs(bot, async () => ({ branch: 'agent/k1' }));
    const start = async () => {
      const id = (await alice.send(generalId, { text: 'Run K-1 with Bot', run: await runOf() })).id;
      for (const m of await bot.sync()) await runs.handle(m);
      return (await alice.sync()).filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id).map((m) => m.content?.text);
    };
    assert.deepEqual(await start(), ['I could not run K-1: I can’t find that card on the board anymore. Open it again and press Start.']);

    const direct = (await alice.request<{ id: number }>('POST', '/conversations/direct', { userId: bot.id, key: await newChatKey(alice, [alice.id, bot.id]) })).id;
    const fingerprint = await keyFingerprint(carol.identity.publicKeys);
    const trust = (from: AgentClient, chat: number, trusted: { fingerprint?: string; sentAt?: number } = {}) =>
      from.send(chat, { text: 'I checked Carol’s security code.', trust: { user: carol.id, fingerprint, sentAt: Date.now(), ...trusted } });
    // Nobody but the owner, in their direct chat, and only for the keys the server shows now.
    await alice.sync();
    await carol.sync();
    await trust(carol, generalId);
    await trust(alice, generalId);
    await trust(alice, direct, { fingerprint: 'other' });
    await bot.sync();
    assert.equal(bot.keysOf(carol.id), null);

    // However late it comes: Claude Code may have been closed when Alice checked the code.
    const sentAt = Date.now() - REQUEST_TTL_MS - 1000;
    const checked = await trust(alice, direct, { sentAt });
    await bot.sync();
    assert.deepEqual(bot.keysOf(carol.id), carol.identity.publicKeys);
    assert.equal(JSON.parse(await fs.readFile(botFile, 'utf8')).pins[carol.id], fingerprint);
    assert.deepEqual(await start(), ['I am on K-1: Pushes with bad keys', 'I finished K-1 on agent/k1.']);

    // A check older than the one it pinned, played again, pins nothing.
    await fs.writeFile(botFile, JSON.stringify({ ...JSON.parse(await fs.readFile(botFile, 'utf8')), pins: { [alice.id]: await keyFingerprint(alice.identity.publicKeys), [carol.id]: 'old' } }));
    const older = await trust(alice, direct, { sentAt: sentAt - 1 });
    bot = await AgentClient.load(botFile);
    await bot.sync();
    assert.ok(older.id > checked.id);
    assert.equal(bot.keysOf(carol.id), null);
    await alice.editSection(roadmap, cardId, () => ({ text: cardText, pos: 1 }));
    await trust(alice, direct);
    await bot.sync();
  });

  test('stops a run when its owner cancels it, and for nobody else (R-030)', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const runs = new Runs(bot, ({ signal }) => {
      started();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('the owner cancelled the run.'))));
    });
    const id = (await alice.send(generalId, { text: 'Run K-1 with Bot', run: await runOf() })).id;
    const handled = Promise.all((await bot.sync()).map((m) => runs.handle(m)));
    await running;
    await carol.send(generalId, { text: 'Cancel K-1 with Bot', run: { kind: 'cancel', request: id } });
    for (const m of await bot.sync()) await runs.handle(m);
    assert.deepEqual(runs.running.map((r) => r.card), ['K-1'], "a teammate's cancel stops nothing");
    await alice.send(generalId, { text: 'Cancel K-1 with Bot', run: { kind: 'cancel', request: id } });
    for (const m of await bot.sync()) await runs.handle(m);
    await handled;
    // Its next check-in says it is idle again.
    await bot.sync();
    const reports = (await alice.sync()).filter((m) => m.senderId === bot.id).map((m) => m.content?.text);
    assert.deepEqual(reports, ['I am on K-1: Pushes with bad keys', 'I could not run K-1: the owner cancelled the run.']);
  });

  test('reports each run that a restart cut short as failed (K-46, R-037)', async () => {
    const ids = [
      (await alice.send(generalId, { text: 'Run K-1 with Bot', run: await runOf() })).id,
      (await alice.send(generalId, { text: 'Run K-2 with Bot', run: await runOfK2() })).id,
    ];
    // The daemon stops mid-run: its runners never return.
    let started = 0;
    const runs = new Runs(bot, () => (started++, new Promise(() => {})));
    for (const m of await bot.sync()) void runs.handle(m);
    while (started < 2) await sleep(10);
    const saved = async () => JSON.parse(await fs.readFile(botFile, 'utf8')).running;
    assert.deepEqual(await saved(), [
      { message: ids[0], conversation: generalId, card: 'K-1' },
      { message: ids[1], conversation: generalId, card: 'K-2' },
    ]);

    // Started again from its file, it no longer sees the requests: the cursor is past them.
    bot = await AgentClient.load(botFile);
    assert.deepEqual(await bot.sync(), []);
    const restarted = new Runs(bot, async () => ({ branch: 'agent/k1' }));
    await restarted.recover();
    assert.deepEqual(await saved(), []);
    await restarted.recover();
    const heard = await alice.sync();
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
    const old = path.join(home, 'old-account.json');
    const taken = { message: 1, conversation: generalId, card: 'K-1' };
    await fs.writeFile(old, JSON.stringify({ ...JSON.parse(await fs.readFile(botFile, 'utf8')), running: taken }));
    assert.deepEqual((await AgentClient.load(old)).running, [taken]);
  });

  test("names each run's branch after its card, apart from the branches here and on origin", async () => {
    // A repository with a remote, as a student's checkout has.
    const origin = path.join(home, 'origin.git');
    const repo = path.join(home, 'repo');
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
    const again = await AgentClient.load(botFile);
    assert.equal(again.id, bot.id);
    await alice.send(generalId, { text: 'Still there?' });
    assert.deepEqual((await again.sync()).map((m) => m.content?.text), ['Still there?']);

    await again.api.request('POST', '/auth/logout');
    await alice.send(generalId, { text: 'And now?' });
    assert.deepEqual((await again.sync()).map((m) => m.content?.text), ['And now?']);
    const file = JSON.parse(await fs.readFile(botFile, 'utf8')) as { cookie: string };
    assert.equal(file.cookie, again.api.cookie, 'the new session is on disk');
  });
  test(
    'serves every folder from one window, runs a card in a background Claude, fixes its pull request, and clones a repository on its owner\'s word (R-030, R-035, R-036)',
    { timeout: 60_000 },
    async () => {
      // A checkout whose origin is on GitHub, as its config says. Its pushes land in a bare repository here.
      const origin = path.join(home, 'app.git');
      const project = path.join(home, 'app');
      await sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      await sh('git', ['clone', '-q', origin, project]);
      await fs.writeFile(path.join(project, 'README.md'), '# App\n');
      await git(project, 'add', 'README.md');
      await git(project, 'commit', '-q', '-m', 'Start');
      await git(project, 'push', '-q', '-u', 'origin', 'main');
      await git(project, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
      await git(project, 'config', `url.${origin}.insteadOf`, 'https://github.com/acme/app.git');
      const bin = path.join(home, 'bin');
      await fs.mkdir(bin);
      await fs.writeFile(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
      await fs.writeFile(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
      await fs.writeFile(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
      const ghState = path.join(home, 'gh.json');
      await fs.writeFile(ghState, JSON.stringify({ origin, pulls: [] }));
      const claudeLog = path.join(home, 'claude.log');
      const gitConfig = path.join(home, 'gitconfig');
      // The agent's own clone fetches from GitHub's address, which the test points at its bare repository.
      await fs.writeFile(gitConfig, `[user]\n\tname = Alice\n\temail = alice@example.com\n[url "${origin}"]\n\tinsteadOf = https://github.com/acme/app.git\n`);
      const restore = setEnv({
        GIT_CONFIG_GLOBAL: gitConfig,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FAKE_GH_STATE: ghState,
        FAKE_CLAUDE_LOG: claudeLog,
        FAKE_CODEX_LOG: path.join(home, 'codex.log'),
        GH_CONFIG_DIR: path.join(home, 'gh'),
        CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      });
      const dataDir = path.join(home, 'plugin');
      // The owner turned the plan gate off for these runs; the gate has a run of its own below.
      await fs.mkdir(path.join(dataDir, 'laptop'), { recursive: true });
      await fs.writeFile(path.join(dataDir, 'laptop', 'setup.json'), JSON.stringify({ choice: { claudeMd: false, skills: [], noAttribution: false, noPlan: true } }));
      // The owner's settings turn the sandbox off, which no longer counts: the background Claude runs under the plugin's.
      await fs.mkdir(path.join(project, '.claude'));
      await fs.writeFile(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { enabled: false } }));
      const cloneRoot = path.join(home, 'WebChat');
      const options = { harnesses: [claudeHarness(path.join(bin, 'claude'), 'true', dataDir), codexHarness(path.join(bin, 'codex'), dataDir)], cloneRoot };
      // A window open in a folder that is no repository serves the agent all the same (R-036).
      const anywhere = path.join(home, 'anywhere');
      await fs.mkdir(anywhere);
      const turns = async () =>
        (await fs.readFile(claudeLog, 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { args: string[]; input: string; cwd: string; plugin?: string[]; session: string; resumed: boolean; turn: number; pid: number; mcp?: { mcpServers: { webchat: { url: string; headers: { Authorization: string } } } } });
      try {
        const code = newPairingCode();
        // The page shows its address with the code, so the address setting stays empty (R-031).
        const plugin = new Plugin({ ...options, code: `${baseUrl}#${code}`, dataDir, projectDir: anywhere });
        const starting = plugin.start();
        const pairingRows = async () => instance.sql.query<{ picks: string | null }>('SELECT picks FROM webchat.pairings WHERE id = $1', [await pairingId(code)]);
        await waitFor('the pairing is filed', async () => (await pairingRows()).length > 0);
        const [filed] = await pairingRows();
        assert.ok(filed!.picks && !/Claude|Codex/.test(Buffer.from(filed!.picks, 'base64url').toString('latin1')), 'the server holds the picks sealed');
        assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'setup.json'), 'utf8')).choice.linked, undefined, 'nothing links before the owner approves');
        const agent = await approve(alice, code, 'Claude Code');
        assert.equal(await starting, true);
        assert.deepEqual(await openPicks(code, agent.keys!, filed!.picks), [{ name: 'Claude Code', version: '2.1.300', signedIn: true }, { name: 'Codex', version: '0.58.0', signedIn: true }]);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'setup.json'), 'utf8')).choice.linked, ['Claude Code', 'Codex'], 'the approved picks link');
        // The agent is online with no folder yet, and says what its laptop can do (R-036, D-103).
        await plugin.client!.sync();
        await alice.sync();
        assert.deepEqual([alice.users.get(agent.id)?.online, alice.users.get(agent.id)?.protocol, alice.users.get(agent.id)?.agentRepos], [true, 5, []]);
        assert.match(await plugin.call('connect'), /This folder is no GitHub repository/);
        // A window in a checkout the owner has connects it, and the serving window works there.
        assert.match(await new Plugin({ ...options, code: '', dataDir, projectDir: project }).call('connect'), /Connected acme\/app: your agent works in this folder/);
        await plugin.scan();
        await plugin.client!.sync();
        await alice.sync();
        assert.deepEqual(alice.users.get(agent.id)?.agentRepos.map((seat) => [seat.repo, seat.online, seat.protocol]), [['acme/app', true, 5]]);
        // The status names the address that came with the code, whatever the owner's settings say.
        assert.deepEqual((await plugin.call('status')).split('\n').slice(0, 2), [`Taking the cards that Alice hands to this agent, on ${baseUrl}.`, `Working in acme/app in ${project}.`]);

        const key = await newChatKey(alice, [alice.id, agent.id, carol.id]);
        const app = await alice.request<CreateProjectResponse>('POST', '/projects', { name: 'App', memberIds: [agent.id, carol.id], key });
        const general = app.channel.id;
        await alice.sync();
        await carol.sync();
        const board = { id: newKeyId(), conversationId: general };
        const section = newKeyId().slice(0, 11);
        await alice.request('POST', '/docs', {
          ...board,
          revisions: [
            { section: 'title', envelope: await alice.sealDoc(board, 'title', { text: 'Roadmap', board: 'roadmap' }) },
            { section, envelope: await alice.sealDoc(board, section, { text: '### K-7: Sums are off by one\n\nStatus: Open.', pos: 1 }) },
          ],
        });
        // The hash of the brief Alice saw: the card, and no decisions on this board (D-105).
        const brief = await textHash(briefText('### K-7: Sums are off by one\n\nStatus: Open.', []));
        const today = new Date().toISOString().slice(0, 10);
        const ask = (from: AgentClient, extra: Partial<RunRequest> = {}) =>
          from.send(general, {
            text: 'Run K-7 with Claude Code',
            run: { kind: 'request', card: 'K-7', title: 'Sums are off by one', docId: board.id, section, runtime: agent.id, sentAt: Date.now(), repo: 'acme/app', hash: brief, ...extra },
          });
        // A check-in of the plugin's, which hands each message on as its loop does.
        const checkIn = async () => {
          const heard: OpenedMessage[] = await plugin.client!.sync();
          return { heard, handled: Promise.all(heard.map((m) => plugin.handle(m))) };
        };
        // The agent's reports on a request, each with its run field, or only their texts.
        const reports = async (request: number, reader = alice) =>
          (await reader.sync())
            .filter((m) => m.senderId === agent.id && m.content?.run?.kind !== 'request' && m.content?.run?.request === request)
            .map((m) => ({ text: m.content!.text, run: m.content!.run as RunReport }));
        const reportsOn = async (request: number, reader = alice) => (await reports(request, reader)).map((r) => r.text);
        type FakePull = { head: string; base: string; draft: boolean; title: string; body: string; edited?: object; closed?: string; view?: object };
        const pullsNow = async () => JSON.parse(await fs.readFile(ghState, 'utf8')).pulls as FakePull[];

        // A teammate's request is refused.
        const fromCarol = (await ask(carol)).id;
        await (await checkIn()).handled;
        assert.deepEqual(await reportsOn(fromCarol), ['I could not run K-7: Only Alice hands cards to me.']);
        assert.deepEqual(await turns(), [], 'no Claude ran for it');

        // Alice's request starts a run, which holds at the gate.
        const gate = path.join(home, 'gate');
        const asked = await withEnv({ FAKE_CLAUDE_GATE: gate }, async () => {
          const id = (await ask(alice)).id;
          const { heard, handled } = await checkIn();
          await waitFor('the background Claude started', async () => (await turns()).length === 1);
          // The same signed request under a new id, as a server could post it again, starts nothing (K-47).
          await plugin.handle({ ...heard[0]!, id: heard[0]!.id + 1000 });
          // Another tab's request for the card that runs fails at once (K-51). Carol reads the
          // report, so Alice's next check-in still holds the run's own.
          const twice = (await ask(alice)).id;
          await (await checkIn()).handled;
          assert.deepEqual(await reportsOn(twice, carol), ['I could not run K-7: K-7 is already running.']);
          assert.equal((await turns()).length, 1, 'only the run started Claude');
          // Put to sleep, the agent finishes the card it runs and starts nothing new until a wake (K-66).
          assert.match(await plugin.call('sleep'), /goes to sleep once it finishes K-7\./);
          assert.match(await plugin.call('status'), /Every card fails at once: I am going to sleep, so I start nothing new/);
          assert.match(await plugin.call('wake'), /waking up/);
          assert.match(await plugin.call('wake'), /not asleep/);
          await fs.writeFile(gate, '');
          await handled;
          return id;
        });
        const branch = 'agent/k-7-sums-are-off-by-one';
        assert.deepEqual(await reportsOn(asked), ['I am on K-7: Sums are off by one', `I finished K-7 on ${branch} (acme/app#1). Sums add up now.`]);
        const pullsFile = path.join(dataDir, 'laptop', 'pulls.json');
        assert.equal(JSON.parse(await fs.readFile(pullsFile, 'utf8'))[0].harness, 'Claude Code', 'a request that names no harness ran on the host, which its rounds keep');

        // Two turns ran in a worktree of the checkout, restricted, under the plugin's settings: the
        // check that the card holds, then the work, in the same session (R-042).
        const [first, work] = await turns();
        const worktree = first!.cwd;
        assert.ok(worktree.startsWith(path.join(await fs.realpath(project), '.claude', 'worktrees')), 'the worktree is in the checkout, where the sandboxed shell may write');
        const settings = path.join(dataDir, 'laptop', 'claude.json');
        assert.ok(first!.args.includes('--restricted'));
        assert.equal(first!.args[first!.args.indexOf('--settings') + 1], settings);
        assert.ok(!first!.resumed);
        assert.ok(first!.input.includes('### K-7: Sums are off by one'), 'the brief holds the card');
        assert.ok(first!.input.includes('check that the card still holds'), 'the first turn checks the card');
        assert.equal(work!.session, first!.session, 'the work resumes the check');
        assert.ok(work!.input.includes('acme/app#1 claims it'), 'the draft claims the card before the work');
        const denied = JSON.parse(await fs.readFile(settings, 'utf8')).sandbox.filesystem.denyRead;
        assert.ok(denied.includes(dataDir) && denied.includes(process.env.GH_CONFIG_DIR), 'the shell cannot read the plugin or gh');

        // It pushed its own branch only, the claim before the work, and opened the draft with the
        // check in its body, which the work's title and body then replaced (R-042).
        assert.deepEqual((await sh('git', ['--git-dir', origin, 'branch', '--format=%(refname:short)'])).stdout.trim().split('\n').sort(), [branch, 'main']);
        const log = async (head: string) => (await sh('git', ['--git-dir', origin, 'log', '--format=%s', `main..${head}`])).stdout.trim().split('\n');
        assert.deepEqual(await log(branch), ['Change sum.test.js', 'chore: Claim K-7']);
        const gh = JSON.parse(await fs.readFile(ghState, 'utf8'));
        const claim = { title: 'K-7: Sums are off by one', body: `Claims K-7. Checked ${today}: Read K-7 and sum.js on main.` };
        assert.deepEqual(gh.pulls, [{ head: branch, base: 'main', draft: true, ...claim, edited: { title: 'Fix sums', body: 'Sums were off by one.' } }]);

        // CI fails on it: Claude gets another round, in the same session, with the log.
        const failing = { statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/7/job/8' }] };
        await fs.writeFile(ghState, JSON.stringify({ ...gh, pulls: [{ ...gh.pulls[0], view: failing }] }));
        await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'done', note: 'The test passes.' }) }, () => plugin.pollPulls());
        const [, , fix] = await turns();
        assert.equal(fix!.session, first!.session, 'the fix resumes the first turn');
        assert.equal(fix!.cwd, worktree);
        assert.ok(fix!.input.includes('CI failed: test') && fix!.input.includes('expected 3, got 4'), 'the brief says what failed, with the end of its log');
        assert.deepEqual(await reportsOn(asked), ['I am back on K-7: CI failed: test', `I finished K-7 on ${branch} (acme/app#1). The test passes.`]);
        assert.equal(JSON.parse(await fs.readFile(ghState, 'utf8')).pulls.length, 1, 'the fix went to the same pull request');

        // A teammate's review waits for Alice's go, with the comments in full (D-105).
        const reviewed = { reviews: [{ author: { login: 'bob' }, body: 'Please rename sum.', submittedAt: new Date().toISOString() }], updatedAt: new Date().toISOString() };
        await fs.writeFile(ghState, JSON.stringify({ ...gh, pulls: [{ ...gh.pulls[0], view: reviewed }] }));
        await plugin.pollPulls();
        assert.equal((await turns()).length, 3, 'nothing runs before the go');
        const [review] = (await alice.sync()).filter((m) => m.senderId === agent.id && m.content?.run?.kind === 'review');
        assert.equal(review?.content?.text, 'bob asked for changes on acme/app#1:\n\n- bob: Please rename sum.');
        // A go without the review runs only Alice's words, and none of Bob's text she did not approve.
        await alice.send(general, { text: 'Let the agent fix it', run: { kind: 'fix', request: asked, review: review!.id, note: 'Call it add.', sentAt: Date.now() } });
        await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'done', note: 'Renamed.' }) }, async () => (await checkIn()).handled);
        const [, , , go] = await turns();
        assert.ok(go!.input.includes('Please rename sum.') && go!.input.includes('Call it add.'), "the round has the review and Alice's words");
        assert.ok(go!.input.startsWith('You are fixing the draft') && !go!.input.includes("OWNER'S WORDS"), 'a draft that is not paused gets the fix brief');
        assert.deepEqual(await reportsOn(asked), ['I am back on K-7: review from bob', `I finished K-7 on ${branch} (acme/app#1). Renamed.`]);

        // Someone else pushes to it: it is theirs now, and Claude runs no more.
        await git(worktree, 'commit', '-q', '--allow-empty', '-m', 'By hand');
        await git(worktree, 'push', '-q', 'origin', `HEAD:${branch}`);
        await plugin.pollPulls();
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'pulls.json'), 'utf8')), []);
        assert.deepEqual(await reportsOn(asked), ['I stopped watching acme/app#1: someone else pushed to it.']);
        assert.equal((await turns()).length, 4, 'four turns in all');

        // Its owner's prompt in their direct chat is answered in a scratch repository of its own, never pushed (R-035).
        const direct = (await alice.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(alice, [alice.id, agent.id]) })).id;
        await alice.sync();
        await plugin.client!.sync();
        const branches = async () => (await sh('git', ['--git-dir', origin, 'branch', '--format=%(refname:short)'])).stdout.trim().split('\n').sort();
        const before = await branches();
        // Its own branches only: each turn fetches, which moves origin's.
        const refs = async () => (await git(project, 'for-each-ref', 'refs/heads')).stdout;
        const refsBefore = await refs();
        const tell = async (prompt: PromptDTO, text: string) => {
          const sent = await alice.send(direct, { text, prompt });
          await Promise.all((await plugin.client!.sync()).map((m) => plugin.handle(m)));
          return sent.clientId!;
        };
        const answers = async () => (await alice.sync()).filter((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'answer').map((m) => m.content?.text);
        // Every turn reads the decisions the team holds and the repository's open pull requests (R-041).
        const decisions = { id: newKeyId(), conversationId: general };
        const [held, gone] = [newKeyId().slice(0, 11), newKeyId().slice(0, 11)];
        await alice.request('POST', '/docs', {
          ...decisions,
          revisions: [
            { section: 'title', envelope: await alice.sealDoc(decisions, 'title', { text: 'Decisions', board: 'decisions' }) },
            { section: held, envelope: await alice.sealDoc(decisions, held, { text: '### D-1: Sums stay exact\n\nStatus: Accepted.', pos: 1 }) },
            { section: gone, envelope: await alice.sealDoc(decisions, gone, { text: '### D-2: Sums round\n\nStatus: Superseded by D-1.', pos: 2 }) },
          ],
        });
        const ghNow = JSON.parse(await fs.readFile(ghState, 'utf8'));
        await fs.writeFile(ghState, JSON.stringify({ ...ghNow, open: [{ number: 5, title: 'Fix sums' }] }));
        // Alice has her agent load parts of her Claude setup into every turn and run (R-039, D-115).
        await instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        const claudeDir = path.join(home, 'claude');
        const skill = path.join(claudeDir, 'skills', 'commit-style');
        await fs.mkdir(path.join(skill, 'references'), { recursive: true });
        await fs.writeFile(path.join(claudeDir, 'CLAUDE.md'), 'Write short commit messages.\n');
        await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: commit-style\ndescription: >\n  Writes commit\n  messages.\n---\nUse the imperative.\n');
        await fs.writeFile(path.join(skill, 'references', 'style.md'), 'At most 50 characters.\n');
        // A link in a skill could lead to a secret, so the copy leaves it out.
        await fs.symlink(path.join(dataDir, 'account.json'), path.join(skill, 'key.json'));
        await fs.mkdir(path.join(claudeDir, 'skills', 'other'));
        await fs.writeFile(path.join(claudeDir, 'skills', 'other', 'SKILL.md'), '---\nname: other\ndescription: "Does other things."\n---\n');
        // The agent's answers, each naming the ask it answers.
        const setup = async (from: AgentClient, chat: number, choice?: SetupChoice) => {
          const sent = await from.send(chat, { text: 'Settings', setup: { sentAt: Date.now(), ...(choice && { choice }) } });
          await Promise.all((await plugin.client!.sync()).map((m) => plugin.handle(m)));
          const states = (await alice.sync()).filter((m) => m.senderId === agent.id && m.content?.setupState).map((m) => m.content!.setupState!);
          return states.map(({ to, ...state }) => (assert.equal(to, sent.clientId), state));
        };
        const offer = { claudeMd: true, skills: [{ name: 'commit-style', description: 'Writes commit messages.' }, { name: 'other', description: 'Does other things.' }] };
        // The runs before loaded nothing of it, as nothing was chosen.
        const { harnesses, ...shown } = (await setup(alice, direct))[0]!;
        assert.deepEqual({ ...shown, applied: { ...shown.applied, at: 0 } }, { ...offer, choice: { claudeMd: false, skills: [], noAttribution: false, linked: ['Claude Code', 'Codex'], noPlan: true }, applied: { claudeMd: false, skills: [], noAttribution: false, at: 0 } });
        const claudeCode = { name: 'Claude Code', path: path.join(bin, 'claude'), linked: true, attention: undefined, version: '2.1.300', signedIn: true, answers: undefined, refusal: undefined, instructions: path.join(claudeDir, 'CLAUDE.md'), skills: path.join(claudeDir, 'skills'), knobs: ['noAttribution', 'noPlan'] };
        const codexState = { name: 'Codex', path: path.join(bin, 'codex'), linked: true, attention: undefined, version: '0.58.0', signedIn: true, answers: undefined, refusal: CODEX_GAP, instructions: '~/.codex/AGENTS.md', skills: '~/.agents/skills', knobs: [] };
        assert.deepEqual(harnesses, [claudeCode, codexState], 'the pane learns each harness the laptop has, the knobs it honors, and why Codex takes no cards');
        // Turned off, Claude Code leaves the linked harnesses, and only Codex is left, which takes no cards; a page from before the list keeps it off.
        const [{ harnesses: offHarnesses }] = await setup(alice, direct, { claudeMd: false, skills: [], noAttribution: false, off: ['Claude Code'] });
        assert.deepEqual(
          offHarnesses!.map((h) => [h.name, h.answers]),
          [['Claude Code', 'You turned Claude Code off, so I start nothing with it. Link it in my settings under Coding agents.'], ['Codex', undefined]],
          'a question may still pick Codex, which answers though it takes no cards',
        );
        await setup(alice, direct, { claudeMd: false, skills: [], noAttribution: false });
        assert.match(await plugin.call('status'), /Every card fails at once: Codex’s sandbox[\s\S]*Linked: Codex\./);
        // Carol's word changes nothing and hears nothing; Alice's is kept, a skill she chose that is gone too.
        const chosen = { claudeMd: true, skills: ['commit-style', 'gone'], noAttribution: true, noPlan: true };
        assert.deepEqual(await setup(carol, general, chosen), []);
        assert.deepEqual((await setup(alice, direct, { ...chosen, off: [] })).map((s) => s.choice), [{ ...chosen, off: [], linked: ['Claude Code', 'Codex'] }]);
        assert.deepEqual(JSON.parse(await fs.readFile(settings, 'utf8')).attribution, { commit: '', pr: '' }, 'the settings hide the attribution lines');
        // A prompt naming a coding agent the laptop does not have fails with the reason, and no turn runs.
        const turnsBeforePrompts = (await turns()).length;
        await tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, harness: 'Hermes' }, 'What does sum.js do?');
        const refusedPrompt = (await alice.sync()).filter((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'failed').map((m) => m.content?.text);
        assert.deepEqual(refusedPrompt, ['I could not answer. I have no Hermes on this laptop. Pick another coding agent.']);
        assert.equal((await turns()).length, turnsBeforePrompts, 'no Claude ran for it');
        // One naming Codex is answered by it, in a scratch copy: it takes no cards, but answers only is the floor.
        await tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, harness: 'Codex' }, 'What does sum.js do?');
        const codexAnswer = (await alice.sync()).filter((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'answer').map((m) => m.content?.text);
        assert.deepEqual(codexAnswer.slice(-1), ['It adds.']);
        assert.equal((await turns()).length, turnsBeforePrompts, 'no Claude ran for it either');
        // The owner links each harness (docs/decisions/harness-linking.md): only linked ones run, and a prompt that names none runs on the first she linked.
        const lkLink = (...linked: string[]) => setup(alice, direct, { ...chosen, linked, off: [] });
        const lkFailures = async () => (await alice.sync()).filter((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'failed').map((m) => m.content?.text);
        const lkHarnessOf = async (root: string) => (JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'conversations.json'), 'utf8')) as Array<{ root: string; harness?: string }>).find((c) => c.root === root)?.harness;
        const lkCodexPrompt = () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, harness: 'Codex' }, 'What does sum.js do?');
        const lkPlain = () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id }, 'What does sum.js do?');
        const lkNotLinked = (name: string) => [`I could not answer. You have not linked ${name}, so I start nothing with it. Link it in my settings under Coding agents.`];
        const [lkOnlyClaude] = await lkLink('Claude Code');
        assert.deepEqual(lkOnlyClaude!.harnesses!.map((h) => [h.name, harnessRow(h)]), [['Claude Code', 'linked'], ['Codex', 'found']]);
        assert.equal(plugin.client!.protocol, 15, 'Claude Code linked, and gh signed in: cards, and it asks');
        await lkCodexPrompt();
        assert.deepEqual(await lkFailures(), lkNotLinked('Codex'));
        assert.equal(await lkHarnessOf(await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"It adds."}' }, lkPlain)), 'Claude Code', 'Claude Code still runs');
        await lkLink('Codex', 'Claude Code');
        assert.equal(plugin.client!.protocol, 15);
        assert.equal(await lkHarnessOf(await lkPlain()), 'Codex', 'a prompt that names none runs on the first she linked');
        const [lkOnlyCodex] = await lkLink('Codex');
        assert.equal(plugin.client!.protocol, 13, 'Codex takes no cards, so the union has none, but it asks');
        assert.deepEqual(lkOnlyCodex!.harnesses!.map((h) => harnessRow(h)), ['found', 'linked']);
        await lkLink();
        assert.equal(plugin.client!.protocol, 5, 'with none linked the agent still answers settings');
        assert.match(await plugin.call('status'), /Every card fails at once: You have linked no coding agent[\s\S]*Linked: none\./);
        await lkPlain();
        assert.deepEqual(await lkFailures(), ['I could not answer. You have linked no coding agent on this laptop, so I start nothing. Link one in my settings under Coding agents.']);

        // `webchat-agent link`: the laptop asks in the owner's direct chat, and only her signed word links it, once (D-089, K-47).
        const lkAsks = async () => (await alice.sync()).filter((m) => m.senderId === agent.id && m.content?.ask).map((m) => m.content!);
        const lkAnswer = async (from: AgentClient, chat: number, step: 'approve' | 'decline', to: string, extra: object = {}) => {
          await from.send(chat, { text: 'Answer', ask: { kind: 'link', step, to, sentAt: Date.now(), ...extra } as MessageContent['ask'] });
          const lkHeard = await plugin.client!.sync();
          await Promise.all(lkHeard.map((m) => plugin.handle(m)));
          return lkHeard;
        };
        const lkLinked = async () => (JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'setup.json'), 'utf8')) as { choice: SetupChoice }).choice.linked;
        // What the laptop remembers it asked, by the request message's client id.
        const lkPending = () => (plugin as unknown as { setup: { asks?: Record<string, { what: string; at: number }> } }).setup.asks ?? {};
        await lkLink('Claude Code');
        const lkDir = path.join(dataDir, 'asks');
        const lkFile = (name: string, body: object) => fs.writeFile(path.join(lkDir, name), JSON.stringify(body));
        assert.match(await plugin.requestLink('Codex'), /Approve it in WebChat/);
        // A file naming no supported harness, or filed more than 10 minutes ago, sends nothing.
        await lkFile('hermes.json', { kind: 'link', harness: 'Hermes', at: Date.now() });
        await lkFile('old.json', { kind: 'link', harness: 'Codex', at: Date.now() - REQUEST_TTL_MS - 1000 });
        await plugin.sendAsks();
        assert.deepEqual((await lkAsks()).map((c) => c.ask), [{ kind: 'link', step: 'request', harness: 'Codex' }]);
        assert.equal((await fs.readdir(lkDir)).length, 0, 'every file was taken');
        // One request waits for each harness.
        await plugin.requestLink('Codex');
        await plugin.sendAsks();
        assert.deepEqual(await lkAsks(), []);
        const [lkAsked] = Object.keys(lkPending());
        // Not the owner's word: Carol's, one outside the direct chat, a request nobody made, and one signed too long ago.
        await lkAnswer(carol, general, 'approve', lkAsked!);
        await lkAnswer(alice, general, 'approve', lkAsked!);
        await lkAnswer(alice, direct, 'approve', 'nobody');
        await lkAnswer(alice, direct, 'approve', lkAsked!, { sentAt: Date.now() - REQUEST_TTL_MS - 1000 });
        assert.deepEqual(await lkLinked(), ['Claude Code']);
        // Her approve links the harness the laptop recorded, whatever name the message adds, and says so.
        const lkHeard = await lkAnswer(alice, direct, 'approve', lkAsked!, { harness: 'Claude Code' });
        assert.deepEqual(await lkLinked(), ['Claude Code', 'Codex']);
        assert.equal(plugin.client!.protocol, 15);
        assert.ok((await lkAsks()).some((c) => c.ask?.step === 'done'), 'the laptop says it linked it');
        // The same message again, or another that names the same request, changes nothing.
        await lkLink('Claude Code');
        await plugin.handle(lkHeard.find((m) => m.content?.ask)!);
        await lkAnswer(alice, direct, 'approve', lkAsked!);
        assert.deepEqual(await lkLinked(), ['Claude Code']);
        // A decline links nothing; a request left past 10 minutes fails with a note.
        await plugin.requestLink('Codex');
        await plugin.sendAsks();
        const lkDeclined = Object.keys(lkPending()).find((id) => id !== lkAsked)!;
        await lkAnswer(alice, direct, 'decline', lkDeclined);
        assert.deepEqual(await lkLinked(), ['Claude Code']);
        await plugin.requestLink('Codex');
        await plugin.sendAsks();
        const lkLapsed = Object.keys(lkPending()).find((id) => id !== lkAsked && id !== lkDeclined)!;
        lkPending()[lkLapsed]!.at -= REQUEST_TTL_MS + 1000;
        await lkAsks();
        await lkAnswer(alice, direct, 'approve', lkLapsed);
        assert.deepEqual(await lkLinked(), ['Claude Code']);
        assert.match((await lkAsks()).find((c) => c.ask?.step === 'failed')?.text ?? '', /older than 10 minutes/);
        await lkLink('Claude Code', 'Codex');
        // The board Alice's page picked goes in the brief, and no other (D-104).
        const prompted = await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"It adds."}' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id }, 'What does sum.js do?'));
        const kept = JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'conversations.json'), 'utf8')) as Array<{ root: string; harness?: string }>;
        assert.equal(kept.find((c) => c.root === prompted)?.harness, 'Claude Code', 'a prompt that names no harness runs on the host, which each reply keeps');
        const [chat] = (await turns()).slice(-1);
        assert.ok(chat!.input.includes('### D-1: Sums stay exact') && !chat!.input.includes('### D-2'), 'the brief holds the decisions the team holds');
        assert.ok(chat!.input.includes('#5: Fix sums'), 'the brief holds the open pull requests');
        assert.ok(chat!.input.includes('Before you draft, check the draft'), 'the brief asks for the check');
        const scratch = chat!.cwd;
        assert.ok(scratch.startsWith(path.join(await fs.realpath(os.tmpdir()), 'webchat-scratch')), 'the prompt runs in a scratch repository, not in the project');
        assert.equal((await git(scratch, 'remote')).stdout.trim(), '', 'the scratch copy has no remote');
        assert.ok(!chat!.resumed, 'the first turn starts a session');
        assert.ok(chat!.input.includes('What does sum.js do?') && chat!.input.includes('scratch copy'), 'the brief holds the prompt');
        assert.ok(chat!.input.includes('opens a draft pull request'), 'the brief says a card run, unlike a question, ends in a draft');
        assert.deepEqual(await answers(), ['It adds.']);
        // The turn got her CLAUDE.md, the Skill tool, and copies of the chosen skills still there, with no link.
        const flag = (name: string) => chat!.args[chat!.args.indexOf(name) + 1]!;
        assert.equal(flag('--append-system-prompt-file'), path.join(claudeDir, 'CLAUDE.md'));
        assert.equal(flag('--tools'), 'Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Skill');
        assert.equal(flag('--add-dir'), flag('--plugin-dir'), "the skills' own files can be read");
        const copied = ['skills', 'skills/commit-style', 'skills/commit-style/SKILL.md', 'skills/commit-style/references', 'skills/commit-style/references/style.md'];
        assert.deepEqual(chat!.plugin, copied.map((f) => f.split('/').join(path.sep)), 'only skills/, with the chosen skills');
        assert.equal(existsSync(flag('--plugin-dir')), false, 'the copy goes once the turn ends');
        const [loaded] = await setup(alice, direct);
        assert.deepEqual({ ...loaded!.applied!, at: 0 }, { claudeMd: true, skills: ['commit-style'], noAttribution: true, at: 0 }, 'the pane learns what the turn loaded');
        assert.equal((await git(scratch, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'HEAD', 'the scratch copy is detached');
        const was = (await git(project, 'rev-parse', 'refs/remotes/origin/main')).stdout.trim();
        assert.equal((await git(scratch, 'rev-list', '--max-parents=0', 'HEAD')).stdout.trim(), was, 'it starts at origin/main, and the fake Claude commits on top');
        // A merge on GitHub between turns: the reply's copy moves to it, and the agent hears what moved.
        const merger = path.join(home, 'merger');
        await sh('git', ['clone', '-q', origin, merger]);
        await fs.writeFile(path.join(merger, 'merged.txt'), 'new\n');
        await git(merger, 'add', 'merged.txt');
        await git(merger, 'commit', '-q', '-m', 'Merge');
        await git(merger, 'push', '-q', 'origin', 'HEAD:main');
        const now = (await git(merger, 'rev-parse', 'HEAD')).stdout.trim();
        // A decision changes between turns, and a pull request opens: the reply holds both.
        await alice.sync();
        const decisionsDoc = (await alice.boardDocs(app.project.id)).decisions!;
        await alice.editSection(decisionsDoc, held, () => ({ text: '### D-1: Sums stay exact\n\nStatus: Accepted.\n\nWhy: money.', pos: 1 }));
        await fs.writeFile(ghState, JSON.stringify({ ...ghNow, open: [{ number: 5, title: 'Fix sums' }, { number: 6, title: 'Add a test' }] }));
        await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"Still adds."}' }, () => tell({ kind: 'reply', to: prompted, sentAt: Date.now() }, 'And sum.test.js?'));
        const [again] = (await turns()).slice(-1);
        assert.ok(again!.input.includes('Why: money.') && !again!.input.includes('### K-7'), 'the reply holds the decision that changed, and no card that did not');
        assert.ok(again!.input.includes('#6: Add a test'), 'the reply holds the open pull requests');
        assert.equal(again!.session, chat!.session, 'the reply resumes the session');
        assert.equal(again!.cwd, scratch);
        assert.ok(again!.input.includes('Your owner replies:') && again!.input.includes('And sum.test.js?'));
        assert.ok(again!.input.includes(`main moved from ${was.slice(0, 7)} to ${now.slice(0, 7)}`), 'the reply says what moved');
        assert.equal((await git(scratch, 'rev-list', '--max-parents=0', 'HEAD')).stdout.trim(), now, 'the copy moved to the merge');
        assert.match((await git(scratch, 'diff', '--stat', was, now)).stdout, /merged\.txt/, 'both commits are in the copy, so the agent can diff them');
        assert.deepEqual(await answers(), ['Still adds.']);
        // A draft that changes a card names it, with the hash of the text the brief held (D-104).
        assert.ok(chat!.input.includes('### K-7: Sums are off by one') && chat!.input.includes("TEAMMATES' TEXT START"), 'the brief holds the board, fenced');
        // Its related ids are only those the brief held: a superseded decision, a card or a pull request it never had are left out (R-041).
        const related = [
          { id: '#5', kind: 'duplicate', why: 'It fixes the same sums.' },
          { id: 'D-1', kind: 'conflict', why: 'Exact sums.' },
          { id: 'D-2', kind: 'conflict', why: 'Superseded.' },
          { id: 'K-99', kind: 'duplicate', why: 'Not on the board.' },
          { id: '#9', kind: 'duplicate', why: 'Not open.' },
        ];
        const card = { kind: 'issue', title: 'Sums are off by two', body: 'Seen: in the tests.', replaces: 'K-7', checked: 'Read 1 card, 1 decision, the code and 2 open pull requests.', related };
        const decision = { kind: 'decision', title: 'Sums round to cents', body: 'Why: money.', checked: 'Read D-1.' };
        await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ reply: 'Here is the change.', drafts: [card, decision] }), FAKE_CLAUDE_COMMIT: '0' }, () =>
          tell({ kind: 'reply', to: prompted, sentAt: Date.now() }, 'Draft a change to K-7.'),
        );
        const seen = await textHash('### K-7: Sums are off by one\n\nStatus: Open.');
        assert.deepEqual((await alice.sync()).filter((m) => m.senderId === agent.id).map((m) => [m.content?.text, m.content?.prompt]), [
          ['Here is the change.', { kind: 'answer', to: prompted }],
          [
            'Card draft: Sums are off by two',
            {
              kind: 'answer',
              to: prompted,
              card: { kind: 'K', title: 'Sums are off by two', body: 'Seen: in the tests.', replaces: { card: 'K-7', doc: board.id, section, seen }, checked: card.checked, related: related.slice(0, 2) },
            },
          ],
          ['Decision draft: Sums round to cents', { kind: 'answer', to: prompted, card: { kind: 'D', title: 'Sums round to cents', body: 'Why: money.', checked: 'Read D-1.' } }],
        ]);
        // Runs below hash a brief with no decisions.
        await alice.request('DELETE', `/docs/${decisions.id}`);
        assert.deepEqual(await branches(), before, 'nothing of the conversation was pushed');
        assert.equal(await refs(), refsBefore, 'the owner\'s checkout gained no branch or commit');
        // The agent has sent many messages in a few seconds by now (D-091).
        await instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        // A question about a project's board alone, as one that links no repository asks, runs in an
        // empty folder, with the board in its brief (R-038).
        await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"From the board."}', FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'prompt', sentAt: Date.now(), project: app.project.id }, 'What is left to do?'));
        const [boardTurn] = (await turns()).slice(-1);
        assert.deepEqual(await fs.readdir(boardTurn!.cwd), [], 'an empty folder, with no code');
        assert.ok(boardTurn!.input.includes('It links no code') && boardTurn!.input.includes('### K-7: Sums are off by one'), 'the brief holds the board');
        assert.deepEqual(await answers(), ['From the board.']);

        // A draft whose request is not in Alice's direct chat with the agent, as every one from before
        // D-105 is, ends when the plugin loads: the pane shows a card's thread only from that chat (K-58).
        const old = (await ask(alice)).id;
        await (await checkIn()).handled;
        const request: RunRequest = { kind: 'request', card: 'K-7', title: 'Sums are off by one', docId: board.id, section, runtime: agent.id, sentAt: Date.now(), repo: 'acme/app', hash: brief };
        const current = (await alice.send(direct, { text: 'Run K-7 with Claude Code', run: request })).id;
        await (await checkIn()).handled;
        const watching = async () => (JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'pulls.json'), 'utf8')) as Array<{ pull: { number: number } }>).map((w) => w.pull.number);
        assert.deepEqual(await watching(), [2, 3]);
        await plugin.endStrandedDrafts();
        assert.deepEqual(await watching(), [3], 'the draft from the direct chat is watched on');
        assert.equal((await reportsOn(old)).at(-1), 'I stopped watching acme/app#2: its request is not in your direct chat with me, so the pane cannot show you its reviews.');
        assert.ok(!(await reportsOn(current)).some((text) => text?.startsWith('I stopped')), 'the other draft says nothing');

        // A second window on the laptop waits until this one closes (D-094).
        const second = new Plugin({ ...options, code: '', dataDir, projectDir: project });
        void second.start();
        await waitFor('the second window waits', () => second.problem.startsWith('Another'));
        assert.match(second.problem, /Another Claude Code window on this laptop serves your agent/);

        // Alice and the agent have sent many messages in a few seconds by now (D-091).
        const unthrottle = () => instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        await unthrottle();
        // A repository with no folder on the laptop: the agent says so, and the run waits for Alice
        // to have it cloned. It clones only on her word, and only a repository her project links (R-036, D-108).
        const webOrigin = path.join(home, 'web.git');
        await sh('git', ['init', '-q', '--bare', '-b', 'main', webOrigin]);
        await git(project, 'push', '-q', webOrigin, 'refs/remotes/origin/main:refs/heads/main');
        await instance.sql.query(
          'INSERT INTO webchat.project_repos (project_id, repo, repo_id, installation_id, conversation_id, added_by, added_at) VALUES ($1, $2, 7, 8, $3, $4, $5)',
          [app.project.id, 'acme/web', general, alice.id, Date.now()],
        );
        await fs.appendFile(gitConfig, `[url "${webOrigin}"]\n\tinsteadOf = https://github.com/acme/web.git\n`);
        const inDirect = async (repo: string) => (await alice.send(direct, { text: 'Run K-7 with Claude Code', run: { ...request, repo, sentAt: Date.now() } })).id;
        const offered = async (id: number, repo: string) => {
          // Each look reads only what came since, so a seen offer stays seen.
          let seen = false;
          await waitFor('the agent offers a clone', async () => (seen ||= (await reportsOn(id)).includes(`I have no copy of ${repo} on this laptop.`)));
        };
        const clone = (from: AgentClient, chat: number, id: number, repo: string) => from.send(chat, { text: `Clone ${repo}`, run: { kind: 'clone', request: id, repo, sentAt: Date.now() } });
        const unlinked = await inDirect('acme/other');
        const waits = (await checkIn()).handled;
        await offered(unlinked, 'acme/other');
        await clone(alice, direct, unlinked, 'acme/other');
        await (await checkIn()).handled;
        await waits;
        assert.deepEqual(await reportsOn(unlinked), ['I could not run K-7: None of your projects links acme/other, so I do not clone it.']);
        const webRun = await inDirect('acme/web');
        const webWaits = (await checkIn()).handled;
        await offered(webRun, 'acme/web');
        // Carol's word is not Alice's, whatever it names.
        await clone(carol, general, webRun, 'acme/web');
        await (await checkIn()).handled;
        const cloneDir = path.join(cloneRoot, 'acme', 'web');
        assert.equal(existsSync(cloneDir), false, "a teammate's clone request does nothing");
        await clone(alice, direct, webRun, 'acme/web');
        await (await checkIn()).handled;
        await webWaits;
        assert.deepEqual(await reportsOn(webRun), [`Cloning acme/web into ${cloneDir}. This can take a while.`, `I finished K-7 on ${branch} (acme/web#4). Sums add up now.`]);
        assert.equal((await git(cloneDir, 'config', '--get', 'remote.origin.url')).stdout.trim(), 'https://github.com/acme/web.git', 'the clone pushes where GitHub has the repository');
        assert.equal((await git(cloneDir, 'rev-parse', 'HEAD')).stdout.trim(), (await git(cloneDir, 'rev-parse', 'origin/main')).stdout.trim(), 'it is on the default branch');
        assert.ok((await turns()).at(-1)!.cwd.startsWith(path.join(await fs.realpath(cloneDir), '.claude', 'worktrees')), 'the run went on in the clone');
        assert.deepEqual(plugin.client!.repos, ['acme/app', 'acme/web']);

        // The folder now takes runs like any other.
        await unthrottle();
        const askWeb = async () => {
          const id = (await ask(alice, { repo: 'acme/web' })).id;
          await (await checkIn()).handled;
          return reportsOn(id);
        };
        const failed = JSON.stringify({ outcome: 'failed', note: 'Not today.' });
        assert.deepEqual(await withEnv({ FAKE_CLAUDE_ANSWER: failed }, askWeb), ['I am on K-7: Sums are off by one', 'I could not run K-7: Not today.']);
        assert.equal((await pullsNow()).at(-1)!.closed, 'The agent stopped: Not today. The branch stays.', 'a run that fails after its claim closes its draft (R-042)');
        // A turn that says done but commits nothing fails, and its draft closes.
        assert.deepEqual(await withEnv({ FAKE_CLAUDE_COMMIT: '0' }, askWeb), ['I am on K-7: Sums are off by one', 'I could not run K-7: I left no new commits.']);
        assert.equal((await pullsNow()).at(-1)!.closed, 'The agent stopped: I left no new commits. The branch stays.');
        // Disconnecting forgets the folder, never its files.
        assert.match(await new Plugin({ ...options, code: '', dataDir, projectDir: cloneDir }).call('disconnect'), /Disconnected acme\/web/);
        await plugin.scan();
        assert.deepEqual(plugin.client!.repos, ['acme/app']);
        assert.ok(existsSync(path.join(cloneDir, 'README.md')));
        // A folder connected in another window lets a run that waits for it go on, with no clone (R-036).
        const connectWaits = async () => {
          const id = (await ask(alice, { repo: 'acme/web' })).id;
          const handled = (await checkIn()).handled;
          await offered(id, 'acme/web');
          await new Plugin({ ...options, code: '', dataDir, projectDir: cloneDir }).call('connect');
          await plugin.scan();
          await handled;
          return reportsOn(id);
        };
        assert.deepEqual(await withEnv({ FAKE_CLAUDE_ANSWER: failed }, connectWaits), ['I could not run K-7: Not today.'], 'the run went on in the connected folder');
        await new Plugin({ ...options, code: '', dataDir, projectDir: cloneDir }).call('disconnect');
        await plugin.scan();
        // Alice forgets the app's folder from the pane, and Carol cannot: the mark goes, the files stay (R-038).
        const forget = (from: AgentClient, chat: number) => from.send(chat, { text: 'Forget the folder of acme/app', forget: { repo: 'acme/app', sentAt: Date.now() } });
        await forget(carol, general);
        await (await checkIn()).handled;
        assert.deepEqual(plugin.client!.repos, ['acme/app'], "a teammate's word forgets nothing");
        await forget(alice, direct);
        await (await checkIn()).handled;
        assert.deepEqual(plugin.client!.repos, []);
        // The laptop's next check-in names no folder, so the pane shows none at once.
        await plugin.client!.sync();
        await alice.sync();
        assert.deepEqual(alice.users.get(agent.id)?.agentRepos, []);
        assert.ok(existsSync(path.join(project, 'README.md')));

        // Alice links the board to the repository, whose docs then copy the board (R-040, D-117).
        await new Plugin({ ...options, code: '', dataDir, projectDir: project }).call('connect');
        await plugin.scan();
        await unthrottle();
        await git(project, 'config', 'user.name', 'Alice');
        await git(project, 'config', 'user.email', 'alice@example.com');
        const docsAt = async (files: Record<string, string>) => {
          await git(merger, 'pull', '-q', 'origin', 'main');
          for (const [file, text] of Object.entries(files)) {
            await fs.mkdir(path.dirname(path.join(merger, file)), { recursive: true });
            await fs.writeFile(path.join(merger, file), text);
          }
          await git(merger, 'add', '-A');
          await git(merger, 'commit', '-q', '-m', 'Docs');
          await git(merger, 'push', '-q', 'origin', 'HEAD:main');
        };
        await docsAt({
          'docs/decisions.md': '# Decisions\n\n## A topic\n\n### D-001: Keep sums exact\n\nAccepted 2026-11-01.\n\nWhy: money.\n',
          'docs/roadmap.md': '# Roadmap\n\n## Known issues\n\n### K-3: Totals lag\n\nStatus: Open.\n',
          'docs/roadmap/K-9.md': '### K-9: Not folded in yet\n\nStatus: Open.\n',
          'docs/roadmap/new-thing.md': '### R: A new thing\n\nStatus: Idea.\n\nWhy: tests.\n',
        });
        const link = (await alice.send(direct, { text: 'Link the board to acme/app', board: { kind: 'link', project: app.project.id, repo: 'acme/app', sentAt: Date.now() } })).clientId!;
        await (await checkIn()).handled;
        const fromAgent = async () => (await alice.sync()).filter((m) => m.senderId === agent.id && m.content?.board).map((m) => ({ ...m.content!.board!, clientId: m.clientId! }));
        const [entries] = await fromAgent();
        assert.deepEqual(entries?.kind === 'entries' && [entries.to, entries.part, entries.parts, entries.entries.map((e) => readCard(e)!.id)], [link, 1, 1, ['D-001', 'K-3', 'K-9']], "the repository's entries, with one not folded in yet, and no proposal");
        // Alice's page imports them, then names the repository in the Roadmap's title; a teammate's naming counts for nothing.
        await alice.sync();
        const roadmapDoc = (await alice.boardDocs(app.project.id)).roadmap!;
        await carol.sync();
        await carol.editSection(roadmapDoc, 'title', () => ({ text: 'Roadmap', board: 'roadmap', repo: 'acme/app' }));
        await plugin.client!.sync();
        await plugin.syncBoards(Date.now() + 11 * 60_000);
        assert.equal((await fromAgent()).length, 0, 'nothing comes of a link the owner did not write');
        await alice.editSection(roadmapDoc, 'title', () => ({ text: 'Roadmap', board: 'roadmap', repo: 'acme/app' }));
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), open: [{ number: 8, title: 'Fix totals', body: 'Claims K-7. Checked it.', headRefName: 'claude/k7-totals' }] }));
        const pullsBefore = JSON.parse(await fs.readFile(ghState, 'utf8')).pulls.length;
        await plugin.client!.sync();
        // A change waits until the board stays unchanged for 10 minutes.
        const start = Date.now();
        await plugin.syncBoards(start);
        const atBoard = (file: string) => sh('git', ['--git-dir', origin, 'show', `agent/board:${file}`]).then((r) => r.stdout, () => null);
        assert.equal(await atBoard('docs/roadmap.md'), null, 'no copy before the board is quiet');
        const sent = await fromAgent();
        const proposal = sent.find((m) => m.kind === 'proposal');
        assert.deepEqual(proposal?.kind === 'proposal' && proposal.card, { kind: 'R', title: 'A new thing', body: 'Why: tests.' }, 'a proposal on main comes as a draft');
        assert.deepEqual(sent.find((m) => m.kind === 'claims'), { kind: 'claims', project: app.project.id, repo: 'acme/app', claims: [{ card: 'K-7', pull: 8 }], clientId: sent.find((m) => m.kind === 'claims')!.clientId }, 'an open pull request claims K-7');
        await plugin.syncBoards(start + 11 * 60_000);
        const cards = (await alice.sections(roadmapDoc)).map((s) => s.text);
        assert.equal(await atBoard('docs/roadmap.md'), copyOf('roadmap', cards), 'the copy is what Copy as Markdown gives');
        assert.equal(await atBoard('docs/decisions.md'), copyOf('decisions', []));
        assert.equal(await atBoard('docs/roadmap/K-9.md'), null, 'the entry the import took in leaves its file');
        assert.ok((await atBoard('docs/roadmap/new-thing.md'))?.includes('A new thing'), 'a proposal stays until it is on the board');
        assert.deepEqual(
          JSON.parse(await fs.readFile(ghState, 'utf8')).pulls.slice(pullsBefore).map((p: { head: string; base: string; draft: boolean; title: string }) => [p.head, p.base, p.draft, p.title]),
          [['agent/board', 'main', true, 'docs: Copy the board']],
          'one draft, on agent/board',
        );
        // Alice adds the proposal; the board changes, and the next copy drops its file, on the same draft.
        await alice.send(direct, { text: 'Added R-1 to the board.', added: { to: proposal!.clientId, draft: proposal!.clientId, card: 'R-1' } });
        await (await checkIn()).handled;
        await alice.editSection(roadmapDoc, newKeyId().slice(0, 11), () => ({ text: '### R-1: A new thing\n\nStatus: Idea.\n\nWhy: tests.', pos: 9 }));
        await plugin.client!.sync();
        await plugin.syncBoards(start + 12 * 60_000);
        await plugin.syncBoards(start + 23 * 60_000);
        assert.equal(await atBoard('docs/roadmap/new-thing.md'), null, 'the added proposal leaves its file');
        assert.ok((await atBoard('docs/roadmap.md'))?.includes('### R-1: A new thing'));
        assert.equal(JSON.parse(await fs.readFile(ghState, 'utf8')).pulls.length, pullsBefore + 1, 'still one draft');
        // On cards Alice opened, Carol's Ready and Carol's removal do not stand, so the copy shows neither, as the board does (the card-owner decision).
        const [owned, unremoved] = [newKeyId().slice(0, 11), newKeyId().slice(0, 11)];
        await alice.editSection(roadmapDoc, owned, () => ({ text: '### K-10: Owned\n\nStatus: Open.', pos: 10, opened: true }));
        await alice.editSection(roadmapDoc, unremoved, () => ({ text: '### K-11: Kept\n\nStatus: Open.', pos: 11, opened: true }));
        await carol.sync();
        await carol.editSection(roadmapDoc, owned, () => ({ text: '### K-10: Owned\n\nStatus: Ready.', pos: 10 }));
        await carol.editSection(roadmapDoc, unremoved, () => ({ text: '### K-11: Kept\n\nStatus: Open.', pos: 11, removed: true }));
        await plugin.client!.sync();
        await plugin.syncBoards(start + 24 * 60_000);
        await plugin.syncBoards(start + 35 * 60_000);
        const copyNow = (await atBoard('docs/roadmap.md'))!;
        assert.ok(copyNow.includes('### K-10: Owned\n\nStatus: Open.') && !copyNow.includes('## Ready'), "Carol's Ready on Alice's card is not copied");
        assert.ok(copyNow.includes('### K-11: Kept'), "Carol's removal of Alice's card is not copied");

        // A card run follows the repository's workflow (R-042, D-118).
        await unthrottle();
        const k7Now = async () => (await plugin.client!.sections(plugin.client!.docs.find((d) => d.id === board.id)!)).find((s) => s.id === section)!.text;
        // The brief as Alice's page hashes it now: the card, then the decisions the team holds (D-105).
        const briefNow = async () => {
          const { decisions: held } = await plugin.client!.boardDocs(app.project.id);
          return textHash(briefText(await k7Now(), held ? (await plugin.client!.sections(held)).map((s) => s.text) : []));
        };
        const runK7 = async (env: Record<string, string> = {}) =>
          withEnv(env, async () => {
            const id = (await ask(alice, { hash: await briefNow() })).id;
            await (await checkIn()).handled;
            return { id, said: await reports(id) };
          });
        const DAY = 24 * 60 * 60_000;

        // An open pull request that claims the card refuses the run, before the agent takes it.
        const turnsBefore = (await turns()).length;
        assert.deepEqual((await runK7()).said.map((r) => r.text), ['I could not run K-7: acme/app#8 claims K-7 already. Pick another card, or ask whoever opened it.']);
        assert.equal((await turns()).length, turnsBefore, 'no Claude ran for it');
        // So does a request naming a coding agent that takes no cards here, with the reason.
        const codex = (await ask(alice, { hash: await briefNow(), harness: 'Codex' })).id;
        await (await checkIn()).handled;
        assert.deepEqual(await reportsOn(codex), [`I could not run K-7: ${CODEX_GAP}`]);
        assert.equal((await turns()).length, turnsBefore, 'no Claude ran for it either');

        // A card the code already does ends at its check, pushes nothing, and offers its new status
        // as a change Alice adds (D-104).
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), open: [] }));
        const [pullsBeforeRuns, branchesBeforeRuns] = [(await pullsNow()).length, await branches()];
        const check = { outcome: 'stale', status: 'Done', note: 'sum.js adds exactly already.', checked: 'Read K-7 and sum.js on main.' };
        const stale = await runK7({ FAKE_CLAUDE_CHECK: JSON.stringify(check) });
        assert.deepEqual(stale.said.map((r) => r.text), ['I am on K-7: Sums are off by one', 'K-7 no longer holds: sum.js adds exactly already.']);
        assert.deepEqual(stale.said[1]!.run.card, {
          kind: 'K',
          title: 'Sums are off by one',
          body: '',
          status: `Done on ${today}: sum.js adds exactly already`,
          checked: 'Read K-7 and sum.js on main.',
          replaces: { card: 'K-7', doc: board.id, section, seen: await textHash((await k7Now()).trim()) },
        });
        assert.equal((await turns()).length, turnsBefore + 1, 'only the check ran');
        assert.deepEqual([(await pullsNow()).length, await branches()], [pullsBeforeRuns, branchesBeforeRuns], 'nothing was pushed or opened');

        // A run that finds a decision nobody foresaw stops for it, with its claim and its work so far
        // pushed, and holds the card. The plan gate's knob is off, so no plan waits for a go first.
        const needed = { kind: 'decision', title: 'Sums round half to even', body: 'Why: money.', checked: 'Read sum.js.' };
        const paused = await runK7({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'decision', note: 'Rounding needs a rule.', drafts: [needed] }) });
        assert.deepEqual(paused.said.map((r) => r.text), ['I am on K-7: Sums are off by one', 'K-7 needs a decision first: Sums round half to even. Add it on the board, then tell me to go on.']);
        assert.deepEqual(paused.said[1]!.run.card, { kind: 'D', title: 'Sums round half to even', body: 'Why: money.', checked: 'Read sum.js.' });
        const number = pullsBeforeRuns + 1;
        const pausedPull = (await pullsNow())[number - 1]!;
        assert.deepEqual(pausedPull, { head: pausedPull.head, base: 'main', draft: true, ...claim }, 'the claim opened the draft, and nothing edited it');
        assert.deepEqual(await log(pausedPull.head), ['Change sum.test.js', 'chore: Claim K-7']);
        // It waits for the go, with one reminder after a day.
        const [pausedCheck] = (await turns()).slice(-2);
        const turnsPaused = (await turns()).length;
        await plugin.pollPulls(Date.now() + 2 * DAY);
        await plugin.pollPulls(Date.now() + 3 * DAY);
        assert.deepEqual((await reports(paused.id)).map((r) => r.text), ['I still wait for your decision on K-7. Add it on the board, then tell me to go on.']);
        assert.equal((await turns()).length, turnsPaused, 'nothing runs before the go');
        // Alice adds the decision, which the board numbers D-1, and says go: the run goes on in its session.
        const decisionsNow = { id: newKeyId(), conversationId: general };
        const d1 = newKeyId().slice(0, 11);
        await alice.request('POST', '/docs', {
          ...decisionsNow,
          revisions: [
            { section: 'title', envelope: await alice.sealDoc(decisionsNow, 'title', { text: 'Decisions', board: 'decisions' }) },
            { section: d1, envelope: await alice.sealDoc(decisionsNow, d1, { text: '### D-1: Sums round half to even\n\nStatus: Proposed.\n\nWhy: money.', pos: 1 }) },
          ],
        });
        const gap = { kind: 'issue', title: 'Totals round twice', body: 'Seen: in totals.js.', checked: 'Read totals.js.' };
        const finished = { outcome: 'done', note: 'Sums round half to even.', title: 'fix: Round sums half to even', body: 'As D-1 says.', decisions: ['D-1', 'D-9'], drafts: [gap] };
        await alice.send(general, { text: 'Go on with D-1', run: { kind: 'fix', request: paused.id, note: 'I added the decision as D-1. Go on with the work.', sentAt: Date.now() } });
        await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify(finished) }, async () => (await checkIn()).handled);
        const resumed = (await turns()).at(-1)!;
        assert.equal(resumed.session, pausedCheck!.session, 'it resumes the run');
        assert.ok(resumed.input.includes('I added the decision as D-1') && resumed.input.includes('Your owner added the decision you waited for'), 'the round has the number');
        const goneOn = await reports(paused.id);
        assert.deepEqual(goneOn.map((r) => r.text), [
          'I am back on K-7: you added the decision',
          `I finished K-7 on ${pausedPull.head} (acme/app#${number}). Sums round half to even.`,
          'Card draft: Totals round twice',
        ]);
        assert.deepEqual(goneOn[2]!.run.card, { kind: 'K', title: 'Totals round twice', body: 'Seen: in totals.js.', checked: 'Read totals.js.' }, 'a gap the run found waits for Alice');
        assert.deepEqual((await pullsNow())[number - 1]!.edited, { title: 'fix: Round sums half to even', body: 'As D-1 says.' });
        // Once it is merged, the agent says so, with the decision the work made true, which Alice's
        // page accepts; a decision the board does not have is left out.
        const merging = await pullsNow();
        merging[number - 1] = { ...merging[number - 1]!, view: { state: 'MERGED' } };
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), pulls: merging }));
        await plugin.pollPulls();
        assert.deepEqual(await reports(paused.id), [
          { text: `I stopped watching acme/app#${number}: it was merged.`, run: { kind: 'merged', request: paused.id, note: 'it was merged', pull: { repo: 'acme/app', number }, decisions: ['D-1'] } },
        ]);

        // A finished run's draft closed unmerged says so, and Alice's page moves the card back.
        await unthrottle();
        const dropped = await runK7({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'done', note: 'Done.', title: 'fix: Sums', body: 'Fixed.' }) });
        const closing = await pullsNow();
        closing[closing.length - 1] = { ...closing.at(-1)!, view: { state: 'CLOSED' } };
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), pulls: closing }));
        await plugin.pollPulls();
        assert.deepEqual((await reports(dropped.id)).map((r) => r.run.kind), ['closed']);

        // A run left waiting for 7 days fails, and its draft closes with its branch kept.
        await unthrottle();
        const left = await runK7({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'decision', note: 'Totals need a rule.', drafts: [{ ...needed, title: 'Totals round once' }] }) });
        assert.equal(left.said.at(-1)!.text, 'K-7 needs a decision first: Totals round once. Add it on the board, then tell me to go on.');
        await plugin.pollPulls(Date.now() + 8 * DAY);
        assert.deepEqual((await reports(left.id)).map((r) => r.text), ['I could not run K-7: No decision came within 7 days.']);
        const leftPull = (await pullsNow()).at(-1)!;
        assert.equal(leftPull.closed, 'The agent stopped: No decision came within 7 days. The branch stays.');
        assert.ok((await branches()).includes(leftPull.head), 'the branch stays');

        // A stop before the work is done pauses the run: what is committed is pushed, and the
        // worktree, branch, draft and session wait for the owner's words (docs/decisions/stop-pauses-run.md).
        const hold = path.join(home, 'hold');
        const stopK7 = async () => {
          await unthrottle();
          const before = (await turns()).length;
          return withEnv({ FAKE_CLAUDE_HOLD: hold }, async () => {
            const id = (await ask(alice, { hash: await briefNow() })).id;
            const { handled } = await checkIn();
            // The work turn says what it does as soon as it starts, and the report follows. Polled
            // slowly: a tight loop of check-ins starves the plugin's own requests to the server.
            await waitFor('the work turn started', async () => (await turns()).length === before + 2);
            const said: Array<{ text: string; run: RunReport }> = [];
            const more = async () => void said.push(...(await reports(id)));
            for (let tries = 0; tries < 50 && !said.some((r) => r.run.kind === 'progress'); tries++) await sleep(100).then(more);
            await alice.send(general, { text: 'Stop', run: { kind: 'cancel', request: id } });
            await (await checkIn()).handled;
            await handled;
            await more();
            return { id, said, turns: (await turns()).slice(before) };
          });
        };
        const stopped = await stopK7();
        const [stoppedCheck, stoppedWork] = stopped.turns;
        const stoppedPull = (await pullsNow()).at(-1)!;
        assert.deepEqual(
          stopped.said.map((r) => [r.run.kind, r.text]),
          [
            ['claimed', 'I am on K-7: Sums are off by one'],
            ['progress', 'Run the tests'],
            ['paused', `I stopped K-7 as you asked. What I committed is on ${stoppedPull.head} (acme/app#${(await pullsNow()).length}), and I keep where I was. Tell me what to change, or start the card over.`],
          ],
          'two progress lines within 30 seconds send one report',
        );
        assert.deepEqual(await log(stoppedPull.head), ['Change sum.test.js', 'chore: Claim K-7'], 'what was committed is pushed');
        assert.equal(stoppedPull.closed, undefined, 'the draft stays open');
        await fs.access(stoppedWork!.cwd);
        const stoppedRecord = (JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'pulls.json'), 'utf8')) as Array<{ taken: { message: number }; session: string; unfinished?: { paused?: number; stopped?: true } }>).find((w) => w.taken.message === stopped.id)!;
        assert.equal(stoppedRecord.session, stoppedCheck!.session, 'the session is kept');
        assert.ok(stoppedRecord.unfinished?.paused && stoppedRecord.unfinished.stopped, 'the run waits as paused');
        await plugin.pollPulls();
        assert.deepEqual(await reports(stopped.id), [], 'nothing ends a paused run');
        // A second stop starts the card over: the draft closes, and the branch stays.
        await alice.send(general, { text: 'Stop', run: { kind: 'cancel', request: stopped.id } });
        await (await checkIn()).handled;
        await plugin.pollPulls();
        assert.deepEqual((await reports(stopped.id)).map((r) => r.text), ['I could not run K-7: You started it over.']);
        assert.equal((await pullsNow()).at(-1)!.closed, 'The agent stopped: You started it over. The branch stays.');
        assert.ok((await branches()).includes(stoppedPull.head), 'the branch stays');
        // With no words, a paused run fails after 7 days, as a decision pause does.
        const silent = await stopK7();
        assert.equal(silent.said.at(-1)!.run.kind, 'paused');
        await plugin.pollPulls(Date.now() + 8 * DAY);
        assert.deepEqual((await reports(silent.id)).map((r) => r.text), ['I could not run K-7: No words came within 7 days.']);
        // The owner's words redirect a stopped run: its session goes on with them, fenced, and ends the run.
        const redirected = await stopK7();
        const words = 'Do not add a table; reuse messages.';
        await alice.send(general, { text: words, run: { kind: 'fix', request: redirected.id, note: words, sentAt: Date.now() } });
        await (await checkIn()).handled;
        const [redirectedCheck] = redirected.turns;
        const steered = (await turns()).at(-1)!;
        assert.equal(steered.session, redirectedCheck!.session, 'the same session goes on');
        assert.ok(steered.input.includes(`OWNER'S WORDS START ============\n${words}\n============`), 'the words are fenced');
        assert.ok(steered.input.includes('read `git status` first'), 'it looks at the worktree first');
        const redirectedPull = (await pullsNow()).at(-1)!;
        assert.deepEqual((await reports(redirected.id)).map((r) => r.text), [
          'I am back on K-7: you told me what to change',
          `I finished K-7 on ${redirectedPull.head} (acme/app#${(await pullsNow()).length}). Sums add up now.`,
        ]);

        // With the gate on, a card that holds shows its plan and waits, with nothing committed or
        // pushed; the owner's go claims it, and the work goes on in the check's session
        // (docs/decisions/redirect-plan-gate.md). Every run above had the knob off, and none waited.
        await setup(alice, direct, { ...chosen, noPlan: false });
        await unthrottle();
        const [pullsBeforePlan, branchesBeforePlan, turnsBeforePlan] = [(await pullsNow()).length, await branches(), (await turns()).length];
        const plan = 'Fix the off-by-one in sum.js.\nAdd a test for it.';
        const planned = await runK7({ FAKE_CLAUDE_CHECK: JSON.stringify({ outcome: 'holds', note: '', checked: 'Read K-7 and sum.js on main.', plan }) });
        assert.deepEqual(
          planned.said.map((r) => [r.run.kind, r.text, r.run.note]),
          [
            ['claimed', 'I am on K-7: Sums are off by one', undefined],
            ['planned', `K-7 holds. My plan:\n\n${plan}\n\nSay go, or tell me what to change.`, plan],
          ],
        );
        const [planCheck] = (await turns()).slice(turnsBeforePlan);
        assert.equal((await turns()).length, turnsBeforePlan + 1, 'only the check ran');
        assert.deepEqual([(await pullsNow()).length, await branches()], [pullsBeforePlan, branchesBeforePlan], 'nothing was pushed or opened');
        assert.notEqual((await git(planCheck!.cwd, 'log', '-1', '--format=%s')).stdout.trim(), 'chore: Claim K-7', 'nothing was committed');
        await alice.send(general, { text: 'Go', run: { kind: 'fix', request: planned.id, sentAt: Date.now() } });
        await (await checkIn()).handled;
        const planPull = (await pullsNow()).at(-1)!;
        assert.equal((await pullsNow()).length, pullsBeforePlan + 1, 'the go opened the draft');
        assert.deepEqual(await reportsOn(planned.id), ['I am back on K-7: you said go', `I finished K-7 on ${planPull.head} (acme/app#${pullsBeforePlan + 1}). Sums add up now.`]);
        assert.deepEqual(await log(planPull.head), ['Change sum.test.js', 'chore: Claim K-7']);
        const [, planWork] = (await turns()).slice(turnsBeforePlan);
        assert.equal(planWork!.session, planCheck!.session, 'the work resumes the check');
        assert.ok(planWork!.input.includes('says go') && planWork!.input.includes(`acme/app#${pullsBeforePlan + 1} claims it`), 'the brief carries the go');
        // A card run asks its owner before an action Claude Code would ask about, through its permission
        // prompt tool, which the fake calls on a loopback endpoint of the plugin; the owner's second
        // device answers (docs/decisions/harness-approvals.md). The plan gate is off again for these.
        await setup(alice, direct, { ...chosen, noPlan: true });
        await unthrottle();
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), open: [] }));
        await fs.copyFile(path.join(home, 'alice.json'), path.join(home, 'alice-phone2.json'));
        const phone = await AgentClient.load(path.join(home, 'alice-phone2.json'));
        const askedLog = path.join(home, 'asked.log');
        const restoreAsk = setEnv({ FAKE_CLAUDE_ASK: JSON.stringify([{ tool_name: 'Write', input: { file_path: '$CWD/.claude/settings.json', content: '{}' } }]), FAKE_CLAUDE_ASKED: askedLog });
        try {
          const decisions = async () => (await fs.readFile(askedLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { decision: { behavior?: string; message?: string; updatedInput?: object; status?: number } });
          const heardPermits: OpenedMessage[] = [];
          const nextQuestion = async (n: number) => {
            await waitFor('the question reaches the owner', async () => {
              heardPermits.push(...(await phone.sync()).filter((m) => m.senderId === agent.id && m.content?.permit));
              return heardPermits.filter((m) => m.content!.permit!.kind === 'question').length > n;
            });
            return heardPermits.filter((m) => m.content!.permit!.kind === 'question')[n]!;
          };
          const reply = async (question: OpenedMessage, decision: 'once' | 'run' | 'deny') => {
            const permit = question.content!.permit as Extract<PermitDTO, { kind: 'question' }>;
            await phone.send(direct, { text: 'Answer', permit: { kind: 'answer', to: question.clientId!, decision, seen: await permitHash(permit), sentAt: Date.now() } });
            for (const m of await plugin.client!.sync()) await plugin.handle(m);
          };
          const startAsking = async () => {
            const id = (await ask(alice, { hash: await briefNow(), asks: true })).id;
            return { id, handled: (await checkIn()).handled };
          };

          // Allow, from the second device: the run goes on and finishes. The question names the file Claude Code would write.
          const turnsBeforeAsk = (await turns()).length;
          const allowed = await startAsking();
          const first = await nextQuestion(0);
          const permit = first.content!.permit as Extract<PermitDTO, { kind: 'question' }>;
          assert.deepEqual([permit.what, permit.request, permit.detail.startsWith('Write ') && permit.detail.endsWith('.claude/settings.json')], ['edit', allowed.id, true]);
          assert.deepEqual(await decisions(), [], 'Claude Code waits for the answer');
          await reply(first, 'once');
          await allowed.handled;
          const allowedPull = (await pullsNow()).at(-1)!;
          assert.deepEqual((await reportsOn(allowed.id)).at(-1), `I finished K-7 on ${allowedPull.head} (acme/app#${(await pullsNow()).length}). Sums add up now.`);
          const [answered] = await decisions();
          assert.deepEqual([answered!.decision.behavior, typeof answered!.decision.updatedInput], ['allow', 'object'], 'the tool answers allow, with the input');
          // One process took both turns, started with the prompt tool and no refusal of what it asks.
          const [check, work] = (await turns()).slice(turnsBeforeAsk);
          assert.equal(check!.pid, work!.pid, 'one process for the session');
          for (const flag of ['--mcp-config', '--permission-prompt-tool', '--disallowedTools']) assert.ok(check!.args.includes(flag), flag);
          assert.ok(!check!.args.includes('--permission-prompts'), 'it no longer refuses what it asks');
          const approveFile = check!.args[check!.args.indexOf('--mcp-config') + 1]!;
          assert.equal((await fs.stat(approveFile)).mode & 0o777, 0o600, 'the token file is for the owner only');
          assert.ok(approveFile.startsWith(path.join(dataDir, 'laptop')), 'it is in the plugin\'s folder, which the shell cannot read');
          // Only the plugin's own endpoint is called, and only with the token.
          const server = check!.mcp!.mcpServers.webchat;
          const post = (headers: Record<string, string>) => fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
          assert.equal((await post({})).status, 401, 'no token');
          assert.equal((await post({ authorization: 'Bearer wrong' })).status, 401, 'a wrong token');
          assert.equal((await post({ authorization: server.headers.Authorization, origin: 'https://evil.example' })).status, 401, 'a page in a browser');
          const tools = (await (await post({ authorization: server.headers.Authorization })).json()) as { result: { tools: Array<{ name: string }> } };
          assert.deepEqual(tools.result.tools.map((t) => t.name), ['approve']);

          // Deny stops that action: the fake writes nothing and commits nothing, so the run has no work to push.
          await unthrottle();
          const denied = await startAsking();
          await reply(await nextQuestion(1), 'deny');
          await denied.handled;
          assert.deepEqual((await decisions()).at(-1)!.decision, { behavior: 'deny', message: 'Your owner said no. Do not try it again: do something else, or stop.' });
          assert.equal((await reportsOn(denied.id)).at(-1), 'I could not run K-7: I left no new commits.');

          // A question left 7 days ends the run: it fails with the reason, closes its draft, and keeps the branch.
          await unthrottle();
          const forgotten = await startAsking();
          await nextQuestion(2);
          const draftsBefore = (await pullsNow()).length;
          await plugin.pollPulls(Date.now() + 8 * DAY);
          await forgotten.handled;
          assert.equal((await reportsOn(forgotten.id)).at(-1), 'I could not run K-7: No answer came within 7 days.');
          assert.equal((await pullsNow()).at(-1)!.closed, 'The agent stopped: No answer came within 7 days. The branch stays.');
          assert.equal((await pullsNow()).length, draftsBefore, 'the draft it opened is the one closed');
          await waitFor('the owner is told it expired', async () => {
            heardPermits.push(...(await phone.sync()).filter((m) => m.senderId === agent.id && m.content?.permit));
            return heardPermits.some((m) => m.content!.permit!.kind === 'settled' && m.content!.permit!.outcome === 'expired');
          });
          // A request from a page that sets no flag asks nothing, and the process refuses what it would ask, as before.
          await unthrottle();
          const before = (await turns()).length;
          const refused = (await ask(alice, { hash: await briefNow() })).id;
          await (await checkIn()).handled;
          const [plain] = (await turns()).slice(before);
          assert.ok(plain!.args.includes('--permission-prompts') && !plain!.args.includes('--mcp-config'), 'no question can be asked, so it refuses');
          assert.equal((await reportsOn(refused)).length > 0, true);
        } finally {
          restoreAsk();
        }
        // Ending the sessions ends the processes, and the token files go with them.
        await Promise.all(options.harnesses.map((h) => h.end?.()));
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'laptop', 'approve')), []);
      } finally {
        restore();
      }
    },
  );

  test('sleeps on its owner\'s word in every window until a wake, and a background job never serves (K-66, D-113)', { timeout: 30_000 }, async () => {
    const dataDir = path.join(home, 'sleepy');
    const projectDir = path.join(home, 'sleepy-folder');
    await fs.mkdir(projectDir);
    const options = { harnesses: [claudeHarness('', 'true', dataDir)], cloneRoot: path.join(home, 'WebChat'), dataDir, projectDir };
    const code = newPairingCode();
    const first = new Plugin({ ...options, code: `${baseUrl}#${code}` });
    const second = new Plugin({ ...options, code: '' });
    // Caught, as agent/mcp.ts does: a window whose check-in outlasts the test starts again after
    // the file's server closed and its folder went, and pairs again with nobody to answer.
    const serve = (window: Plugin) => void window.serve().catch(() => undefined);
    serve(first);
    try {
      const agent = await approve(alice, code, 'Sleepy');
      await waitFor('the first window serves', () => first.problem === '');
      const job = new Plugin({ ...options, code: '', job: true });
      assert.equal(await job.start(), false);
      assert.match(await job.call('status'), /background job, so it does not serve/);
      serve(second);
      await waitFor('the second window waits', () => /Another Claude Code window/.test(second.problem));

      // Nothing runs, so the agent sleeps at once on Alice's word in the pane, and says so.
      await alice.sync();
      const direct = (await alice.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(alice, [alice.id, agent.id]) })).id;
      await alice.sync();
      await alice.send(direct, { text: 'Go to sleep', sleep: { sentAt: Date.now() } });
      for (const message of await first.client!.sync()) await first.handle(message);
      await waitFor('the first window sleeps', () => /asleep/.test(first.problem));
      const said = (await alice.sync()).filter((m) => m.senderId === agent.id).map((m) => m.content?.text);
      assert.deepEqual(said, ['I go to sleep now. To wake me, type /webchat:wake in Claude Code on your laptop.']);
      // The watch is free, and no window takes it while the agent sleeps.
      assert.equal(existsSync(path.join(dataDir, 'watch.lock')), false);
      assert.match(await second.call('status'), /Your agent is asleep/);

      // A wake in the waiting window serves there at once, and a sleep there stops it again.
      assert.match(await second.call('wake'), /waking up/);
      await waitFor('the second window serves', () => second.problem === '');
      assert.match(await second.call('sleep'), /goes to sleep within 15 seconds/);
      await waitFor('the second window sleeps', () => /asleep/.test(second.problem));
      assert.equal(existsSync(path.join(dataDir, 'watch.lock')), false);
    } finally {
      // A window that still serves would keep checking in after the test.
      await first.call('sleep');
      await second.call('sleep');
    }
  });

  test('shows offline while no runner is connected, serves once one says hello, and stops when it goes (docs/decisions/locked-room.md)', { timeout: 30_000 }, async () => {
    const dataDir = path.join(home, 'roomy');
    const room = new Room({ version: '1' });
    const file = path.join(home, 'roomy.sock');
    const code = newPairingCode();
    const plugin = new Plugin({ bench: room.bench, runner: room, cloneRoot: path.join(home, 'WebChat'), dataDir, code: `${baseUrl}#${code}` });
    await room.listen(file, plugin);
    const bench = new LocalBench([claudeHarness('', 'true', dataDir)], undefined, dataDir);
    const runners: Array<{ close: () => void }> = [];
    void plugin.serve().catch(() => undefined);
    try {
      await waitFor('it shows offline', () => /not started the part of this agent/.test(plugin.problem));
      assert.equal(plugin.client, null, 'it checked in nowhere');
      runners.push(await connectRunner({ file, bench, version: '1' }));
      await approve(alice, code, 'Roomy');
      await waitFor('it serves', () => plugin.problem === '');
      assert.equal((await callRoom<{ runner: boolean }>(file, 'status', {}, '1')).runner, true);
      runners[0]!.close();
      await waitFor('it is offline again', () => /not started the part of this agent/.test(plugin.problem));
      runners.push(await connectRunner({ file, bench, version: '1' }));
      await waitFor('it serves again', () => plugin.problem === '');
    } finally {
      runners.forEach((r) => r.close());
      await plugin.call('sleep');
      room.close();
    }
  });

  test('connects a folder only on its owner\'s signed approval, within 10 minutes and once (docs/decisions/connect-approval.md)', { timeout: 60_000 }, async () => {
    const dataDir = path.join(home, 'connector', 'laptop');
    const folder = path.join(home, 'connector-app');
    await sh('git', ['init', '-q', folder]);
    const setOrigin = (repo: string) => git(folder, 'remote', 'set-url', 'origin', `https://github.com/${repo}.git`);
    await git(folder, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    const options = { harnesses: [claudeHarness('', 'true', dataDir)], cloneRoot: path.join(home, 'WebChat'), dataDir, projectDir: folder, code: '' };
    const terminal = new Plugin(options);
    assert.match(await new Plugin({ ...options, dataDir: path.join(home, 'unpaired') }).requestConnect(), /Pair first/);
    const code = newPairingCode();
    const plugin = new Plugin({ ...options, code: `${baseUrl}#${code}`, projectDir: home });
    const starting = plugin.start();
    const agent = await approve(alice, code, 'Connector');
    assert.equal(await starting, true);
    await alice.sync();
    await carol.sync();
    const carols = (await carol.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(carol, [carol.id, agent.id]) })).id;
    const direct = (await alice.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(alice, [alice.id, agent.id]) })).id;
    const group = (await alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Connect', memberIds: [agent.id], key: await newChatKey(alice, [alice.id, agent.id]) })).channel.id;
    await alice.sync();
    await carol.sync();
    await plugin.client!.sync();
    const mark = path.join(dataDir, 'repos', 'acme__app', 'connected');
    const pending = () => (plugin as unknown as { setup: { asks?: Record<string, { at: number }> } }).setup.asks ?? {};
    const heard = async () => {
      const messages = await plugin.client!.sync();
      await Promise.all(messages.map((m) => plugin.handle(m)));
      return messages;
    };
    const failures: string[] = [];
    const said = async () => {
      const asks = (await alice.sync()).filter((m) => m.senderId === agent.id && m.content?.ask).map((m) => m.content!);
      failures.push(...asks.filter((c) => c.ask?.step === 'failed').map((c) => c.text));
      return asks.filter((c) => c.ask?.step !== 'failed');
    };
    // What a person types in the folder, then the serving agent's tick: the request Alice sees, and its client id.
    const ask = async () => {
      assert.match(await terminal.requestConnect(), /Asked your agent's owner to connect acme\/app/);
      await plugin.sendAsks();
      const [sent] = await said();
      assert.equal(sent?.ask?.step, 'request');
      return { request: sent!.ask as Extract<AskDTO, { kind: 'connect'; step: 'request' }>, to: Object.keys(pending()).at(-1)! };
    };
    type Asked = Awaited<ReturnType<typeof ask>>;
    const answer = async (from: AgentClient, chat: number, step: 'approve' | 'decline', asked: Asked, extra: object = {}) => {
      const { repo, folder: shown } = asked.request;
      await from.send(chat, { text: 'Answer', ask: { kind: 'connect', step, to: asked.to, sentAt: Date.now(), ...(step === 'approve' && { repo, folder: shown }), ...extra } as MessageContent['ask'] });
      return heard();
    };
    const nothing = async (why: string) => {
      await plugin.scan();
      assert.equal(existsSync(mark), false, why);
      assert.deepEqual(plugin.client!.repos, [], why);
    };

    // The real command, typed in a terminal, files a request and returns: nothing changes.
    // It asks the keyholder over its socket, which here is the terminal's plugin.
    const room = new Room({ version: pkg.version });
    await room.listen(path.join(home, 'connector', 'keyholder.sock'), terminal);
    const run = await sh(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../agent/index.ts', import.meta.url)), 'connect'], {
      cwd: folder,
      env: { PATH: '/usr/bin:/bin', HOME: path.join(home, 'connector'), WEBCHAT_AGENT_HOME: path.join(home, 'connector') },
    }).finally(() => room.close());
    assert.match(run.stdout, /Asked your agent's owner to connect acme\/app/);
    await nothing('a typed connect marks nothing');
    await plugin.sendAsks();
    const [first] = await said();
    assert.deepEqual([first?.ask?.step, (first?.ask as { repo?: string })?.repo], ['request', 'acme/app']);
    await nothing('a request marks nothing');
    // A second command for the repository while one waits sends no second request.
    await terminal.requestConnect();
    await plugin.sendAsks();
    assert.deepEqual(await said(), []);
    // Not the owner's word: Carol's in her own chat with the agent, Alice's outside her direct chat, a request nobody made, and one signed too long ago.
    const open: Asked = { request: first!.ask as Asked['request'], to: Object.keys(pending())[0]! };
    await answer(carol, carols, 'approve', open);
    await answer(alice, group, 'approve', open);
    await answer(alice, direct, 'approve', { ...open, to: 'nobody' });
    await answer(alice, direct, 'approve', open, { sentAt: Date.now() - REQUEST_TTL_MS - 1000 });
    await nothing('only the owner, in the direct chat, lately, and for a request that was made');
    // Her approve connects the folder the laptop recorded, once.
    const approving = await answer(alice, direct, 'approve', open);
    assert.equal(await fs.readFile(mark, 'utf8'), await fs.realpath(folder), 'the folder the command ran in');
    assert.deepEqual(plugin.client!.repos, ['acme/app']);
    assert.equal((await said()).at(-1)?.ask?.step, 'done');
    // The same message again, or another that names the same request, connects nothing once it is disconnected.
    await terminal.call('disconnect');
    await plugin.handle(approving.find((m) => m.content?.ask)!);
    await answer(alice, direct, 'approve', open);
    await nothing('an approval counts once');

    // A request left past 10 minutes by the agent's clock fails with a note.
    const lapsed = await ask();
    pending()[lapsed.to]!.at -= REQUEST_TTL_MS + 1000;
    await answer(alice, direct, 'approve', lapsed);
    await nothing('a lapsed request');
    await said();
    assert.match(failures.at(-1)!, /older than 10 minutes/);
    // An approval for another folder or repository than the request showed, and a folder that moved to another repository, connect nothing.
    const another = await ask();
    await answer(alice, direct, 'approve', another, { folder: `${another.request.folder}-other` });
    await nothing('another folder');
    const elsewhere = await ask();
    await answer(alice, direct, 'approve', elsewhere, { repo: 'acme/other' });
    await nothing('another repository');
    const moved = await ask();
    await setOrigin('acme/other');
    await answer(alice, direct, 'approve', moved);
    await setOrigin('acme/app');
    await nothing('a folder that pushes elsewhere now');
    // A decline connects nothing, and the request cannot be approved after it.
    const declined = await ask();
    await answer(alice, direct, 'decline', declined);
    await answer(alice, direct, 'approve', declined);
    await nothing('a decline');
    await said();
    assert.equal(failures.length, 4, 'each refusal is said, and a decline or an approval of nothing is not');
    // A folder connected already asks nothing.
    await terminal.call('connect');
    assert.match(await terminal.requestConnect(), /connected to this folder already/);
    // The plugin's own tool keeps its prompt in Claude Code and marks at once (D-101).
    await terminal.call('disconnect');
    assert.match(await terminal.call('connect'), /Connected acme\/app: your agent works in this folder/);
  });

  test('answers its owner\'s prompts in their direct chat, and resumes the conversation for each reply (R-035)', async () => {
    // A fresh owner, since Alice's sends in the tests before count against the rate limit.
    const owner = await AgentClient.signUp(path.join(home, 'erin.json'), { server: baseUrl, username: 'erin', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Erin', 'friends-only');
    const code = newPairingCode();
    const pairing = AgentClient.pair(path.join(home, 'talker.json'), baseUrl, code, 10);
    await approve(owner, code, 'Talker');
    const agent = await pairing;
    await owner.sync();
    await carol.sync();
    const open = async (person: AgentClient) =>
      (await person.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(person, [person.id, agent.id]) })).id;
    const direct = await open(owner);
    const carols = await open(carol);
    const group = (await owner.request<CreateProjectResponse>('POST', '/projects', { name: 'Talk', memberIds: [agent.id], key: await newChatKey(owner, [owner.id, agent.id]) })).channel.id;
    await owner.sync();
    await carol.sync();
    await agent.sync();

    const calls: { input: string; resume: boolean; session: string }[] = [];
    // What the next call does; it gets the call's signal.
    let next: (signal: AbortSignal) => Promise<string> | string = () => 'It adds.';
    const answer: Answerer = ({ conversation, input, resume, signal }) => {
      calls.push({ input, resume, session: conversation.session });
      return Promise.resolve(next(signal)).then((reply) => ({ reply }));
    };
    const conversations = new Conversations(agent, path.join(home, 'talker-conversations.json'), answer);
    const asks = (extra: Partial<Extract<PromptDTO, { kind: 'prompt' }>> = {}): PromptDTO => ({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), ...extra });
    const hear = async () => {
      const heard = await agent.sync();
      for (const m of heard) await conversations.handle(m);
      return heard;
    };
    const said = async () => (await owner.sync()).filter((m) => m.senderId === agent.id).map((m) => [m.content?.prompt, m.content?.text]);

    const first = (await owner.send(direct, { text: 'What does sum.js do?', prompt: asks() })).clientId!;
    await hear();
    assert.deepEqual(calls, [{ input: 'What does sum.js do?', resume: false, session: calls[0]!.session }]);
    assert.deepEqual(await said(), [[{ kind: 'answer', to: first }, 'It adds.']]);

    await owner.send(direct, { text: 'And the test?', prompt: { kind: 'reply', to: first, sentAt: Date.now() } });
    await hear();
    assert.deepEqual(calls[1], { input: 'And the test?', resume: true, session: calls[0]!.session });
    await said();

    // None of these starts a conversation: nothing runs, and nothing is said.
    await carol.send(carols, { text: 'Hi', prompt: asks() });
    await owner.send(group, { text: 'In a channel', prompt: asks() });
    const signed = await owner.send(direct, { text: 'Once', prompt: asks() });
    const heard = await agent.sync();
    for (const m of heard) if (m.id !== signed.id) await conversations.handle(m);
    assert.equal(calls.length, 2, 'no turn ran for them');
    assert.deepEqual(await said(), []);
    const once = heard.find((m) => m.id === signed.id)!;
    await conversations.handle(once);
    assert.equal(calls.length, 3, 'the real one runs');
    assert.equal((await said()).length, 1);
    // The same signed message under a new id, as a server could post it again, runs nothing (K-47).
    await conversations.handle({ ...once, id: once.id + 1000 });
    assert.equal(calls.length, 3);
    // One laptop answers every conversation, so a reply it cannot place hears so (R-036).
    await owner.send(direct, { text: 'Remember me?', prompt: { kind: 'reply', to: 'gone', sentAt: Date.now() } });
    await hear();
    assert.deepEqual(await said(), [[{ kind: 'failed', to: 'gone' }, 'I no longer know this conversation. Start a new one.']]);
    assert.deepEqual(await said(), []);

    // A prompt signed 11 minutes ago is refused, and a reply asks it again, afresh.
    const skipped = (await owner.send(direct, { text: 'Old', prompt: asks({ sentAt: Date.now() - 11 * 60_000 }) })).clientId!;
    await hear();
    assert.equal(calls.length, 3);
    assert.deepEqual((await said()).map((m) => m[1]), ['I got this more than 10 minutes after you sent it, so I skipped it. Reply to ask again.']);
    await owner.send(direct, { text: 'Now?', prompt: { kind: 'reply', to: skipped, sentAt: Date.now() } });
    await hear();
    assert.deepEqual(calls.slice(3).map((c) => [c.input, c.resume]), [['Old\n\nNow?', false]]);
    assert.deepEqual((await said()).map((m) => m[1]), ['It adds.']);
    calls.length = 3;

    // A long answer comes as several messages, in order, each within the limit.
    const long = Array.from({ length: 9 }, (_, i) => `${i}`.repeat(1000)).join('\n');
    next = () => long;
    await owner.send(direct, { text: 'Tell me everything', prompt: asks() });
    await hear();
    const pieces = (await said()).map((m) => m[1] as string);
    assert.ok(pieces.length > 1 && pieces.every((text) => text.length <= 4000), 'each message is short enough');
    assert.equal(pieces.join(''), long, 'in order, with nothing lost');

    // A cancel stops the turn that waits.
    next = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted.'))));
    const slow = await owner.send(direct, { text: 'Think hard', prompt: asks() });
    const waiting = hear();
    for (let tries = 0; tries < 500 && calls.length < 5; tries++) await sleep(10);
    assert.equal(calls.length, 5, 'the turn started');
    await owner.send(direct, { text: 'Stop', prompt: { kind: 'cancel', to: slow.clientId!, sentAt: Date.now() } });
    await hear();
    await waiting;
    assert.deepEqual(await said(), [[{ kind: 'failed', to: slow.clientId! }, 'I stopped, as you asked.']]);

    // A turn that throws says why.
    next = () => {
      throw new Error('No luck.');
    };
    const broken = await owner.send(direct, { text: 'Try', prompt: asks() });
    await hear();
    assert.deepEqual(await said(), [[{ kind: 'failed', to: broken.clientId! }, 'I could not answer. No luck.']]);

    // A first turn that throws, then a reply: it starts afresh with the prompt and the reply.
    next = () => {
      throw new Error('No luck.');
    };
    const retried = await owner.send(direct, { text: 'Try again', prompt: asks() });
    await hear();
    await said();
    next = () => 'Now it works.';
    await owner.send(direct, { text: 'Please?', prompt: { kind: 'reply', to: retried.clientId!, sentAt: Date.now() } });
    await hear();
    assert.deepEqual(calls.at(-1)!.resume, false);
    assert.equal(calls.at(-1)!.input, 'Try again\n\nPlease?');
    assert.deepEqual(await said(), [[{ kind: 'answer', to: retried.clientId! }, 'Now it works.']]);

    // A prompt and its reply from one check-in give two turns, in order.
    next = () => 'One.';
    const together = await owner.send(direct, { text: 'First?', prompt: asks() });
    await owner.send(direct, { text: 'Second?', prompt: { kind: 'reply', to: together.clientId!, sentAt: Date.now() } });
    const pair = await agent.sync();
    const started = calls.length;
    await Promise.all(pair.map((m) => conversations.handle(m)));
    assert.deepEqual(calls.slice(started).map((c) => [c.input, c.resume]), [['First?', false], ['Second?', true]]);
    await said();

    // A prompt and its cancel from one check-in stop the turn.
    next = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted.'))));
    const doomed = await owner.send(direct, { text: 'Think hard again', prompt: asks() });
    await owner.send(direct, { text: 'Stop', prompt: { kind: 'cancel', to: doomed.clientId!, sentAt: Date.now() } });
    await Promise.all((await agent.sync()).map((m) => conversations.handle(m)));
    assert.deepEqual(await said(), [[{ kind: 'failed', to: doomed.clientId! }, 'I stopped, as you asked.']]);

    // A conversation its owner left for a day ends, and a late reply hears so.
    next = () => 'Fine.';
    const old = await owner.send(direct, { text: 'Hello', prompt: asks() });
    await hear();
    await said();
    await conversations.sweep(Date.now() + 23 * 60 * 60_000);
    next = () => 'Still here.';
    await owner.send(direct, { text: 'Hello still', prompt: { kind: 'reply', to: old.clientId!, sentAt: Date.now() } });
    await hear();
    assert.deepEqual(await said(), [[{ kind: 'answer', to: old.clientId! }, 'Still here.']]);
    await conversations.sweep(Date.now() + 25 * 60 * 60_000);
    await owner.send(direct, { text: 'Hello again', prompt: { kind: 'reply', to: old.clientId!, sentAt: Date.now() } });
    const turns = calls.length;
    await hear();
    assert.equal(calls.length, turns);
    assert.deepEqual(await said(), [[{ kind: 'failed', to: old.clientId! }, 'This conversation ended after a day with no reply. Start a new one.']]);

    // A restart that cut a turn short says so, and the next turn starts afresh.
    const file = path.join(home, 'talker-recover.json');
    const cut = { root: randomUUID(), chat: direct, session: randomUUID(), answered: false, prompt: 'Cut short', working: true, last: Date.now() };
    await fs.writeFile(file, JSON.stringify([cut]));
    const restarted = new Conversations(agent, file, answer);
    await restarted.load();
    await restarted.recover();
    assert.deepEqual(await said(), [[{ kind: 'failed', to: cut.root }, 'I stopped, because Claude Code closed on your laptop. Send it again.']]);
    const [saved] = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.ok(!saved.working && saved.session !== cut.session, 'a fresh session');
  });

  test("asks its owner before an action its harness asks about, and goes on with the owner's signed answer from another device (docs/decisions/harness-approvals.md)", { timeout: 60_000 }, async () => {
    const dataDir = path.join(home, 'asker', 'laptop');
    // A harness that asks before it runs a command, and runs it only when told to.
    const turns: Array<{ cwd: string; asked: boolean; reply?: Reply }> = [];
    const fake = {
      name: 'Fake',
      asks: true,
      refusal: async () => undefined,
      offers: () => ({ knobs: [] }),
      found: async () => ({ path: '/fake' }),
      apply: async () => undefined,
      async turn(t) {
        const entry: (typeof turns)[number] = { cwd: t.cwd, asked: !!t.ask };
        turns.push(entry);
        if (t.ask) {
          entry.reply = await t.ask({ tool: 'Bash', kind: 'execute', paths: [], detail: 'npm test' });
          if (entry.reply.allow) await fs.writeFile(path.join(t.cwd, 'ran.txt'), 'x');
        }
        return { reply: entry.reply?.allow ? 'It ran.' : 'It did not run.' };
      },
    } as Harness;
    const code = newPairingCode();
    const plugin = new Plugin({ harnesses: [fake], cloneRoot: path.join(home, 'WebChat'), dataDir, projectDir: home, code: `${baseUrl}#${code}` });
    const starting = plugin.start();
    const agent = await approve(alice, code, 'Asker');
    assert.equal(await starting, true);
    await alice.sync();
    const direct = (await alice.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(alice, [alice.id, agent.id]) })).id;
    const project = (await alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Asks', memberIds: [agent.id], key: await newChatKey(alice, [alice.id, agent.id]) })).project.id;
    // Alice's second device: the same account, signed in again.
    await fs.copyFile(path.join(home, 'alice.json'), path.join(home, 'alice-phone.json'));
    const phone = await AgentClient.load(path.join(home, 'alice-phone.json'));
    await alice.sync();
    await plugin.client!.sync();

    const prompt = async (asks: boolean) => {
      await alice.send(direct, { text: 'Run the tests', prompt: { kind: 'prompt', sentAt: Date.now(), project, ...(asks && { asks: true as const }) } });
      // Not awaited: the turn waits for the owner.
      for (const m of await plugin.client!.sync()) void plugin.handle(m);
    };
    // Everything each reader heard from the agent, since a sync returns a message once.
    const heard = new Map<AgentClient, OpenedMessage[]>();
    const fromAgent = async (reader: AgentClient) => {
      const list = heard.get(reader) ?? [];
      heard.set(reader, list);
      list.push(...(await reader.sync()).filter((m) => m.senderId === agent.id));
      return list;
    };
    /** The nth question the agent asked, once it reaches the reader. */
    const question = async (reader: AgentClient, n: number) => {
      let found: OpenedMessage | undefined;
      await waitFor('the question reaches the owner', async () => !!(found = (await fromAgent(reader)).filter((m) => m.content?.permit?.kind === 'question')[n]));
      return found!;
    };
    const answer = async (to: OpenedMessage, decision: 'once' | 'run' | 'deny', from: AgentClient = phone) => {
      const asked = to.content!.permit as Extract<PermitDTO, { kind: 'question' }>;
      await from.send(direct, { text: 'Answer', permit: { kind: 'answer', to: to.clientId!, decision, seen: await permitHash(asked), sentAt: Date.now() } });
      for (const m of await plugin.client!.sync()) await plugin.handle(m);
    };
    const replies = async () => (await fromAgent(alice)).filter((m) => m.content?.prompt?.kind === 'answer' || m.content?.prompt?.kind === 'failed').map((m) => m.content!.text);

    // The owner's page can show a question: it asks, sealed, and Alice's second device answers.
    await prompt(true);
    const asked = await question(phone, 0);
    const permit = asked.content!.permit as Extract<PermitDTO, { kind: 'question' }>;
    assert.deepEqual([permit.what, permit.detail, typeof permit.to, asked.content!.text.split('\n')[0]], ['run', 'npm test', 'string', 'Your agent asks your permission to run a command:']);
    const [row] = await instance.sql.query<Record<string, unknown>>('SELECT * FROM webchat.messages WHERE id = $1', [asked.id]);
    assert.ok(!JSON.stringify(row).includes('npm test') && !JSON.stringify(row).includes('permission'), 'the server holds the question sealed');
    assert.equal(turns.at(-1)!.reply, undefined, 'the turn waits for the answer');
    await answer(asked, 'once');
    await waitFor('the turn goes on', async () => (await replies()).includes('It ran.'));
    await fs.access(path.join(turns.at(-1)!.cwd, 'ran.txt'));
    assert.deepEqual((await fromAgent(phone)).map((m) => m.content?.permit?.kind).filter(Boolean), ['question', 'settled'], 'the second device learns it was answered');
    // The answer counts once: sent again, it changes nothing.
    await answer(asked, 'deny');
    assert.equal((await replies()).filter((r) => r === 'It did not run.').length, 0);

    // Deny stops that action, and the turn still ends with its answer.
    await prompt(true);
    await answer(await question(phone, 1), 'deny');
    await waitFor('the turn ends', async () => (await replies()).includes('It did not run.'));
    assert.equal(existsSync(path.join(turns.at(-1)!.cwd, 'ran.txt')), false, 'the action did not run');
    assert.deepEqual(turns.at(-1)!.reply, { allow: false, message: 'Your owner said no. Do not try it again: do something else, or stop.' });

    // A page from before questions sets no flag: nothing is asked, and the harness gets no way to ask.
    const quiet = turns.length;
    const permitted = async () => (await fromAgent(alice)).filter((m) => m.content?.permit).length;
    const before = await permitted();
    await prompt(false);
    await waitFor('the turn ran', async () => turns.length === quiet + 1);
    assert.equal(turns.at(-1)!.asked, false);
    assert.equal(await permitted(), before, 'no question was posted');

    // A question that waits 7 days ends the turn, and says so.
    await prompt(true);
    await question(alice, 2);
    await plugin.pollPulls(Date.now() + 8 * 24 * 60 * 60_000);
    await waitFor('the turn failed', async () => (await replies()).includes('I could not answer. No answer came within 7 days.'));
    assert.ok((await fromAgent(alice)).some((m) => m.content?.permit?.kind === 'settled' && m.content.permit.outcome === 'expired'));
  });

  test('goes when its owner deletes their account (R-030)', async () => {
    const dave = await AgentClient.signUp(path.join(home, 'dave.json'), { server: baseUrl, username: 'dave', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Dave', 'friends-only');
    const code = newPairingCode();
    const pairing = AgentClient.pair(path.join(home, 'dave-agent.json'), baseUrl, code, 10);
    const agent = await approve(dave, code, 'Dave agent');
    await pairing;
    await dave.request('DELETE', '/auth/account');
    await alice.sync();
    assert.equal(alice.users.get(dave.id)?.deleted, true);
    assert.equal(alice.users.get(agent.id)?.deleted, true, 'nobody else may hand it cards');
  });

  test('is removed by its owner, and by nobody else (R-033)', async () => {
    const code = newPairingCode();
    const pairing = AgentClient.pair(path.join(home, 'spare.json'), baseUrl, code, 10);
    const spare = await approve(alice, code, 'Spare');
    const agent = await pairing;
    await assert.rejects(carol.request('DELETE', `/agents/${spare.id}`), { status: 404 });
    await alice.request('DELETE', `/agents/${spare.id}`);
    await alice.sync();
    assert.deepEqual([alice.users.get(spare.id)?.deleted, alice.users.get(spare.id)?.agentOwner], [true, null], 'no menu offers it');
    // Its session ends, and it cannot sign in again.
    await assert.rejects(agent.sync(), { status: 401 });
    await assert.rejects(alice.request('DELETE', `/agents/${spare.id}`), { status: 404 });
  });

  test('counts an agent online for 2 minutes after its check-in, a person for 1, on the page and in the sync fingerprint (docs/roadmap/new-agent-setup.md)', async () => {
    const db = await openDb(instance.sql);
    const seen = (id: number, ms: number) => instance.sql.query('UPDATE webchat.users SET last_active_at = $2 WHERE id = $1', [id, Date.now() - ms]);
    // The fingerprint's online part names the ids, and its repositories part hashes who is online by folder.
    const parts = async () => (await db.stamp(alice.id)).split('.');
    const onlineIds = async () => ((await parts())[9] ?? '').split(',');
    const dto = async (id: number) => toUserDTO((await db.listUsers()).find((row) => row.id === id)!);
    await instance.sql.query(`INSERT INTO webchat.agent_repos (user_id, repo, last_seen, protocol) VALUES ($1, 'acme/window', $2, 5)`, [bot.id, Date.now() - 90_000]);
    try {
      await seen(alice.id, 90_000);
      await seen(bot.id, 90_000);
      assert.deepEqual([(await dto(alice.id)).online, (await dto(bot.id)).online, (await dto(bot.id)).agentRepos[0]?.online], [false, true, true]);
      assert.deepEqual([(await onlineIds()).includes(String(alice.id)), (await onlineIds()).includes(String(bot.id))], [false, true]);
      const before = (await parts())[11];
      await seen(bot.id, 150_000);
      await instance.sql.query(`UPDATE webchat.agent_repos SET last_seen = $2 WHERE user_id = $1 AND repo = 'acme/window'`, [bot.id, Date.now() - 150_000]);
      assert.deepEqual([(await dto(bot.id)).online, (await dto(bot.id)).agentRepos[0]?.online], [false, false]);
      assert.equal((await onlineIds()).includes(String(bot.id)), false);
      assert.notEqual((await parts())[11], before, 'the page learns when a folder goes offline');
    } finally {
      await instance.sql.query(`DELETE FROM webchat.agent_repos WHERE repo = 'acme/window'`);
      await alice.sync();
    }
  });

  test('waits for the interval it is asked for before each check-in', async () => {
    const stop = new AbortController();
    let rounds = 0;
    for await (const message of alice.watch(stop.signal, () => (++rounds === 3 && stop.abort(), 5))) assert.ok(message);
    assert.equal(rounds, 3);
  });

  test('tells its owner to wake it in the words of its host', async () => {
    const dataDir = path.join(home, 'wake-words');
    const options = { harnesses: [claudeHarness('', 'true', dataDir)], cloneRoot: path.join(home, 'WebChat'), dataDir, projectDir: home, code: '' };
    assert.match(await new Plugin({ ...options, wake: 'run webchat-agent wake in a terminal' }).call('sleep'), /To wake it, run webchat-agent wake in a terminal\.$/);
    assert.match(await new Plugin(options).call('sleep'), /To wake it, type \/webchat:wake in Claude Code on your laptop\.$/);
  });

  test('sets an agent up with one command: pairs it, installs its login service, replaces it on a second run, and removes it (docs/roadmap/new-agent-setup.md)', { timeout: 30_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(home, 'setup-'));
    const [bin, laptopHome, agentHome, log, ghState] = ['bin', 'home', 'home/.webchat', 'services.log', 'gh.json'].map((name) => path.join(dir, name));
    await fs.mkdir(bin);
    await fs.mkdir(laptopHome);
    await fs.writeFile(ghState, JSON.stringify({ pulls: [] }));
    const fake = (name: string, body: string) => fs.writeFile(path.join(bin, name), body, { mode: 0o755 });
    // One script stands in for launchctl and systemctl: it logs what it was asked and says the service runs.
    const service = `#!/bin/sh\necho "$(basename "$0") $*" >> "${log}"\ncase "$*" in *"print "*) echo "state = running";; *is-active*) echo active;; esac\n`;
    for (const name of ['launchctl', 'systemctl']) await fake(name, service);
    // Everything the laptop would need is there, so setup installs nothing and runs no sudo.
    for (const name of ['git', 'xcode-select', 'bwrap', 'socat']) await fake(name, '#!/bin/sh\n');
    await fake('id', '#!/bin/sh\necho "$FAKE_GROUPS"\n');
    await fake('gh', FAKE_GH);
    await fake('claude', FAKE_CLAUDE);
    await fake('codex', FAKE_CODEX);
    await fake('shell', `#!/bin/sh\nprintf '%s%s%s' __webchat_path__ "$PATH" __webchat_path__\n`);
    const restore = setEnv({
      HOME: laptopHome,
      XDG_CONFIG_HOME: path.join(laptopHome, '.config'),
      SHELL: path.join(bin, 'shell'),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_STATE: ghState,
      FAKE_GROUPS: 'staff admin sudo',
    });
    const said: string[] = [];
    const print = console.log;
    console.log = (...words: unknown[]) => void said.push(words.join(' '));
    const asked: string[] = [];
    const options = { home: agentHome, program: '/opt/webchat-agent', ask: async (question: string) => (asked.push(question), 'y') };
    const unitFile = process.platform === 'darwin' ? path.join(laptopHome, 'Library/LaunchAgents/webchat-agent.plist') : path.join(laptopHome, '.config/systemd/user/webchat-agent.service');
    const commands = async () => (await fs.readFile(log, 'utf8')).trim().split('\n');
    try {
      // Not an administrator: it says so alone, asks nothing and changes nothing.
      process.env.FAKE_GROUPS = 'staff';
      await assert.rejects(setup(`${baseUrl}#${newPairingCode()}`, options), /Nothing was changed/);
      // Only the read-only check that `systemctl --user` runs, on Linux, reaches the services.
      const ran = existsSync(log) ? (await commands()).filter((line) => line !== 'systemctl --user show-environment') : [];
      assert.deepEqual([asked.length, existsSync(unitFile), ran, said.filter((line) => /Administrator/.test(line)).length], [0, false, [], 1]);
      process.env.FAKE_GROUPS = 'staff admin sudo';

      const code = newPairingCode();
      const [agent] = await Promise.all([approve(alice, code, 'Laptop'), setup(`${baseUrl}#${code}`, options)]);
      assert.match(asked[0]!, /pair with .* you approve the agent in WebChat[\s\S]*login service[\s\S]*changes no security setting/);
      assert.match(asked[0]!, /\[x\] Claude Code 2\.1\.300, signed in\n {2}\[x\] Codex 0\.58\.0, signed in/, 'both are ticked: found and signed in');
      assert.ok(said.some((line) => /^ {2}ok {2,}Claude Code 2\.1\.300, signed in: found, not linked\.$/.test(line)), said.join('\n'));
      assert.ok(said.includes('Paired with Alice.'));
      // The account is where `serve` reads it, and the service runs the installed program, with the login shell's PATH.
      const account = JSON.parse(await fs.readFile(path.join(agentHome, 'laptop', 'account.json'), 'utf8')) as { userId: number; owner: number; picked: string[] };
      assert.deepEqual([account.userId, account.owner, account.picked], [agent.id, alice.id, ['Claude Code', 'Codex']]);
      const unit = await fs.readFile(unitFile, 'utf8');
      assert.ok(unit.includes('/opt/webchat-agent') && unit.includes(bin), unit);
      const first = await commands();
      assert.ok(first.some((line) => (process.platform === 'darwin' ? line.startsWith(`launchctl bootstrap gui/${process.getuid!()} ${unitFile}`) : line === 'systemctl --user restart webchat-agent')), first.join('\n'));

      // A second run, with no code, pairs nothing again and replaces the service.
      said.length = 0;
      await setup(undefined, options);
      assert.equal(asked.length, 2);
      assert.doesNotMatch(asked[1]!, /pair with|to link/);
      assert.ok(!said.includes('Approve the agent in WebChat, in the window that shows the code.'));
      assert.ok((await commands()).length > first.length);

      // Declined, uninstall removes nothing; agreed, it leaves no service and no account.
      await assert.rejects(uninstall(agentHome, async () => false), /Nothing was removed/);
      assert.equal(existsSync(unitFile), true);
      await uninstall(agentHome, async () => true);
      assert.deepEqual([existsSync(unitFile), existsSync(path.join(agentHome, 'laptop'))], [false, false]);
      assert.match((await commands()).at(-1) ?? '', process.platform === 'darwin' ? /^launchctl bootout|^launchctl bootstrap/ : /^systemctl --user daemon-reload/);
    } finally {
      console.log = print;
      restore();
    }
  });

  test('finds the supported harnesses on the PATH and in the usual folders, and names each row for doctor', { timeout: 30_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(home, 'finder-'));
    const [bin, userHome, agentHome] = ['bin', 'home', 'home/.webchat'].map((name) => path.join(dir, name));
    await fs.mkdir(bin);
    await fs.mkdir(path.join(userHome, '.local', 'bin'), { recursive: true });
    const fake = (where: string, name: string, body: string) => fs.writeFile(path.join(where, name), body, { mode: 0o755 });
    await fake(bin, 'claude', FAKE_CLAUDE);
    await fake(bin, 'shell', `#!/bin/sh\nprintf '%s%s%s' __webchat_path__ "$PATH" __webchat_path__\n`);
    await fake(bin, 'id', '#!/bin/sh\necho admin sudo\n');
    await fake(bin, 'gh', FAKE_GH);
    await fs.writeFile(path.join(dir, 'gh.json'), JSON.stringify({ pulls: [] }));
    // A PATH of its own, with node for the shims and none of the real harnesses this machine may have.
    await fs.mkdir(path.join(dir, 'tools'));
    await fs.symlink(process.execPath, path.join(dir, 'tools', 'node'));
    const restore = setEnv({ HOME: userHome, SHELL: path.join(bin, 'shell'), PATH: ['relative-bin', bin, path.join(dir, 'tools'), '/usr/bin', '/bin'].join(path.delimiter), FAKE_GH_STATE: path.join(dir, 'gh.json') });
    const print = console.log;
    const said: string[] = [];
    try {
      assert.deepEqual(pathDirs().slice(0, 1), [bin], 'a relative PATH entry is no place to look: the model writes the worktree');
      const find = harnessFinder({ hook: 'true', dataDir: agentHome });
      const where = async () => Promise.all((await find()).map(async (h) => (await h.found()).path));
      const [claude, codex] = await find();
      assert.deepEqual(await where(), [path.join(bin, 'claude'), undefined], 'Codex is not found, and still listed');
      assert.equal(await codex!.refusal(), 'I cannot find Codex on this laptop.');
      // Installed later, in a folder the installers use, it shows at the next look, and the adapter before it stays.
      await fake(path.join(userHome, '.local', 'bin'), 'codex', FAKE_CODEX);
      assert.deepEqual(await where(), [path.join(bin, 'claude'), path.join(userHome, '.local', 'bin', 'codex')]);
      assert.equal((await find())[0], claude, 'an unchanged program keeps its adapter');
      await fs.utimes(path.join(bin, 'claude'), new Date(), new Date(Date.now() + 5000));
      assert.notEqual((await find())[0], claude, 'an updated one gets a new adapter');
      assert.deepEqual([supported('Claude Code')?.id, supported('CODEX')?.id, supported('hermes')], ['claude', 'codex', undefined]);
      assert.equal(supportedList(), 'claude (Claude Code), codex (Codex)');
      await assert.rejects(sh(process.execPath, ['--import', 'tsx', 'agent/index.ts', 'link', 'hermes']), (error: { code: number; stderr: string }) => error.code === 1 && /^'hermes' is not a harness WebChat supports\. Supported: claude \(Claude Code\), codex \(Codex\)\./.test(error.stderr));

      assert.equal(await claudeHarness(path.join(bin, 'claude'), '', agentHome).refusal(), undefined);
      await withEnv({ FAKE_CLAUDE_VERSION: '2.1.258' }, async () => assert.equal(await claudeHarness(path.join(bin, 'claude'), '', agentHome).refusal(), 'Claude Code 2.1.258 is older than 2.1.259, which I need. Update it.'));
      for (const [found, min, ok] of [['2.1.259', '2.1.259', true], ['2.1.260', '2.1.259', true], ['2.2.0', '2.1.259', true], ['3', '2.1.259', true], ['2.1.258', '2.1.259', false], ['2.0.999', '2.1.259', false], ['2.1.259-beta', '2.1.259', true], ['dev', '2.1.259', true], [undefined, '2.1.259', true]] as const) {
        assert.equal(versionAtLeast(found, min), ok, `${found} against ${min}`);
      }

      // One doctor line per supported harness, for each state a row can be in (docs/decisions/harness-linking.md).
      console.log = (...words: unknown[]) => void said.push(words.join(' '));
      const doctorSays = async (linked: string[], env: Record<string, string> = {}) => {
        await fs.mkdir(path.join(agentHome, 'laptop', 'laptop'), { recursive: true });
        await fs.writeFile(path.join(agentHome, 'laptop', 'laptop', 'setup.json'), JSON.stringify({ choice: { claudeMd: false, skills: [], noAttribution: false, linked } }));
        said.length = 0;
        await withEnv(env, () => doctor(agentHome));
        process.exitCode = 0;
        return said.filter((line) => /^ {2}\w+ {2,}(Claude Code|Codex)/.test(line)).map((line) => line.replace(/^ {2}\w+ {2,}/, ''));
      };
      assert.deepEqual(await doctorSays(['Claude Code', 'Codex']), ['Claude Code 2.1.300, signed in: linked.', 'Codex 0.58.0, signed in: linked.']);
      assert.deepEqual(await doctorSays(['Claude Code']), ['Claude Code 2.1.300, signed in: linked.', 'Codex 0.58.0, signed in: found, not linked.']);
      assert.deepEqual((await doctorSays(['Codex'], { FAKE_CODEX_SIGNED_OUT: '1' }))[1], 'Codex 0.58.0: linked, needs attention.');
      assert.deepEqual((await doctorSays(['Claude Code'], { FAKE_CLAUDE_VERSION: '2.1.0' }))[0], 'Claude Code 2.1.0, signed in: linked, needs attention.');
      await fs.rm(path.join(userHome, '.local', 'bin', 'codex'));
      assert.deepEqual(await doctorSays(['Codex']), ['Claude Code 2.1.300, signed in: found, not linked.', 'Codex: linked, needs attention.']);
      assert.deepEqual(await doctorSays([]), ['Claude Code 2.1.300, signed in: found, not linked.', 'Codex: not installed.']);
    } finally {
      console.log = print;
      restore();
    }
  });

  test('reads setup\'s answer: yes takes the ticked harnesses, names take exactly those, and anything else stops it', () => {
    const found = [
      { id: 'claude', name: 'Claude Code', command: 'claude', program: '/bin/claude', signedIn: true },
      { id: 'codex', name: 'Codex', command: 'codex', program: '/bin/codex' },
    ];
    const names = (answer: string) => linksFrom(answer, found)?.map((f) => f.name);
    assert.deepEqual([names('y'), names('Yes'), names('none'), names('codex'), names('claude-code, codex'), names('codex codex')], [['Claude Code'], ['Claude Code'], [], ['Codex'], ['Claude Code', 'Codex'], ['Codex']]);
    assert.deepEqual([names(''), names('n'), names('hermes'), names('claude hermes')], [undefined, undefined, undefined, undefined]);
  });

  test('keeps the file tools away from the secrets, even through a link (R-030)', async () => {
    const dir = await fs.mkdtemp(path.join(home, 'guard-'));
    const data = path.join(dir, 'data');
    const project = path.join(dir, 'app');
    const worktree = path.join(project, '.claude', 'worktrees', 'k-7');
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(data);
    await fs.symlink(data, path.join(worktree, 'link'));
    const use = (tool_name: string, tool_input: Record<string, unknown> = {}, cwd = project) => ({ tool_name, tool_input, cwd });
    assert.match(guard(use('Read', { file_path: path.join(data, 'account.json') }), [data]) ?? '', /secrets/);
    assert.match(guard(use('Read', { file_path: 'link/account.json' }, worktree), [data]) ?? '', /secrets/);
    assert.equal(guard(use('Read', { file_path: 'README.md' }), [data]), undefined);
    // Nor through a link to a file not made yet, which Write would make in the folder (K-55).
    await fs.symlink(path.join(data, 'new.json'), path.join(worktree, 'new.json'));
    await fs.symlink('loop', path.join(worktree, 'loop'));
    await fs.mkdir(path.join(data, 'inner'));
    await fs.writeFile(path.join(data, 'account.json'), '{}');
    await fs.symlink(path.join(data, 'inner'), path.join(worktree, 'inner'));
    await fs.symlink('inner/../account.json', path.join(worktree, 'up.json'));
    await fs.symlink('inner/../made.json', path.join(worktree, 'up-new.json'));
    await fs.mkdir(path.join(worktree, 'a', 'b'), { recursive: true });
    await fs.symlink(path.join(worktree, 'a', 'b'), path.join(worktree, 'hop'));
    await fs.symlink(path.relative(path.join(worktree, 'a', 'b'), path.join(data, 'far.json')), path.join(worktree, 'a', 'b', 'far.json'));
    const caseBlind = await fs.access(path.join(dir, 'DATA')).then(() => true, () => false);
    assert.match(guard(use('Write', { file_path: 'new.json' }, worktree), [data]) ?? '', /secrets/);
    assert.equal(guard(use('Write', { file_path: 'loop' }, worktree), [data]), undefined, 'a loop of links ends');
    // Paths resolve as the kernel resolves them: `..` after a link goes up from its target, and other
    // letter case names the folder where the disk ignores case, as macOS's does by default.
    assert.match(guard(use('Read', { file_path: 'up.json' }, worktree), [data]) ?? '', /secrets/);
    assert.match(guard(use('Write', { file_path: 'up-new.json' }, worktree), [data]) ?? '', /secrets/);
    // A relative link counts from its real folder, not from the linked folder that named it.
    assert.match(guard(use('Write', { file_path: 'hop/far.json' }, worktree), [data]) ?? '', /secrets/);
    assert.equal(guard(use('Read', { file_path: path.join(dir, 'DATA', 'account.json') }), [data]) !== undefined, caseBlind);

    // A background Claude reads only managed settings and the plugin's file, so the project cannot reopen the secrets (R-035).
    await fs.writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({ sandbox: { filesystem: { allowRead: [data] } } }));
    const file = path.join(dir, 'claude.json');
    await fs.writeFile(file, JSON.stringify(claudeSettings({ secrets: [data], npmCache: path.join(dir, 'npm'), guard: 'true', env: {} })));
    assert.equal(await sandboxProblem(project, [data], restrictedSettings(file)), undefined);
    // Its reads stop at the working directories, so only a folder inside them needs a rule of its own.
    assert.match((await sandboxProblem(project, [data, path.join(project, 'keys')], restrictedSettings(file))) ?? '', /could read/, 'a folder in the project the file leaves out');
    const off = path.join(dir, 'off.json');
    await fs.writeFile(off, '{}');
    assert.match((await sandboxProblem(project, [data], restrictedSettings(off))) ?? '', /turn its sandbox off/);
    // Where the sandbox cannot start, Claude Code would run the shell without it unless told to fail (K-53).
    const unsafe = path.join(dir, 'unsafe.json');
    await fs.writeFile(unsafe, JSON.stringify({ sandbox: { failIfUnavailable: false } }));
    assert.match((await sandboxProblem(project, [data], [[unsafe, dir], [file, dir]])) ?? '', /unsandboxed/);
    // Managed settings come first and can reopen a folder; the narrower rule decides, as in Claude Code.
    const managed = path.join(dir, 'managed.json');
    await fs.writeFile(managed, JSON.stringify({ sandbox: { filesystem: { allowRead: [path.join(data, 'keys')] } } }));
    assert.match((await sandboxProblem(project, [path.join(data, 'keys')], [[managed, dir], [file, dir]])) ?? '', /could read/, 'a narrower allow wins');
    // Its shell gets no variable that holds a credential, by its name or by a password in a URL.
    const env = { GH_TOKEN: 'x', DATABASE_URL: 'postgres://me:pw@db/app', SSH_AUTH_SOCK: '/tmp/agent', MY_VAR: 'ghp_abc', PATH: '/bin', HOME: '/home/me' };
    const denied = claudeSettings({ secrets: [], npmCache: '', guard: '', env }).sandbox.credentials.envVars.map((v) => v.name);
    assert.deepEqual(denied, ['GH_TOKEN', 'DATABASE_URL', 'SSH_AUTH_SOCK', 'MY_VAR']);
  });
});

test("runs git in a worktree on the git folder its checkout lists, whatever the worktree's .git file says", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-git-')));
  // The checkout is reached through a link, and its worktree's pointer is relative, as git 2.48 can write it.
  await fs.mkdir(path.join(dir, 'real'));
  await fs.symlink(path.join(dir, 'real'), path.join(dir, 'link'));
  const project = path.join(dir, 'link', 'app');
  await sh('git', ['init', '-q', project]);
  await git(project, 'commit', '-q', '--allow-empty', '-m', 'Start');
  const worktree = path.join(project, '.claude', 'worktrees', 'k-7');
  await git(project, 'worktree', 'add', '-q', '--detach', worktree);
  const admin = path.join(dir, 'real', 'app', '.git', 'worktrees', 'k-7');
  await fs.writeFile(path.join(admin, 'gitdir'), '../../../.claude/worktrees/k-7/.git\n');
  // The model points the worktree, and a submodule it stages, at a git folder whose config runs a command.
  const planted = path.join(dir, 'planted');
  await sh('git', ['init', '-q', planted]);
  await git(planted, 'commit', '-q', '--allow-empty', '-m', 'Planted');
  const ran = path.join(dir, 'ran');
  await git(planted, 'config', 'core.fsmonitor', `touch ${ran}`);
  const plantedHead = (await git(planted, 'rev-parse', 'HEAD')).stdout.trim();
  await sh('git', [`--git-dir=${admin}`, `--work-tree=${worktree}`, 'update-index', '--add', '--cacheinfo', `160000,${plantedHead},sub`]);
  await fs.mkdir(path.join(worktree, 'sub'));
  await fs.writeFile(path.join(worktree, 'sub', '.git'), `gitdir: ${path.join(planted, '.git')}\n`);
  await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(planted, '.git')}\n`);
  assert.equal(await fs.realpath(await worktreeGit(worktree, 'rev-parse', '--absolute-git-dir')), admin);
  await worktreeGit(worktree, 'status', '--porcelain');
  await worktreeGit(worktree, 'diff', '--cached', '--quiet').catch(() => undefined);
  assert.equal(existsSync(ran), false, 'the planted config ran nothing');
  await fs.rm(dir, { recursive: true, force: true });
});

test('cuts an answer into messages after line breaks, never inside a surrogate pair', () => {
  const line = 'x'.repeat(3900);
  const [one, two] = parts(`${line}\n  ${'z'.repeat(200)}\n${'y'.repeat(300)}`);
  assert.equal(one, `${line}\n`);
  assert.ok(two!.startsWith(`  ${'z'.repeat(5)}`), 'the next line keeps its indentation');
  const emoji = parts(`${'a'.repeat(3999)}\u{1F600} and more`);
  assert.ok(emoji.length > 1);
  for (const part of emoji) assert.ok(!/[\ud800-\udbff]$/.test(part), 'no part ends inside a pair');
  assert.equal(emoji.join(''), `${'a'.repeat(3999)}\u{1F600} and more`);
});

test('answers through Codex app-server, one process for a session, and resumes its thread after a restart; takes no cards', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-codex-')));
  const program = path.join(dir, 'codex');
  const log = path.join(dir, 'codex.log');
  await fs.writeFile(program, FAKE_CODEX, { mode: 0o755 });
  // The owner's Codex config lists MCP servers, which are turned off by name.
  const home = path.join(dir, 'home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'config.toml'), '[mcp_servers.github]\ncommand = "x"\n[mcp_servers.github.env]\nA = "1"\n[mcp_servers."odd.name"]\ncommand = "y"\n');
  const restore = setEnv({ FAKE_CODEX_LOG: log, CODEX_HOME: home });
  const entries = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string; args?: string[]; input?: string; schema?: object; thread?: string; pid?: number; params?: Record<string, unknown> });
  const harnesses: Harness[] = [];
  try {
    const schema = { type: 'object', properties: { reply: { type: 'string' }, drafts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } }, required: ['reply'] };
    const turn = (harness: Harness, resume: boolean, message: string) => harness.turn({ cwd: dir, session: 's-1', resume, message, schema, setup: {}, signal: new AbortController().signal });
    const harness = codexHarness(program, dir);
    harnesses.push(harness);
    assert.equal(await harness.refusal(), undefined, 'it answers questions');
    assert.equal(await harness.refusal(dir), CODEX_GAP, 'it takes no cards');
    assert.equal(await codexHarness('', dir).refusal(), 'I cannot find Codex on this laptop.');
    assert.deepEqual(await turn(harness, false, 'What does sum.js do?'), { reply: 'It adds.' }, 'a null for a left-out field is dropped');
    assert.deepEqual(await turn(harness, true, 'And again?'), { reply: 'It adds.' });
    // A restart keeps the thread of each session.
    const again = codexHarness(program, dir);
    harnesses.push(again);
    await withEnv({ FAKE_CODEX_ANSWER: '{"reply":"Still adds.","drafts":[{"title":"Sums"}]}' }, () => turn(again, true, 'And now?'));
    const all = await entries();
    const [first, second, third] = all.filter((e) => e.method === 'turn/start');
    const [start, resumed] = all.filter((e) => e.method?.startsWith('thread/'));
    assert.equal(first!.input, 'What does sum.js do?');
    assert.equal(first!.pid, second!.pid, 'one process takes the turns of a session');
    assert.notEqual(first!.pid, third!.pid, 'a restart starts another');
    assert.equal(start!.method, 'thread/start');
    assert.equal(resumed!.method, 'thread/resume');
    assert.equal(resumed!.params!.threadId, '0199a213-81c0-7800-8aa1-bbab2a035a53');
    assert.equal(start!.params!.approvalPolicy, 'never', 'with no question to ask, it asks for nothing');
    const args = all[0]!.args!;
    assert.ok(!args.some((arg) => arg.includes('sum.js')), 'the message is never in the arguments');
    assert.ok(args.includes('shell_environment_policy.inherit="core"') && args.includes('features.hooks=false'), "none of the owner's hooks or tokens");
    assert.ok(args.includes('mcp_servers.github.enabled=false') && args.includes('mcp_servers."odd.name".enabled=false'), "none of the owner's MCP servers, one by one");
    assert.ok(!args.includes('--ignore-user-config'), 'app-server has no such flag');
    assert.deepEqual(first!.schema, {
      type: 'object',
      properties: {
        reply: { type: 'string' },
        drafts: { anyOf: [{ type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }, { type: 'null' }] },
      },
      required: ['reply', 'drafts'],
      additionalProperties: false,
    });
    await assert.rejects(withEnv({ FAKE_CODEX_FAIL: 'Usage limit reached.' }, () => turn(again, true, 'Again?')), /Usage limit reached/);
  } finally {
    restore();
    await Promise.all(harnesses.map((h) => h.end?.()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('asks through Claude Code\'s permission prompt tool, one process for a session, and no rule outlives the turn (docs/decisions/harness-approvals.md)', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-claude-ask-')));
  const program = path.join(dir, 'claude');
  await fs.writeFile(program, FAKE_CLAUDE, { mode: 0o755 });
  const [log, asked] = [path.join(dir, 'claude.log'), path.join(dir, 'asked.log')];
  const calls = [
    { tool_name: 'Bash', input: { command: 'npm test ../elsewhere', description: 'Quietly delete everything' } },
    { tool_name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
    { tool_name: 'mcp__owner__mail', input: { to: 'x' } },
  ];
  const restore = setEnv({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_ASKED: asked, FAKE_CLAUDE_ASK: JSON.stringify(calls), FAKE_CLAUDE_COMMIT: '0' });
  const harness = claudeHarness(program, 'true', dir);
  try {
    await fs.mkdir(path.join(dir, 'laptop'), { recursive: true });
    const one = { type: 'object', properties: { outcome: { type: 'string', enum: ['holds', 'stale'] }, note: { type: 'string' }, checked: { type: 'string' } }, required: ['outcome', 'note', 'checked'] };
    const two = { type: 'object', properties: { outcome: { type: 'string', enum: ['done', 'failed'] }, note: { type: 'string' }, title: { type: 'string' } }, required: ['outcome', 'note'] };
    const seen: Ask[] = [];
    const replies: Reply[] = [{ allow: true }, { allow: false, message: 'Your owner said no.' }, { allow: true }];
    const turn = (over: Partial<Turn> = {}) =>
      harness.turn({ cwd: dir, session: 's-1', resume: false, message: 'Run it', schema: two, schemas: [one, two], setup: {}, signal: new AbortController().signal, ask: async (ask) => (seen.push(ask), replies[seen.length - 1]!), ...over });
    await withEnv({ FAKE_CLAUDE_ANSWER: '{"outcome":"done","note":"ok"}' }, () => turn());
    // What the owner is asked is the tool's own input, never the model's description, and paths are the ones that name a place.
    assert.deepEqual(seen.map((a) => [a.tool, a.kind, a.detail, a.paths]), [
      ['Bash', 'execute', 'npm test ../elsewhere', [path.resolve(dir, '../elsewhere')]],
      ['Edit', 'edit', 'Edit src/a.ts', [path.join(dir, 'src/a.ts')]],
      ['mcp__owner__mail', 'other', 'mcp__owner__mail {"to":"x"}', []],
    ]);
    const decisions = (await fs.readFile(asked, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { decision: { behavior: string; message?: string; updatedInput?: object } });
    assert.deepEqual(decisions.map((d) => d.decision.behavior), ['allow', 'deny', 'allow']);
    assert.deepEqual(decisions[0]!.decision.updatedInput, calls[0]!.input, 'an allow hands the input back');
    assert.equal(decisions[1]!.decision.message, 'Your owner said no.');
    const [first] = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; input: string; pid: number; mcp: { mcpServers: { webchat: { type: string; url: string; timeout: number } } } });
    const flag = (name: string) => first!.args[first!.args.indexOf(name) + 1];
    assert.equal(flag('--permission-prompt-tool'), 'mcp__webchat__approve');
    assert.equal(flag('--disallowedTools'), 'mcp__webchat__approve', 'the model cannot call the tool');
    assert.ok(first!.args.includes('--strict-mcp-config') && first!.args.includes('--restricted') && !first!.args.includes('--permission-prompts'));
    assert.equal(first!.args.at(-2), '--session-id');
    assert.deepEqual(first!.mcp.mcpServers.webchat.type, 'http');
    assert.match(first!.mcp.mcpServers.webchat.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, 'a port of this machine only');
    assert.ok(first!.mcp.mcpServers.webchat.timeout > 7 * 24 * 60 * 60_000, 'it outwaits the 7 days a question waits');
    // One schema serves the session, with what every turn needs; the turn's own schema is in its message.
    const schema = JSON.parse(flag('--json-schema')!) as { properties: Record<string, { enum?: string[] }>; required: string[] };
    assert.deepEqual([Object.keys(schema.properties), schema.properties.outcome!.enum, schema.required], [['outcome', 'note', 'checked', 'title'], ['holds', 'stale', 'done', 'failed'], ['outcome', 'note']]);
    assert.ok(first!.input.includes('Answer this message only') && first!.input.includes(JSON.stringify(two)), 'each turn says to answer afresh, as its own schema says');
    assert.ok(!first!.args.some((arg) => arg.includes('Run it')), 'the message is never in the arguments');
    assert.equal((await fs.readdir(path.join(dir, 'laptop', 'approve'))).length, 1, 'a token file while it runs');

    // A later turn of the session goes to the same process, which takes a different schema; one with no way to ask starts another that refuses.
    seen.length = 0;
    replies.push({ allow: true }, { allow: true }, { allow: true });
    await withEnv({ FAKE_CLAUDE_ANSWER: '{"outcome":"holds","note":"","checked":"x"}' }, () => turn({ resume: true, schema: one }));
    const later = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { pid: number; turn: number; args: string[] });
    assert.deepEqual([later[1]!.pid === later[0]!.pid, later[1]!.turn], [true, 1], 'one process takes the session\'s turns');
    await withEnv({ FAKE_CLAUDE_ANSWER: '{"outcome":"done","note":"ok"}' }, () => turn({ resume: true, ask: undefined }));
    const refusing = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { pid: number; args: string[] }).at(-1)!;
    assert.notEqual(refusing.pid, later[0]!.pid);
    assert.deepEqual([refusing.args.includes('--permission-prompts'), refusing.args.includes('--mcp-config'), refusing.args.includes('--resume')], [true, false, true]);
    // An answer that does not fit the turn's own schema fails the turn.
    await assert.rejects(withEnv({ FAKE_CLAUDE_ANSWER: '{"outcome":"done"}' }, () => turn({ ask: undefined })), /answer did not fit: the answer\.note: required/);
    // A question that cannot be asked fails the turn with the reason, and its process ends.
    await assert.rejects(turn({ resume: true, ask: async () => Promise.reject(new Error('No answer came within 7 days.')) }), /^Error: No answer came within 7 days\.$/);
    await harness.end?.();
    assert.deepEqual(await fs.readdir(path.join(dir, 'laptop', 'approve')), [], 'no token file outlives its process');
  } finally {
    restore();
    await harness.end?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('answers Codex\'s approvals accept or decline only, and never a rule that outlives one (docs/decisions/harness-approvals.md)', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-codex-ask-')));
  const program = path.join(dir, 'codex');
  const log = path.join(dir, 'codex.log');
  await fs.writeFile(program, FAKE_CODEX, { mode: 0o755 });
  const requests = [
    { method: 'item/commandExecution/requestApproval', params: { itemId: 'i1', command: '/bin/zsh -lc \'curl https://example.com\'', cwd: dir } },
    { method: 'item/fileChange/requestApproval', params: { itemId: 'i2', reason: null, grantRoot: null }, changes: [{ path: 'src/a.ts', kind: 'update', diff: '' }] },
    { method: 'item/fileChange/requestApproval', params: { itemId: 'i3', grantRoot: '/' }, changes: [{ path: 'b.ts', kind: 'add', diff: '' }] },
    { method: 'item/permissions/requestApproval', params: { itemId: 'i4' } },
  ];
  const restore = setEnv({ FAKE_CODEX_LOG: log, FAKE_CODEX_ASK: JSON.stringify(requests), CODEX_HOME: path.join(dir, 'none') });
  const harness = codexHarness(program, dir);
  try {
    const schema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };
    const seen: Ask[] = [];
    await harness.turn({ cwd: dir, session: 's-1', resume: false, message: 'Go', schema, setup: {}, signal: new AbortController().signal, ask: async (ask): Promise<Reply> => (seen.push(ask), seen.length === 1 ? { allow: true } : { allow: false, message: 'No.' }) });
    assert.deepEqual(seen.map((a) => [a.tool, a.kind, a.detail, a.paths]), [
      ['shell', 'execute', '/bin/zsh -lc \'curl https://example.com\'', []],
      ['apply_patch', 'edit', path.join(dir, 'src/a.ts'), [path.join(dir, 'src/a.ts')]],
    ], 'a file change names its files from the item it joins, and one that asks for a whole folder is declined unasked');
    const entries = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { method?: string; params?: { approvalPolicy: string }; asked?: string; decision?: unknown });
    assert.equal(entries.find((e) => e.method === 'thread/start')!.params!.approvalPolicy, 'on-request', 'with a way to ask, Codex asks');
    assert.deepEqual(
      entries.filter((e) => e.asked).map((e) => [e.asked, e.decision]),
      [
        ['item/commandExecution/requestApproval', { decision: 'accept' }],
        ['item/fileChange/requestApproval', { decision: 'decline' }],
        ['item/fileChange/requestApproval', { decision: 'decline' }],
        ['item/permissions/requestApproval', { code: -32601, message: 'WebChat answers only the approval of a command or a file change.' }],
      ],
      'only accept or decline, never a decision for the session or an amendment',
    );
    // A question that cannot be asked fails the turn with its reason.
    await assert.rejects(harness.turn({ cwd: dir, session: 's-2', resume: false, message: 'Go', schema, setup: {}, signal: new AbortController().signal, ask: () => Promise.reject(new Error('No answer came within 7 days.')) }), /^Error: No answer came within 7 days\.$/);
  } finally {
    restore();
    await harness.end?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Claude Code's own behaviour, which the plugin relies on (R-035, D-097). It costs a few cents of
// the account `claude` is signed in to, so it runs only when asked. Run it after each Claude Code
// update: a -p run drops, without a word, a settings file holding a value it no longer accepts.
test(
  'runs a background Claude restricted, sandboxed and guarded, and resumes its session (R-035)',
  { skip: !process.env.WEBCHAT_REAL_CLAUDE && 'set WEBCHAT_REAL_CLAUDE=1 to run it with your claude', timeout: 10 * 60_000 },
  async (t) => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-claude-')));
    const data = path.join(dir, 'data');
    const project = path.join(dir, 'app');
    const worktree = path.join(project, '.claude', 'worktrees', 'k-1');
    const canary = `CANARY-${randomUUID()}`;
    await fs.mkdir(path.join(project, '.claude'), { recursive: true });
    await fs.mkdir(data);
    await fs.writeFile(path.join(data, 'canary.txt'), canary);
    // A repository's settings and MCP servers, which a restricted run must not load.
    await fs.writeFile(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${path.join(dir, 'hook-ran')}` }] }] },
        sandbox: { filesystem: { allowRead: [data] } },
      }),
    );
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'touch', args: [path.join(dir, 'mcp-ran')] } } }));
    await git(project, 'init', '-q');
    // The sandboxed shell commits with plain git, so the repository needs a name to commit under.
    await git(project, 'config', 'user.name', 'Claude');
    await git(project, 'config', 'user.email', 'claude@example.com');
    await git(project, 'add', '-A');
    await git(project, 'commit', '-q', '-m', 'Start');
    await git(project, 'worktree', 'add', '-q', '-b', 'agent/k-1', worktree);
    // A link in the worktree, which the file tools follow and the guard must catch.
    await fs.symlink(data, path.join(worktree, 'link'));

    const settings = path.join(dir, 'claude.json');
    const tsx = fileURLToPath(import.meta.resolve('tsx'));
    const hook = `"${process.execPath}" --import "${tsx}" "${fileURLToPath(new URL('../agent/mcp.ts', import.meta.url))}" guard "${data}"`;
    // Tokens the owner's environment holds, which the shell of a background Claude must not inherit.
    const githubToken = `gho_CANARY${randomUUID().replaceAll('-', '')}`.slice(0, 40);
    const npmToken = `npm_CANARY${randomUUID().replaceAll('-', '')}`.slice(0, 40);
    t.after(setEnv({ GH_TOKEN: githubToken, NPM_TOKEN: npmToken }));
    // Claude Code lets a sandboxed shell read the environments SessionStart hooks left, tokens and all.
    const sessionEnv = path.join(os.homedir(), '.claude', 'session-env');
    await fs.writeFile(settings, JSON.stringify(claudeSettings({ secrets: [data, sessionEnv], npmCache: path.join(dir, 'npm'), guard: hook, env: process.env })));
    assert.equal(await sandboxProblem(worktree, [data], restrictedSettings(settings)), undefined);

    const lines: string[] = [];
    const session = randomUUID();
    const answer = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };
    const turn = (input: string, resume: boolean) => runClaude([...claudeArgs({ settings, session, resume, schema: answer }), '--model', 'haiku', '--max-budget-usd', '1'], worktree, input, (line) => lines.push(line));
    const first = await turn(
      [
        'This checks a sandbox. Do these steps in order, one tool call each, and do not retry one that fails. Steps 1 to 3, 6 and 7 are meant to fail.',
        `1. Run with the Bash tool: cat ${path.join(data, 'canary.txt')}`,
        '2. Use the Read tool on link/canary.txt',
        "3. Run with the Bash tool: curl -sS -m 8 -o /dev/null -w '%{http_code}' https://example.com",
        "4. Run with the Bash tool: curl -sS -m 8 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/left-pad",
        '5. Run with the Bash tool: echo hi > notes.txt && git add notes.txt && git commit -q -m "Add notes"',
        '6. Run with the Bash tool: ls ~/Library/Keychains',
        '7. Run with the Bash tool: ls ~/.claude/session-env',
        '8. Run with the Bash tool: npm view left-pad version',
        '9. Run with the Bash tool: printenv > env.txt',
        '10. Keep the word PELICAN in mind for later.',
        'Then put one line per step in reply.',
      ].join('\n'),
      false,
    );
    assert.equal(first.session, session);
    assert.ok(first.answer, 'the turn ends with the JSON answer');

    // What each tool call returned, by the command or file it named.
    const events = lines.map((line) => JSON.parse(line) as { type: string; message?: { content?: Array<Record<string, unknown>> } });
    const blocks = events.flatMap((e) => (e.type === 'assistant' || e.type === 'user' ? (e.message?.content ?? []) : []));
    const resultOf = (named: string) => {
      const use = blocks.find((b) => b.type === 'tool_use' && JSON.stringify(b.input).includes(named));
      assert.ok(use, `Claude tried: ${named}`);
      return JSON.stringify(blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === use.id)?.content);
    };
    assert.match(resultOf('cat '), /Operation not permitted/, 'the sandbox keeps the shell from the secrets, whatever the project allows');
    assert.match(resultOf('link/canary.txt'), /secrets the WebChat plugin keeps/, 'the guard hook runs, and follows the link');
    assert.match(resultOf('example.com'), /deny network-outbound/, 'the shell reaches no other host');
    assert.match(resultOf('registry.npmjs.org'), /200/, 'the shell reaches the registry');
    assert.ok(!lines.some((line) => line.includes(canary)), 'the secret never reaches the model');
    assert.match((await git(worktree, 'log', '--format=%s', '-1')).stdout, /Add notes/, 'the sandboxed shell commits in the worktree');
    assert.equal(await fs.stat(path.join(dir, 'hook-ran')).catch(() => null), null, "the repository's hook never runs");
    assert.equal(await fs.stat(path.join(dir, 'mcp-ran')).catch(() => null), null, "the repository's MCP server never runs");
    // gh keeps the owner's token in the keychain, which the shell reaches only through these files (K-54).
    assert.match(resultOf('Library/Keychains'), /Operation not permitted/, 'the shell cannot read the home folder, keychain included');
    assert.match(resultOf('session-env'), /Operation not permitted|No such file/, 'the shell cannot read the environments hooks left');
    assert.match(resultOf('npm view'), /\d+\.\d+\.\d+/, "npm works with a cache and no config of the owner's");

    const env = await fs.readFile(path.join(worktree, 'env.txt'), 'utf8');
    assert.ok(env.includes('PATH='), 'the command ran');
    assert.ok(!env.includes(githubToken), 'the shell gets no GitHub token from the environment');
    assert.ok(!env.includes(npmToken), 'the shell gets no npm token from the environment');

    const second = await turn('Which word did the first message ask you to keep in mind? Put only that word in reply.', true);
    assert.equal(second.session, session);
    assert.match(String((second.answer as { reply?: string } | undefined)?.reply), /PELICAN/i, 'the turn resumes the session');
  },
);

test(
  "runs a real background Claude with its owner's CLAUDE.md, a chosen skill and no attribution (R-039)",
  { skip: !process.env.WEBCHAT_REAL_CLAUDE && 'set WEBCHAT_REAL_CLAUDE=1 to run it with your claude', timeout: 10 * 60_000 },
  async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-setup-')));
    const project = path.join(dir, 'app');
    // The plugin folder a turn gets: only skills/, with the chosen skill's copy.
    const skills = path.join(dir, 'turn', 'owner');
    await fs.mkdir(path.join(skills, 'skills', 'pr-title'), { recursive: true });
    await fs.writeFile(
      path.join(skills, 'skills', 'pr-title', 'SKILL.md'),
      '---\nname: pr-title\ndescription: How to title a pull request. Use it whenever you write a pull request title.\n---\nA pull request title starts with "Ostrich: ", then says what changed.\n',
    );
    const claudeMd = path.join(dir, 'CLAUDE.md');
    await fs.writeFile(claudeMd, 'Before you write a pull request title, use the pr-title skill.\n');
    await fs.mkdir(project);
    await git(project, 'init', '-q');
    await git(project, 'config', 'user.name', 'Claude');
    await git(project, 'config', 'user.email', 'claude@example.com');
    await git(project, 'commit', '-q', '--allow-empty', '-m', 'Start');
    const settings = path.join(dir, 'claude.json');
    await fs.writeFile(settings, JSON.stringify(claudeSettings({ secrets: [], npmCache: path.join(dir, 'npm'), guard: 'true', env: process.env, noAttribution: true })));
    const answer = { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] };
    const turn = await runClaude(
      [...claudeArgs({ settings, session: randomUUID(), resume: false, schema: answer, claudeMd, skills }), '--model', 'haiku', '--max-budget-usd', '1'],
      project,
      'Add a line "hi" to notes.txt and commit it with git. Then answer with the title and the body of a pull request for it.',
    );
    const pull = turn.answer as { title?: string; body?: string } | undefined;
    assert.match(pull?.title ?? '', /^Ostrich: /, 'the title follows the chosen skill, which CLAUDE.md named');
    assert.doesNotMatch(pull?.body ?? '', /Generated with/i, 'the body has no attribution line');
    const commit = (await git(project, 'log', '-1', '--format=%B')).stdout;
    assert.ok(commit.trim() && commit.trim() !== 'Start', 'the turn committed');
    assert.doesNotMatch(commit, /Co-Authored-By/i, 'the commit has no attribution trailer');
  },
);
