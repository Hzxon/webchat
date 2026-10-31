import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import ece from 'http_ece';
import { createApp, type WebChatApp } from '../server/app.ts';
import { hashPassword } from '../server/auth.ts';
import type { Config } from '../server/config.ts';
import {
  createIdentity,
  decryptMessage,
  deriveAccountSecrets,
  encryptMessage,
  importChatKey,
  importIdentity,
  newChatKeyBytes,
  newKeyId,
  openIdentity,
  sealIdentity,
  unwrapChatKey,
  wrapChatKey,
  type Identity,
} from '../shared/e2ee.ts';
import type {
  BootstrapDTO,
  ChatKeyInput,
  ConfigDTO,
  ConversationDTO,
  LoginResponse,
  MessageDTO,
  PushPayload,
  PublicKeysDTO,
  SyncRequest,
  SyncResponse,
  UserDTO,
} from '../shared/types.ts';

// The server never sees how the login key was derived, so fewer PBKDF2 rounds keep tests fast.
const KDF_ROUNDS = 1000;

interface ReceivedPush {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Stands in for a browser push service such as FCM, and records what the server sends to it. */
async function startFakePushService() {
  const received: ReceivedPush[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A browser-side push subscription: an endpoint plus the keys the payload is encrypted for. */
function makeSubscription(endpoint: string) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  return {
    json: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth } },
    decrypt: (body: Buffer) =>
      JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString()) as PushPayload,
  };
}

/** One person's browser: session cookie, account keys, and the chat keys it has opened. */
class Client {
  cookie = '';
  cursor = 0;
  stamp = '';
  id = 0;
  identity: Identity | undefined;
  readonly tabId = crypto.randomUUID();
  readonly chatKeys = new Map<number, { keyId: string; key: CryptoKey }>();
  constructor(
    private baseUrl: string,
    readonly username: string,
    readonly password = 'correct horse battery',
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  }

  async secrets(password = this.password) {
    const { data } = await this.request<ConfigDTO>('GET', '/config');
    return deriveAccountSecrets(password, this.username, data.kdfSalt, KDF_ROUNDS);
  }

  async register(inviteCode = 'friends-only') {
    const { authKey, backupKey } = await this.secrets();
    const secrets = await createIdentity();
    const res = await this.request<UserDTO & { error?: string }>('POST', '/auth/register', {
      username: this.username,
      displayName: this.username[0]!.toUpperCase() + this.username.slice(1),
      authKey,
      inviteCode,
      keys: { ...secrets.publicKeys, backup: await sealIdentity(secrets, backupKey) },
    });
    if (res.status === 201) {
      this.id = res.data.id;
      this.identity = await importIdentity(secrets);
    }
    return res;
  }

  async login(password = this.password) {
    const { authKey, backupKey } = await this.secrets(password);
    const res = await this.request<LoginResponse & { error?: string; code?: string }>('POST', '/auth/login', {
      username: this.username,
      authKey,
    });
    if (res.status === 200 && res.data.backup) {
      this.id = res.data.user.id;
      this.identity = await importIdentity(await openIdentity(res.data.backup, backupKey));
    }
    return res;
  }

  async bootstrap() {
    const { data } = await this.request<BootstrapDTO>('GET', '/bootstrap');
    this.cursor = data.cursor;
    this.stamp = data.stamp;
    return data;
  }

  async sync(attentive: boolean, endpoint: string | null = null) {
    const body: SyncRequest = { cursor: this.cursor, stamp: this.stamp, attentive, tabId: this.tabId, endpoint };
    const { status, data } = await this.request<SyncResponse>('POST', '/sync', body);
    assert.equal(status, 200, JSON.stringify(data));
    this.cursor = data.cursor;
    this.stamp = data.stamp;
    return data;
  }

