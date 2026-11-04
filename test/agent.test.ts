import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { AgentClient } from '../agent/client.ts';
import { createRunner } from '../agent/runner.ts';
import { Runs, type Runner } from '../agent/runs.ts';
import { createApp, type WebChatApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { newChatKeyBytes, newKeyId, wrapChatKey } from '../shared/e2ee.ts';
import type { ChatKeyInput, CreateProjectResponse, DocDTO, RunDTO } from '../shared/types.ts';

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
  let botFile: string;
  let projectId: number;
  let generalId: number;
  let roadmap: DocDTO;
  let cardId: string;
  const cardText = '### K-1: Pushes with bad keys\n\nStatus: Open.\n\nSeen: on a phone.';

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

  test('signs up and keeps its keys in a file only its owner can read', async () => {
    const credentials = { server: baseUrl, username: 'bot', password: PASSWORD, kdfIterations: KDF_ROUNDS };
    bot = await AgentClient.signUp(botFile, credentials, 'Bot', 'friends-only');
    assert.equal((await fs.stat(botFile)).mode & 0o777, 0o600);
    const file = JSON.parse(await fs.readFile(botFile, 'utf8'));
    assert.deepEqual(Object.keys(file).sort(), ['allow', 'authKey', 'cookie', 'cursor', 'pins', 'secrets', 'server', 'userId', 'username']);
    assert.ok(!JSON.stringify(file).includes(PASSWORD), 'the password is not on disk');
    // A second sign-up must not overwrite an account's keys.
    await assert.rejects(AgentClient.signUp(botFile, { ...credentials, username: 'bot2' }, 'Bot', 'friends-only'), { code: 'EEXIST' });
  });

  test('reads and answers in a project it was added to', async () => {
    alice = await AgentClient.signUp(path.join(home, 'alice.json'), { server: baseUrl, username: 'alice', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Alice', 'friends-only');
    await alice.sync();
    const key = await newChatKey(alice, [alice.id, bot.id]);
    const created = await alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Capstone', memberIds: [bot.id], key });
    projectId = created.project.id;
    await alice.sync();
    generalId = alice.general(projectId)!.id;
    await alice.send(generalId, { text: 'Hello bot' });

    const heard = await bot.sync();
    assert.equal(bot.general(projectId)?.id, generalId);
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
    assert.deepEqual(await bot.sections(roadmap), [{ id: card, text, pos: 1 }]);

    const edited = text.replace('Status: Open.', 'Status: In progress on branch agent/k1-bad-keys.');
    await bot.replaceSection(roadmap, card, { text: edited, pos: 1 });
    await alice.sync();
    assert.deepEqual((await alice.sections(roadmap)).map((s) => s.text), [edited]);
    // The lock is free again: Alice can edit the card in turn.
    await alice.replaceSection(roadmap, card, { text, pos: 1 });
    assert.deepEqual((await bot.sections(roadmap)).map((s) => s.text), [text]);
  });

  test('runs a card a teammate hands to it, and reports in #general', async () => {
    const jobs: Parameters<Runner>[0][] = [];
    const runs = new Runs(bot, async (job) => {
      jobs.push(job);
      return { branch: 'agent/k1-bad-keys', pull: { repo: 'acme/app', number: 9 }, note: 'Two files changed.' };
    });
    const request = async (): Promise<number> => {
      const run: RunDTO = { kind: 'request', card: 'K-1', title: 'Pushes with bad keys', docId: roadmap.id, section: cardId, runtime: bot.id };
      return (await alice.send(generalId, { text: 'Run K-1 with Bot', run })).id;
    };
    const reports = async (requestId: number) => {
      const heard = await alice.sync();
      return heard.map((m) => [m.content?.run && m.content.run.kind !== 'request' && m.content.run.request === requestId, m.content?.run?.kind, m.content?.text]);
    };
    // Alice is not allowed yet.
    let id = await request();
    for (const m of await bot.sync()) await runs.handle(m);
    assert.deepEqual(await reports(id), [[true, 'failed', 'I could not run K-1: Alice is not allowed to run cards here.']]);
    assert.equal(jobs.length, 0);

    await bot.allow('alice');
    id = await request();
    for (const m of await bot.sync()) await runs.handle(m);
    assert.deepEqual(await reports(id), [
      [true, 'claimed', 'I am on K-1: Pushes with bad keys'],
      [true, 'done', 'I finished K-1 on agent/k1-bad-keys (acme/app#9). Two files changed.'],
    ]);
    assert.deepEqual(jobs.map((j) => [j.request.card, j.card, j.projectId]), [['K-1', cardText, projectId]]);
    const [card] = await alice.sections(roadmap);
    assert.equal(card?.text, cardText.replace('Status: Open.', 'Status: In progress on branch agent/k1-bad-keys (acme/app#9).'));
    assert.equal(runs.running, null);
    assert.equal((JSON.parse(await fs.readFile(botFile, 'utf8')) as { allow: string[] }).allow.join(), 'alice');
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
    const run: RunDTO = { kind: 'request', card: 'K-1', title: 'Pushes with bad keys', docId: roadmap.id, section: cardId, runtime: bot.id };
    await alice.send(generalId, { text: 'Run K-1 with Bot', run });
    for (const m of await bot.sync()) await runs.handle(m);
    await bot.sync();
    await alice.sync();
    assert.equal(alice.users.get(bot.id)?.busy, false, 'idle again');
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

    const request = async () => {
      const run: RunDTO = { kind: 'request', card: 'K-1', title: 'Pushes with bad keys', docId: roadmap.id, section: cardId, runtime: bot.id };
      const id = (await alice.send(generalId, { text: 'Run K-1 with Bot', run })).id;
      for (const m of await bot.sync()) await runs.handle(m);
      const heard = await alice.sync();
      return heard.filter((m) => m.content?.run?.kind !== 'request' && m.content?.run?.request === id).map((m) => m.content?.text);
    };
    assert.deepEqual(await request(), ['I am on K-1: Pushes with bad keys', 'I finished K-1 on agent/k-1-pushes-with-bad-keys. In one file.']);
    const [card] = await alice.sections(roadmap);
    assert.match(card!.text, /^Status: In progress on branch agent\/k-1-pushes-with-bad-keys\.$/m);
    const { stdout: brief } = await git('show', 'agent/k-1-pushes-with-bad-keys:BRIEF.md');
    assert.ok(brief.includes('### K-1: Pushes with bad keys'), 'the brief holds the card');
    assert.ok(brief.includes('`agent/k-1-pushes-with-bad-keys`'), 'the brief names the branch');
    assert.ok(brief.includes('gh pr create --draft'), 'the brief says how to finish');
    assert.deepEqual((await fs.readdir(runsDir)).filter((f) => f.endsWith('.brief.md')).length, 1);

    // A run that fails reports so, and the card keeps its status. The card run again gets a branch of its own.
    process.env.FAKE_FAIL = '1';
    try {
      assert.deepEqual(await request(), ['I am on K-1: Pushes with bad keys', 'I could not run K-1: I gave up.']);
    } finally {
      delete process.env.FAKE_FAIL;
    }
    const { stdout: branches } = await git('branch', '--list', '--format=%(refname:short)', 'agent/*');
    assert.deepEqual(branches.trim().split('\n').sort(), ['agent/k-1-pushes-with-bad-keys', 'agent/k-1-pushes-with-bad-keys-2']);
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
