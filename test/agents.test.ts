import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// In a variable, so the tools tsconfig, which has no DOM types, does not typecheck the client module.
const clientAgents = '../client/src/agents.ts';
const { agentOf, threadsOf, THREAD_TTL_MS } = await import(clientAgents);

const ME = 1;
const AGENT = 2;
let id = 0;
const say = (senderId: number, prompt: object, clientId = `c${++id}`, createdAt = id) => ({
  id,
  conversationId: 9,
  senderId,
  clientId,
  createdAt,
  security: 'encrypted',
  text: '',
  prompt,
});

describe('Conversations with an agent in client/src/agents.ts (D-102, D-103)', () => {
  test('a prompt and what names it make one conversation, whose state follows the newest turn', () => {
    const prompt = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'p1');
    const answer = say(AGENT, { kind: 'answer', to: 'p1' });
    const [thread] = threadsOf([prompt, answer], ME, AGENT, {}, 100);
    assert.equal(thread.root, 'p1');
    assert.equal(thread.repo, 'team/app');
    assert.deepEqual(thread.messages, [prompt, answer]);
    assert.equal(thread.state, 'answered');
    const reply = say(ME, { kind: 'reply', to: 'p1', sentAt: 2 });
    assert.equal(threadsOf([prompt, answer, reply], ME, AGENT, {}, 100)[0].state, 'working');
    const cancel = say(ME, { kind: 'cancel', to: 'p1', sentAt: 3 });
    assert.equal(threadsOf([prompt, answer, reply, cancel], ME, AGENT, {}, 100)[0].state, 'working', 'until the agent says it stopped');
    const stopped = say(AGENT, { kind: 'failed', to: 'p1' });
    assert.equal(threadsOf([prompt, answer, reply, cancel, stopped], ME, AGENT, {}, 100)[0].state, 'failed');
  });

  test("a long answer's parts show as one message, which keeps the first part's id", () => {
    const prompt = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'p1');
    const one = { ...say(AGENT, { kind: 'answer', to: 'p1' }), text: 'Line one\n' };
    const two = { ...say(AGENT, { kind: 'answer', to: 'p1' }), text: 'line two' };
    const [thread] = threadsOf([prompt, one, two], ME, AGENT, {}, 100);
    assert.equal(thread.messages.length, 2);
    assert.deepEqual([thread.messages[1].id, thread.messages[1].text], [one.id, 'Line one\nline two']);
  });

  test('a prompt or reply that did not send leaves the conversation Not sent, not Working', () => {
    const prompt = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'p1');
    assert.equal(threadsOf([prompt], ME, AGENT, { p1: 'failed' }, 100)[0].state, 'unsent');
    assert.equal(threadsOf([prompt], ME, AGENT, { p1: 'sending' }, 100)[0].state, 'working');
    const answer = say(AGENT, { kind: 'answer', to: 'p1' });
    const reply = say(ME, { kind: 'reply', to: 'p1', sentAt: 2 }, 'r1');
    assert.equal(threadsOf([prompt, answer, reply], ME, AGENT, { r1: 'failed' }, 100)[0].state, 'unsent');
  });

  test('only the owner starts or replies, only the agent answers, and only signed messages count', () => {
    const prompt = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'p1');
    const fake = say(ME, { kind: 'answer', to: 'p1' });
    const theirs = say(AGENT, { kind: 'reply', to: 'p1', sentAt: 2 });
    const unsigned = { ...say(AGENT, { kind: 'answer', to: 'p1' }), security: 'failed' };
    const elsewhere = say(AGENT, { kind: 'answer', to: 'p0' });
    const agentPrompt = say(AGENT, { kind: 'prompt', repo: 'team/app', sentAt: 3 });
    const plain = { ...say(ME, {}), prompt: null };
    const threads = threadsOf([prompt, fake, theirs, unsigned, elsewhere, agentPrompt, plain], ME, AGENT, {}, 100);
    assert.equal(threads.length, 1);
    assert.deepEqual(threads[0].messages, [prompt]);
    assert.equal(threads[0].state, 'working');
  });

  test('conversations come newest first, and one left for a day has ended', () => {
    const old = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'old', 1_000);
    const fresh = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 2 }, 'fresh', 5_000);
    const late = say(AGENT, { kind: 'answer', to: 'old' }, 'a', 9_000);
    assert.deepEqual(threadsOf([old, fresh, late], ME, AGENT, {}, 10_000).map((t: { root: string }) => t.root), ['old', 'fresh']);
    const [, ended] = threadsOf([old, fresh], ME, AGENT, {}, 1_000 + THREAD_TTL_MS + 1);
    assert.deepEqual([ended.root, ended.state], ['old', 'ended']);
  });

  test('a chat is an agent chat only when it is direct, with an agent of this user', () => {
    const users = { 2: { id: 2, agentOwner: 1, deleted: false }, 3: { id: 3, agentOwner: 4, deleted: false }, 5: { id: 5, agentOwner: 1, deleted: true } };
    const state = { users, me: { id: 1 } };
    const direct = (other: number) => ({ type: 'direct', members: [{ userId: 1 }, { userId: other }] });
    assert.equal(agentOf(state, direct(2))?.id, 2);
    assert.equal(agentOf(state, direct(3)), undefined, "someone else's agent");
    assert.equal(agentOf(state, direct(5)), undefined, 'a removed agent');
    assert.equal(agentOf(state, { type: 'group', members: [{ userId: 1 }, { userId: 2 }] }), undefined);
  });
});
