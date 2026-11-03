import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { PushPayload, WorkerToPageMessage } from '../shared/types.ts';

// The service worker runs in the browser. This stands in for the little of its global scope that
// its handlers use: the registration and its notifications, the open pages and fetch.
type Listener = (event: unknown) => void;
const listeners = new Map<string, Listener>();
const NEW_ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/new';
const pages = [0, 1].map(() => ({ received: [] as WorkerToPageMessage[] }));
const posts: { url: string; body: unknown }[] = [];
const notifications: { tag: string; closed: boolean; close(): void }[] = [];

Object.assign(globalThis, {
  self: {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    clients: {
      matchAll: async () => pages.map((page) => ({ postMessage: (m: WorkerToPageMessage) => page.received.push(m) })),
    },
    registration: {
      pushManager: {
        subscribe: async () => ({
          endpoint: NEW_ENDPOINT,
          toJSON: () => ({ endpoint: NEW_ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
        }),
      },
      getNotifications: async ({ tag }: { tag: string }) => notifications.filter((n) => n.tag === tag && !n.closed),
      showNotification: async (_title: string, { tag }: { tag: string }) => {
        notifications.push({ tag, closed: false, close() { this.closed = true; } });
      },
    },
  },
  fetch: async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(init.body as string) });
    return new Response(url === '/api/config' ? JSON.stringify({ vapidPublicKey: 'AQAB' }) : null);
  },
});

// The path lives in a variable so the tools tsconfig, which has no service worker types, does not
// typecheck the worker. tsx still loads it.
const worker = '../client/src/sw.ts';

describe('The service worker in client/src/sw.ts', () => {
  before(async () => {
    await import(worker);
  });

  test('tells every open page when the browser replaces the push subscription (K-17)', async () => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get('pushsubscriptionchange')!({ oldSubscription: null, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    for (const page of pages) assert.deepEqual(page.received, [{ type: 'subscription-changed' }]);
    assert.deepEqual(posts.map((p) => p.url), ['/api/push/subscribe']);
  });

  test('deletes the endpoint the browser replaced, so pushes stop going to it (K-33)', async () => {
    posts.length = 0;
    let done: Promise<unknown> = Promise.resolve();
    const oldSubscription = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/old' };
    listeners.get('pushsubscriptionchange')!({ oldSubscription, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    assert.deepEqual(posts, [
      { url: '/api/push/unsubscribe', body: { endpoint: oldSubscription.endpoint } },
      { url: '/api/push/subscribe', body: { endpoint: NEW_ENDPOINT, keys: { p256dh: 'p', auth: 'a' } } },
    ]);
  });

  test('closes the last ring of an urgent message before it shows the next, so every browser sounds (D-079)', async () => {
    const payload: PushPayload = {
      kind: 'message',
      title: 'URGENT from Alice',
      body: '',
      bodyPrefix: '',
      urgent: true,
      tag: 'urgent-7',
      conversationId: 1,
      messageId: 7,
      senderId: 2,
      clientId: 'c',
      envelope: null,
      unreadTotal: null,
      sentAt: 0,
      url: null,
    };
    for (let ring = 0; ring < 2; ring++) {
      let done: Promise<unknown> = Promise.resolve();
      listeners.get('push')!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => (done = p) });
      await done;
    }
    assert.deepEqual(
      notifications.map((n) => [n.tag, n.closed]),
      [
        ['urgent-7', true],
        ['urgent-7', false],
      ],
    );
  });
});