  /** A fresh chat key, wrapped for each member using the public keys the server lists. */
  async newChatKey(members: Array<{ id: number; keys: PublicKeysDTO }>): Promise<ChatKeyInput & { raw: Uint8Array<ArrayBuffer> }> {
    const raw = newChatKeyBytes();
    const keyId = newKeyId();
    const me = { id: this.id, identity: this.identity! };
    const wrappedKeys = await Promise.all(
      members.map(async (m) => ({ userId: m.id, ...(await wrapChatKey(raw, me, { id: m.id, dh: m.keys.dh }, keyId)) })),
    );
    return { keyId, wrappedKeys, raw };
  }

  /** Opens this user's copy of a chat key, checking it was wrapped by the named member. */
  async openChatKey(conversation: ConversationDTO, wrapperKeys: PublicKeysDTO) {
    const key = await unwrapChatKey(
      conversation.myKey!,
      { id: this.id, identity: this.identity! },
      { id: conversation.myKey!.wrappedBy, dh: wrapperKeys.dh },
      conversation.keyId!,
    );
    this.chatKeys.set(conversation.id, { keyId: conversation.keyId!, key });
    return key;
  }

  async send(conversationId: number, text: string, urgent = false) {
    const { keyId, key } = this.chatKeys.get(conversationId)!;
    const clientId = crypto.randomUUID();
    const envelope = await encryptMessage(key, keyId, this.identity!.signPrivate, { conversationId, senderId: this.id, urgent, clientId }, text);
    return this.request<MessageDTO & { error?: string; code?: string }>('POST', `/conversations/${conversationId}/messages`, {
      envelope,
      urgent,
      clientId,
    });
  }

  async read(message: MessageDTO, senderKeys: PublicKeysDTO) {
    const { key } = this.chatKeys.get(message.conversationId)!;
    return decryptMessage(
      key,
      senderKeys.sign,
      { conversationId: message.conversationId, senderId: message.senderId, urgent: message.urgent, clientId: message.clientId! },
      message.envelope!,
    );
  }
}

