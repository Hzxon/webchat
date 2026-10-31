import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import ece from 'http_ece';
import { createApp, type WebChatApp } from '../server/app.ts';
import type { Config } from '../server/config.ts';
import type {
  BootstrapDTO,
  ConversationDTO,
  MessageDTO,
  PushPayload,
  SyncRequest,
  SyncResponse,
} from '../shared/types.ts';

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

class Client {
  cookie = '';
  cursor = 0;
  stamp = '';
  readonly tabId = crypto.randomUUID();
  constructor(private baseUrl: string) {}

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

  async send(conversationId: number, body: string, urgent = false) {
    return this.request<MessageDTO>('POST', `/conversations/${conversationId}/messages`, {
      body,
      urgent,
      clientId: crypto.randomUUID(),
    });
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
  let bobId: number;
  let directChat: ConversationDTO;

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
      logger: silent,
    };
    instance = await createApp(config);
    server = http.createServer(instance.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    alice = new Client(baseUrl);
    bob = new Client(baseUrl);
    carol = new Client(baseUrl);
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await instance?.close();
    await pushService?.close();
  });

  test('registration needs the invite code', async () => {
    const wrong = await alice.request('POST', '/auth/register', {
      username: 'alice',
      displayName: 'Alice',
      password: 'correct horse',
      inviteCode: 'guess',
    });
    assert.equal(wrong.status, 403);

    for (const [client, username] of [
      [alice, 'alice'],
      [bob, 'bob'],
      [carol, 'carol'],
    ] as const) {
      const res = await client.request<{ id: number }>('POST', '/auth/register', {
        username,
        displayName: username[0]!.toUpperCase() + username.slice(1),
        password: 'correct horse',
        inviteCode: 'friends-only',
      });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      if (username === 'bob') bobId = res.data.id;
    }
    const taken = await new Client(baseUrl).request('POST', '/auth/register', {
      username: 'BOB',
      displayName: 'Other Bob',
      password: 'correct horse',
      inviteCode: 'friends-only',
    });
    assert.equal(taken.status, 409, 'usernames are unique regardless of case');
  });

  test('login rejects a wrong password and accepts the right one', async () => {
    const probe = new Client(baseUrl);
    assert.equal((await probe.request('POST', '/auth/login', { username: 'bob', password: 'nope-nope' })).status, 401);
    assert.equal((await probe.request('POST', '/auth/login', { username: 'Bob', password: 'correct horse' })).status, 200);
  });

  test('requests without a session are refused', async () => {
    const stranger = new Client(baseUrl);
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

  test('a message reaches the other person on their next sync, and the sender sees "delivered"', async () => {
    const created = await alice.request<ConversationDTO>('POST', '/conversations/direct', { userId: bobId });
    assert.equal(created.status, 200);
    directChat = created.data;
    await alice.bootstrap();

    const sent = await alice.send(directChat.id, 'Are you free to call?');
    assert.equal(sent.status, 201);

    const bobSync = await bob.sync(true);
    assert.ok(bobSync.changed);
    assert.deepEqual(
      bobSync.messages.map((m) => m.body),
      ['Are you free to call?'],
    );
    assert.equal(bobSync.conversations.find((c) => c.id === directChat.id)?.unread, 1);

    const aliceSync = await alice.sync(true);
    assert.ok(aliceSync.changed);
    const bobState = aliceSync.conversations.find((c) => c.id === directChat.id)!.members.find((m) => m.userId === bobId)!;
    assert.equal(bobState.lastDeliveredId, sent.data.id);
    assert.equal(bobState.lastReadId, 0);
  });

  test('reading a chat moves the read pointer and clears unread', async () => {
    const chat = (await bob.bootstrap()).conversations.find((c) => c.id === directChat.id)!;
    const read = await bob.request('POST', `/conversations/${chat.id}/read`, { messageId: chat.lastMessage!.id });
    assert.equal(read.status, 204);
    const aliceSync = await alice.sync(true);
    assert.ok(aliceSync.changed);
    const bobState = aliceSync.conversations.find((c) => c.id === directChat.id)!.members.find((m) => m.userId === bobId)!;
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
    assert.equal(laptop.decrypt(push!.body).body, 'You there?');
  });

  test('while looking at a tab without push, no push is sent at all', async () => {
    await bob.sync(true, null);
    pushService.received.length = 0;
    await alice.send(directChat.id, 'Still there?');
    await sleep(300);
    assert.equal(pushService.received.length, 0);
  });

  test('once the recipient looks away, every device gets the push, encrypted for that browser', async () => {
    const phone = makeSubscription(`http://${pushService.host}/bob-phone-2`);
    assert.equal((await bob.request('POST', '/push/subscribe', phone.json)).status, 204);
    await bob.sync(false);

    pushService.received.length = 0;
    await alice.send(directChat.id, 'Call me back, it is urgent', true);
    const pushes = await waitForPushes(pushService.received, 3);
    assert.deepEqual(pushes.map((p) => p.path).sort(), ['/bob-laptop', '/bob-phone', '/bob-phone-2']);

    const phonePush = pushes.find((p) => p.path === '/bob-phone-2')!;
    assert.equal(phonePush.headers['urgency'], 'high');
    assert.equal(phonePush.headers['content-encoding'], 'aes128gcm');
    assert.match(String(phonePush.headers['authorization']), /^vapid t=/);
    const payload = phone.decrypt(phonePush.body);
    assert.equal(payload.title, 'URGENT from Alice');
    assert.equal(payload.body, 'Call me back, it is urgent');
    assert.equal(payload.urgent, true);
    assert.equal(payload.conversationId, directChat.id);
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
    const bobState = aliceSync.conversations.find((c) => c.id === directChat.id)!.members.find((m) => m.userId === bobId)!;
    assert.equal(bobState.lastDeliveredId, latest.id);
  });

  test('group messages reach every member', async () => {
    const carolId = (await carol.bootstrap()).me.id;
    const group = await alice.request<ConversationDTO>('POST', '/conversations/group', {
      title: 'Weekend',
      memberIds: [bobId, carolId],
    });
    assert.equal(group.status, 201);
    await alice.send(group.data.id, 'Dinner at 7?');

    for (const client of [bob, carol]) {
      const res = await client.sync(true);
      assert.ok(res.changed);
      assert.equal(res.conversations.find((c) => c.id === group.data.id)?.title, 'Weekend');
      assert.ok(res.messages.some((m) => m.body === 'Dinner at 7?'));
    }
  });

  test('people outside a chat cannot read or post in it', async () => {
    assert.equal((await carol.request('GET', `/conversations/${directChat.id}/messages`)).status, 404);
    assert.equal((await carol.send(directChat.id, 'sneaky')).status, 404);
    assert.equal(
      (await carol.request('POST', '/delivered', { conversationId: directChat.id, messageId: 1 })).status,
      404,
    );
  });

  test('message history pages backwards', async () => {
    const page = await alice.request<MessageDTO[]>('GET', `/conversations/${directChat.id}/messages`);
    assert.equal(page.status, 200);
    assert.deepEqual(
      page.data.map((m) => m.body),
      ['Are you free to call?', 'You there?', 'Still there?', 'Call me back, it is urgent', 'Ping after you left'],
    );
    const older = await alice.request<MessageDTO[]>(
      'GET',
      `/conversations/${directChat.id}/messages?before=${page.data[2]!.id}`,
    );
    assert.deepEqual(
      older.data.map((m) => m.body),
      ['Are you free to call?', 'You there?'],
    );
  });

  test('logout ends the session', async () => {
    assert.equal((await carol.request('POST', '/auth/logout')).status, 204);
    assert.equal((await carol.request('GET', '/bootstrap')).status, 401);
  });
});
