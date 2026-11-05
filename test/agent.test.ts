import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { Api } from '../agent/api.ts';
import { AgentClient } from '../agent/client.ts';
import { ADAPTERS, createRunner } from '../agent/runner.ts';
import { REQUEST_TTL_MS, Runs, type Runner } from '../agent/runs.ts';
import { createApp, type WebChatApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { createIdentity, deriveAccountSecrets, newChatKeyBytes, newKeyId, sealIdentity, wrapChatKey } from '../shared/e2ee.ts';
import type { ChatKeyInput, ConfigDTO, CreateProjectResponse, DocDTO, RunDTO, RunRequest, UserDTO } from '../shared/types.ts';

// The server never sees how the login key was derived, so fewer PBKDF2 rounds keep tests fast.
const KDF_ROUNDS = 1000;
const sh = promisify(execFile);

/** Stands in for a coding agent: keeps the brief it was given as a commit, and prints a result line. */
const FAKE_AGENT = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
fs.writeFileSync('BRIEF.md', fs.readFileSync(/in (\\S+) and/.exec(process.argv[process.argv.indexOf('-p') + 1])[1]));
execFileSync('git', ['add', 'BRIEF.md']);
execFileSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '-q', '-m', 'Keep the brief']);
console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
console.log(JSON.stringify({ type: 'result', result: process.env.FAKE_FAIL ? 'I gave up.' : 'I kept the brief.\\nIn one file.', is_error: !!process.env.FAKE_FAIL }));
`;
const PASSWORD = 'correct horse battery';

/** A fresh chat key, wrapped by this client for each member, as a browser does when it makes a project. */
async function newChatKey(client: AgentClient, memberIds: number[]): Promise<ChatKeyInput> {
  const raw = newChatKeyBytes();
  const keyId = newKeyId();
  const me = { id: client.id, identity: client.identity };
  const wrappedKeys = await Promise.all(
    memberIds.map(async (id) => ({ id, ...(await wrapChatKey(raw, me, { id, dh: client.keysOf(id)!.dh }, keyId)) })),
  ).then((keys) => keys.map(({ id, ...k }) => ({ userId: id, ...k })));
  return { keyId, wrappedKeys };
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
  const runOf = (extra: Partial<RunRequest> = {}): RunDTO => ({
    kind: 'request',
    card: 'K-1',
    title: 'Pushes with bad keys',
    docId: roadmap.id,
    section: cardId,
    runtime: bot.id,
    sentAt: Date.now(),
    ...extra,
  });

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

  test("signs up as its owner's agent and keeps its keys in a file only its owner can read", async () => {
    // A person, who signs up in a browser; the client stands in for the page here.
    alice = await AgentClient.signUp(path.join(home, 'alice.json'), { server: baseUrl, username: 'alice', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Alice', 'friends-only');
    const credentials = { server: baseUrl, username: 'bot', password: PASSWORD, kdfIterations: KDF_ROUNDS };
    // Usernames match in any case, as they do at sign-in.
    bot = await AgentClient.signUp(botFile, credentials, 'Bot', 'friends-only', 'Alice');
    assert.equal(bot.owner, alice.id);
    assert.equal((await fs.stat(botFile)).mode & 0o777, 0o600);
    const file = JSON.parse(await fs.readFile(botFile, 'utf8'));
    assert.deepEqual(Object.keys(file).sort(), ['authKey', 'cookie', 'cursor', 'owner', 'pins', 'secrets', 'server', 'userId', 'username']);
    assert.ok(!JSON.stringify(file).includes(PASSWORD), 'the password is not on disk');
    // Alice's board offers the bot, as hers.
    await alice.sync();
    assert.equal(alice.users.get(bot.id)?.agentOwner, alice.id);
    // A second sign-up must not overwrite an account's keys.
    await assert.rejects(AgentClient.signUp(botFile, { ...credentials, username: 'bot2' }, 'Bot', 'friends-only', 'alice'), { code: 'EEXIST' });
    await assert.rejects(AgentClient.signUp(path.join(home, 'bot3.json'), { ...credentials, username: 'bot3' }, 'Bot', 'friends-only', 'nobody'), {
      message: 'No account has the owner username.',
    });
  });

  test("any account becomes someone's agent when the daemon signs in (K-41)", async () => {
    const credentials = { server: baseUrl, username: 'oldbot', password: PASSWORD, kdfIterations: KDF_ROUNDS };
    // Signed up without the flag, as a browser or an older daemon would.
    const api = new Api(baseUrl);
    const { kdfSalt } = await api.request<ConfigDTO>('GET', '/config');
    const { authKey, backupKey } = await deriveAccountSecrets(PASSWORD, 'oldbot', kdfSalt, KDF_ROUNDS);
    const secrets = await createIdentity();
    const plain = await api.request<UserDTO>('POST', '/auth/register', {
      username: 'oldbot',
      displayName: 'Old bot',
      authKey,
      inviteCode: 'friends-only',
      keys: { ...secrets.publicKeys, backup: await sealIdentity(secrets, backupKey) },
    });
    await alice.sync();
    assert.equal(alice.users.get(plain.id)?.agentOwner, null);
    await api.request('POST', '/auth/login', { username: 'oldbot', authKey });
    await alice.sync();
    assert.equal(alice.users.get(plain.id)?.agentOwner, null, 'a sign-in that names nobody changes nothing');

    // The owner is in the fingerprint (D-021), so Alice's next check-in brings it.
    const oldbot = await AgentClient.signIn(path.join(home, 'oldbot.json'), credentials, 'alice');
    assert.equal(oldbot.owner, alice.id);
    await alice.sync();
    assert.equal(alice.users.get(plain.id)?.agentOwner, alice.id);
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

    assert.deepEqual(await ask(carol, runOf()), [['failed', 'I could not run K-1: Only Alice hands cards to me.']]);
    const stale = [['failed', 'I could not run K-1: The request was not sent in the last 10 minutes.']];
    // Without the time the page signed, as from a page before D-089, or with an old one.
    assert.deepEqual(await ask(alice, runOf({ sentAt: 0 })), stale);
    assert.deepEqual(await ask(alice, runOf({ sentAt: Date.now() - REQUEST_TTL_MS - 1000 })), stale);
    assert.equal(jobs.length, 0);

    assert.deepEqual(await ask(alice, runOf()), [
      ['claimed', 'I am on K-1: Pushes with bad keys'],
      ['done', 'I finished K-1 on agent/k1-bad-keys (acme/app#9). Two files changed.'],
    ]);
    assert.deepEqual(jobs.map((j) => [j.request.card, j.card, j.projectId]), [['K-1', written, projectId]]);
    assert.equal(runs.running, null);
    // The run leaves the card as it was: the reports in #general are its status (D-089).
    assert.deepEqual((await alice.sections(roadmap)).map((s) => s.text), [written]);
    await alice.editSection(roadmap, cardId, () => ({ text: cardText, pos: 1 }));
  });

  test('runs one request at a time', async () => {
    const reports = async () => (await alice.sync()).filter((m) => m.content?.run?.kind !== 'request').map((m) => m.content?.text);
    let jobs = 0;
    const runs = new Runs(bot, async () => {
      jobs++;
      return { branch: 'agent/k1' };
    });
    // Two requests in one check-in.
    await alice.send(generalId, { text: 'Run K-1 with Bot', run: runOf() });
    await alice.send(generalId, { text: 'Run K-1 with Bot again', run: runOf() });
    await Promise.all((await bot.sync()).map((m) => runs.handle(m)));
    assert.deepEqual((await reports()).sort(), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: I am busy with K-1.', 'I finished K-1 on agent/k1.']);
    assert.equal(jobs, 1);
  });

  test('says it is busy in its check-ins while a card runs, so the board offers it no other', async () => {
    const runs = new Runs(bot, async () => {
      // The watch loop keeps checking in while the runner works.
      await bot.sync();
      const seen = await alice.sync();
      assert.equal(alice.users.get(bot.id)?.busy, true, `busy mid-run (${seen.length} new)`);
      return { branch: 'agent/k1' };
    });
    assert.equal(alice.users.get(bot.id)?.busy, false);
    await alice.send(generalId, { text: 'Run K-1 with Bot', run: runOf() });
    for (const m of await bot.sync()) await runs.handle(m);
    await bot.sync();
    await alice.sync();
    assert.equal(alice.users.get(bot.id)?.busy, false, 'idle again');
  });

  test('reports a run that a restart cut short as failed (K-46)', async () => {
    const id = (await alice.send(generalId, { text: 'Run K-1 with Bot', run: runOf() })).id;
    // The daemon stops mid-run: its runner never returns.
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const runs = new Runs(bot, () => {
      started();
      return new Promise(() => {});
    });
    for (const m of await bot.sync()) void runs.handle(m);
    await running;
    const saved = async () => JSON.parse(await fs.readFile(botFile, 'utf8')).running;
    assert.deepEqual(await saved(), { message: id, conversation: generalId, card: 'K-1' });

    // Started again from its file, it no longer sees the request: the cursor is past it.
    bot = await AgentClient.load(botFile);
    assert.deepEqual(await bot.sync(), []);
    const restarted = new Runs(bot, async () => ({ branch: 'agent/k1' }));
    await restarted.recover();
    assert.equal(await saved(), undefined);
    await restarted.recover();
    const reports = (await alice.sync()).filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id);
    assert.deepEqual(reports.map((m) => [m.content?.run?.kind, m.content?.text]), [
      ['claimed', 'I am on K-1: Pushes with bad keys'],
      ['failed', 'I could not run K-1: The daemon stopped during the run.'],
    ]);
  });

  test('runs a card with the coding agent in a worktree of the project repository', async () => {
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
    const fake = path.join(home, 'fake-agent.mjs');
    await fs.writeFile(fake, FAKE_AGENT, { mode: 0o755 });
    const runsDir = path.join(home, 'runs');
    const runs = new Runs(bot, createRunner({ command: fake, projects: { Capstone: repo } }, bot, runsDir));
    // A decision Carol wrote goes into the brief too: decisions are the team's (D-089).
    const decisions = { id: newKeyId(), conversationId: generalId };
    const decision = newKeyId().slice(0, 11);
    await carol.request('POST', '/docs', {
      ...decisions,
      revisions: [
        { section: 'title', envelope: await carol.sealDoc(decisions, 'title', { text: 'Decisions', board: 'decisions' }) },
        { section: decision, envelope: await carol.sealDoc(decisions, decision, { text: '### D-1: Keys rotate when someone leaves', pos: 1 }) },
      ],
    });

    const request = async () => {
      const id = (await alice.send(generalId, { text: 'Run K-1 with Bot', run: runOf() })).id;
      for (const m of await bot.sync()) await runs.handle(m);
      const heard = await alice.sync();
      return heard.filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id).map((m) => m.content?.text);
    };
    assert.deepEqual(await request(), ['I am on K-1: Pushes with bad keys', 'I finished K-1 on agent/k-1-pushes-with-bad-keys. In one file.']);
    const { stdout: brief } = await git('show', 'agent/k-1-pushes-with-bad-keys:BRIEF.md');
    assert.ok(brief.includes('### K-1: Pushes with bad keys'), 'the brief holds the card');
    assert.ok(brief.includes('### D-1: Keys rotate when someone leaves'), "the brief holds a teammate's decision");
    assert.ok(brief.includes('`agent/k-1-pushes-with-bad-keys`'), 'the brief names the branch');
    assert.ok(brief.includes('gh pr create --draft'), 'the brief says how to finish');
    assert.deepEqual((await fs.readdir(runsDir)).filter((f) => f.endsWith('.brief.md')).length, 1);

    // A run that fails reports so. The card run again gets a branch of its own.
    process.env.FAKE_FAIL = '1';
    try {
      assert.deepEqual(await request(), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: I gave up.']);
      // A branch pushed from another machine is taken too.
      await git('push', '-q', 'origin', 'main:refs/heads/agent/k-1-pushes-with-bad-keys-3');
      assert.deepEqual(await request(), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: I gave up.']);
    } finally {
      delete process.env.FAKE_FAIL;
    }
    const { stdout: branches } = await git('branch', '--list', '--format=%(refname:short)', 'agent/*');
    assert.deepEqual(branches.trim().split('\n').sort(), ['agent/k-1-pushes-with-bad-keys', 'agent/k-1-pushes-with-bad-keys-2', 'agent/k-1-pushes-with-bad-keys-4']);
  });

  test('reads the final word of each coding agent from its own output lines', () => {
    const last = (agent: keyof typeof ADAPTERS, lines: string[]) =>
      lines.reduce<ReturnType<(typeof ADAPTERS)['claude']['result']>>((kept, line) => ADAPTERS[agent].result(line) ?? kept, undefined);
    assert.deepEqual(last('claude', ['not json', '{"type":"system"}', '{"type":"result","result":"Done.","is_error":false}']), { text: 'Done.', error: false });
    assert.deepEqual(
      last('codex', [
        '{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Pushed."}}',
        '{"type":"turn.completed"}',
      ]),
      { text: 'Pushed.', error: false },
    );
    assert.deepEqual(last('codex', ['{"type":"turn.failed","error":{"message":"Out of credit."}}']), { text: 'Out of credit.', error: true });
    assert.deepEqual(last('hermes', ['{"type":"result","exit_code":2,"text":"Partial."}']), { text: 'Partial.', error: true });
    for (const agent of Object.keys(ADAPTERS) as Array<keyof typeof ADAPTERS>) {
      assert.ok(ADAPTERS[agent].args('/tmp/brief.md').some((a) => a.includes('/tmp/brief.md')), `${agent} is told where the brief is`);
    }
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
});