/** Pushes go out after the send request returns, so wait until the expected number arrive. */
async function waitForPushes(received: ReceivedPush[], count: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return received.slice(0, count);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('chat server', () => {
  let instance: WebChatApp;
  let server: http.Server;
  let baseUrl: string;
  let pushService: Awaited<ReturnType<typeof startFakePushService>>;
  let alice: Client;
  let bob: Client;
  let carol: Client;
  let directChat: ConversationDTO;
  const keysOf = (c: Client) => c.identity!.publicKeys;

  before(async () => {
    pushService = await startFakePushService();
    const silent = { info() {}, warn() {}, error() {} };
    const config: Config = {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: undefined,
      databaseCaCert: undefined,
      pgliteDir: ':memory:',
      inviteCode: 'friends-only',
      vapidPublicKey: undefined,
      vapidPrivateKey: undefined,
      vapidSubject: 'mailto:test@example.com',
      trustProxy: false,
      sessionDays: 1,
      extraPushHosts: [pushService.host],
      clientDir: null,
      githubClientId: undefined,
      githubClientSecret: undefined,
      githubCallbackUrl: undefined,
      githubOauthUrl: 'https://github.com',
      githubApiUrl: 'https://api.github.com',
      githubPollSeconds: 0,
      cronSecret: undefined,
      logger: silent,
    };
    instance = await createApp(config);
    server = http.createServer(instance.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    alice = new Client(baseUrl, 'alice');
    bob = new Client(baseUrl, 'bob');
    carol = new Client(baseUrl, 'carol');
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await instance?.close();
    await pushService?.close();
  });

  test('registration needs the invite code and account keys, and never a password', async () => {
    assert.equal((await alice.register('guess')).status, 403);
    const noKeys = await alice.request('POST', '/auth/register', {
      username: 'alice',
      displayName: 'Alice',
      authKey: (await alice.secrets()).authKey,
      inviteCode: 'friends-only',
    });
    assert.equal(noKeys.status, 400);

    for (const client of [alice, bob, carol]) assert.equal((await client.register()).status, 201);
    assert.equal((await new Client(baseUrl, 'BOB').register()).status, 409, 'usernames are unique regardless of case');

    const stored = await instance.sql.query<{ password_hash: string; key_backup: string }>(
      'SELECT password_hash, key_backup FROM webchat.users',
    );
    for (const row of stored) {
      assert.ok(!row.password_hash.includes('correct horse') && !row.key_backup.includes('correct horse'));
    }
  });

  test('login returns the sealed keys, which only the right password opens', async () => {
    const laptop = new Client(baseUrl, 'Bob');
    assert.equal((await laptop.login('wrong password!')).status, 401);
    const res = await laptop.login();
    assert.equal(res.status, 200);
    assert.deepEqual(laptop.identity!.publicKeys, keysOf(bob), 'a new device gets the same account keys');
  });

  test('the key backup needs the login key, not just a session cookie', async () => {
    const wrong = await bob.request('POST', '/keys/backup', { authKey: (await bob.secrets('not my password')).authKey });
    assert.equal(wrong.status, 403);
    const right = await bob.request<LoginResponse>('POST', '/keys/backup', { authKey: (await bob.secrets()).authKey });
    assert.equal(right.status, 200);
    assert.ok(right.data.backup);
    const replace = await bob.request('PUT', '/keys', { authKey: (await bob.secrets()).authKey, keys: right.data.backup });
    assert.equal(replace.status, 400, 'malformed keys are rejected');
  });

  test('requests without a session are refused', async () => {
    const stranger = new Client(baseUrl, 'nobody');
    assert.equal((await stranger.request('GET', '/bootstrap')).status, 401);
    assert.equal((await stranger.request('POST', '/sync', {})).status, 401);
  });

  test('push endpoints outside known push services are refused', async () => {
    const res = await bob.request('POST', '/push/subscribe', makeSubscription('http://169.254.169.254/latest').json);
    assert.equal(res.status, 400);
  });

  test('a sync with nothing new answers "unchanged"', async () => {
    await bob.bootstrap();
    // The first check-in brings Bob online, which is itself a change.
    assert.equal((await bob.sync(true)).changed, true);
    assert.equal((await bob.sync(true)).changed, false);
  });

  test('a new chat needs its key wrapped for every member', async () => {
    const partial = await alice.newChatKey([{ id: alice.id, keys: keysOf(alice) }]);
    const refused = await alice.request('POST', '/conversations/direct', { userId: bob.id, key: partial });
    assert.equal(refused.status, 400);

    const key = await alice.newChatKey([
      { id: alice.id, keys: keysOf(alice) },
      { id: bob.id, keys: keysOf(bob) },
    ]);
    const created = await alice.request<ConversationDTO>('POST', '/conversations/direct', { userId: bob.id, key });
    assert.equal(created.status, 200);
    directChat = created.data;
    assert.equal(directChat.keyId, key.keyId);
    await alice.openChatKey(directChat, keysOf(alice));
    await alice.bootstrap();
  });

  test('messages are stored and relayed only as ciphertext, and the recipient decrypts them', async () => {
    const plain = await alice.request('POST', `/conversations/${directChat.id}/messages`, {
      body: 'plain text',
      clientId: 'x',
    });
    assert.equal(plain.status, 400, 'plain text is refused');

    const secret = 'Are you free to call? The code is 4417.';
    const sent = await alice.send(directChat.id, secret);
    assert.equal(sent.status, 201, JSON.stringify(sent.data));

    const rows = await instance.sql.query<Record<string, unknown>>('SELECT * FROM webchat.messages');
    assert.ok(!JSON.stringify(rows).includes('4417'), 'the database holds no plain text');

    const bobSync = await bob.sync(true);
    assert.ok(bobSync.changed);
    const message = bobSync.messages.find((m) => m.id === sent.data.id)!;
    assert.equal(message.body, '');
    const chat = bobSync.conversations.find((c) => c.id === directChat.id)!;
    assert.equal(chat.unread, 1);
    await bob.openChatKey(chat, keysOf(alice));
    assert.equal(await bob.read(message, keysOf(alice)), secret);

    const aliceSync = await alice.sync(true);
    assert.ok(aliceSync.changed);
    const bobState = aliceSync.conversations.find((c) => c.id === directChat.id)!.members.find((m) => m.userId === bob.id)!;
    assert.equal(bobState.lastDeliveredId, sent.data.id);
  });

  test('a message that the server altered is rejected by the recipient', async () => {
    const sent = await alice.send(directChat.id, 'Meet at 7');
    await instance.sql.query('UPDATE webchat.messages SET urgent = true WHERE id = $1', [sent.data.id]);
    const page = await bob.request<MessageDTO[]>('GET', `/conversations/${directChat.id}/messages`);
    const altered = page.data.find((m) => m.id === sent.data.id)!;
    await assert.rejects(bob.read(altered, keysOf(alice)), /bad signature/);
  });

  test('reading a chat moves the read pointer and clears unread', async () => {
    const chat = (await bob.bootstrap()).conversations.find((c) => c.id === directChat.id)!;
    const read = await bob.request('POST', `/conversations/${chat.id}/read`, { messageId: chat.lastMessage!.id });
    assert.equal(read.status, 204);
    const aliceSync = await alice.sync(true);
    assert.ok(aliceSync.changed);
    const bobState = aliceSync.conversations.find((c) => c.id === directChat.id)!.members.find((m) => m.userId === bob.id)!;
    assert.equal(bobState.lastReadId, chat.lastMessage!.id);
    assert.equal((await bob.bootstrap()).conversations.find((c) => c.id === directChat.id)!.unread, 0);
  });

  test('while the recipient is looking at the app, only that browser gets a push', async () => {
    const laptop = makeSubscription(`http://${pushService.host}/bob-laptop`);
    const phone = makeSubscription(`http://${pushService.host}/bob-phone`);
    assert.equal((await bob.request('POST', '/push/subscribe', laptop.json)).status, 204);
    assert.equal((await bob.request('POST', '/push/subscribe', phone.json)).status, 204);
    await bob.sync(true, laptop.json.endpoint);

    pushService.received.length = 0;
    await alice.send(directChat.id, 'You there?');
    const [push] = await waitForPushes(pushService.received, 1);
    await sleep(200);
    assert.deepEqual(
      pushService.received.map((p) => p.path),
      ['/bob-laptop'],
    );
    assert.ok(laptop.decrypt(push!.body).envelope);
  });

  test('while looking at a tab without push, no push is sent at all', async () => {
    await bob.sync(true, null);
    pushService.received.length = 0;
    await alice.send(directChat.id, 'Still there?');
    await sleep(300);
    assert.equal(pushService.received.length, 0);
  });

  test('pushes carry no plain text; the device decrypts the envelope inside', async () => {
    const phone = makeSubscription(`http://${pushService.host}/bob-phone-2`);
    assert.equal((await bob.request('POST', '/push/subscribe', phone.json)).status, 204);
    await bob.sync(false);

    pushService.received.length = 0;
    const text = 'Call me back, it is urgent';
    await alice.send(directChat.id, text, true);
    const pushes = await waitForPushes(pushService.received, 3);
    assert.deepEqual(pushes.map((p) => p.path).sort(), ['/bob-laptop', '/bob-phone', '/bob-phone-2']);

    const phonePush = pushes.find((p) => p.path === '/bob-phone-2')!;
    assert.equal(phonePush.headers['urgency'], 'high');
    assert.equal(phonePush.headers['content-encoding'], 'aes128gcm');
    const payload = phone.decrypt(phonePush.body);
    assert.equal(payload.title, 'URGENT from Alice');
    assert.equal(payload.body, '');
    assert.ok(!JSON.stringify(payload).includes('urgent, '), 'no plain text in the push');
    const { key } = bob.chatKeys.get(directChat.id)!;
    const decrypted = await decryptMessage(
      key,
      keysOf(alice).sign,
      { conversationId: payload.conversationId!, senderId: payload.senderId!, urgent: payload.urgent, clientId: payload.clientId! },
      payload.envelope!,
    );
    assert.equal(decrypted, text);
  });

  test('closing the tab (beacon) ends attention at once', async () => {
    const laptopEndpoint = `http://${pushService.host}/bob-laptop`;
    await bob.sync(true, laptopEndpoint);
    assert.equal((await bob.request('POST', '/away', { tabId: bob.tabId })).status, 204);
    pushService.received.length = 0;
    await alice.send(directChat.id, 'Ping after you left');
    const pushes = await waitForPushes(pushService.received, 3);
    assert.equal(pushes.length, 3);
  });

  test('the service worker can mark a pushed message delivered', async () => {
    const latest = (await alice.bootstrap()).conversations.find((c) => c.id === directChat.id)!.lastMessage!;
    const res = await bob.request('POST', '/delivered', { conversationId: directChat.id, messageId: latest.id });
    assert.equal(res.status, 204);
    const aliceSync = await alice.sync(true);
    assert.ok(aliceSync.changed);
    const bobState = aliceSync.conversations.find((c) => c.id === directChat.id)!.members.find((m) => m.userId === bob.id)!;
    assert.equal(bobState.lastDeliveredId, latest.id);
  });

  test('group messages reach every member, each with their own copy of the key', async () => {
    const members = [alice, bob, carol].map((c) => ({ id: c.id, keys: keysOf(c) }));
    const key = await alice.newChatKey(members);
    const group = await alice.request<ConversationDTO>('POST', '/conversations/group', {
      title: 'Weekend',
      memberIds: [bob.id, carol.id],
      key,
    });
    assert.equal(group.status, 201);
    alice.chatKeys.set(group.data.id, { keyId: key.keyId, key: await importChatKey(key.raw) });
    await alice.send(group.data.id, 'Dinner at 7?');

    for (const client of [bob, carol]) {
      const res = await client.sync(true);
      assert.ok(res.changed);
      const chat = res.conversations.find((c) => c.id === group.data.id)!;
      assert.equal(chat.title, 'Weekend');
      await client.openChatKey(chat, keysOf(alice));
      const message = res.messages.find((m) => m.conversationId === group.data.id)!;
      assert.equal(await client.read(message, keysOf(alice)), 'Dinner at 7?');
    }
  });

  test('people outside a chat cannot read or post in it', async () => {
    assert.equal((await carol.request('GET', `/conversations/${directChat.id}/messages`)).status, 404);
    carol.chatKeys.set(directChat.id, { keyId: directChat.keyId!, key: await importChatKey(newChatKeyBytes()) });
    assert.equal((await carol.send(directChat.id, 'sneaky')).status, 404);
    assert.equal(
      (await carol.request('POST', '/delivered', { conversationId: directChat.id, messageId: 1 })).status,
      404,
    );
  });

  test('message history pages backwards', async () => {
    const page = await alice.request<MessageDTO[]>('GET', `/conversations/${directChat.id}/messages`);
    assert.equal(page.status, 200);
    const results = await Promise.allSettled(page.data.map((m) => alice.read(m, keysOf(alice))));
    assert.deepEqual(
      results.map((r) => (r.status === 'fulfilled' ? r.value : 'rejected')),
      [
        'Are you free to call? The code is 4417.',
        'rejected', // the message the server altered in an earlier test
        'You there?',
        'Still there?',
        'Call me back, it is urgent',
        'Ping after you left',
      ],
    );
    const older = await alice.request<MessageDTO[]>('GET', `/conversations/${directChat.id}/messages?before=${page.data[2]!.id}`);
    assert.equal(older.data.length, 2);
  });

  test('an account from before encryption upgrades once, then signs in with a login key', async () => {
    // Simulate an old account: its hash covers the raw password and it has no keys.
    const dave = new Client(baseUrl, 'dave', 'old password 123');
    await instance.sql.query(
      `INSERT INTO webchat.users (username, display_name, password_hash, created_at, auth_version)
       VALUES ('dave', 'Dave', $1, $2, 1)`,
      [await hashPassword('old password 123'), Date.now()],
    );
    const daveId = (await instance.sql.query<{ id: number }>("SELECT id FROM webchat.users WHERE username = 'dave'"))[0]!.id;

    const first = await dave.login();
    assert.equal(first.status, 409);
    assert.equal(first.data.code, 'upgrade_required');

    // Before Dave has keys, nobody can start an encrypted chat with him.
    const blocked = await alice.request<{ code?: string }>('POST', '/conversations/direct', {
      userId: daveId,
      key: await alice.newChatKey([{ id: alice.id, keys: keysOf(alice) }]),
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'no_keys');

    const { authKey, backupKey } = await dave.secrets();
    assert.equal((await dave.request('POST', '/auth/upgrade', { username: 'dave', password: 'wrong', authKey })).status, 401);
    const upgraded = await dave.request<LoginResponse>('POST', '/auth/upgrade', { username: 'dave', password: dave.password, authKey });
    assert.equal(upgraded.status, 200);
    assert.equal(upgraded.data.backup, null);

    const secrets = await createIdentity();
    const keys = { ...secrets.publicKeys, backup: await sealIdentity(secrets, backupKey) };
    assert.equal((await dave.request('PUT', '/keys', { authKey, keys })).status, 200);
    assert.equal((await dave.request('PUT', '/keys', { authKey, keys })).status, 409, 'keys are set only once');

    const again = await new Client(baseUrl, 'dave', 'old password 123').login();
    assert.equal(again.status, 200);
    assert.ok(again.data.backup);
    assert.equal((await dave.request('POST', '/auth/upgrade', { username: 'dave', password: dave.password, authKey })).status, 401);
  });

  test('a chat from before encryption gets one key; the first member to set it wins', async () => {
    const now = Date.now();
    const [{ id }] = (await instance.sql.query<{ id: number }>(
      `INSERT INTO webchat.conversations (type, title, created_at, updated_at) VALUES ('group', 'Old chat', $1, $1) RETURNING id`,
      [now],
    )) as [{ id: number }];
    for (const user of [alice, bob]) {
      await instance.sql.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [id, user.id, now]);
    }
    const members = [alice, bob].map((c) => ({ id: c.id, keys: keysOf(c) }));
    alice.chatKeys.set(id, { keyId: 'AAAAAAAAAAAAAAAAAAAAAA', key: await importChatKey(newChatKeyBytes()) });
    const early = await alice.send(id, 'too early');
    assert.equal(early.status, 409);
    assert.equal(early.data.code, 'no_chat_key');

    const first = await alice.request('POST', `/conversations/${id}/key`, await alice.newChatKey(members));
    const second = await bob.request<{ code?: string }>('POST', `/conversations/${id}/key`, await bob.newChatKey(members));
    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.equal(second.data.code, 'has_key');
  });

  test('a tab still showing another account is refused instead of acting as the signed-in one', async () => {
    const asBob = (headers: Record<string, string>) =>
      fetch(`${baseUrl}/api/bootstrap`, { headers: { cookie: bob.cookie, ...headers } });
    const stale = await asBob({ 'x-webchat-user': String(alice.id) });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code: string }).code, 'account_changed');
    assert.equal((await asBob({ 'x-webchat-user': String(bob.id) })).status, 200);
    assert.equal((await asBob({})).status, 200, 'requests without the header still work');
  });

  test('logout ends the session', async () => {
    assert.equal((await carol.request('POST', '/auth/logout')).status, 204);
    assert.equal((await carol.request('GET', '/bootstrap')).status, 401);
  });
});
