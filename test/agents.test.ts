import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ASK_WAIT_MS, harnessRow, type HarnessState } from '../shared/types.ts';

// In a variable, so the tools tsconfig, which has no DOM types, does not typecheck the client module.
const clientAgents = '../client/src/agents.ts';
const { agentOf, proposalsWaiting, seatFor, threadCard, threadsOf, THREAD_TTL_MS, waitingProposals } = await import(clientAgents);

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

  test("a session's steps are no message of the thread and move nothing, and only its agent's count (R-072)", () => {
    const prompt = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'p2', 1);
    const step = { kind: 'command', title: 'npm test', at: 5 };
    const steps = say(AGENT, { kind: 'events', to: 'p2', events: [step] }, 'e1', 50);
    const forged = say(ME, { kind: 'events', to: 'p2', events: [step] }, 'e2', 60);
    const [thread] = threadsOf([prompt, steps, forged], ME, AGENT, {}, 100);
    assert.deepEqual(thread.messages, [prompt]);
    assert.deepEqual(thread.steps, [{ id: steps.id, at: 50, events: [step] }]);
    assert.equal(thread.last, 1, 'a step does not move the thread up the list');
    assert.equal(thread.state, 'working');
    // What the session runs with: the newest of each part, from its own agent's batches.
    const about = say(AGENT, { kind: 'events', to: 'p2', events: [], about: { model: 'm', context: 5 } }, 'e3', 70);
    const later = say(AGENT, { kind: 'events', to: 'p2', events: [], about: { context: 9 } }, 'e4', 80);
    assert.deepEqual(threadsOf([prompt, about, later], ME, AGENT, {}, 100)[0].about, { model: 'm', context: 9 });
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

  test('the Coding agents row counts the proposals in every project whose draft the owner has not added (R-045)', () => {
    const proposal = (clientId: string, project: number) => ({ ...say(AGENT, {}, clientId), prompt: null, board: { kind: 'proposal', project, repo: 'team/app', card: { kind: 'K', title: clientId, body: '' } } });
    const added = { ...say(ME, {}), prompt: null, added: { to: 'x1', draft: 'x1', card: 'K-4' } };
    const theirs = { ...say(AGENT, {}), prompt: null, added: { to: 'x2', draft: 'x2', card: 'K-5' } };
    const prompt = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'p1');
    const count = (...messages: object[]) => proposalsWaiting(threadsOf(messages, ME, AGENT, {}, 100));
    assert.equal(count(prompt), 0);
    assert.equal(count(prompt, proposal('x1', 4), proposal('x2', 5)), 2);
    assert.equal(count(proposal('x1', 4), proposal('x2', 5), added, theirs), 1, "only the owner's note ends the wait");
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
    // A progress line is a note under Working…, not a message; a stop before the work is done pauses the run (docs/decisions/stop-pauses-run.md).
    const progress = sayRun(AGENT, { kind: 'progress', request: request.id, note: 'Run the tests' });
    assert.deepEqual([state(claimed, progress).state, state(claimed, progress).progress, state(claimed, progress).messages.length], ['working', 'Run the tests', 2]);
    assert.equal(state(claimed, progress, sayRun(AGENT, { kind: 'paused', request: request.id })).progress, undefined);
    assert.equal(state(claimed, sayRun(AGENT, { kind: 'paused', request: request.id })).state, 'paused');
    // A screenshot is a message in the thread that changes no state (R-046).
    const shot = sayRun(AGENT, { kind: 'note', request: request.id });
    assert.deepEqual([state(claimed, shot).state, state(claimed, done, shot).state, state(claimed, done, shot).messages.at(-1)], ['working', 'draft', shot]);
    // A plan waits for the owner's go (docs/decisions/redirect-plan-gate.md).
    assert.equal(state(claimed, sayRun(AGENT, { kind: 'planned', request: request.id, note: 'Fix sum.js.' })).state, 'planned');
    // A round that failed on a draft leaves the draft, and a go that did not send starts nothing.
    assert.equal(state(claimed, done, sayRun(AGENT, { kind: 'failed', request: request.id })).state, 'draft');
    const unsentGo = sayRun(ME, { kind: 'fix', request: request.id, sentAt: 3 });
    assert.equal(threadsOf([request, claimed, done, unsentGo], ME, AGENT, { [unsentGo.clientId]: 'failed' }, 100)[0].state, 'unsent');
    // Only the agent reports, and a card's conversation does not end after a day.
    assert.equal(state(sayRun(ME, { kind: 'done', request: request.id })).state, 'working');
    assert.equal(threadsOf([request], ME, AGENT, {}, 1 + THREAD_TTL_MS + 1)[0].state, 'working');
  });

  test("a card's run names its card on its board, and a question names none (the card-run-in-peek decision)", () => {
    const request = { ...say(ME, {}, 'r0'), prompt: null, run: { kind: 'request', card: 'K-7', title: 'Sums', docId: 'd', section: 's', runtime: AGENT, repo: 'team/app', sentAt: 1, hash: 'h' } };
    const [run] = threadsOf([request], ME, AGENT, {}, 100);
    const [asked] = threadsOf([say(ME, { kind: 'prompt', sentAt: 1, project: 4 }, 'q0')], ME, AGENT, {}, 100);
    const docs = { d: { conversationId: 3 } };
    const conversations = { 3: { projectId: 4 } };
    assert.deepEqual(threadCard(run, docs, conversations), { projectId: 4, section: 's' });
    assert.equal(threadCard(run, {}, conversations), undefined, 'a board the page does not hold');
    assert.equal(threadCard(asked, docs, conversations), undefined);
  });

  test('a run or a question waits for the owner while the laptop has no copy, and works once they have it cloned (R-036)', () => {
    const sayRun = (senderId: number, run: object) => ({ ...say(senderId, {}, `r${++id}`), prompt: null, run });
    const request = sayRun(ME, { kind: 'request', card: 'K-7', title: 'Sums', docId: 'd', section: 's', runtime: AGENT, repo: 'team/app', sentAt: 1, hash: 'h' });
    const offer = sayRun(AGENT, { kind: 'nocopy', request: request.id });
    const run = (...rest: object[]) => threadsOf([request, ...rest], ME, AGENT, {}, 100)[0].state;
    assert.deepEqual([run(offer), run(offer, sayRun(ME, { kind: 'clone', request: request.id, repo: 'team/app', sentAt: 2 }))], ['waiting', 'working']);
    const prompt = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'p9');
    const turn = (...rest: object[]) => threadsOf([prompt, ...rest], ME, AGENT, {}, 100)[0].state;
    const clone = say(ME, { kind: 'clone', to: 'p9', repo: 'team/app', sentAt: 2 });
    // A note says what the agent does meanwhile, and changes nothing.
    assert.deepEqual([turn(say(AGENT, { kind: 'nocopy', to: 'p9' })), turn(say(AGENT, { kind: 'nocopy', to: 'p9' }), clone, say(AGENT, { kind: 'note', to: 'p9' }))], ['waiting', 'working']);
  });

  test('a question names its project, and one about the board alone names no repository (R-038)', () => {
    const [thread] = threadsOf([say(ME, { kind: 'prompt', sentAt: 1, project: 4 }, 'b1')], ME, AGENT, {}, 100);
    assert.deepEqual([thread.project, thread.repo], [4, '']);
  });

  test("a board shows the proposals for it and its repository that wait for the owner's go (K-72, R-047)", () => {
    const propose = (clientId: string, project: number, repo: string) => ({ ...say(AGENT, {}, clientId), prompt: null, board: { kind: 'proposal', project, repo, card: { kind: 'K', title: clientId, body: '' } } });
    const proposals = [propose('a', 4, 'team/app'), propose('b', 4, 'Team/App'), propose('c', 5, 'team/app'), propose('d', 4, 'team/web')];
    const waiting = (...rest: object[]) => waitingProposals(threadsOf([...proposals, ...rest], ME, AGENT, {}, 100), 4, 'team/app').map((p: { thread: { root: string } }) => p.thread.root).sort();
    assert.deepEqual(waiting(), ['a', 'b'], 'its project and repository, whatever the case');
    const [first] = waitingProposals(threadsOf(proposals, ME, AGENT, {}, 100), 4, 'team/app');
    assert.deepEqual([first.message.clientId, first.draft], [first.thread.root, { kind: 'K', title: first.thread.root, body: '' }], 'with the message and the draft the board shows');
    assert.deepEqual(waiting({ ...say(ME, {}), prompt: null, added: { to: 'a', draft: 'a', card: 'K-9' } }), ['b'], 'an added draft no longer waits');
    assert.deepEqual(waiting({ ...say(AGENT, {}), prompt: null, added: { to: 'b', draft: 'b', card: 'K-9' } }), ['a', 'b'], 'only the owner adds');
  });

  test('the owner dismisses a proposal, and a newer copy of the same card or change replaces an older one', () => {
    const propose = (clientId: string, card: object) => ({ ...say(AGENT, {}, clientId, ++id), prompt: null, board: { kind: 'proposal', project: 4, repo: 'team/app', card: { body: '', ...card } } });
    const note = (senderId: number, to: string) => ({ ...say(senderId, {}), prompt: null, dismissed: { to } });
    const waiting = (...messages: object[]) => waitingProposals(threadsOf(messages, ME, AGENT, {}, 100), 4, 'team/app').map((p: { thread: { root: string } }) => p.thread.root);
    const one = propose('a', { kind: 'K', title: 'Bug' });
    assert.deepEqual(waiting(one, note(ME, 'a')), [], "the owner's note ends the wait");
    assert.deepEqual(waiting(one, note(AGENT, 'a')), ['a'], 'only the owner dismisses');
    assert.equal(threadsOf([one, note(ME, 'a')], ME, AGENT, {}, 100)[0].state, 'ended');
    assert.equal(proposalsWaiting(threadsOf([one, note(ME, 'a')], ME, AGENT, {}, 100)), 0);
    // The agent sends a file again when it changes, and may send one twice (K-71).
    const change = (clientId: string, title: string) => propose(clientId, { kind: 'R', title, replaces: { card: 'R-47', doc: 'd', section: 's', seen: 'h' } });
    const added = { ...say(ME, {}), prompt: null, added: { to: 'c3', draft: 'c3', card: 'R-47' } };
    assert.deepEqual(waiting(change('c1', 'Old'), change('c2', 'Older'), change('c3', 'New'), added), [], 'older changes to a card wait no longer once a newer one is added');
    assert.deepEqual(waiting(change('c4', 'Old'), change('c5', 'New')), ['c5'], 'only the newest change waits');
    assert.deepEqual(waiting(propose('d1', { kind: 'K', title: 'Bug' }), propose('d2', { kind: 'K', title: ' bug ' }), propose('d3', { kind: 'R', title: 'Bug' })).sort(), ['d2', 'd3'], 'a copy with the same kind and title');
  });

  test('a laptop that serves every folder takes a repository it has no folder of, and offers to clone it (R-036)', () => {
    const seat = { repo: 'team/app', online: true, lastSeen: 5, protocol: 2 };
    const agent = (extra: object) => ({ id: AGENT, online: true, lastSeen: 5, protocol: 2, agentRepos: [seat], ...extra });
    assert.equal(seatFor(agent({}), 'Team/App').noFolder, undefined, 'its folder, whatever the case');
    assert.deepEqual(seatFor(agent({}), 'team/web'), { repo: 'team/web', online: true, lastSeen: 5, protocol: 2, agent: agent({}), noFolder: true });
    assert.equal(seatFor(agent({ online: false, agentRepos: [] }), 'team/web').online, false, 'asleep');
    assert.equal(seatFor(agent({ protocol: 0, agentRepos: [] }), 'team/web'), undefined, 'an older plugin clones nothing');
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

  test("a question of the agent makes its thread Asking you, until the agent says it settled, and waits 7 days (docs/decisions/harness-approvals.md)", () => {
    const sayPermit = (senderId: number, permit: object, clientId: string, createdAt = ++id) => ({ ...say(senderId, {}, clientId, createdAt), prompt: null, permit });
    const sayRun = (senderId: number, run: object, createdAt = ++id) => ({ ...say(senderId, {}, `r${id}`, createdAt), prompt: null, run });
    const request = sayRun(ME, { kind: 'request', card: 'K-7', title: 'Sums', docId: 'd', section: 's', runtime: AGENT, repo: 'team/app', sentAt: 1, hash: 'h' });
    const asked = sayPermit(AGENT, { kind: 'question', request: request.id, what: 'run', detail: 'npm test', expires: 9 }, 'q1');
    const answered = sayPermit(ME, { kind: 'answer', to: 'q1', decision: 'once', seen: 'h', sentAt: 1 }, 'a1');
    const settled = (outcome: string) => sayPermit(AGENT, { kind: 'settled', to: 'q1', outcome }, 's1');
    const thread = (...rest: object[]) => threadsOf([request, ...rest], ME, AGENT, {}, 100)[0];
    assert.deepEqual([thread(asked).state, thread(asked).ask.message.clientId, thread(asked).ask.answered, thread(asked).messages.length], ['asking', 'q1', false, 2]);
    // The owner's answer turns the buttons off until the agent says it settled; one that did not send leaves them on.
    assert.equal(thread(asked, answered).ask.answered, true);
    assert.equal(threadsOf([request, asked, answered], ME, AGENT, { [answered.clientId]: 'failed' }, 100)[0].ask.answered, false);
    // Settled, the thread works on; a stale answer leaves the question open, with the buttons back.
    for (const outcome of ['allowed', 'allowedForRun', 'denied', 'expired', 'stopped']) assert.deepEqual([thread(asked, answered, settled(outcome)).state, thread(asked, answered, settled(outcome)).ask], ['working', undefined]);
    assert.deepEqual([thread(asked, answered, settled('stale')).state, thread(asked, answered, settled('stale')).ask.answered], ['asking', false]);
    // Any later word of the run clears an orphaned question, such as after the agent restarted.
    assert.deepEqual([thread(asked, sayRun(AGENT, { kind: 'failed', request: request.id })).state, thread(asked, sayRun(AGENT, { kind: 'failed', request: request.id })).ask], ['unfinished', undefined]);
    // Only the thread's own agent asks, and only the owner answers.
    assert.equal(thread(sayPermit(ME, { kind: 'question', request: request.id, what: 'run', detail: 'x', expires: 9 }, 'q2')).state, 'working');
    assert.equal(thread(sayPermit(7, { kind: 'question', request: request.id, what: 'run', detail: 'x', expires: 9 }, 'q3')).state, 'working');
    assert.equal(thread(asked, sayPermit(AGENT, { kind: 'answer', to: 'q1', decision: 'once', seen: 'h', sentAt: 1 }, 'a2')).ask.answered, false);
    // A conversation asks too, by its prompt's client id, and a question left a day still asks, until 7 days.
    const prompt = say(ME, { kind: 'prompt', repo: 'team/app', sentAt: 1 }, 'p1', 1_000);
    const converse = sayPermit(AGENT, { kind: 'question', to: 'p1', what: 'edit', detail: 'Write x', expires: 9 }, 'q9', 2_000);
    const [chat] = threadsOf([prompt, converse], ME, AGENT, {}, 2_000 + THREAD_TTL_MS + 1);
    assert.deepEqual([chat.kind, chat.state], ['question', 'asking']);
    assert.equal(threadsOf([prompt, converse], ME, AGENT, {}, 2_000 + ASK_WAIT_MS + 1)[0].state, 'ended');
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

describe('A harness row in shared/types.ts (docs/decisions/harness-linking.md)', () => {
  test('each harness is linked, linked and needing attention, found and not linked, or not found', () => {
    const h = (rest: Partial<HarnessState>): HarnessState => ({ name: 'Codex', knobs: [], ...rest });
    assert.equal(harnessRow(h({ linked: true, path: '/bin/codex' })), 'linked');
    assert.equal(harnessRow(h({ linked: true, path: '/bin/codex', attention: 'Not signed in.' })), 'attention');
    assert.equal(harnessRow(h({ linked: true, attention: 'I cannot find Codex on this laptop.' })), 'attention', 'linked, then uninstalled');
    assert.equal(harnessRow(h({ linked: false, path: '/bin/codex', attention: 'ignored' })), 'found');
    assert.equal(harnessRow(h({ linked: false })), 'missing');
  });
});
