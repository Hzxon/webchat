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

  test('a card draft stays a message of its own, and only the owner notes it was added (D-104)', () => {
    const prompt = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'p1');
    const answer = { ...say(AGENT, { kind: 'answer', to: 'p1' }), text: 'Here it is.' };
    const draft = { ...say(AGENT, { kind: 'answer', to: 'p1', card: { kind: 'K', title: 'Bug', body: 'Seen: here.' } }, 'd1'), text: 'Card draft: Bug' };
    const theirs = { ...say(AGENT, {}), prompt: null, added: { to: 'p1', draft: 'd1', card: 'K-9' } };
    const mine = { ...say(ME, {}), prompt: null, added: { to: 'p1', draft: 'd1', card: 'K-3' } };
    const [thread] = threadsOf([prompt, answer, draft, theirs, mine], ME, AGENT, {}, 100);
    assert.deepEqual(thread.messages, [prompt, answer, draft]);
    assert.deepEqual(thread.added, { d1: 'K-3' });
  });

  test("a card's run makes a conversation of its own, whose state follows the agent's reports (D-105)", () => {
    const sayRun = (senderId: number, run: object, createdAt = ++id) => ({ ...say(senderId, {}, `r${id}`, createdAt), prompt: null, run });
    const request = sayRun(ME, { kind: 'request', card: 'K-7', title: 'Sums', docId: 'd', section: 's', runtime: AGENT, repo: 'team/app', sentAt: 1, hash: 'h' });
    const state = (...rest: object[]) => threadsOf([request, ...rest], ME, AGENT, {}, 100)[0];
    assert.deepEqual([state().kind, state().state, state().repo, state().request], ['card', 'working', 'team/app', request.id]);
    const claimed = sayRun(AGENT, { kind: 'claimed', request: request.id });
    const done = sayRun(AGENT, { kind: 'done', request: request.id, pull: { repo: 'team/app', number: 4 } });
    const review = sayRun(AGENT, { kind: 'review', request: request.id, note: 'Bob asked for changes' });
    const go = sayRun(ME, { kind: 'fix', request: request.id, sentAt: 2 });
    const ended = sayRun(AGENT, { kind: 'ended', request: request.id, note: 'it was merged' });
    assert.equal(state(claimed, done).state, 'draft');
    assert.equal(state(claimed, done, review).state, 'waiting');
    assert.equal(state(claimed, done, review, go).state, 'working');
    assert.equal(state(claimed, done, ended).state, 'done');
    assert.equal(state(claimed, sayRun(AGENT, { kind: 'failed', request: request.id })).state, 'unfinished');
    // Only the agent reports, and a card's conversation does not end after a day.
    assert.equal(state(sayRun(ME, { kind: 'done', request: request.id })).state, 'working');
    assert.equal(threadsOf([request], ME, AGENT, {}, 1 + THREAD_TTL_MS + 1)[0].state, 'working');
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
