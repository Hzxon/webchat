import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { AgentClient } from '../agent/client.ts';
import { Runs, type Runner } from '../agent/runs.ts';
import { createApp, type WebChatApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { newChatKeyBytes, newKeyId, wrapChatKey } from '../shared/e2ee.ts';
import type { ChatKeyInput, CreateProjectResponse, DocDTO, RunDTO } from '../shared/types.ts';

// The server never sees how the login key was derived, so fewer PBKDF2 rounds keep tests fast.
const KDF_ROUNDS = 1000;
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
