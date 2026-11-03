import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import type { WorkerToPageMessage } from '../shared/types.ts';

// The service worker runs in the browser. This stands in for the little of its global scope that
// the pushsubscriptionchange handler uses: the registration, the open pages and fetch.
type Listener = (event: unknown) => void;
const listeners = new Map<string, Listener>();
const NEW_ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/new';
const pages = [0, 1].map(() => ({ received: [] as WorkerToPageMessage[] }));
const posts: { url: string; body: unknown }[] = [];

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
});
