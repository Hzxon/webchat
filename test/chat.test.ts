import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import ece from 'http_ece';
import { createApp, type WebChatApp } from '../server/app.ts';
import { hashPassword } from '../server/auth.ts';
import type { Config } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import {
  createIdentity,
  decryptContent,
  decryptDoc,
  decryptFile,
  decryptMessage,
  deriveAccountSecrets,
  encryptDoc,
  encryptFile,
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
  type DocContent,
  type Identity,
  type MessageContent,
} from '../shared/e2ee.ts';
import type {
  BarkDTO,
  BootstrapDTO,
  ConfigDTO,
  ConversationDTO,
  CreateProjectResponse,
  DocDTO,
  DocRevisionDTO,
  FirstChatKeyInput,
  LoginResponse,
  MessageDTO,
  MessageKind,
  ProjectDTO,
  PushPayload,
  PublicKeysDTO,
  SyncRequest,
  SyncResponse,
  UploadDTO,
  UserDTO,
} from '../shared/types.ts';
import { LIMITS, toChannelName } from '../shared/types.ts';

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
  /** Paths answered 410 Gone, as for a subscription the browser ended. */
  const gone = new Set<string>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(gone.has(req.url ?? '') ? 410 : 201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    gone,
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

/** One person's browser: its cookies, account keys, and the chat keys it has opened. */
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
    // Like a browser, a new cookie replaces the one of the same name and leaves the others.
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0]!;
      const name = pair.slice(0, pair.indexOf('=') + 1);
      this.cookie = [...this.cookie.split('; ').filter((c) => c && !c.startsWith(name)), pair].join('; ');
    }
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

  /**
   * A fresh chat key, wrapped for each member using the public keys the server lists, for the
   * given chat, or for a new one whose id it reserves.
   */
  async newChatKey(
    members: Array<{ id: number; keys: PublicKeysDTO }>,
    conversationId?: number,
  ): Promise<FirstChatKeyInput & { raw: Uint8Array<ArrayBuffer> }> {
    conversationId ??= (await this.request<{ id: number }>('POST', '/conversations/ids')).data.id;
    const raw = newChatKeyBytes();
    const keyId = newKeyId();
    const me = { id: this.id, identity: this.identity! };
    const wrappedKeys = await Promise.all(
      members.map(async (m) => ({ userId: m.id, ...(await wrapChatKey(raw, me, { id: m.id, dh: m.keys.dh }, keyId, conversationId)) })),
    );
    return { conversationId, keyId, wrappedKeys, raw };
  }

  /** Opens this user's copy of a chat key, checking it was wrapped by the named member. */
  async openChatKey(conversation: ConversationDTO, wrapperKeys: PublicKeysDTO) {
    const key = await unwrapChatKey(
      conversation.myKey!,
      { id: this.id, identity: this.identity! },
      { id: conversation.myKey!.wrappedBy, dh: wrapperKeys.dh },
      conversation.keyId!,
      conversation.id,
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
    // As a page does: the server ties the upload to the message, never seeing what the file is.
    const fileId = typeof content === 'object' ? content.file?.id : undefined;
    return this.request<MessageDTO & { error?: string; code?: string }>('POST', `/conversations/${conversationId}/messages`, {
      envelope,
      urgent,
      clientId,
      kind,
      fileId,
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
    const { raw: previous } = await openChatKeyBytes(chat.myKey!, me, { id: chat.myKey!.wrappedBy, dh: wrapperKeys.dh }, previousKeyId, chat.id);
    const { raw, ...key } = await this.newChatKey(
      members.map((m) => ({ id: m.id, keys: m.identity!.publicKeys })),
      chat.id,
    );
    const link = await linkChatKey(await importChatKey(raw), key.keyId, chat.id, previous, previousKeyId);
    return { ...key, link: { previousKeyId, ...link } };
  }

  /** Wraps this user's copy of a channel's key for people joining its project. */
  async shareChatKey(conversation: ConversationDTO, wrapperKeys: PublicKeysDTO, recipients: Client[]) {
    const me = { id: this.id, identity: this.identity! };
    const keyId = conversation.keyId!;
    const { raw } = await openChatKeyBytes(conversation.myKey!, me, { id: conversation.myKey!.wrappedBy, dh: wrapperKeys.dh }, keyId, conversation.id);
    const wrappedKeys = await Promise.all(
      recipients.map(async (r) => ({
        userId: r.id,
        ...(await wrapChatKey(raw, me, { id: r.id, dh: r.identity!.publicKeys.dh }, keyId, conversation.id)),
      })),
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

/** Work after a response, such as deleting files, finishes a moment later. */
async function waitFor(done: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
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
  let config: Config;
  /** The self-hosted file store's folder, where the tests look at everything the storage holds. */
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-files-'));
  const keysOf = (c: Client) => c.identity!.publicKeys;
  /** A chat as this person's next bootstrap lists it, without moving their sync cursor. */
  const viewOf = async (client: Client, conversationId: number) =>
    (await client.request<BootstrapDTO>('GET', '/bootstrap')).data.conversations.find((c) => c.id === conversationId)!;
  const viewDocs = async (client: Client) => (await client.request<BootstrapDTO>('GET', '/bootstrap')).data.docs;

  before(async () => {
    pushService = await startFakePushService();
    apns = await startFakeApns();
    // Stands in for the key Bark publishes. The fake APNs never checks the signature.
    const apnsKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const silent = { info() {}, warn() {}, error() {} };
    config = {
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
      urgentRingUrl: undefined,
      build: 'test-build',
      filesDir,
      blobStore: false,
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
    fs.rmSync(filesDir, { recursive: true, force: true });
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

  describe('the sign-in limit for one address (K-14)', () => {
    const laptop = () => new Client(baseUrl, 'bob');
    const signIn = async (authKey: string) => (await laptop().request('POST', '/auth/login', { username: 'bob', authKey })).status;
    const clearLimit = () => instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'auth:%'");
    before(clearLimit);
    after(clearLimit);

    test('successful sign-ins do not use it up', async () => {
      const { authKey } = await laptop().secrets();
      for (let i = 1; i <= 21; i++) assert.equal(await signIn(authKey), 200, `sign-in ${i}`);
    });

    test('20 failed sign-ins lock the address out, even for the right password', async () => {
      await clearLimit();
      const { authKey } = await laptop().secrets();
      const { authKey: wrong } = await laptop().secrets('not my password');
      for (let i = 1; i <= 20; i++) assert.equal(await signIn(wrong), 401, `attempt ${i}`);
      assert.equal(await signIn(authKey), 429);
    });
  });

  test('a device that has had an account cannot sign up for another (D-080)', async () => {
    const erinWith = (cookie: string) => Object.assign(new Client(baseUrl, 'erin'), { cookie });
    const dana = new Client(baseUrl, 'dana');
    assert.equal((await dana.register()).status, 201);
    assert.equal((await dana.request('POST', '/auth/logout')).status, 204);
    const refused = await erinWith(dana.cookie).register();
    assert.equal(refused.status, 403);
    assert.equal(refused.data.error, 'This device already has a WebChat account. Sign in to it instead.');

    const laptop = new Client(baseUrl, 'bob');
    assert.equal((await laptop.login()).status, 200);
    assert.equal((await erinWith(laptop.cookie).register()).status, 403, 'signing in marks the device too');

    // A browser signed in from before this rule has only the session cookie. Signing out marks it.
    const oldSession = erinWith(laptop.cookie.split('; ').find((c) => c.startsWith('webchat_sid='))!);
    assert.equal((await oldSession.request('POST', '/auth/logout')).status, 204);
    assert.equal((await oldSession.register()).status, 403);

    assert.equal((await erinWith('').register()).status, 201, 'another device can');
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

  test('push keys of the wrong size are refused', async () => {
    const { json } = makeSubscription(`http://${pushService.host}/bob-bad-keys`);
    const shortKey = { ...json, keys: { ...json.keys, p256dh: json.keys.p256dh.slice(0, -2) } };
    const longAuth = { ...json, keys: { ...json.keys, auth: crypto.randomBytes(32).toString('base64url') } };
    for (const subscription of [shortKey, longAuth]) {
      assert.equal((await bob.request('POST', '/push/subscribe', subscription)).status, 400);
    }
  });

  test('a subscription web-push cannot encrypt for is deleted, and pushes go on', async () => {
    const good = makeSubscription(`http://${pushService.host}/bob-good`);
    // 65 bytes, so the size check passes, but not a point on the curve, so web-push throws.
    const broken = {
      endpoint: `http://${pushService.host}/bob-broken`,
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    };
    assert.equal((await bob.request('POST', '/push/subscribe', good.json)).status, 204);
    assert.equal((await bob.request('POST', '/push/subscribe', broken)).status, 204);

    const first = await bob.request<{ sent: number; failed: number }>('POST', '/push/test');
    assert.equal(first.status, 200);
    assert.deepEqual(first.data, { sent: 1, failed: 1 });
    const second = await bob.request<{ sent: number; failed: number }>('POST', '/push/test');
    assert.deepEqual(second.data, { sent: 1, failed: 0 }, 'the broken subscription is gone');

    await bob.request('POST', '/push/unsubscribe', { endpoint: good.json.endpoint });
  });

  test('a push endpoint moves to another account only with its keys', async () => {
    const browser = makeSubscription(`http://${pushService.host}/bob-shared`);
    const ownerOf = async () =>
      (await instance.sql.query<{ user_id: number }>('SELECT user_id FROM webchat.push_subscriptions WHERE endpoint = $1', [browser.json.endpoint]))[0]?.user_id;
    assert.equal((await bob.request('POST', '/push/subscribe', browser.json)).status, 204);
    const forged = makeSubscription(browser.json.endpoint);
    // Refused, so the page makes a new subscription instead of believing it has one.
    const refused = await carol.request<{ code?: string }>('POST', '/push/subscribe', forged.json);
    assert.deepEqual([refused.status, refused.data.code], [409, 'endpoint_taken']);
    assert.equal(await ownerOf(), bob.id, 'knowing the endpoint is not enough');
    // The same browser signed in to another account sends the same subscription.
    assert.equal((await carol.request('POST', '/push/subscribe', browser.json)).status, 204);
    assert.equal(await ownerOf(), carol.id);
    await carol.request('POST', '/push/unsubscribe', { endpoint: browser.json.endpoint });
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

  test('a new chat takes the id its key copies name, reserved for its creator and used once (D-111)', async () => {
    const members = [alice, bob].map((c) => ({ id: c.id, keys: keysOf(c) }));
    const group = (key: object) => alice.request<ConversationDTO>('POST', '/conversations/group', { title: 'Reserved', memberIds: [bob.id], key });
    const bobs = (await bob.request<{ id: number }>('POST', '/conversations/ids')).data.id;
    assert.equal((await group(await alice.newChatKey(members, bobs))).status, 400, 'an id reserved for Bob is not for Alice');

    const key = await alice.newChatKey(members);
    const created = await group(key);
    assert.equal(created.data.id, key.conversationId);
    assert.equal((await group(key)).status, 400, 'an id is used once');
    assert.equal((await alice.request('DELETE', `/conversations/${created.data.id}`)).status, 204);
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

  test('a page that opens learns the newest urgent message of each chat sent while it was closed', async () => {
    const urgentIds = async (client: Client) =>
      (await client.request<BootstrapDTO>('GET', '/bootstrap')).data.urgent.filter((m) => m.conversationId === directChat.id).map((m) => m.id);
    const first = await bob.send(directChat.id, 'Call me', true);
    const newest = await bob.send(directChat.id, 'Now, please', true);
    await bob.send(directChat.id, 'Thanks');
    assert.deepEqual(await urgentIds(alice), [newest.data.id], 'the newest one, though a normal message followed');
    assert.deepEqual(await urgentIds(bob), [], 'never your own');

    await instance.sql.query('UPDATE webchat.messages SET created_at = created_at - $1 WHERE id >= $2', [
      3 * 24 * 3600_000,
      first.data.id,
    ]);
    assert.deepEqual(await urgentIds(alice), [], 'no longer than its push waits for an offline device');

    const again = await bob.send(directChat.id, 'Still there?', true);
    assert.equal((await alice.request('POST', `/conversations/${directChat.id}/read`, { messageId: again.data.id })).status, 204);
    assert.deepEqual(await urgentIds(alice), [], 'not once read');
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

  test('a reaction only wakes the browser in use, and never under the tag of a message alert', async () => {
    const laptop = makeSubscription(`http://${pushService.host}/bob-laptop`);
    assert.equal((await bob.request('POST', '/push/subscribe', laptop.json)).status, 204);
    await bob.sync(true, laptop.json.endpoint);

    pushService.received.length = 0;
    const sent = await alice.send(directChat.id, 'React to this');
    const message = laptop.decrypt((await waitForPushes(pushService.received, 1))[0]!.body);

    pushService.received.length = 0;
    const wave = { text: '', reaction: { messageId: sent.data.id, emoji: '👋' } };
    assert.equal((await alice.send(directChat.id, wave, false, 'reaction')).status, 201);
    const [push] = await waitForPushes(pushService.received, 1);
    await sleep(200);
    assert.deepEqual(
      pushService.received.map((p) => p.path),
      ['/bob-laptop'],
    );
    const reaction = laptop.decrypt(push!.body);
    assert.equal(reaction.kind, 'reaction', 'the service worker shows no notification for this kind');
    assert.equal(reaction.messageId, null);
    assert.equal(reaction.envelope, null);
    // The server can think Bob is looking after his laptop slept, so the push can reach a browser
    // nobody looks at. It must not replace the chat's message notification there.
    assert.notEqual(reaction.tag, message.tag);
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
    // "urgent" is left out: the field name and the tag carry it.
    const serialized = JSON.stringify(payload);
    for (const part of [text, 'Call', 'back']) assert.ok(!serialized.includes(part), `no "${part}" in the push`);
    const { key } = bob.chatKeys.get(directChat.id)!;
    const decrypted = await decryptMessage(
      key,
      keysOf(alice).sign,
      { conversationId: payload.conversationId!, senderId: payload.senderId!, urgent: payload.urgent, clientId: payload.clientId! },
      payload.envelope!,
    );
    assert.equal(decrypted, text);
  });

  test('a push stays under 3,000 bytes for the longest message, and still carries no plain text (D-017)', async () => {
    const watch = makeSubscription(`http://${pushService.host}/bob-watch`);
    assert.equal((await bob.request('POST', '/push/subscribe', watch.json)).status, 204);
    await bob.sync(false);

    pushService.received.length = 0;
    const text = 'Plain text that must never leave the device. '.repeat(LIMITS.messageLength).slice(0, LIMITS.messageLength);
    await alice.send(directChat.id, text);
    // The suite spends nearly all of Alice's 30 sends per 10 seconds; give this one back.
    await instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
    const pushes = await waitForPushes(pushService.received, 4);
    const payload = watch.decrypt(pushes.find((p) => p.path === '/bob-watch')!.body);
    const serialized = JSON.stringify(payload);
    assert.ok(Buffer.byteLength(serialized) <= 3000, `a push payload is at most 3,000 bytes, this one is ${Buffer.byteLength(serialized)}`);
    assert.equal(payload.envelope, null, 'a message that does not fit goes without its envelope');
    assert.ok(!serialized.includes('never leave'), 'no plain text in the push');
    await bob.request('POST', '/push/unsubscribe', { endpoint: watch.json.endpoint });
  });

  test('a request about a board card pushes only the person asked, as an ordinary message (the card-notes decision)', async () => {
    const asked = makeSubscription(`http://${pushService.host}/bob-note`);
    const elsewhere = makeSubscription(`http://${pushService.host}/carol-note`);
    assert.equal((await bob.request('POST', '/push/subscribe', asked.json)).status, 204);
    assert.equal((await carol.request('POST', '/push/subscribe', elsewhere.json)).status, 204);
    await carol.sync(false);
    await bob.sync(false);

    pushService.received.length = 0;
    const title = 'Fix the secret login bug';
    const note = { text: `Asks you to mark K-4 ready: ${title}`, card: { kind: 'ready' as const, card: 'K-4', docId: 'doc-secret', section: 'section-secret' } };
    assert.equal((await alice.send(directChat.id, note)).status, 201);
    await instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
    const pushes = await waitForPushes(pushService.received, 4);
    await sleep(200);
    const paths = pushService.received.map((p) => p.path);
    assert.ok(paths.length > 0 && paths.every((p) => p.startsWith('/bob-')), `only Bob's devices: ${paths}`);
    assert.equal(new Set(paths).size, paths.length, 'each device once');
    const payload = asked.decrypt(pushes.find((p) => p.path === '/bob-note')!.body);
    const serialized = JSON.stringify(payload);
    assert.ok(Buffer.byteLength(serialized) <= 3000);
    // The envelope is base64url, so a part as short as the card's id could show up in it by chance.
    for (const part of [title, 'doc-secret', 'section-secret', 'ready']) assert.ok(!serialized.includes(part), `no "${part}" in the push`);
    await bob.request('POST', '/push/unsubscribe', { endpoint: asked.json.endpoint });
    await carol.request('POST', '/push/unsubscribe', { endpoint: elsewhere.json.endpoint });
  });

  test("an agent's board traffic is a sync message: no push, never unread, no new preview (K-69)", async () => {
    const phone = makeSubscription(`http://${pushService.host}/bob-board`);
    assert.equal((await bob.request('POST', '/push/subscribe', phone.json)).status, 204);
    await bob.sync(false);
    const before = (await bob.bootstrap()).conversations.find((c) => c.id === directChat.id)!;

    pushService.received.length = 0;
    const claims = { text: 'Claims in acme/app', board: { kind: 'claims' as const, project: 1, repo: 'acme/app', claims: [{ card: 'K-4', pull: 7 }] } };
    assert.equal((await alice.send(directChat.id, claims, true, 'sync')).status, 400, 'a sync message is never urgent');
    const sent = await alice.send(directChat.id, claims, false, 'sync');
    await instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
    assert.equal(sent.status, 201);
    assert.equal(sent.data.kind, 'sync');
    await sleep(300);
    assert.equal(pushService.received.length, 0, 'nobody is looking, so nothing is pushed');

    const res = await bob.sync(false);
    assert.ok(res.changed);
    const chat = res.conversations.find((c) => c.id === directChat.id)!;
    assert.equal(chat.unread, before.unread, 'a sync message does not count as unread');
    assert.equal(chat.lastMessage?.id, before.lastMessage?.id, 'a sync message does not replace the chat preview');
    const event = res.messages.find((m) => m.id === sent.data.id)!;
    assert.deepEqual((await bob.readContent(event, keysOf(alice))).board, claims.board);
    await bob.request('POST', '/push/unsubscribe', { endpoint: phone.json.endpoint });
    // The migration tests below run migration 8 again, whose kind check knows no sync.
    await instance.sql.query('DELETE FROM webchat.messages WHERE id = $1', [sent.data.id]);
  });

  test('an unread urgent message rings again, like an alarm, until it is read (D-079)', async () => {
    const alarm = makeSubscription(`http://${pushService.host}/bob-alarm`);
    assert.equal((await bob.request('POST', '/push/subscribe', alarm.json)).status, 204);
    await bob.sync(false);
    await alice.send(directChat.id, 'Wake up', true);
    const newest = await alice.send(directChat.id, 'Wake up now', true);
    await sleep(300);
    const ring = async () => {
      pushService.received.length = 0;
      await instance.ringUrgent();
      return pushService.received.filter((p) => p.path === '/bob-alarm');
    };

    const [first, ...others] = await ring();
    assert.equal(others.length, 0, 'one alarm per chat');
    const payload = alarm.decrypt(first!.body);
    assert.deepEqual([payload.title, payload.tag], ['URGENT from Alice', `urgent-${newest.data.id}`], 'the newest one, as first pushed');
    const [second] = await ring();
    assert.ok(first!.headers['topic'] && first!.headers['topic'] === second!.headers['topic'], 'an offline phone keeps only the newest ring');
    assert.ok(!String(first!.headers['topic']).includes(String(newest.data.id)), 'the topic names no message');

    await bob.sync(true, alarm.json.endpoint);
    assert.deepEqual(await ring(), [], 'while Bob looks at the app, the page rings instead');
    await bob.sync(false);
    assert.equal((await bob.request('POST', `/conversations/${directChat.id}/read`, { messageId: newest.data.id })).status, 204);
    assert.deepEqual(await ring(), [], 'read, so it stops');
    assert.equal((await bob.request('POST', '/push/unsubscribe', { endpoint: alarm.json.endpoint })).status, 204);
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

  test('a subscription the push service reports gone is deleted at the next push', async () => {
    // A browser whose session expired ends its subscription without telling the server (K-18).
    const expired = makeSubscription(`http://${pushService.host}/bob-expired`);
    assert.equal((await bob.request('POST', '/push/subscribe', expired.json)).status, 204);
    pushService.gone.add('/bob-expired');
    await bob.sync(false);
    pushService.received.length = 0;
    await alice.send(directChat.id, 'Anyone home?');
    await waitForPushes(pushService.received, 4);
    await sleep(100);
    const rows = await instance.sql.query('SELECT 1 FROM webchat.push_subscriptions WHERE endpoint = $1', [expired.json.endpoint]);
    assert.equal(rows.length, 0);
  });

  test('the endpoint a worker replaced is deleted by its owner only (K-33)', async () => {
    const replaced = makeSubscription(`http://${pushService.host}/bob-replaced`);
    const fresh = makeSubscription(`http://${pushService.host}/bob-fresh`);
    const stored = async () =>
      (
        await instance.sql.query<{ endpoint: string }>(
          'SELECT endpoint FROM webchat.push_subscriptions WHERE endpoint IN ($1, $2) ORDER BY endpoint',
          [replaced.json.endpoint, fresh.json.endpoint],
        )
      ).map((row) => row.endpoint);
    assert.equal((await bob.request('POST', '/push/subscribe', replaced.json)).status, 204);
    assert.equal((await bob.request('POST', '/push/subscribe', fresh.json)).status, 204);

    assert.equal((await alice.request('POST', '/push/unsubscribe', { endpoint: replaced.json.endpoint })).status, 204);
    assert.deepEqual(await stored(), [fresh.json.endpoint, replaced.json.endpoint], "Alice cannot delete Bob's endpoint");
    assert.equal((await bob.request('POST', '/push/unsubscribe', { endpoint: replaced.json.endpoint })).status, 204);
    assert.deepEqual(await stored(), [fresh.json.endpoint]);

    await bob.request('POST', '/push/unsubscribe', { endpoint: fresh.json.endpoint });
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

  test('a member gives a chat that nobody left a new key, as a page does for a key from before D-111 (K-65)', async () => {
    const path = `/conversations/${lab.id}/key`;
    const [bobView, aliceView] = [await viewOf(bob, lab.id), await viewOf(alice, lab.id)];
    assert.equal(bobView.needsNewKey, false);
    const replaced = await bob.request<ConversationDTO>('PUT', path, await bob.rotateChatKey(bobView, keysOf(bob), [alice, bob]));
    assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
    const late = await alice.request<{ code?: string }>('PUT', path, await alice.rotateChatKey(aliceView, keysOf(bob), [alice, bob]));
    assert.equal(late.data.code, 'stale_key', 'the first member to replace it wins');
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

    test('someone removed after the membership check cannot add a channel', async () => {
      // The route checked Carol while she was a member; the lock is where the removal shows.
      const key = await carol.newChatKey([alice, bob].map((c) => ({ id: c.id, keys: keysOf(c) })));
      assert.equal(await (await openDb(instance.sql)).createChannel(project.id, 'late', carol.id, key), 'stale');
    });

    test('a channel cannot take an id from before #general, which pages tell by the lowest id (D-111)', async () => {
      const members = [{ id: alice.id, keys: keysOf(alice) }];
      const early = await alice.newChatKey(members);
      const own = await alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Order', key: await alice.newChatKey(members) });
      const res = await alice.request<{ code?: string }>('POST', `/projects/${own.data.project.id}/channels`, { name: 'early', key: early });
      assert.equal(res.data.code, 'stale_project');
    });

    test('the server accepts every name the New channel dialog makes', async () => {
      const members = [{ id: alice.id, keys: keysOf(alice) }];
      const own = await alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Names', key: await alice.newChatKey(members) });
      const almostFull = (letter: string) => letter.repeat(LIMITS.channelNameLength - 1);
      for (const typed of [`${almostFull('a')} b`, 'ℂhat', `${almostFull('c')}𠀀`, 'Slides & Design']) {
        const name = toChannelName(typed);
        const res = await alice.request('POST', `/projects/${own.data.project.id}/channels`, { name, key: await alice.newChatKey(members) });
        assert.equal(res.status, 201, `${typed} became ${name}`);
      }
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
      Promise.all([general, design].map(async (channel) => alice.rotateChatKey(await viewOf(alice, channel.id), keysOf(alice), members)));

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

    test('only the owner deletes a channel, with its messages, and never #general (R-034)', async () => {
      const path = `/projects/${project.id}/channels/${design.id}`;
      const messagesIn = async (id: number) =>
        (await instance.sql.query('SELECT 1 FROM webchat.messages WHERE conversation_id = $1', [id])).length;
      assert.equal((await alice.request<{ code?: string }>('DELETE', path)).data.code, 'not_owner');
      assert.equal((await carol.request('DELETE', path)).status, 404, 'nor anyone outside the project');
      const kept = await bob.request('DELETE', `/projects/${project.id}/channels/${general.id}`);
      assert.equal(kept.status, 400, 'its key opens the docs and the board');
      assert.ok((await messagesIn(design.id)) > 0);

      await alice.sync(true);
      assert.equal((await bob.request('DELETE', path)).status, 204);
      assert.equal((await bob.request('DELETE', path)).status, 404, 'it is gone');
      assert.equal(await messagesIn(design.id), 0);
      assert.equal((await alice.request('GET', `/conversations/${design.id}/messages`)).status, 404);
      const res = await alice.sync(true);
      assert.ok(res.changed, 'every member sees it go');
      assert.deepEqual(
        res.conversations.filter((c) => c.projectId === project.id).map((c) => c.id),
        [general.id],
      );
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

  describe('docs (R-020)', () => {
    let general: ConversationDTO;
    let doc: DocDTO;
    const id = newKeyId();
    const goals = crypto.randomBytes(8).toString('base64url');
    const plan = 'Requirement: the export works offline';

    /** A revision as this person's browser seals it for the doc's chat. */
    const seal = (client: Client, section: string, content: DocContent) => {
      const { keyId, key } = client.chatKeys.get(general.id)!;
      const meta = { conversationId: general.id, authorId: client.id, docId: id, section };
      return encryptDoc(key, keyId, client.identity!.signPrivate, meta, content);
    };
    const open = (client: Client, author: Client, revision: DocRevisionDTO) =>
      decryptDoc(
        client.chatKeys.get(general.id)!.key,
        keysOf(author).sign,
        { conversationId: general.id, authorId: revision.authorId, docId: revision.docId, section: revision.section },
        revision.envelope,
      );
    const save = async (client: Client, text: string) =>
      client.request<DocRevisionDTO & { code?: string }>('PUT', `/docs/${id}/sections/${goals}`, {
        envelope: await seal(client, goals, { text, pos: 1 }),
      });
    const lock = (client: Client, method = 'POST') => client.request(method, `/docs/${id}/sections/${goals}/lock`);

    test('a doc lives in a project channel, and the database holds none of its text', async () => {
      const key = await alice.newChatKey([alice, bob].map((c) => ({ id: c.id, keys: keysOf(c) })));
      const created = await alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Specs', memberIds: [bob.id], key });
      general = created.data.channel;
      alice.chatKeys.set(general.id, { keyId: key.keyId, key: await importChatKey(key.raw) });
      await bob.openChatKey(await viewOf(bob, general.id), keysOf(alice));

      const revisions = [
        { section: 'title', envelope: await seal(alice, 'title', { text: 'Export PRD' }) },
        { section: goals, envelope: await seal(alice, goals, { text: plan, pos: 1 }) },
      ];
      const outsider = await carol.request('POST', '/docs', { id: newKeyId(), conversationId: general.id, revisions });
      assert.equal(outsider.status, 404);
      const inDirect = await alice.request('POST', '/docs', { id, conversationId: directChat.id, revisions });
      assert.equal(inDirect.status, 400, 'docs belong to projects');
      const untitled = await alice.request('POST', '/docs', { id, conversationId: general.id, revisions: revisions.slice(1) });
      assert.equal(untitled.status, 400);
      const res = await alice.request<DocDTO>('POST', '/docs', { id, conversationId: general.id, revisions });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      doc = res.data;
      assert.equal((await alice.request('POST', '/docs', { id, conversationId: general.id, revisions })).status, 409);

      const stored = JSON.stringify(await instance.sql.query('SELECT * FROM webchat.docs d JOIN webchat.doc_revisions r ON r.doc_id = d.id'));
      assert.ok(!stored.includes('Export PRD') && !stored.includes('offline'), 'the server stores only ciphertext');

      const synced = await bob.sync(true);
      assert.ok(synced.changed);
      const listed = synced.docs.find((d) => d.id === id)!;
      assert.equal((await open(bob, alice, listed.title!)).text, 'Export PRD');
      const sections = await bob.request<DocRevisionDTO[]>('GET', `/docs/${id}`);
      assert.deepEqual(await open(bob, alice, sections.data.find((r) => r.section === goals)!), { text: plan, pos: 1 });

      assert.equal((await carol.request('GET', `/docs/${id}`)).status, 404);
      assert.deepEqual(await viewDocs(carol), []);
    });

    test('one person edits a section at a time, and each editing session is one revision', async () => {
      assert.equal((await save(alice, 'No lock yet')).data.code, 'not_locked');
      assert.equal((await lock(alice)).status, 204);
      const busy = await bob.request<{ error: string; code: string }>('POST', `/docs/${id}/sections/${goals}/lock`);
      assert.equal(busy.status, 409);
      assert.equal(busy.data.code, 'locked');
      assert.match(busy.data.error, /Alice is editing/);
      assert.equal((await save(bob, 'Sneaky edit')).data.code, 'not_locked');
      assert.equal((await lock(carol)).status, 404);

      const first = await save(alice, `${plan}, on a phone`);
      assert.equal(first.status, 200, JSON.stringify(first.data));
      const second = await save(alice, `${plan}, on a phone and a laptop`);
      assert.equal(second.data.id, first.data.id, 'saves in one session replace its revision');

      const seen = await bob.sync(true);
      assert.ok(seen.changed, 'a save changes the fingerprint');
      const now = seen.docs.find((d) => d.id === id)!;
      assert.ok(now.version > doc.version);
      assert.equal(now.updatedBy, alice.id);
      assert.deepEqual(now.locks, [{ section: goals, userId: alice.id }]);

      assert.equal((await lock(alice, 'DELETE')).status, 204);
      assert.ok((await bob.sync(true)).changed, 'a lock let go changes the fingerprint');
      assert.equal((await lock(bob)).status, 204);
      const bobs = await save(bob, `${plan}, and prints to PDF`);
      assert.notEqual(bobs.data.id, first.data.id, 'a new session adds a revision');

      const history = await alice.request<DocRevisionDTO[]>('GET', `/docs/${id}/sections/${goals}`);
      assert.deepEqual(
        history.data.map((r) => r.authorId),
        [bob.id, alice.id, alice.id],
        'newest first: Bob, then Alice, then the first version',
      );
      assert.equal((await open(alice, bob, history.data[0]!)).text, `${plan}, and prints to PDF`);
      assert.equal((await carol.request('GET', `/docs/${id}/sections/${goals}`)).status, 404);
    });

    test("a check-in keeps the editor's lock, and a lock that ran out goes to the next editor", async () => {
      await instance.sql.query('UPDATE webchat.doc_locks SET expires_at = $1', [Date.now() + 1000]);
      const editing = { docId: id, section: goals };
      const body: SyncRequest = { cursor: bob.cursor, stamp: bob.stamp, attentive: true, tabId: bob.tabId, endpoint: null, editing };
      assert.equal((await bob.request('POST', '/sync', body)).status, 200);
      const [held] = await instance.sql.query<{ expires_at: number }>('SELECT expires_at FROM webchat.doc_locks');
      assert.ok(held!.expires_at > Date.now() + 60_000, 'the check-in renewed it');
      assert.equal((await lock(alice)).status, 409);

      await instance.sql.query('UPDATE webchat.doc_locks SET expires_at = $1', [Date.now() - 1]);
      assert.equal((await lock(alice)).status, 204);
      assert.equal((await save(bob, 'Too late')).data.code, 'not_locked');
      assert.equal((await save(alice, plan)).status, 200);
      assert.equal((await lock(alice, 'DELETE')).status, 204);
    });

    test("a doc's words are each section's first revision and each author's newest, for members only", async () => {
      const history = (await alice.request<DocRevisionDTO[]>('GET', `/docs/${id}/sections/${goals}`)).data;
      assert.deepEqual(history.map((r) => r.authorId), [alice.id, bob.id, alice.id, alice.id]);
      const words = await bob.request<DocRevisionDTO[]>('GET', `/docs/${id}/words`);
      assert.equal(words.status, 200);
      assert.deepEqual(
        words.data.filter((r) => r.section === goals).map((r) => r.id),
        [history[3]!.id, history[1]!.id, history[0]!.id],
        'the first, then Bob’s and Alice’s newest, in id order, and not Alice’s revision between',
      );
      assert.equal(words.data.filter((r) => r.section === 'title').length, 1);
      assert.equal((await carol.request('GET', `/docs/${id}/words`)).status, 404);
    });

    test('only whoever made a doc, or the project owner, deletes it', async () => {
      assert.equal((await bob.request('DELETE', `/docs/${id}`)).status, 403);
      assert.equal((await carol.request('DELETE', `/docs/${id}`)).status, 404);
      assert.equal((await alice.request('DELETE', `/docs/${id}`)).status, 204);
      assert.equal((await bob.request('GET', `/docs/${id}`)).status, 404);
      assert.deepEqual(await viewDocs(bob), []);
    });
  });

  // Its own group, sent by carol, so that other tests' sends to the direct chat do not have to be
  // listed here, and alice's send limit (30 per 10 seconds) is left to them (D-076). Deleted at the
  // end, so later tests see the groups they expect.
  test('message history pages backwards', async () => {
    const key = await carol.newChatKey([alice, bob, carol].map((c) => ({ id: c.id, keys: keysOf(c) })));
    const paging = await carol.request<ConversationDTO>('POST', '/conversations/group', { title: 'Paging', memberIds: [alice.id, bob.id], key });
    assert.equal(paging.status, 201);
    carol.chatKeys.set(paging.data.id, { keyId: key.keyId, key: await importChatKey(key.raw) });
    const texts = ['one', 'two', 'three', 'four', 'five'];
    for (const text of texts) assert.equal((await carol.send(paging.data.id, text)).status, 201);
    const page = await carol.request<MessageDTO[]>('GET', `/conversations/${paging.data.id}/messages`);
    assert.equal(page.status, 200);
    assert.deepEqual(await Promise.all(page.data.map((m) => carol.read(m, keysOf(carol)))), texts);
    const older = await carol.request<MessageDTO[]>('GET', `/conversations/${paging.data.id}/messages?before=${page.data[2]!.id}`);
    assert.deepEqual(await Promise.all(older.data.map((m) => carol.read(m, keysOf(carol)))), ['one', 'two']);
    assert.equal((await carol.request('DELETE', `/conversations/${paging.data.id}`)).status, 204);
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
    assert.equal(push!.body.level, 'critical', 'rings through silent mode and Do Not Disturb (D-079)');
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

    const first = await alice.request<ConversationDTO>('POST', `/conversations/${id}/key`, await alice.newChatKey(members, id));
    const second = await bob.request<{ code?: string }>('POST', `/conversations/${id}/key`, await bob.newChatKey(members, id));
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
      key: await bob.newChatKey([{ id: carol.id, keys: keysOf(carol) }], id),
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
        keyed = await setter.request<{ code?: string }>('POST', `/conversations/${id}/key`, await setter.newChatKey(members, id));
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

  test('a key with two copies for one member and none for another is refused', async () => {
    const db = await openDb(instance.sql);
    const now = Date.now();
    const [{ id }] = (await instance.sql.query<{ id: number }>(
      `INSERT INTO webchat.conversations (type, title, created_at, updated_at) VALUES ('group', 'Doubled', $1, $1) RETURNING id`,
      [now],
    )) as [{ id: number }];
    for (const user of [alice, bob, carol]) {
      await instance.sql.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [id, user.id, now]);
    }
    const key = await alice.newChatKey([alice, bob, bob].map((c) => ({ id: c.id, keys: keysOf(c) })));
    const route = await alice.request('POST', `/conversations/${id}/key`, key);
    assert.equal(route.status, 400, 'the route refuses the copies before the database sees them');
    assert.equal(await db.setConversationKey(id, key.keyId, alice.id, key.wrappedKeys), 'stale');
  });

  test('deleting an account leaves every chat, frees the name and the device, and blocks on what it owns (R-028)', async () => {
    const frank = new Client(baseUrl, 'frank');
    assert.equal((await frank.register()).status, 201);
    const keyFor = (members: Client[]) => frank.newChatKey(members.map((c) => ({ id: c.id, keys: keysOf(c) })));
    const direct = await frank.request<ConversationDTO>('POST', '/conversations/direct', { userId: alice.id, key: await keyFor([frank, alice]) });
    const study = await frank.request<ConversationDTO>('POST', '/conversations/group', { title: 'Study', memberIds: [bob.id], key: await keyFor([frank, bob]) });
    const thesis = await frank.request<CreateProjectResponse>('POST', '/projects', { name: 'Thesis', memberIds: [bob.id], key: await keyFor([frank, bob]) });

    const owning = await frank.request<{ code?: string }>('DELETE', '/auth/account');
    assert.equal(owning.status, 409);
    assert.equal(owning.data.code, 'owner', 'a group or project with other people in it is handed over or deleted first');
    assert.equal((await frank.request('PUT', `/conversations/${study.data.id}/owner`, { userId: bob.id })).status, 200);
    assert.equal((await frank.request<{ code?: string }>('DELETE', '/auth/account')).data.code, 'owner', 'the project still blocks it');
    assert.equal((await frank.request('PUT', `/projects/${thesis.data.project.id}/owner`, { userId: bob.id })).status, 200);
    assert.equal((await frank.request('DELETE', '/auth/account')).status, 204);
    const deletedId = frank.id;

    assert.equal((await frank.request('GET', '/bootstrap')).status, 401, 'the session ended');
    assert.equal((await frank.login()).status, 401, 'nobody signs in to a deleted account');
    assert.equal((await frank.register()).status, 201, 'the name is free again, and so is the device');

    // Bob stays in the group and the project, which need new keys. Alice's direct chat is gone.
    const bobView = (await bob.request<BootstrapDTO>('GET', '/bootstrap')).data;
    const studyLeft = bobView.conversations.find((c) => c.id === study.data.id)!;
    assert.deepEqual(memberIdsOf(studyLeft), [bob.id]);
    assert.equal(studyLeft.needsNewKey, true);
    assert.equal(bobView.conversations.find((c) => c.id === thesis.data.channel.id)!.needsNewKey, true);
    assert.deepEqual(bobView.projects.find((p) => p.id === thesis.data.project.id)!.memberIds, [bob.id]);
    const { deleted, displayName, keys } = bobView.users.find((u) => u.id === deletedId)!;
    assert.deepEqual({ deleted, displayName, keys }, { deleted: true, displayName: 'Deleted account', keys: null });
    const addBack = await bob.request<{ error?: string }>('POST', `/conversations/${study.data.id}/members`, { userIds: [deletedId] });
    assert.equal(addBack.data.error, 'Person not found.', 'a deleted account cannot be added to a chat');
    assert.ok(!(await alice.request<BootstrapDTO>('GET', '/bootstrap')).data.conversations.some((c) => c.id === direct.data.id));
  });

  /** Encrypts a file as a page does and uploads the ciphertext to the address the server gives. */
  async function upload(client: Client, conversationId: number, plain: Uint8Array<ArrayBuffer>) {
    const sealed = await encryptFile(plain);
    const target = await client.request<UploadDTO & { error?: string }>('POST', `/conversations/${conversationId}/files`, {
      size: sealed.data.length,
    });
    assert.equal(target.status, 201, JSON.stringify(target.data));
    const put = await fetch(new URL(target.data.url, baseUrl), { method: 'PUT', body: sealed.data });
    assert.equal(put.status, 204);
    return { id: target.data.id, key: sealed.key, data: sealed.data };
  }
  /** Everything the file store holds, as one buffer to search. */
  const stored = () => Buffer.concat(fs.readdirSync(filesDir).map((f) => fs.readFileSync(path.join(filesDir, f))));
  const isStored = (id: string) => fs.existsSync(path.join(filesDir, id));
  const daysAgo = (days: number) => Date.now() - days * 24 * 3_600_000;

  test('a file reaches the store only as ciphertext, and only members get its address (R-005)', async () => {
    assert.equal((await alice.request<ConfigDTO>('GET', '/config')).data.files, true);
    const plain = new TextEncoder().encode('%PDF-1.7 Lab report, the answer is 7731');
    const outsider = await carol.request('POST', `/conversations/${directChat.id}/files`, { size: 100 });
    assert.equal(outsider.status, 404, 'someone outside the chat gets no upload address');
    const tooLarge = await alice.request('POST', `/conversations/${directChat.id}/files`, { size: LIMITS.fileBytes + 29 });
    assert.equal(tooLarge.status, 400);

    const file = await upload(alice, directChat.id, plain);
    const again = await fetch(new URL(`/api/files/${file.id}/data`, baseUrl), { method: 'PUT', body: file.data });
    assert.equal(again.status, 403, 'an unsigned address takes nothing');
    const content: MessageContent = {
      text: '📎 report.pdf, 39 bytes',
      file: { id: file.id, key: file.key, name: 'report.pdf', type: 'application/pdf', size: plain.length },
    };
    const sent = await alice.send(directChat.id, content);
    assert.equal(sent.status, 201, JSON.stringify(sent.data));

    const bobSync = await bob.sync(true);
    assert.ok(bobSync.changed);
    const message = bobSync.messages.find((m) => m.id === sent.data.id)!;
    assert.deepEqual((await bob.readContent(message, keysOf(alice))).file, content.file);
    assert.equal((await carol.request('GET', `/files/${file.id}`)).status, 404, 'someone outside the chat gets no download address');
    const address = await bob.request<{ url: string }>('GET', `/files/${file.id}`);
    assert.equal(address.status, 200);
    const download = await fetch(new URL(address.data.url, baseUrl));
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(await decryptFile(file.key, new Uint8Array(await download.arrayBuffer())), plain);

    const everything = Buffer.concat([stored(), Buffer.from(JSON.stringify(await instance.sql.query('SELECT * FROM webchat.files')))]);
    for (const secret of ['7731', 'report.pdf', file.key]) assert.ok(!everything.includes(secret), `the server never holds ${secret}`);
    assert.ok(!everything.includes(Buffer.from(file.key, 'base64url')), 'nor the raw key');
  });

  test("a photo's push stays under 3,000 bytes with its envelope, and holds no name, key or preview (D-017)", async () => {
    const tablet = makeSubscription(`http://${pushService.host}/bob-tablet`);
    assert.equal((await bob.request('POST', '/push/subscribe', tablet.json)).status, 204);
    await bob.sync(false);
    pushService.received.length = 0;
    await instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
    const photo = await upload(alice, directChat.id, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    const name = `${'n'.repeat(LIMITS.fileNameLength - 4)}.jpg`;
    const preview = `data:image/jpeg;base64,${'A'.repeat(LIMITS.previewLength - 23)}`;
    const file = { id: photo.id, key: photo.key, name, type: 'image/jpeg', size: 4, width: 1600, height: 1200, preview };
    assert.equal((await alice.send(directChat.id, { text: '📷 Photo', file })).status, 201);
    const pushed = (await waitForPushes(pushService.received, 10, 1000)).find((p) => p.path === '/bob-tablet')!;
    const serialized = JSON.stringify(tablet.decrypt(pushed.body));
    assert.ok(Buffer.byteLength(serialized) <= 3000, `this one is ${Buffer.byteLength(serialized)} bytes`);
    assert.notEqual(tablet.decrypt(pushed.body).envelope, null, 'the device can still show "📷 Photo"');
    for (const secret of [name, photo.key, 'AAAAAAAA']) assert.ok(!serialized.includes(secret));
    await bob.request('POST', '/push/unsubscribe', { endpoint: tablet.json.endpoint });
  });

  test('the server drops a file after 7 days, and an upload no message followed after an hour; the message stays', async () => {
    const old = await upload(alice, directChat.id, new TextEncoder().encode('old slides'));
    const sent = await alice.send(directChat.id, { text: '📎 slides.pdf', file: { id: old.id, key: old.key, name: 'slides.pdf', type: 'application/pdf', size: 10 } });
    const unsent = await upload(alice, directChat.id, new TextEncoder().encode('never sent'));
    await instance.sql.query('UPDATE webchat.files SET created_at = $1 WHERE id = $2', [daysAgo(7) - 60_000, old.id]);
    await instance.sql.query('UPDATE webchat.files SET created_at = $1 WHERE id = $2', [Date.now() - 3_600_001, unsent.id]);
    const expired = await bob.request<{ code?: string }>('GET', `/files/${old.id}`);
    assert.deepEqual([expired.status, expired.data.code], [410, 'expired']);
    assert.ok(isStored(old.id) && isStored(unsent.id), 'with no scheduler, nothing goes before the next upload address');

    await upload(alice, directChat.id, new TextEncoder().encode('new'));
    assert.ok(!isStored(old.id) && !isStored(unsent.id));
    const retry = await alice.send(directChat.id, { text: '📎 notes.txt', file: { id: unsent.id, key: unsent.key, name: 'notes.txt', type: 'text/plain', size: 10 } });
    assert.deepEqual([retry.status, retry.data.code], [409, 'file_gone'], 'a page that retries learns to upload again');
    const history = await bob.request<MessageDTO[]>('GET', `/conversations/${directChat.id}/messages`);
    assert.ok(history.data.some((m) => m.id === sent.data.id), 'the message stays');
  });

  test("uploads stop before the store's monthly or size limit (D-123)", async () => {
    const month = `uploads:${new Date().toISOString().slice(0, 7)}`;
    const before = (await instance.sql.query<{ value: string }>('SELECT value FROM webchat.meta WHERE key = $1', [month]))[0]!.value;
    await instance.sql.query('UPDATE webchat.meta SET value = $1 WHERE key = $2', [String(LIMITS.uploadsPerMonth), month]);
    const monthly = await alice.request<{ code?: string }>('POST', `/conversations/${directChat.id}/files`, { size: 100 });
    assert.deepEqual([monthly.status, monthly.data.code], [429, 'upload_limit']);
    await instance.sql.query('UPDATE webchat.meta SET value = $1 WHERE key = $2', [before, month]);

    await instance.sql.query('INSERT INTO webchat.files (id, conversation_id, uploader_id, size, created_at, sent) VALUES ($1, $2, $3, $4, $5, true)', [
      'f'.repeat(22),
      directChat.id,
      alice.id,
      LIMITS.storedBytes - 99,
      Date.now(),
    ]);
    const full = await alice.request<{ code?: string }>('POST', `/conversations/${directChat.id}/files`, { size: 100 });
    assert.deepEqual([full.status, full.data.code], [507, 'storage_full']);
    await instance.sql.query('DELETE FROM webchat.files WHERE id = $1', ['f'.repeat(22)]);
  });

  test("deleting a chat or an account deletes its files' ciphertext", async () => {
    const gina = new Client(baseUrl, 'gina');
    assert.equal((await gina.register()).status, 201);
    const members = [gina, alice].map((c) => ({ id: c.id, keys: keysOf(c) }));
    const group = await gina.request<ConversationDTO>('POST', '/conversations/group', { title: 'Poster', memberIds: [alice.id], key: await gina.newChatKey(members) });
    const direct = await gina.request<ConversationDTO>('POST', '/conversations/direct', { userId: alice.id, key: await gina.newChatKey(members) });
    const files: string[] = [];
    for (const chat of [group.data, direct.data]) {
      await gina.openChatKey((await gina.bootstrap()).conversations.find((c) => c.id === chat.id)!, keysOf(gina));
      const file = await upload(gina, chat.id, new TextEncoder().encode('poster draft'));
      const sent = await gina.send(chat.id, { text: '📎 poster.png', file: { id: file.id, key: file.key, name: 'poster.png', type: 'image/png', size: 12 } });
      assert.equal(sent.status, 201, JSON.stringify(sent.data));
      files.push(file.id);
    }
    assert.equal((await gina.request('DELETE', `/conversations/${group.data.id}`)).status, 204);
    await waitFor(() => !isStored(files[0]!));
    assert.ok(isStored(files[1]!));
    assert.equal((await gina.request('DELETE', '/auth/account')).status, 204);
    await waitFor(() => !isStored(files[1]!));
  });

  test('a server with no file store says so and gives no upload address', async () => {
    const plain = await createApp({ ...config, filesDir: undefined });
    const app = http.createServer(plain.app);
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
      const dora = new Client(url, 'dora');
      assert.equal((await dora.request<ConfigDTO>('GET', '/config')).data.files, false);
      assert.equal((await dora.register()).status, 201);
      const refused = await dora.request<{ code?: string }>('POST', '/conversations/1/files', { size: 100 });
      assert.deepEqual([refused.status, refused.data.code], [404, 'files_off']);
    } finally {
      await new Promise<void>((resolve) => app.close(() => resolve()));
      await plain.close();
    }
  });

  test('logout ends the session', async () => {
    assert.equal((await carol.request('POST', '/auth/logout')).status, 204);
    assert.equal((await carol.request('GET', '/bootstrap')).status, 401);
  });
});
