import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module. tsx still loads it.
const clientStore = '../client/src/store.ts';

const { actions, localEditCount, reloadPath, store } = await import(clientStore);
const chat = (id: number) => ({ id, projectId: null });
const project = (id: number) => ({ id, memberIds: [] });

describe('A check-in answer in client/src/store.ts, against changes this page made (K-15, D-069)', () => {
  beforeEach(() => actions.reset());

  test('an answer requested before the page added a chat is ignored, so the chat stays', () => {
    const since = localEditCount();
    actions.upsertConversation(chat(7));
    assert.equal(actions.applySync([], [], [], [], [], since), false);
    assert.ok(store.get().conversations[7]);
  });

  test('an answer requested after it applies, and drops a chat it no longer lists', () => {
    actions.upsertConversation(chat(7));
    assert.equal(actions.applySync([], [], [], [], [], localEditCount()), true);
    assert.equal(store.get().conversations[7], undefined);
  });

  test('an answer requested before the page left a chat or changed a project is ignored too', () => {
    actions.upsertConversation(chat(7));
    let since = localEditCount();
    actions.dropConversation(7);
    assert.equal(actions.applySync([], [], [chat(7)], [], [], since), false);
    assert.equal(store.get().conversations[7], undefined);
    since = localEditCount();
    actions.upsertProject(project(3));
    assert.equal(actions.applySync([], [], [], [], [], since), false);
    assert.ok(store.get().projects[3]);
  });
});

describe('The address a reload after a deploy opens, in client/src/store.ts (D-040, K-60)', () => {
  beforeEach(() => actions.reset());

  test('names the board that is open, and the page itself once it closes', () => {
    actions.setBoardOpen(3);
    assert.equal(reloadPath(store.get()), '/?board=3');
    actions.setBoardOpen(null);
    assert.equal(reloadPath(store.get()), '/');
  });
});

describe('The sidebar tab, in client/src/store.ts (K-62)', () => {
  beforeEach(() => actions.reset());

  test('turns to Projects when a board or doc opens, as at a reload, so its row shows', () => {
    actions.setBoardOpen(3);
    assert.equal(store.get().tab, 'projects');
    actions.setTab('chats');
    actions.setDocOpen('d1');
    assert.equal(store.get().tab, 'projects');
  });
});

describe('The board a request opens, in client/src/store.ts', () => {
  beforeEach(() => actions.reset());

  test('opens a board on the card a request names, and the next board on none (the card-notes decision)', () => {
    actions.setBoardOpen(3, 's1');
    assert.deepEqual([store.get().boardOpen, store.get().boardCard], [3, 's1']);
    actions.setBoardOpen(4);
    assert.deepEqual([store.get().boardOpen, store.get().boardCard], [4, null]);
  });
});
