import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module. tsx still loads it.
const clientBuild = '../client/src/build.ts';

const page = (bundle: string) => `<head><script type="module" src="/assets/index-${bundle}.js"></script></head>`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// The module keeps the build it saw across calls, as a tab does, so the tests run in order.
describe('The reload after a deploy in client/src/build.ts (D-040)', () => {
  let noteBuild: (response: Response) => void;
  /** The page the server hands out now. Null answers 502. */
  let served: string | null = page('A');
  const reloads: string[] = [];
  const respond = (build: string) => noteBuild(new Response(null, { headers: { 'x-webchat-build': build } }));

  before(async () => {
    // A hidden tab reloads at once, so a reload shows up without waiting 30 seconds.
    Object.assign(globalThis, {
      fetch: async () => new Response(served, { status: served === null ? 502 : 200 }),
      document: { head: { innerHTML: page('A') }, visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} },
      window: { addEventListener() {}, removeEventListener() {} },
      location: { replace: (url: string) => reloads.push(url) },
    });
    ({ noteBuild } = await import(clientBuild));
  });

  test('a deploy that leaves the page as it is does not reload the tab (K-36)', async () => {
    respond('deploy-1');
    respond('deploy-2');
    await settle();
    assert.deepEqual(reloads, []);
  });

  test('a page that fails to load leaves the reload for the next answer', async () => {
    served = null;
    respond('deploy-3');
    await settle();
    assert.deepEqual(reloads, []);
  });

  test('a deploy with new bundle files reloads the tab once', async () => {
    served = page('B');
    respond('deploy-3');
    respond('deploy-3');
    await settle();
    respond('deploy-4');
    await settle();
    assert.deepEqual(reloads, ['/']);
  });
});
