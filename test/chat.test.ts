import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import ece from 'http_ece';
import { createApp, type WebChatApp } from '../server/app.ts';
import { hashPassword } from '../server/auth.ts';
import type { Config } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import {
  createIdentity,
  decryptContent,
  decryptMessage,
  deriveAccountSecrets,
  encryptMessage,
  importChatKey,
  importIdentity,
  linkChatKey,
  newChatKeyBytes,
  newKeyId,
  openChatKeyBytes,
  openIdentity,
  openKeyLink,
  sealIdentity,
  unwrapChatKey,
  wrapChatKey,
  type Identity,
  type MessageContent,
} from '../shared/e2ee.ts';
import type {
  BarkDTO,
  BootstrapDTO,
  ChatKeyInput,
  ConfigDTO,
  ConversationDTO,
  CreateProjectResponse,
  LoginResponse,
  MessageDTO,
  MessageKind,
  ProjectDTO,
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

interface ReceivedApns {
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** Stands in for Apple's push service, which only speaks HTTP/2, and records what the server sends to it. */
async function startFakeApns() {
  const received: ReceivedApns[] = [];
  /** Every provider token seen, to check that one serves many pushes. */
  const authorizations: string[] = [];
  /** An answer to give for a device token instead of 200, once or every time. */
  const failing = new Map<string, { status: number; reason: string; once: boolean }>();
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer();
  server.on('session', (session) => sessions.add(session));
  server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const path = String(headers[':path']);
      received.push({ path, headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> });
      authorizations.push(String(headers.authorization));
      const token = path.slice(path.lastIndexOf('/') + 1);
      const failure = failing.get(token);
      if (failure) {
        if (failure.once) failing.delete(token);
        stream.respond({ ':status': failure.status, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ reason: failure.reason }));
      } else {
        stream.respond({ ':status': 200, 'apns-id': crypto.randomUUID() });
        stream.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    authorizations,
    failing,
    close: () => {
      for (const session of sessions) session.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
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

  async send(
    conversationId: number,
    content: string | MessageContent,
    urgent = false,
    kind: MessageKind = 'message',
    clientId = crypto.randomUUID(),
  ) {
    const { keyId, key } = this.chatKeys.get(conversationId)!;
    const meta = { conversationId, senderId: this.id, urgent, clientId, kind };
    const envelope = await encryptMessage(key, keyId, this.identity!.signPrivate, meta, content);
    return this.request<MessageDTO & { error?: string; code?: string }>('POST', `/conversations/${conversationId}/messages`, {
      envelope,
      urgent,
      clientId,
      kind,
    });
  }

  /** Reads a message with this user's current key, or, given the chat, an earlier key it links to. */
  async read(message: MessageDTO, senderKeys: PublicKeysDTO, chat?: ConversationDTO) {
    return (await this.readContent(message, senderKeys, chat)).text;
  }

  async readContent(message: MessageDTO, senderKeys: PublicKeysDTO, chat?: ConversationDTO) {
    const current = this.chatKeys.get(message.conversationId)!;
    const kid = message.envelope!.kid;
    const key = chat && kid !== current.keyId ? await this.earlierKey(chat, kid) : current.key;
    const { conversationId, senderId, urgent, clientId, kind } = message;
    return decryptContent(key, senderKeys.sign, { conversationId, senderId: senderId!, urgent, clientId: clientId!, kind }, message.envelope!);
  }

  /** Opens an earlier key of a chat through its links, starting from this user's current key. */
  async earlierKey(chat: ConversationDTO, keyId: string) {
    let { key, keyId: newer } = this.chatKeys.get(chat.id)!;
    while (newer !== keyId) {
      const link = chat.keyLinks.find((l) => l.keyId === newer);
      if (!link) throw new Error(`No link back from ${newer}`);
      key = await openKeyLink(key, newer, chat.id, link, link.previousKeyId);
      newer = link.previousKeyId;
    }
    return key;
  }

  /**
   * A new key to replace a chat's current one, wrapped for the given people, with the current key
   * inside it, made from this user's own copy as a browser makes it.
   */
  async rotateChatKey(chat: ConversationDTO, wrapperKeys: PublicKeysDTO, members: Client[]) {
    const me = { id: this.id, identity: this.identity! };
    const previousKeyId = chat.keyId!;
    const previous = await openChatKeyBytes(chat.myKey!, me, { id: chat.myKey!.wrappedBy, dh: wrapperKeys.dh }, previousKeyId);
    const { raw, ...key } = await this.newChatKey(members.map((m) => ({ id: m.id, keys: m.identity!.publicKeys })));
    const link = await linkChatKey(await importChatKey(raw), key.keyId, chat.id, previous, previousKeyId);
    return { ...key, link: { previousKeyId, ...link } };
  }

  /** Wraps this user's copy of a channel's key for people joining its project. */
  async shareChatKey(conversation: ConversationDTO, wrapperKeys: PublicKeysDTO, recipients: Client[]) {
    const me = { id: this.id, identity: this.identity! };
    const keyId = conversation.keyId!;
    const raw = await openChatKeyBytes(conversation.myKey!, me, { id: conversation.myKey!.wrappedBy, dh: wrapperKeys.dh }, keyId);
    const wrappedKeys = await Promise.all(
      recipients.map(async (r) => ({ userId: r.id, ...(await wrapChatKey(raw, me, { id: r.id, dh: r.identity!.publicKeys.dh }, keyId)) })),
    );
    return { conversationId: conversation.id, keyId, wrappedKeys };
  }
}

/** Pushes go out after the send request returns, so wait until the expected number arrive. */
async function waitForPushes<T>(received: T[], count: number, timeoutMs = 3000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return received.slice(0, count);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The member ids of a chat, in order, to compare with assert.deepEqual. */
const memberIdsOf = (chat: ConversationDTO) => chat.members.map((m) => m.userId).sort((a, b) => a - b);

describe('chat server', () => {
  let instance: WebChatApp;
  let server: http.Server;
  let baseUrl: string;
  let pushService: Awaited<ReturnType<typeof startFakePushService>>;
  let apns: Awaited<ReturnType<typeof startFakeApns>>;
  let alice: Client;
  let bob: Client;
  let carol: Client;
  let directChat: ConversationDTO;
  let weekend: ConversationDTO;
  let lab: ConversationDTO;
  const keysOf = (c: Client) => c.identity!.publicKeys;
  /** A chat as this person's next bootstrap lists it, without moving their sync cursor. */
  const viewOf = async (client: Client, conversationId: number) =>
    (await client.request<BootstrapDTO>('GET', '/bootstrap')).data.conversations.find((c) => c.id === conversationId)!;

  before(async () => {
    pushService = await startFakePushService();
    apns = await startFakeApns();
    // Stands in for the key Bark publishes. The fake APNs never checks the signature.
    const apnsKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
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
      barkApnsKey: String(apnsKey),
      barkApnsKeyId: 'TESTKEY123',
      barkApnsTeamId: 'TEAM123456',
      apnsOrigin: apns.origin,
      clientDir: null,
      githubClientId: undefined,
      githubClientSecret: undefined,
      githubCallbackUrl: undefined,
      githubAppSlug: undefined,
      githubAppClientId: undefined,
      githubAppClientSecret: undefined,
      githubWebhookSecret: undefined,
      githubAppCallbackUrl: undefined,
      githubOauthUrl: 'https://github.com',
      githubApiUrl: 'https://api.github.com',
      githubPollSeconds: 0,
      cronSecret: undefined,
      githubPollUrl: undefined,
      build: 'test-build',
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
    await apns?.close();
  });

  test('every API response names the build, so old tabs can reload after a deploy', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    assert.equal(res.headers.get('x-webchat-build'), 'test-build');
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

  test('a body too large or not JSON gets a JSON error, not an HTML page', async () => {
    const post = (body: string) =>
      fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const big = await post(JSON.stringify({ pad: 'x'.repeat(300_000) }));
    assert.equal(big.status, 413);
    assert.match(big.headers.get('content-type') ?? '', /json/);
    assert.equal(((await big.json()) as { error: string }).error, 'This change is too large to send at once.');
    const broken = await post('{');
    assert.equal(broken.status, 400);
    assert.match(broken.headers.get('content-type') ?? '', /json/);
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

  test('the same send again, after a lost answer, returns the stored message and alerts once', async () => {
    pushService.received.length = 0;
    const clientId = crypto.randomUUID();
    const text = 'Did my answer get lost?';
    const first = await alice.send(directChat.id, text, true, 'message', clientId);
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const again = await alice.send(directChat.id, text, true, 'message', clientId);
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.id, first.data.id);
    const rows = await instance.sql.query('SELECT id FROM webchat.messages WHERE client_id = $1', [clientId]);
    assert.equal(rows.length, 1, 'stored once');
    await waitForPushes(pushService.received, 3);
    await sleep(100);
    assert.equal(pushService.received.length, 3, 'alerted once');
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

  test('a delivered pointer stops at the newest message, so a client cannot break check-ins', async () => {
    const res = await bob.request('POST', '/delivered', { conversationId: directChat.id, messageId: 2_147_483_647 });
    assert.equal(res.status, 204);
    for (const client of [alice, bob]) assert.equal((await client.request('GET', '/bootstrap')).status, 200);
    const bobState = (await viewOf(alice, directChat.id)).members.find((m) => m.userId === bob.id)!;
    assert.ok(bobState.lastDeliveredId < 2_147_483_647);
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
    weekend = group.data;
    assert.equal(weekend.ownerId, alice.id);
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

  test('only the owner can remove someone from a group, who cannot read anything sent after', async () => {
    const path = `/conversations/${weekend.id}/members/${carol.id}`;
    const notOwner = await bob.request<{ code?: string }>('DELETE', path, { key: null });
    assert.equal(notOwner.status, 403);
    assert.equal(notOwner.data.code, 'not_owner');

    const view = await viewOf(alice, weekend.id);
    const withCarol = await alice.request<{ code?: string }>('DELETE', path, {
      key: await alice.rotateChatKey(view, keysOf(alice), [alice, bob, carol]),
    });
    assert.equal(withCarol.data.code, 'stale_group', 'the new key may not be wrapped for the person removed');
    const { link } = await alice.rotateChatKey(view, keysOf(alice), [alice, bob]);
    const sameKey = await alice.request<{ code?: string }>('DELETE', path, {
      key: { ...(await alice.shareChatKey(view, keysOf(alice), [alice, bob])), link },
    });
    assert.equal(sameKey.data.code, 'stale_group', 'the old key cannot stay');
    assert.equal((await alice.request('DELETE', `/conversations/${weekend.id}/members/${alice.id}`, { key: null })).status, 400);
    assert.equal((await alice.request('DELETE', `/conversations/${directChat.id}/members/${bob.id}`, { key: null })).status, 400);

    const key = await alice.rotateChatKey(view, keysOf(alice), [alice, bob]);
    const removed = await alice.request<ConversationDTO>('DELETE', path, { key });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.deepEqual(memberIdsOf(removed.data), [alice.id, bob.id]);
    assert.equal(removed.data.keyId, key.keyId);
    assert.deepEqual(
      removed.data.keyLinks.map((l) => l.previousKeyId),
      [view.keyId],
    );
    await alice.openChatKey(removed.data, keysOf(alice));

    assert.equal((await carol.request('GET', `/conversations/${weekend.id}/messages`)).status, 404);
    assert.equal((await carol.send(weekend.id, 'Still invited?')).status, 404);
    const carolView = await carol.sync(true);
    assert.ok(carolView.changed);
    assert.ok(!carolView.conversations.some((c) => c.id === weekend.id));

    // Carol keeps the key she had. It does not open what is sent next, and the database holds no
    // copy of the new key for her.
    const after = await alice.send(weekend.id, 'Carol is out, so: dinner at 8');
    assert.equal(after.status, 201);
    assert.equal(after.data.envelope!.kid, key.keyId);
    await assert.rejects(carol.read(after.data, keysOf(alice)), /decryption failed/);
    const copies = await instance.sql.query<{ user_id: number }>(
      'SELECT user_id FROM webchat.conversation_keys WHERE conversation_id = $1 ORDER BY user_id',
      [weekend.id],
    );
    assert.deepEqual(
      copies.map((c) => c.user_id),
      [alice.id, bob.id].sort((a, b) => a - b),
    );

    const bobView = await bob.sync(true);
    assert.ok(bobView.changed, 'the others see who left');
    const chat = bobView.conversations.find((c) => c.id === weekend.id)!;
    assert.deepEqual(memberIdsOf(chat), [alice.id, bob.id]);
    assert.equal(chat.myKey!.wrappedBy, alice.id);
    await bob.openChatKey(chat, keysOf(alice));
    assert.equal(await bob.read(bobView.messages.find((m) => m.id === after.data.id)!, keysOf(alice)), 'Carol is out, so: dinner at 8');
    const history = await bob.request<MessageDTO[]>('GET', `/conversations/${weekend.id}/messages`);
    assert.equal(await bob.read(history.data[0]!, keysOf(alice), chat), 'Dinner at 7?', 'the old key comes inside the new one');
  });

  test('any member can add someone to a group, who then reads its history', async () => {
    const path = `/conversations/${weekend.id}/members`;
    const view = await viewOf(bob, weekend.id);
    const forCarol = await bob.shareChatKey(view, keysOf(alice), [carol]);
    assert.equal((await carol.request('POST', path, { userIds: [carol.id], key: forCarol })).status, 404);
    assert.equal(
      (await bob.request('POST', `/conversations/${directChat.id}/members`, { userIds: [carol.id], key: forCarol })).status,
      400,
      'a direct chat stays between two people',
    );
    const forBoth = await bob.shareChatKey(view, keysOf(alice), [alice, carol]);
    assert.equal((await bob.request('POST', path, { userIds: [carol.id], key: forBoth })).status, 400, 'a copy for each person added, no more');
    const keyless = await bob.request<{ code?: string }>('POST', path, { userIds: [carol.id], key: null });
    assert.equal(keyless.data.code, 'stale_group', 'a group with a key must share it');
    const forAlice = await bob.shareChatKey(view, keysOf(alice), [alice]);
    const again = await bob.request<{ code?: string }>('POST', path, { userIds: [alice.id], key: forAlice });
    assert.equal(again.data.code, 'already_member');

    const phone = makeSubscription(`http://${pushService.host}/carol-phone`);
    assert.equal((await carol.request('POST', '/push/subscribe', phone.json)).status, 204);
    pushService.received.length = 0;
    const added = await bob.request<ConversationDTO>('POST', path, { userIds: [carol.id], key: forCarol });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.deepEqual(memberIdsOf(added.data), [alice.id, bob.id, carol.id]);
    const [push] = await waitForPushes(pushService.received, 1);
    const invite = phone.decrypt(push!.body);
    assert.deepEqual(
      [invite.kind, invite.title, invite.body, invite.conversationId],
      ['group', 'Weekend', 'Bob added you to this group.', weekend.id],
    );

    const aliceView = await alice.sync(true);
    assert.ok(aliceView.changed, 'the others see the newcomer');
    assert.deepEqual(memberIdsOf(aliceView.conversations.find((c) => c.id === weekend.id)!), [alice.id, bob.id, carol.id]);

    const res = await carol.sync(true);
    assert.ok(res.changed);
    const chat = res.conversations.find((c) => c.id === weekend.id)!;
    assert.equal(chat.unread, 0, 'history from before joining is not unread');
    const mine = chat.members.find((m) => m.userId === carol.id)!;
    assert.equal(mine.lastReadId, chat.lastMessage!.id, 'so the page alerts for none of it');
    assert.equal(chat.myKey!.wrappedBy, bob.id);
    await carol.openChatKey(chat, keysOf(bob));
    const history = await carol.request<MessageDTO[]>('GET', `/conversations/${weekend.id}/messages`);
    // Sent before the new key that came with her removal, so it opens through the link.
    assert.equal(await carol.read(history.data[0]!, keysOf(alice), chat), 'Dinner at 7?');
  });

  test('only the owner can delete a group, for everyone', async () => {
    const notOwner = await bob.request<{ code?: string }>('DELETE', `/conversations/${weekend.id}`);
    assert.equal(notOwner.status, 403);
    assert.equal((await alice.request('DELETE', `/conversations/${directChat.id}`)).status, 400, 'a direct chat stays');

    assert.equal((await alice.request('DELETE', `/conversations/${weekend.id}`)).status, 204);
    assert.equal((await bob.request('GET', `/conversations/${weekend.id}/messages`)).status, 404);
    const left = await instance.sql.query('SELECT 1 FROM webchat.messages WHERE conversation_id = $1', [weekend.id]);
    assert.equal(left.length, 0, 'its messages are deleted');
    const bobView = await bob.sync(true);
    assert.ok(bobView.changed);
    assert.ok(!bobView.conversations.some((c) => c.id === weekend.id));
  });

  test('people leave a group on their own, and a member who stays makes its next key', async () => {
    const key = await alice.newChatKey([alice, bob, carol].map((c) => ({ id: c.id, keys: keysOf(c) })));
    const created = await alice.request<ConversationDTO>('POST', '/conversations/group', {
      title: 'Lab',
      memberIds: [bob.id, carol.id],
      key,
    });
    lab = created.data;
    alice.chatKeys.set(lab.id, { keyId: key.keyId, key: await importChatKey(key.raw) });
    await alice.send(lab.id, 'Lab report draft is up');
    await carol.openChatKey(await viewOf(carol, lab.id), keysOf(alice));

    const ownerLeaves = await alice.request<{ code?: string }>('POST', `/conversations/${lab.id}/leave`);
    assert.equal(ownerLeaves.data.code, 'owner', 'the owner hands the group over first');
    assert.equal((await alice.request('POST', `/conversations/${directChat.id}/leave`)).status, 400, 'a direct chat stays');
    assert.equal((await carol.request('POST', `/conversations/${lab.id}/leave`)).status, 204);
    assert.equal((await carol.request('GET', `/conversations/${lab.id}/messages`)).status, 404);

    // Carol holds the current key, so nothing new is sent with it.
    const [aliceWaiting, bobWaiting] = [await viewOf(alice, lab.id), await viewOf(bob, lab.id)];
    assert.equal(bobWaiting.needsNewKey, true);
    assert.deepEqual(memberIdsOf(bobWaiting), [alice.id, bob.id]);
    assert.equal((await alice.send(lab.id, 'Are we still three?')).data.code, 'needs_new_key');

    // Bob's browser replaces it. A key for the wrong people, or one that skips the current key, is refused.
    const path = `/conversations/${lab.id}/key`;
    const withCarol = await bob.request<{ code?: string }>('PUT', path, await bob.rotateChatKey(bobWaiting, keysOf(alice), [alice, bob, carol]));
    assert.equal(withCarol.data.code, 'stale_key');
    const next = await bob.rotateChatKey(bobWaiting, keysOf(alice), [alice, bob]);
    const skipped = await bob.request<{ code?: string }>('PUT', path, { ...next, link: { ...next.link, previousKeyId: newKeyId() } });
    assert.equal(skipped.data.code, 'stale_key');
    const replaced = await bob.request<ConversationDTO>('PUT', path, next);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
    assert.equal(replaced.data.keyId, next.keyId);
    assert.equal(replaced.data.needsNewKey, false);
    const late = await alice.request<{ code?: string }>('PUT', path, await alice.rotateChatKey(aliceWaiting, keysOf(alice), [alice, bob]));
    assert.equal(late.data.code, 'stale_key', 'the first member to replace it wins');

    await bob.openChatKey(replaced.data, keysOf(bob));
    const sent = await bob.send(lab.id, 'I will take the results section');
    assert.equal(sent.status, 201);
    await assert.rejects(carol.read(sent.data, keysOf(bob)), /decryption failed/);

    const aliceView = await alice.sync(true);
    assert.ok(aliceView.changed);
    const chat = aliceView.conversations.find((c) => c.id === lab.id)!;
    assert.equal(chat.myKey!.wrappedBy, bob.id);
    await alice.openChatKey(chat, keysOf(bob));
    assert.equal(await alice.read(sent.data, keysOf(bob)), 'I will take the results section');
    const history = await alice.request<MessageDTO[]>('GET', `/conversations/${lab.id}/messages`);
    assert.equal(await alice.read(history.data[0]!, keysOf(alice), chat), 'Lab report draft is up');
  });

  test('the owner hands a group over, and can then leave it', async () => {
    const path = `/conversations/${lab.id}/owner`;
    assert.equal((await bob.request('PUT', path, { userId: bob.id })).status, 403, 'only the owner hands it over');
    const toCarol = await alice.request<{ code?: string }>('PUT', path, { userId: carol.id });
    assert.equal(toCarol.data.code, 'stale_group', 'only to someone in it');

    await bob.sync(true);
    assert.equal((await bob.sync(true)).changed, false);
    const handed = await alice.request<ConversationDTO>('PUT', path, { userId: bob.id });
    assert.equal(handed.status, 200, JSON.stringify(handed.data));
    assert.equal(handed.data.ownerId, bob.id);
    const bobView = await bob.sync(true);
    assert.ok(bobView.changed, 'the new owner shows on the next check-in');
    assert.equal(bobView.conversations.find((c) => c.id === lab.id)!.ownerId, bob.id);

    assert.equal((await alice.request('DELETE', `/conversations/${lab.id}`)).status, 403, 'the old owner is a member like any other');
    assert.equal((await alice.request('POST', `/conversations/${lab.id}/leave`)).status, 204);
    assert.equal((await bob.request<{ code?: string }>('POST', `/conversations/${lab.id}/leave`)).data.code, 'owner');
    assert.equal((await bob.request('DELETE', `/conversations/${lab.id}`)).status, 204, 'the last one in it deletes it instead');
  });

  describe('projects', () => {
    let project: ProjectDTO;
    let general: ConversationDTO;
    let design: ConversationDTO;
    const kickoff = 'Kickoff notes: the report is due 12 May';

    test('a project starts with #general, keyed for every member', async () => {
      const key = await alice.newChatKey([alice, bob].map((c) => ({ id: c.id, keys: keysOf(c) })));
      const created = await alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Capstone', memberIds: [bob.id], key });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      ({ project, channel: general } = created.data);
      assert.deepEqual(project.memberIds, [alice.id, bob.id]);
      assert.equal(general.type, 'channel');
      assert.equal(general.title, 'general');
      assert.equal(general.projectId, project.id);
      alice.chatKeys.set(general.id, { keyId: key.keyId, key: await importChatKey(key.raw) });
      const sent = await alice.send(general.id, kickoff);
      assert.equal(sent.status, 201);

      const res = await bob.sync(true);
      assert.ok(res.changed);
      assert.deepEqual(
        res.projects.map((p) => p.name),
        ['Capstone'],
      );
      await bob.openChatKey(res.conversations.find((c) => c.id === general.id)!, keysOf(alice));
      assert.equal(await bob.read(res.messages.find((m) => m.id === sent.data.id)!, keysOf(alice)), kickoff);
      assert.equal((await carol.request('GET', `/conversations/${general.id}/messages`)).status, 404);
    });

    test('a new channel is keyed for exactly the current members, under a unique name', async () => {
      const members = [alice, bob].map((c) => ({ id: c.id, keys: keysOf(c) }));
      const partial = await alice.newChatKey([members[0]!]);
      const stale = await alice.request<{ code?: string }>('POST', `/projects/${project.id}/channels`, { name: 'design', key: partial });
      assert.equal(stale.status, 409);
      assert.equal(stale.data.code, 'stale_project');

      const key = await alice.newChatKey(members);
      assert.equal((await alice.request('POST', `/projects/${project.id}/channels`, { name: 'Design Team', key })).status, 400);
      const created = await alice.request<ConversationDTO>('POST', `/projects/${project.id}/channels`, { name: 'design', key });
      assert.equal(created.status, 201);
      design = created.data;
      alice.chatKeys.set(design.id, { keyId: key.keyId, key: await importChatKey(key.raw) });
      assert.equal((await alice.send(design.id, 'Wireframes v2 are in Figma')).status, 201);

      const taken = await bob.request<{ code?: string }>('POST', `/projects/${project.id}/channels`, {
        name: 'design',
        key: await bob.newChatKey(members),
      });
      assert.equal(taken.data.code, 'name_taken');
      const outsider = await carol.request('POST', `/projects/${project.id}/channels`, { name: 'secret', key });
      assert.equal(outsider.status, 404);
    });

    test('any member can add a classmate, who then reads every channel from the start', async () => {
      const view = await bob.sync(true);
      assert.ok(view.changed, 'Bob sees the new channel');
      const chats = view.conversations;
      const generalKey = await bob.shareChatKey(chats.find((c) => c.id === general.id)!, keysOf(alice), [carol]);
      const designKey = await bob.shareChatKey(chats.find((c) => c.id === design.id)!, keysOf(alice), [carol]);

      const missing = await bob.request<{ code?: string }>('POST', `/projects/${project.id}/members`, {
        userIds: [carol.id],
        channelKeys: [generalKey],
      });
      assert.equal(missing.status, 409, 'every channel key must be shared');
      assert.equal(missing.data.code, 'stale_project');

      const added = await bob.request<ProjectDTO>('POST', `/projects/${project.id}/members`, {
        userIds: [carol.id],
        channelKeys: [generalKey, designKey],
      });
      assert.equal(added.status, 200, JSON.stringify(added.data));
      assert.deepEqual(added.data.memberIds, [alice.id, bob.id, carol.id]);
      const again = await bob.request<{ code?: string }>('POST', `/projects/${project.id}/members`, {
        userIds: [carol.id],
        channelKeys: [generalKey, designKey],
      });
      assert.equal(again.data.code, 'already_member');

      const aliceView = await alice.sync(true);
      assert.ok(aliceView.changed, 'other members see the newcomer');
      assert.deepEqual(aliceView.projects.find((p) => p.id === project.id)!.memberIds, [alice.id, bob.id, carol.id]);

      const res = await carol.sync(true);
      assert.ok(res.changed);
      for (const channel of [general, design]) {
        const chat: ConversationDTO = res.conversations.find((c) => c.id === channel.id)!;
        assert.equal(chat.unread, 0, 'history from before joining is not unread');
        assert.equal(chat.myKey!.wrappedBy, bob.id);
        await carol.openChatKey(chat, keysOf(bob));
      }
      const history = await carol.request<MessageDTO[]>('GET', `/conversations/${general.id}/messages`);
      assert.equal(await carol.read(history.data[0]!, keysOf(alice)), kickoff);
    });

    test('replies and reactions are end-to-end encrypted, and a reaction is never unread', async () => {
      const original = (await carol.request<MessageDTO[]>('GET', `/conversations/${general.id}/messages`)).data[0]!;
      const replyTo = { id: original.id, senderId: alice.id, text: kickoff };
      const reply = await carol.send(general.id, { text: 'I can take the slides', replyTo });
      assert.equal(reply.status, 201);
      const party = { text: '', reaction: { messageId: reply.data.id, emoji: '🎉' } };
      assert.equal((await alice.send(general.id, party, true, 'reaction')).status, 400, 'a reaction is never urgent');
      const reaction = await alice.send(general.id, party, false, 'reaction');
      assert.equal(reaction.status, 201);
      assert.equal(reaction.data.kind, 'reaction');

      const rows = JSON.stringify(await instance.sql.query('SELECT * FROM webchat.messages'));
      for (const plain of ['slides', '12 May', '🎉']) assert.ok(!rows.includes(plain), `the database holds no "${plain}"`);

      const res = await carol.sync(true);
      assert.ok(res.changed);
      const chat = res.conversations.find((c) => c.id === general.id)!;
      assert.equal(chat.unread, 0, 'a reaction does not count as unread');
      assert.equal(chat.lastMessage!.id, reply.data.id, 'a reaction does not replace the chat preview');
      const event = res.messages.find((m) => m.id === reaction.data.id)!;
      assert.deepEqual(await carol.readContent(event, keysOf(alice)), { text: '', reaction: { messageId: reply.data.id, emoji: '🎉' } });

      const bobView = await bob.sync(true);
      assert.ok(bobView.changed);
      const received = bobView.messages.find((m) => m.id === reply.data.id)!;
      assert.deepEqual(await bob.readContent(received, keysOf(carol)), { text: 'I can take the slides', replyTo });

      // Turning a reaction into a message would show its sender saying something they never said.
      await instance.sql.query("UPDATE webchat.messages SET kind = 'message' WHERE id = $1", [reaction.data.id]);
      const page = await carol.request<MessageDTO[]>('GET', `/conversations/${general.id}/messages`);
      await assert.rejects(carol.readContent(page.data.find((m) => m.id === reaction.data.id)!, keysOf(alice)), /bad signature/);

      const unknown = await alice.request('POST', `/conversations/${general.id}/messages`, {
        envelope: reply.data.envelope,
        clientId: 'x',
        kind: 'poll',
      });
      assert.equal(unknown.status, 400);
    });

    test('a shared pull request card reaches members as its sender signed it', async () => {
      const pull = {
        repo: 'acme/app',
        number: 4,
        title: 'Add sign-up page',
        url: 'https://github.com/acme/app/pull/4',
        draft: false,
        review: null,
        checks: null,
        conflicts: false,
        reviewers: ['bob-gh'],
      };
      const card = await carol.send(general.id, { text: 'Pull request acme/app#4: Add sign-up page', pull });
      assert.equal(card.status, 201);

      const bobView = await bob.sync(true);
      assert.ok(bobView.changed);
      const received = bobView.messages.find((m) => m.id === card.data.id)!;
      assert.deepEqual((await bob.readContent(received, keysOf(carol))).pull, pull);
    });

    /** A new key for each channel, made from Alice's copies, wrapped for the given people. */
    const rotateChannelKeys = async (members: Client[]) =>
      Promise.all(
        [general, design].map(async (channel) => ({
          conversationId: channel.id,
          ...(await alice.rotateChatKey(await viewOf(alice, channel.id), keysOf(alice), members)),
        })),
      );

    test('only the owner can remove someone from a project, who cannot read anything sent after', async () => {
      const path = `/projects/${project.id}/members/${bob.id}`;
      const notOwner = await carol.request<{ code?: string }>('DELETE', path, { channelKeys: [] });
      assert.equal(notOwner.status, 403);
      assert.equal(notOwner.data.code, 'not_owner');
      assert.equal((await alice.request('DELETE', `/projects/${project.id}/members/${alice.id}`, { channelKeys: [] })).status, 400);

      const [generalKey, designKey] = await rotateChannelKeys([alice, carol]);
      const missing = await alice.request<{ code?: string }>('DELETE', path, { channelKeys: [generalKey] });
      assert.equal(missing.data.code, 'stale_project', 'every channel needs a new key');
      const withBob = await alice.request<{ code?: string }>('DELETE', path, { channelKeys: await rotateChannelKeys([alice, bob, carol]) });
      assert.equal(withBob.data.code, 'stale_project', 'no new key may be wrapped for the person removed');

      const removed = await alice.request<ProjectDTO>('DELETE', path, { channelKeys: [generalKey, designKey] });
      assert.equal(removed.status, 200, JSON.stringify(removed.data));
      assert.deepEqual(removed.data.memberIds, [alice.id, carol.id]);

      for (const channel of [general, design]) {
        assert.equal((await bob.request('GET', `/conversations/${channel.id}/messages`)).status, 404);
      }
      const bobView = await bob.sync(true);
      assert.ok(bobView.changed);
      assert.ok(!bobView.projects.some((p) => p.id === project.id));
      assert.ok(!bobView.conversations.some((c) => c.projectId === project.id));

      // Bob keeps every key he was given. None of them opens what Alice sends next.
      await alice.openChatKey(await viewOf(alice, general.id), keysOf(alice));
      const next = await alice.send(general.id, 'Bob moved to another team');
      assert.equal(next.status, 201);
      await assert.rejects(bob.read(next.data, keysOf(alice)), /decryption failed/);

      // Carol gets the new keys from Alice, and the history from before comes inside them.
      const res = await carol.sync(true);
      assert.ok(res.changed);
      for (const channel of [general, design]) {
        const chat: ConversationDTO = res.conversations.find((c) => c.id === channel.id)!;
        assert.deepEqual(memberIdsOf(chat), [alice.id, carol.id]);
        assert.equal(chat.myKey!.wrappedBy, alice.id);
        assert.equal(chat.keyLinks.length, 1);
        await carol.openChatKey(chat, keysOf(alice));
      }
      assert.equal(await carol.read(res.messages.find((m) => m.id === next.data.id)!, keysOf(alice)), 'Bob moved to another team');
      const generalChat = res.conversations.find((c) => c.id === general.id)!;
      const history = await carol.request<MessageDTO[]>('GET', `/conversations/${general.id}/messages`);
      assert.equal(await carol.read(history.data[0]!, keysOf(alice), generalChat), kickoff);
    });

    test('someone added after a new key reads the whole history through it', async () => {
      const channelKeys = await Promise.all(
        [general, design].map(async (channel) => alice.shareChatKey(await viewOf(alice, channel.id), keysOf(alice), [bob])),
      );
      const added = await alice.request<ProjectDTO>('POST', `/projects/${project.id}/members`, { userIds: [bob.id], channelKeys });
      assert.equal(added.status, 200, JSON.stringify(added.data));
      assert.deepEqual(added.data.memberIds, [alice.id, carol.id, bob.id]);
      const res = await bob.sync(true);
      assert.ok(res.changed);
      const chat = res.conversations.find((c) => c.id === general.id)!;
      await bob.openChatKey(chat, keysOf(alice));
      const history = await bob.request<MessageDTO[]>('GET', `/conversations/${general.id}/messages`);
      assert.equal(await bob.read(history.data[0]!, keysOf(alice), chat), kickoff);
      assert.equal(await bob.read(history.data.at(-1)!, keysOf(alice), chat), 'Bob moved to another team');
    });

    test('a member leaves a project, and whoever stays gives every channel its next key', async () => {
      assert.equal((await carol.request('POST', `/projects/${project.id}/leave`)).status, 204);
      assert.equal((await carol.request('GET', `/conversations/${general.id}/messages`)).status, 404);
      const owner = await alice.request<{ code?: string }>('POST', `/projects/${project.id}/leave`);
      assert.equal(owner.data.code, 'owner', 'the owner hands the project over first');

      const view = await bob.sync(true);
      assert.ok(view.changed);
      assert.deepEqual(view.projects.find((p) => p.id === project.id)!.memberIds, [alice.id, bob.id]);
      const channels = view.conversations.filter((c) => c.projectId === project.id);
      assert.equal(channels.length, 2);
      assert.ok(channels.every((c) => c.needsNewKey));
      assert.equal((await bob.send(general.id, 'Carol left?')).data.code, 'needs_new_key');

      for (const chat of channels) {
        const next = await bob.rotateChatKey(chat, keysOf(alice), [alice, bob]);
        const replaced = await bob.request<ConversationDTO>('PUT', `/conversations/${chat.id}/key`, next);
        assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
        await bob.openChatKey(replaced.data, keysOf(bob));
      }
      const sent = await bob.send(general.id, 'Carol left, so I take the slides');
      assert.equal(sent.status, 201);
      await assert.rejects(carol.read(sent.data, keysOf(bob)), /decryption failed/);

      const aliceView = await alice.sync(true);
      assert.ok(aliceView.changed);
      const chat = aliceView.conversations.find((c) => c.id === general.id)!;
      assert.equal(chat.keyLinks.length, 2);
      await alice.openChatKey(chat, keysOf(bob));
      const history = await alice.request<MessageDTO[]>('GET', `/conversations/${general.id}/messages`);
      assert.equal(await alice.read(history.data[0]!, keysOf(alice), chat), kickoff, 'two keys back');
    });

    test('the owner hands a project over, and the new owner runs it', async () => {
      const path = `/projects/${project.id}/owner`;
      assert.equal((await bob.request('PUT', path, { userId: bob.id })).status, 403, 'only the owner hands it over');
      const toCarol = await alice.request<{ code?: string }>('PUT', path, { userId: carol.id });
      assert.equal(toCarol.data.code, 'stale_project', 'only to a member');
      const handed = await alice.request<ProjectDTO>('PUT', path, { userId: bob.id });
      assert.equal(handed.status, 200, JSON.stringify(handed.data));
      assert.equal(handed.data.ownerId, bob.id);
      const oldOwner = await alice.request<{ code?: string }>('DELETE', `/projects/${project.id}/members/${bob.id}`, { channelKeys: [] });
      assert.equal(oldOwner.data.code, 'not_owner');
      assert.equal((await bob.request<{ code?: string }>('POST', `/projects/${project.id}/leave`)).data.code, 'owner');
    });

    test('only the owner can delete a project, with every channel and message in it', async () => {
      const notOwner = await alice.request<{ code?: string }>('DELETE', `/projects/${project.id}`);
      assert.equal(notOwner.status, 403);
      assert.equal((await bob.request('DELETE', `/projects/${project.id}`)).status, 204);
      assert.equal((await bob.request('DELETE', `/projects/${project.id}`)).status, 404, 'it is gone');
      assert.equal((await alice.request('GET', `/conversations/${general.id}/messages`)).status, 404);

      for (const table of ['messages', 'members', 'conversation_keys', 'key_links']) {
        const rows = await instance.sql.query(`SELECT 1 FROM webchat.${table} WHERE conversation_id IN ($1, $2)`, [
          general.id,
          design.id,
        ]);
        assert.equal(rows.length, 0, `no ${table} rows are left`);
      }
      const res = await alice.sync(true);
      assert.ok(res.changed);
      assert.ok(!res.projects.some((p) => p.id === project.id));
      assert.ok(!res.conversations.some((c) => c.projectId === project.id));
    });
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
        'Did my answer get lost?',
      ],
    );
    const older = await alice.request<MessageDTO[]>('GET', `/conversations/${directChat.id}/messages?before=${page.data[2]!.id}`);
    assert.equal(older.data.length, 2);
  });

  // Alerts for iPhones without Web Push, through the Bark app (R-018).
  let bobServerUrl = '';
  let bobPhoneToken = '';
  let bobBarkKey = '';
  type Registered = { code: number; data: { key: string; device_key: string; device_token: string } };

  test('Bark: linking gives the app a server URL it can ping and register with', async () => {
    const link = await bob.request<BarkDTO>('POST', '/bark/link');
    assert.equal(link.status, 200);
    assert.equal(link.data.configured, true);
    bobServerUrl = link.data.link!.serverUrl;
    assert.ok(bobServerUrl.startsWith(`${baseUrl}/api/bark/`));
    assert.equal((await bob.request<BarkDTO>('POST', '/bark/link')).data.link!.serverUrl, bobServerUrl, 'linking again keeps the link');

    const ping = await fetch(`${bobServerUrl}/ping`);
    assert.equal(ping.status, 200);
    assert.equal(((await ping.json()) as { message: string }).message, 'pong');

    bobPhoneToken = 'ab'.repeat(32);
    const registered = (await (await fetch(`${bobServerUrl}/register?devicetoken=${bobPhoneToken.toUpperCase()}`)).json()) as Registered;
    assert.equal(registered.code, 200);
    assert.equal(registered.data.device_token, bobPhoneToken);
    assert.equal(registered.data.key, registered.data.device_key);
    bobBarkKey = registered.data.key;
    // The app registers again on every launch, with the key it was given: same phone, same key.
    const again = (await (await fetch(`${bobServerUrl}/register?devicetoken=${bobPhoneToken}&key=${bobBarkKey}`)).json()) as Registered;
    assert.equal(again.data.key, bobBarkKey);
    assert.deepEqual(
      (await bob.request<BarkDTO>('GET', '/bark')).data.link!.devices.map((d) => d.key),
      [bobBarkKey],
    );

    assert.equal((await fetch(`${baseUrl}/api/bark/${'x'.repeat(43)}/ping`)).status, 404);
    assert.equal((await fetch(`${bobServerUrl}/register?devicetoken=nope`)).status, 400);

    apns.received.length = 0;
    const test = await bob.request<{ sent: number }>('POST', '/push/test');
    const [push] = await waitForPushes(apns.received, 1);
    assert.equal((push!.body.aps as { alert: { title: string } }).alert.title, 'Notifications work');
    assert.ok(test.data.sent >= 1, 'the test counts the phone');
  });

  test('Bark: a message to someone away reaches the phone, with no text', async () => {
    await bob.sync(false);
    apns.received.length = 0;
    await alice.send(directChat.id, 'Meet at the library');
    const [push] = await waitForPushes(apns.received, 1);
    assert.equal(push!.path, `/3/device/${bobPhoneToken}`);
    assert.equal(push!.headers['apns-topic'], 'me.fin.bark');
    assert.equal(push!.headers['apns-push-type'], 'alert');
    assert.equal(push!.headers['apns-priority'], '10');
    const [header, claims] = String(push!.headers.authorization).replace('bearer ', '').split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()), { alg: 'ES256', kid: 'TESTKEY123' });
    assert.equal((JSON.parse(Buffer.from(claims!, 'base64url').toString()) as { iss: string }).iss, 'TEAM123456');
    const aps = push!.body.aps as { alert: { title: string; body: string }; 'mutable-content': number; 'thread-id': string };
    assert.equal(aps.alert.title, 'Alice');
    assert.equal(aps.alert.body, 'New message');
    assert.equal(aps['mutable-content'], 1);
    assert.equal(aps['thread-id'], `chat-${directChat.id}`);
    assert.equal(push!.body.url, `${baseUrl}/?chat=${directChat.id}`);
    assert.equal(push!.body.level, 'active');
    assert.equal(push!.body.call, undefined);
    assert.ok(!JSON.stringify(push!.body).includes('library'), 'no message text in the alert');
  });

  test('Bark: nothing while the person is looking at the app, and never for a reaction', async () => {
    await bob.sync(true, null);
    apns.received.length = 0;
    await alice.send(directChat.id, 'Looking?');
    await sleep(300);
    assert.equal(apns.received.length, 0);

    await bob.sync(false);
    const last = (await bob.bootstrap()).conversations.find((c) => c.id === directChat.id)!.lastMessage!;
    const wave = { text: '', reaction: { messageId: last.id, emoji: '👋' } };
    assert.equal((await alice.send(directChat.id, wave, false, 'reaction')).status, 201);
    await sleep(300);
    assert.equal(apns.received.length, 0);
  });

  test('Bark: an urgent message rings, and a newer message replaces an older alert', async () => {
    apns.received.length = 0;
    await alice.send(directChat.id, 'first');
    await alice.send(directChat.id, 'second');
    const [first, second] = await waitForPushes(apns.received, 2);
    assert.equal(first!.headers['apns-collapse-id'], second!.headers['apns-collapse-id'], 'one alert per chat');
    assert.ok(!String(first!.headers['apns-collapse-id']).includes(String(directChat.id)), 'the collapse id names no chat');

    apns.received.length = 0;
    await alice.send(directChat.id, 'Call me', true);
    const [push] = await waitForPushes(apns.received, 1);
    assert.notEqual(push!.headers['apns-collapse-id'], first!.headers['apns-collapse-id'], 'an urgent alert stands on its own');
    assert.ok(Number(push!.headers['apns-expiration']) > Date.now() / 1000 + 2 * 24 * 3600, 'urgent waits up to 3 days');
    const aps = push!.body.aps as { alert: { title: string }; sound: string };
    assert.equal(aps.alert.title, 'URGENT from Alice');
    assert.equal(aps.sound, 'alarm.caf');
    assert.equal(push!.body.level, 'timeSensitive');
    assert.equal(push!.body.call, '1');
  });

  test('Bark: with encryption on, Apple sees only a placeholder and ciphertext', async () => {
    const on = await bob.request<BarkDTO>('PUT', '/bark/encryption', { enabled: true });
    const key = on.data.link!.cipherKey!;
    assert.equal(key.length, 32);

    apns.received.length = 0;
    await alice.send(directChat.id, 'Secret plans');
    const [push] = await waitForPushes(apns.received, 1);
    const outer = JSON.stringify(push!.body);
    assert.ok(!outer.includes('Alice') && !outer.includes('plans') && !outer.includes(`chat-${directChat.id}`), 'nothing readable outside');
    assert.equal((push!.body.aps as { alert: { body: string } }).alert.body, 'New message');
    const iv = push!.body.iv as string;
    assert.equal(iv.length, 12);
    // Decrypt as Bark does: AES-256-GCM, the key and IV as text, the tag after the ciphertext.
    const data = Buffer.from(push!.body.ciphertext as string, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const inner = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString()) as Record<
      string,
      string
    >;
    assert.equal(inner.title, 'Alice');
    assert.equal(inner.body, 'New message');
    assert.equal(inner.group, `chat-${directChat.id}`);
    assert.equal(inner.url, `${baseUrl}/?chat=${directChat.id}`);
    assert.ok(!JSON.stringify(inner).includes('plans'), 'the text is not in the alert either');

    const off = await bob.request<BarkDTO>('PUT', '/bark/encryption', { enabled: false });
    assert.equal(off.data.link!.cipherKey, null);
  });

  test('Bark: one provider token serves every push, and Apple can retire it or the phone', async () => {
    assert.equal(new Set(apns.authorizations).size, 1, 'the token is minted once and reused');
    apns.failing.set(bobPhoneToken, { status: 403, reason: 'ExpiredProviderToken', once: true });
    apns.received.length = 0;
    await alice.send(directChat.id, 'Again');
    const [rejected, retried] = await waitForPushes(apns.received, 2);
    assert.notEqual(rejected!.headers.authorization, retried!.headers.authorization, 'retried with a new token');
    assert.equal(new Set(apns.authorizations).size, 2);

    apns.failing.set(bobPhoneToken, { status: 410, reason: 'Unregistered', once: false });
    apns.received.length = 0;
    await alice.send(directChat.id, 'Still there?');
    await waitForPushes(apns.received, 1);
    await sleep(100);
    assert.deepEqual((await bob.request<BarkDTO>('GET', '/bark')).data.link!.devices, [], 'a phone Apple no longer knows is forgotten');
    apns.failing.delete(bobPhoneToken);
  });

  test('Bark: unlinking ends the alerts and the server URL', async () => {
    assert.equal((await fetch(`${bobServerUrl}/register?devicetoken=${bobPhoneToken}`)).status, 200);
    assert.equal((await bob.request<BarkDTO>('GET', '/bark')).data.link!.devices.length, 1);
    assert.equal((await bob.request<BarkDTO>('DELETE', '/bark/link')).data.link, null);
    assert.equal((await fetch(`${bobServerUrl}/ping`)).status, 404);
    apns.received.length = 0;
    await alice.send(directChat.id, 'Anyone?');
    await sleep(300);
    assert.equal(apns.received.length, 0);
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

    const first = await alice.request<ConversationDTO>('POST', `/conversations/${id}/key`, await alice.newChatKey(members));
    const second = await bob.request<{ code?: string }>('POST', `/conversations/${id}/key`, await bob.newChatKey(members));
    assert.equal(first.status, 200);
    assert.equal(first.data.ownerId, alice.id, 'the group becomes the one who set up its encryption');
    assert.equal(second.status, 409);
    assert.equal(second.data.code, 'has_key');
  });

  test('migration 4 gives each older group the owner its key names; a group without a key has none', async () => {
    const now = Date.now();
    const [{ id }] = (await instance.sql.query<{ id: number }>(
      `INSERT INTO webchat.conversations (type, title, created_at, updated_at) VALUES ('group', 'Older chat', $1, $1) RETURNING id`,
      [now],
    )) as [{ id: number }];
    for (const user of [alice, bob]) {
      await instance.sql.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [id, user.id, now]);
    }
    await instance.sql.query("UPDATE webchat.conversations SET created_by = NULL WHERE type = 'group'");
    await instance.sql.query("UPDATE webchat.meta SET value = '3' WHERE key = 'schema_version'");
    await openDb(instance.sql);

    const groups = await instance.sql.query<{ title: string; created_by: number | null }>(
      "SELECT title, created_by FROM webchat.conversations WHERE type = 'group' ORDER BY id",
    );
    assert.deepEqual(groups, [
      { title: 'Old chat', created_by: alice.id },
      { title: 'Older chat', created_by: null },
    ]);
    assert.equal((await bob.request('DELETE', `/conversations/${id}`)).status, 204, 'any member manages a group without an owner');
  });

  test('a group without a key takes new people without one, and its first message keys it for everyone', async () => {
    const now = Date.now();
    const [{ id }] = (await instance.sql.query<{ id: number }>(
      `INSERT INTO webchat.conversations (type, title, created_at, updated_at) VALUES ('group', 'Study group', $1, $1) RETURNING id`,
      [now],
    )) as [{ id: number }];
    for (const user of [alice, bob]) {
      await instance.sql.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [id, user.id, now]);
    }
    const path = `/conversations/${id}/members`;
    const withKey = await bob.request<{ code?: string }>('POST', path, {
      userIds: [carol.id],
      key: await bob.newChatKey([{ id: carol.id, keys: keysOf(carol) }]),
    });
    assert.equal(withKey.data.code, 'stale_group', 'a new key would leave Alice and Bob without a copy');
    const added = await bob.request<ConversationDTO>('POST', path, { userIds: [carol.id], key: null });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.deepEqual(memberIdsOf(added.data), [alice.id, bob.id, carol.id]);
    assert.equal(added.data.keyId, null);
  });

  test('the first key of a group from before encryption checks the members again under the lock', async () => {
    for (const setter of [bob, carol]) {
      const now = Date.now();
      const [{ id }] = (await instance.sql.query<{ id: number }>(
        `INSERT INTO webchat.conversations (type, title, created_at, updated_at) VALUES ('group', 'Lab group', $1, $1) RETURNING id`,
        [now],
      )) as [{ id: number }];
      for (const user of [alice, bob, carol]) {
        await instance.sql.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [id, user.id, now]);
      }
      const members = [alice, bob, carol].map((c) => ({ id: c.id, keys: keysOf(c) }));
      // Alice removes Carol right after the key route has read the members, before it stores the key.
      const query = instance.sql.query;
      let removal: Promise<{ status: number }> | undefined;
      instance.sql.query = async <T,>(text: string, params?: unknown[]) => {
        const rows = await query<T>(text, params);
        if (!removal && text.startsWith('SELECT user_id FROM webchat.members') && params?.[0] === id) {
          removal = alice.request('DELETE', `/conversations/${id}/members/${carol.id}`, { key: null });
          await removal;
        }
        return rows;
      };
      let keyed;
      try {
        keyed = await setter.request<{ code?: string }>('POST', `/conversations/${id}/key`, await setter.newChatKey(members));
      } finally {
        instance.sql.query = query;
      }
      assert.equal((await removal)?.status, 200);
      assert.equal(keyed.data.code, 'stale_group');

      const copies = await instance.sql.query<{ user_id: number }>(
        'SELECT user_id FROM webchat.conversation_keys WHERE conversation_id = $1',
        [id],
      );
      assert.ok(!copies.some((c) => c.user_id === carol.id), 'Carol was removed, so she holds no copy');
      const [chat] = await instance.sql.query<{ created_by: number | null }>(
        'SELECT created_by FROM webchat.conversations WHERE id = $1',
        [id],
      );
      assert.notEqual(chat?.created_by, carol.id, 'the owner is still a member');
    }
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

  test('a check-in that cannot carry every new message says so, and the next one brings the rest', async () => {
    await bob.bootstrap();
    await instance.sql.query(
      `INSERT INTO webchat.messages (conversation_id, sender_id, body, urgent, created_at, kind)
       SELECT $1, $2, '', false, $3, 'message' FROM generate_series(1, 501)`,
      [directChat.id, alice.id, Date.now()],
    );
    const [{ newest }] = (await instance.sql.query<{ newest: number }>(
      'SELECT MAX(id) AS newest FROM webchat.messages WHERE conversation_id = $1',
      [directChat.id],
    )) as [{ newest: number }];
    await instance.sql.query('UPDATE webchat.conversations SET last_message_id = $2, last_event_id = $2 WHERE id = $1', [
      directChat.id,
      newest,
    ]);
    const first = await bob.sync(false);
    assert.ok(first.changed);
    assert.equal(first.messages.length, 500);
    assert.equal(first.more, true);
    assert.ok(!first.messages.some((m) => m.id === newest));
    const second = await bob.sync(false);
    assert.ok(second.changed);
    assert.equal(second.more, false);
    assert.ok(second.messages.some((m) => m.id === newest));
  });

  test('someone no longer in a project cannot add people to it', async () => {
    const db = await openDb(instance.sql);
    const now = Date.now();
    const [{ id: projectId }] = (await instance.sql.query<{ id: number }>(
      `INSERT INTO webchat.projects (name, created_by, created_at) VALUES ('Left behind', $1, $2) RETURNING id`,
      [alice.id, now],
    )) as [{ id: number }];
    await instance.sql.query('INSERT INTO webchat.project_members (project_id, user_id, joined_at) VALUES ($1, $2, $3)', [
      projectId,
      alice.id,
      now,
    ]);
    // Carol passed the route's membership check before the owner removed her; the lock catches it.
    assert.equal(await db.addProjectMembers(projectId, carol.id, [bob.id], []), 'stale');
  });

  test('logout ends the session', async () => {
    assert.equal((await carol.request('POST', '/auth/logout')).status, 204);
    assert.equal((await carol.request('GET', '/bootstrap')).status, 401);
  });
});
