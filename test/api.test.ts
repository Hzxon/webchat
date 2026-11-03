import assert from 'node:assert/strict';
import { afterEach, before, describe, test } from 'node:test';
import { keyedQueue } from '../client/src/queue.ts';

// The client module opens a BroadcastChannel when it loads. Node has that global too, and an open
// channel would keep this process alive after the tests, so take it away before the module loads.
delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module. tsx still loads it.
const clientApi = '../client/src/api.ts';

type Answer = { status: number; body: string | null };

describe('The request helper in client/src/api.ts', () => {
  let api: {
    sync: (input: unknown) => Promise<unknown>;
    logout: () => Promise<void>;
    sendMessage: (conversationId: number, input: unknown) => Promise<unknown>;
  };
  let ApiError: new (...args: never[]) => Error & { status: number };
  const originalFetch = globalThis.fetch;

  before(async () => {
    const mod = await import(clientApi);
    api = mod.api;
    ApiError = mod.ApiError;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function answerWith({ status, body }: Answer) {
    globalThis.fetch = async () => new Response(body, { status });
  }

  test('a 2xx whose body breaks off is an error, not an empty success (K-7)', async () => {
    answerWith({ status: 200, body: '{"changed":true,"stamp":"a","cursor":12' });
    await assert.rejects(api.sync({ cursor: 12 }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 200);
      assert.equal(error.message, 'The server answer broke off. Try again.');
      return true;
    });
  });

  test('a whole 2xx body is returned as is', async () => {
    answerWith({ status: 200, body: '{"changed":false,"stamp":"a","cursor":12}' });
    assert.deepEqual(await api.sync({ cursor: 12 }), { changed: false, stamp: 'a', cursor: 12 });
  });

  test('a failed answer with a broken body still reports its status', async () => {
    answerWith({ status: 500, body: '<html>Bad gateway' });
    await assert.rejects(api.sync({ cursor: 12 }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 500);
      assert.equal(error.message, 'Request failed (500).');
      return true;
    });
  });

  test('a 204 has no body and resolves to nothing', async () => {
    answerWith({ status: 204, body: null });
    assert.equal(await api.logout(), undefined);
  });

  test('a send that never gets an answer fails after a minute, and the next send in its chat goes out (K-32)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Like a connection that drops without a reset: no answer comes, and only an abort ends the request.
    globalThis.fetch = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const enqueue = keyedQueue();
    const stuck = enqueue(1, () => api.sendMessage(1, {}));
    const next = enqueue(1, async () => 'next');
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    await turn();
    t.mock.timers.tick(60_000);
    await turn();
    const result = await Promise.race([Promise.allSettled([stuck, next]), turn().then(() => 'still waiting')]);
    assert.notEqual(result, 'still waiting');
    await assert.rejects(stuck, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 0);
      return true;
    });
    assert.equal(await next, 'next');
  });
});
