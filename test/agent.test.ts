import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Api } from '../agent/api.ts';
import { claudeArgs, claudeSettings } from '../agent/claude.ts';
import { AgentClient, type OpenedMessage } from '../agent/client.ts';
import { Conversations, parts, type Answerer } from '../agent/conversations.ts';
import { guard, Plugin, restrictedSettings, sandboxProblem } from '../agent/plugin.ts';
import { addWorktree, claudeResult, start, type Final } from '../agent/runner.ts';
import { REQUEST_TTL_MS, Runs, type Runner } from '../agent/runs.ts';
import { createApp, type WebChatApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { keyFingerprint, newChatKeyBytes, newKeyId, newPairingCode, pairingId, pairingProof, textHash, wrapChatKey } from '../shared/e2ee.ts';
import { copyOf, readCard } from '../shared/board.ts';
import { briefText, type RunReport, type ConversationDTO, type CreateProjectResponse, type FirstChatKeyInput, type DocDTO, type PairingDTO, type RunDTO, type PromptDTO, type RunRequest, type UserDTO } from '../shared/types.ts';

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
} else if (args[0] === 'repo' && args[1] === 'clone') {
  // From the bare repository the test names, with origin set to GitHub as a real clone has it.
  const [repo, dir] = [args[2], args[3]];
  const url = 'https://github.com/' + repo + '.git';
  execFileSync('git', ['clone', '-q', state.clones[repo], dir]);
  execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', url]);
  execFileSync('git', ['-C', dir, 'config', 'url.' + state.clones[repo] + '.insteadOf', url]);
  state.cloned = args.slice(2);
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
}
`;
/**
 * Stands in for the background Claude: logs how it was run, waits at a gate when told to, commits
 * a file like the work of a turn, and prints the lines a -p run ends with. A run's first turn only
 * checks that its card holds, and commits nothing (R-042).
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, input, cwd: process.cwd() }) + '\\n');
const resume = args.includes('--resume');
const id = args[args.indexOf(resume ? '--resume' : '--session-id') + 1];
while (process.env.FAKE_CLAUDE_GATE && !fs.existsSync(process.env.FAKE_CLAUDE_GATE)) await new Promise((resolve) => setTimeout(resolve, 20));
const check = input.includes('Change and commit nothing in this turn');
if (process.env.FAKE_CLAUDE_COMMIT !== '0' && !check) {
  const file = resume ? 'sum.test.js' : 'sum.js';
  // A change of its own each turn, so a later round has something to commit.
  fs.writeFileSync(file, file + ' ' + Date.now() + '\\n');
  execFileSync('git', ['add', file]);
  execFileSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '-q', '-m', 'Change ' + file]);
}
const answer = check
  ? JSON.parse(process.env.FAKE_CLAUDE_CHECK ?? '{"outcome":"holds","note":"","checked":"Read K-7 and sum.js on main."}')
  : process.env.FAKE_CLAUDE_ANSWER
    ? JSON.parse(process.env.FAKE_CLAUDE_ANSWER)
    : { outcome: 'done', note: 'Sums add up now.', title: 'Fix sums', body: 'Sums were off by one.' };
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: id, structured_output: answer }));
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

/** Does `work` with these environment variables set, then puts back what was there. */
async function withEnv<T>(vars: Record<string, string>, work: () => Promise<T>) {
  const restore = setEnv(vars);
  try {
    return await work();
  } finally {
    restore();
  }
}

/** Sets environment variables, and returns how to put back what was there. */
function setEnv(vars: Record<string, string>) {
  const saved = Object.entries(vars).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, vars);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
    const runsDir = path.join(home, 'runs');
    const request = (await runOf()) as RunRequest;
    const branches = [(await addWorktree(repo, request, runsDir)).branch, (await addWorktree(repo, request, runsDir)).branch];
    // A branch pushed from another machine is taken too.
    await git('push', '-q', 'origin', 'main:refs/heads/agent/k-1-pushes-with-bad-keys-3');
    branches.push((await addWorktree(repo, request, runsDir)).branch);
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
      const ghState = path.join(home, 'gh.json');
      await fs.writeFile(ghState, JSON.stringify({ origin, pulls: [] }));
      const claudeLog = path.join(home, 'claude.log');
      const gitConfig = path.join(home, 'gitconfig');
      await fs.writeFile(gitConfig, '[user]\n\tname = Alice\n\temail = alice@example.com\n');
      const restore = setEnv({
        GIT_CONFIG_GLOBAL: gitConfig,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FAKE_GH_STATE: ghState,
        FAKE_CLAUDE_LOG: claudeLog,
        GH_CONFIG_DIR: path.join(home, 'gh'),
        CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      });
      const dataDir = path.join(home, 'plugin');
      // The owner's settings turn the sandbox off, which no longer counts: the background Claude runs under the plugin's.
      await fs.mkdir(path.join(project, '.claude'));
      await fs.writeFile(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { enabled: false } }));
      const cloneRoot = path.join(home, 'WebChat');
      const options = { claude: path.join(bin, 'claude'), guard: 'true', cloneRoot };
      // A window open in a folder that is no repository serves the agent all the same (R-036).
      const anywhere = path.join(home, 'anywhere');
      await fs.mkdir(anywhere);
      const turns = async () =>
        (await fs.readFile(claudeLog, 'utf8').catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { args: string[]; input: string; cwd: string });
      try {
        const code = newPairingCode();
        // The page shows its address with the code, so the address setting stays empty (R-031).
        const plugin = new Plugin({ ...options, code: `${baseUrl}#${code}`, dataDir, projectDir: anywhere });
        const starting = plugin.start();
        const agent = await approve(alice, code, 'Claude Code');
        assert.equal(await starting, true);
        // The agent is online with no folder yet, and says what its laptop can do (R-036, D-103).
        await plugin.client!.sync();
        await alice.sync();
        assert.deepEqual([alice.users.get(agent.id)?.online, alice.users.get(agent.id)?.protocol, alice.users.get(agent.id)?.agentRepos], [true, 1, []]);
        assert.match(await plugin.call('connect'), /This folder is no GitHub repository/);
        // A window in a checkout the owner has connects it, and the serving window works there.
        assert.match(await new Plugin({ ...options, code: '', dataDir, projectDir: project }).call('connect'), /Connected acme\/app: your agent works in this folder/);
        await plugin.scan();
        await plugin.client!.sync();
        await alice.sync();
        assert.deepEqual(alice.users.get(agent.id)?.agentRepos.map((seat) => [seat.repo, seat.online, seat.protocol]), [['acme/app', true, 1]]);
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
        const reportsOn = async (request: number, reader = alice) =>
          (await reader.sync()).filter((m) => m.senderId === agent.id && m.content?.run?.kind !== 'request' && m.content?.run?.request === request).map((m) => m.content?.text);

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

        // Two turns ran in a worktree of the checkout, restricted, under the plugin's settings: the
        // check that the card holds, then the work, in the same session (R-042).
        const [first, work] = await turns();
        const worktree = first!.cwd;
        assert.ok(worktree.startsWith(path.join(await fs.realpath(project), '.claude', 'worktrees')), 'the worktree is in the checkout, where the sandboxed shell may write');
        const settings = path.join(dataDir, 'laptop', 'claude.json');
        assert.ok(first!.args.includes('--restricted'));
        assert.equal(first!.args[first!.args.indexOf('--settings') + 1], settings);
        assert.ok(first!.args.includes('--session-id'));
        assert.ok(first!.input.includes('### K-7: Sums are off by one'), 'the brief holds the card');
        assert.ok(first!.input.includes('check that the card still holds'), 'the first turn checks the card');
        assert.equal(work!.args[work!.args.indexOf('--resume') + 1], first!.args[first!.args.indexOf('--session-id') + 1], 'the work resumes the check');
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
        assert.equal(fix!.args[fix!.args.indexOf('--resume') + 1], first!.args[first!.args.indexOf('--session-id') + 1], 'the fix resumes the first turn');
        assert.equal(fix!.cwd, worktree);
        assert.ok(fix!.input.includes('CI failed: test') && fix!.input.includes('expected 3, got 4'), 'the brief says what failed, with the end of its log');
        assert.deepEqual(await reportsOn(asked), ['I am fixing K-7: CI failed: test', `I finished K-7 on ${branch} (acme/app#1). The test passes.`]);
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
        assert.deepEqual(await reportsOn(asked), ['I am fixing K-7: review from bob', `I finished K-7 on ${branch} (acme/app#1). Renamed.`]);

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
        // The board Alice's page picked goes in the brief, and no other (D-104).
        const prompted = await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"It adds."}' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id }, 'What does sum.js do?'));
        const [chat] = (await turns()).slice(-1);
        assert.ok(chat!.input.includes('### D-1: Sums stay exact') && !chat!.input.includes('### D-2'), 'the brief holds the decisions the team holds');
        assert.ok(chat!.input.includes('#5: Fix sums'), 'the brief holds the open pull requests');
        assert.ok(chat!.input.includes('Before you draft, check the draft'), 'the brief asks for the check');
        const scratch = chat!.cwd;
        assert.ok(scratch.startsWith(path.join(await fs.realpath(os.tmpdir()), 'webchat-scratch')), 'the prompt runs in a scratch repository, not in the project');
        assert.equal((await git(scratch, 'remote')).stdout.trim(), '', 'the scratch copy has no remote');
        assert.ok(chat!.args.includes('--session-id'), 'the first turn starts a session');
        assert.ok(chat!.input.includes('What does sum.js do?') && chat!.input.includes('scratch copy'), 'the brief holds the prompt');
        assert.ok(chat!.input.includes('opens a draft pull request'), 'the brief says a card run, unlike a question, ends in a draft');
        assert.deepEqual(await answers(), ['It adds.']);
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
        assert.equal(again!.args[again!.args.indexOf('--resume') + 1], chat!.args[chat!.args.indexOf('--session-id') + 1], 'the reply resumes the session');
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
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), clones: { 'acme/web': webOrigin } }));
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
        assert.deepEqual(JSON.parse(await fs.readFile(ghState, 'utf8')).cloned, ['acme/web', cloneDir, '--', '--filter=blob:none']);
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
        const lastPull = async () => JSON.parse(await fs.readFile(ghState, 'utf8')).pulls.at(-1) as { closed?: string };
        assert.deepEqual(await withEnv({ FAKE_CLAUDE_ANSWER: failed }, askWeb), ['I am on K-7: Sums are off by one', 'I could not run K-7: Not today.']);
        assert.equal((await lastPull()).closed, 'The agent stopped: Not today. The branch stays.', 'a run that fails after its claim closes its draft (R-042)');
        // A turn that says done but commits nothing fails, and its draft closes.
        assert.deepEqual(await withEnv({ FAKE_CLAUDE_COMMIT: '0' }, askWeb), ['I am on K-7: Sums are off by one', 'I could not run K-7: I left no new commits.']);
        assert.equal((await lastPull()).closed, 'The agent stopped: I left no new commits. The branch stays.');
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

        // A card run follows the repository's workflow (R-042, D-118).
        await unthrottle();
        const k7Now = async () => (await plugin.client!.sections(plugin.client!.docs.find((d) => d.id === board.id)!)).find((s) => s.id === section)!.text;
        // The brief as Alice's page hashes it now: the card, then the decisions the team holds (D-105).
        const briefNow = async () => {
          const { decisions: held } = await plugin.client!.boardDocs(app.project.id);
          return textHash(briefText(await k7Now(), held ? (await plugin.client!.sections(held)).map((s) => s.text) : []));
        };
        // The agent's reports on a request, each with its run field.
        const reports = async (request: number) =>
          (await alice.sync())
            .filter((m) => m.senderId === agent.id && m.content?.run?.kind !== 'request' && m.content?.run?.request === request)
            .map((m) => ({ text: m.content!.text, run: m.content!.run as RunReport }));
        const runK7 = async (env: Record<string, string> = {}) =>
          withEnv(env, async () => {
            const id = (await ask(alice, { hash: await briefNow() })).id;
            await (await checkIn()).handled;
            return { id, said: await reports(id) };
          });
        type FakePull = { head: string; base: string; draft: boolean; title: string; body: string; edited?: object; closed?: string; view?: object };
        const pullsNow = async () => JSON.parse(await fs.readFile(ghState, 'utf8')).pulls as FakePull[];
        const branchesNow = async () => (await sh('git', ['--git-dir', origin, 'branch', '--format=%(refname:short)'])).stdout.trim().split('\n').sort();
        const DAY = 24 * 60 * 60_000;

        // An open pull request that claims the card refuses the run, before the agent takes it.
        const turnsBefore = (await turns()).length;
        assert.deepEqual((await runK7()).said.map((r) => r.text), ['I could not run K-7: acme/app#8 claims K-7 already. Pick another card, or ask whoever opened it.']);
        assert.equal((await turns()).length, turnsBefore, 'no Claude ran for it');

        // A card the code already does ends at its check, pushes nothing, and offers its new status
        // as a change Alice adds (D-104).
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), open: [] }));
        const [pullsBeforeRuns, branchesBeforeRuns] = [(await pullsNow()).length, await branchesNow()];
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
        assert.deepEqual([(await pullsNow()).length, await branchesNow()], [pullsBeforeRuns, branchesBeforeRuns], 'nothing was pushed or opened');

        // A run that finds a decision nobody foresaw stops for it, with its claim and its work so far
        // pushed, and holds the card.
        const needed = { kind: 'decision', title: 'Sums round half to even', body: 'Why: money.', checked: 'Read sum.js.' };
        const paused = await runK7({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'decision', note: 'Rounding needs a rule.', drafts: [needed] }) });
        assert.deepEqual(paused.said.map((r) => r.text), ['I am on K-7: Sums are off by one', 'K-7 needs a decision first: Sums round half to even. Add it on the board, then reply with its number.']);
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
        assert.deepEqual((await reports(paused.id)).map((r) => r.text), ['I still wait for your decision on K-7. Add it on the board, then reply with its number.']);
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
        assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], pausedCheck!.args[pausedCheck!.args.indexOf('--session-id') + 1], 'it resumes the run');
        assert.ok(resumed.input.includes('I added the decision as D-1') && resumed.input.includes('If you were waiting for a decision'), 'the round has the number');
        const goneOn = await reports(paused.id);
        assert.deepEqual(goneOn.map((r) => r.text), [
          'I am fixing K-7: you asked for changes',
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

        // A run left waiting for 7 days fails, and its draft closes with its branch kept.
        await unthrottle();
        const left = await runK7({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'decision', note: 'Totals need a rule.', drafts: [{ ...needed, title: 'Totals round once' }] }) });
        assert.equal(left.said.at(-1)!.text, 'K-7 needs a decision first: Totals round once. Add it on the board, then reply with its number.');
        await plugin.pollPulls(Date.now() + 8 * DAY);
        assert.deepEqual((await reports(left.id)).map((r) => r.text), ['I could not run K-7: I stopped, as no decision came within 7 days. I closed the draft and kept its branch.']);
        const leftPull = (await pullsNow()).at(-1)!;
        assert.equal(leftPull.closed, 'The agent stopped: no decision came within 7 days. The branch stays.');
        assert.ok((await branchesNow()).includes(leftPull.head), 'the branch stays');
      } finally {
        restore();
      }
    },
  );

  test('sleeps on its owner\'s word in every window until a wake, and a background job never serves (K-66, D-113)', { timeout: 30_000 }, async () => {
    const dataDir = path.join(home, 'sleepy');
    const projectDir = path.join(home, 'sleepy-folder');
    await fs.mkdir(projectDir);
    const options = { claude: '', guard: 'true', cloneRoot: path.join(home, 'WebChat'), dataDir, projectDir };
    const code = newPairingCode();
    const first = new Plugin({ ...options, code: `${baseUrl}#${code}` });
    const second = new Plugin({ ...options, code: '' });
    void first.serve();
    try {
      const agent = await approve(alice, code, 'Sleepy');
      await waitFor('the first window serves', () => first.problem === '');
      const job = new Plugin({ ...options, code: '', job: true });
      assert.equal(await job.start(), false);
      assert.match(await job.call('status'), /background job, so it does not serve/);
      void second.serve();
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
    const turn = (input: string, resume: boolean) =>
      start(
        'claude',
        [...claudeArgs({ settings, session, resume, answer }), '--model', 'haiku', '--max-budget-usd', '1'],
        worktree,
        AbortSignal.timeout(5 * 60_000),
        (line) => (lines.push(line), claudeResult(line)),
        input,
      );
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
