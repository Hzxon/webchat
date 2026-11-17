import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module. tsx still loads it.
const clientRoute = '../client/src/route.ts';

const { formatRoute, parseRoute, routeOf } = await import(clientRoute);

const closed = { githubOpen: false, agentsOpen: false, agentThread: null, docOpen: null, boardOpen: null, activeId: null };

describe('The address hash in client/src/route.ts', () => {
  test('every view survives a round trip through the hash', () => {
    for (const route of [
      { kind: 'chat', id: 12 },
      { kind: 'board', id: 3 },
      { kind: 'doc', id: 'a1/b c' },
      { kind: 'agents', thread: null },
      { kind: 'agents', thread: 'x y' },
      { kind: 'github' },
    ]) {
      assert.deepEqual(parseRoute(formatRoute(route)), route);
    }
  });

  test('the landing pane has no hash, and an empty hash names it', () => {
    assert.equal(formatRoute(null), '');
    assert.equal(parseRoute(''), null);
    assert.equal(parseRoute('#'), null);
  });

  test('a hash that names nothing the page knows is the landing pane, not an error', () => {
    for (const hash of ['#/chat/abc', '#/chat/0', '#/chat/-1', '#/chat/1.5', '#/chat', '#/chat/1/2', '#/doc', '#/github/x', '#/nope', '#/doc/%E0%A4%A']) {
      assert.equal(parseRoute(hash), null, hash);
    }
  });

  test('the view the page shows follows the pane order ChatLayout uses', () => {
    assert.equal(routeOf(closed), null);
    assert.deepEqual(routeOf({ ...closed, activeId: 7 }), { kind: 'chat', id: 7 });
    assert.deepEqual(routeOf({ ...closed, activeId: 7, boardOpen: 2 }), { kind: 'board', id: 2 });
    assert.deepEqual(routeOf({ ...closed, boardOpen: 2, docOpen: 'd' }), { kind: 'doc', id: 'd' });
    assert.deepEqual(routeOf({ ...closed, docOpen: 'd', agentsOpen: true, agentThread: 't' }), { kind: 'agents', thread: 't' });
    assert.deepEqual(routeOf({ ...closed, agentsOpen: true, githubOpen: true }), { kind: 'github' });
  });
});
