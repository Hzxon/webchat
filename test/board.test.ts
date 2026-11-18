import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The paths live in variables so the tools tsconfig, which has no DOM types, does not typecheck
// the client module, nor the partial rows these tests pass to the shared one. tsx still loads them.
const clientBoard = '../client/src/board.ts';
const sharedBoard = '../shared/board.ts';

const { afterWarnings, cardRuns, cardTemplate, statusMove, standsAt, waitsFor, waitingFace, GOING, draftGroup, duplicates, idOf, moved, needsYou, otherRun, runnerOf, startable, takeable, unchecked, withChecked, workingStatus } = await import(clientBoard);
const { cardOf, cardsOf, cardSections, cardText, groupOf, keepReviews, parseCard, standing, usernamesOf, withReviews, withStatus } = await import(sharedBoard);

const section = (id: string, text: string) => ({ id, text, pos: 1, failed: false });

describe('Board cards in client/src/board.ts (R-021, D-082)', () => {
  test('each template reads back as its kind, number, title and status', () => {
    const d = parseCard(section('a', cardTemplate('D', 'D-3')));
    assert.deepEqual([d.kind, d.number, d.cardId, d.title, d.status], ['D', 3, 'D-3', 'Title', 'Proposed']);
    assert.ok(d.body.startsWith('What was decided'));
    assert.deepEqual(parseCard(section('b', cardTemplate('R', 'R-012'))).status, 'Idea');
    assert.deepEqual(parseCard(section('c', cardTemplate('K', 'K-1'))).status, 'Open');
    assert.deepEqual(parseCard(section('d', cardTemplate('Q', 'Q-6'))).status, 'Open');
  });

  test('a card from the new-card form reads back as typed, even one titled Title', () => {
    const prompts = parseCard(section('a', cardTemplate('R', 'R-1'))).body;
    const card = parseCard(section('b', cardText('R-4', 'Title', 'Idea', prompts)));
    assert.deepEqual([card.cardId, card.title, card.status, card.body], ['R-4', 'Title', 'Idea', prompts]);
    const typed = parseCard(section('c', cardText('K-2', 'Bad keys', 'Open', 'Seen: on a phone.')));
    assert.equal(typed.body, 'Seen: on a phone.');
  });

  test('a status keeps its date and loses its final period', () => {
    const card = parseCard(section('a', '### D-7: Keep the lock\n\nStatus: Accepted 2026-11-04.\n\nWhy: it works.'));
    assert.equal(card.status, 'Accepted 2026-11-04');
    assert.equal(card.body, 'Why: it works.');
    assert.equal(groupOf('decisions', card.status), 1);
    assert.equal(groupOf('roadmap', 'Ready'), 0);
    assert.equal(groupOf('roadmap', 'Running: Ann’s agent'), 1);
    assert.equal(groupOf('roadmap', 'In review: o/r#3'), 2);
    assert.equal(groupOf('roadmap', 'Fixed in #12'), 4);
    assert.equal(groupOf('roadmap', 'Something else'), 3);
    assert.equal(groupOf('roadmap', 'Waiting for a decision'), 1, 'a run that waits for a decision still holds its card (R-042)');
  });

  test('a running card names who runs it, and a card in review its pull request', () => {
    assert.equal(workingStatus('Ann'), 'Running: Ann’s agent');
    assert.equal(runnerOf('Running: Ann’s agent'), 'Ann’s agent');
    assert.equal(runnerOf('Running: o/r#3'), 'o/r#3');
    assert.equal(runnerOf('In review: o/r#3'), 'o/r#3');
    assert.equal(runnerOf('In review'), '');
    assert.equal(runnerOf('Done in o/r#3'), '');
  });

  test('a card belongs to the member who opened it, while they are a member (the board-lanes decision)', () => {
    const opened = { ...section('a', '### K-1: Bug\n\nStatus: Open.'), openedBy: 4 };
    assert.equal(cardOf(opened, [3, 4], {}).owner, 4);
    assert.equal(cardOf(opened, [3], {}).owner, undefined, 'an owner who left owns nothing');
    assert.equal(cardOf(section('a', '### K-1: Bug'), [3, 4], {}).owner, undefined, 'an imported card has no owner');
    assert.equal(cardOf(opened, [4], {}).title, 'Bug');
  });

  test("a card's opener and words come from its oldest revision and each author's newest (the board-lanes decision)", () => {
    // Rows as GET /docs/:id/words gives them, in id order, each with what it opened to or null.
    const row = (id: number, section: string, authorId: number, content: object | null) => ({ revision: { id, section, authorId, createdAt: id }, content });
    const cards = cardSections([
      row(1, 'title', 1, { text: 'Roadmap', board: 'roadmap' }),
      row(2, 'a', 1, { text: 'A1', pos: 1, opened: true }),
      row(3, 'b', 2, { text: 'B1', pos: 2 }),
      row(4, 'c', 1, { text: 'C1', pos: 3, opened: true }),
      row(5, 'd', 3, { text: 'D1', pos: 4, opened: true }),
      row(6, 'a', 2, { text: 'A2', pos: 1 }),
      row(7, 'c', 1, { text: 'C2', pos: 3, removed: true }),
      row(8, 'd', 3, null),
      row(9, 'a', 1, { text: 'A3', pos: 1 }),
    ]);
    assert.deepEqual(cards.map((c: { id: string }) => c.id), ['a', 'b', 'c', 'd'], 'no title; a removal waits for its owner to be known');
    const [a, b, c, d] = cards;
    assert.deepEqual([a.text, a.authorId, a.openedBy], ['A3', 1, 1], 'the same author first and last owns it');
    assert.deepEqual(a.words.map((w: { id: number }) => w.id), [9, 6], 'one word per author, newest first, not the oldest row');
    assert.equal(b.openedBy, undefined, 'a first revision without the mark opens no card');
    assert.deepEqual([c.text, c.removedBy, c.words], ['C1', 1, []], 'a removed card shows its newest other revision, and a removal is no word');
    assert.equal(cardOf(c, [1, 2, 3], {}), null, 'its owner removed it, so it is gone');
    assert.deepEqual([d.failed, d.text, d.pos, d.openedBy, d.words], [true, '', 8, 3, []], 'a newest revision that does not open keeps its opener and no word');
  });

  test('a new status replaces the status line, or goes under the heading', () => {
    const card = (text: string) => parseCard(section('a', text));
    const moved = card(withStatus('### K-1: Bug\n\nStatus: Open.\n\nSeen: here', 'In review: o/r#3'));
    assert.deepEqual([moved.status, moved.body], ['In review: o/r#3', 'Seen: here']);
    const added = card(withStatus('### K-1: Bug\n\nSeen: here', 'In review'));
    assert.deepEqual([added.title, added.status, added.body], ['Bug', 'In review', 'Seen: here']);
  });

  test('a body that starts with its own status line gives the card one status line', () => {
    const made = parseCard(section('a', cardText('K-1', 'Bug', 'Open', 'Status: Open. Found by the owner.\n\nSeen: here')));
    assert.deepEqual([made.status, made.body], ['Open', 'Seen: here']);
  });

  test("a run's report moves its card only from where the run left it (D-118)", () => {
    const pull = { repo: 'o/r', number: 3 };
    const move = (state: string) => statusMove({ request: 1, runtime: 9, state, pull }, 'K-1', 'Open', workingStatus('Ann'));
    assert.deepEqual(move('done'), [['Open', 'Running: Ann’s agent', 'Waiting for a decision'], 'In review: o/r#3']);
    assert.deepEqual(move('merged')[1], 'Fixed in o/r#3');
    assert.deepEqual(move('closed'), [['In review: o/r#3'], 'Open'], 'a draft closed unmerged gives the card its old status back');
    assert.deepEqual(move('ended'), [[], ''], 'watching that stops on an open draft leaves the card in review');
    // A run claimed before Running was the word still moves its card, which reads in the new words (the board-lanes decision).
    const old = parseCard(section('a', '### K-1: Bug\n\nStatus: In progress: Ann’s agent.')).status;
    for (const state of ['decision', 'done', 'failed', 'stale', 'merged']) assert.ok(move(state)[0].includes(old), state);
    assert.ok(!move('done')[0].includes(parseCard(section('a', '### K-1: Bug\n\nStatus: In progress: Bob’s agent.')).status), 'not a teammate’s run');
  });

  test('a run that waits for another card shows it in the Running lane, names who chooses, and goes on from there (docs/roadmap/new-overlap-gate.md)', () => {
    const working = workingStatus('Ann');
    const [from, to] = statusMove({ request: 1, runtime: 9, state: 'overlap', waits: 'K-12' }, 'K-7', 'Ready', working);
    assert.deepEqual([from, to], [['Ready', 'Running: Ann’s agent', 'Waiting for a decision'], 'Waiting for K-12']);
    const waiting = waitsFor(to, ['Ann', 'Bo']);
    assert.equal(waiting, 'Waiting for K-12: Ann and Bo choose');
    assert.equal(waitsFor(to, ['Ann']), 'Waiting for K-12: Ann chooses', 'one person owns both cards');
    assert.equal(groupOf('roadmap', waiting), groupOf('roadmap', 'Running: Ann’s agent'));
    assert.ok(otherRun(waiting, 'Bo'), 'nobody else starts it meanwhile');
    // Each choice goes on through a report the run already has: fixing when it goes on, failed for a fold.
    for (const state of ['fixing', 'failed', 'done']) {
      const [moveFrom, moveTo] = statusMove({ request: 1, runtime: 9, state }, 'K-7', 'Ready', workingStatus('Ann'));
      assert.ok(standsAt(moveFrom, waiting, moveTo), state);
    }
    assert.ok(!standsAt(['Ready'], waiting, working), 'a move that does not start from a wait leaves it');
    assert.ok(!standsAt(from, waiting, waiting), 'a card the move already made moves no more, so a second tab pushes nobody again');
  });

  test('a card reads its Checked line, and has an empty check without one (R-041)', () => {
    const checked = (body: string) => parseCard(section('a', `### K-1: Bug\n\nStatus: Open.\n\n${body}`)).checked;
    assert.equal(checked('Checked: 2026-11-07. Read 3 cards.\n\nSeen: here'), '2026-11-07. Read 3 cards.');
    assert.equal(checked('Seen: here'), '');
  });

  test('a new check goes on top of the body and replaces the old one (R-041)', () => {
    const body = 'Why: x.\n\nChecked: 2026-01-01. Old.';
    // Built from local parts, since withChecked writes the day in the local time zone.
    assert.equal(withChecked(body, 'Read 3 cards.', new Date(2026, 10, 7)), 'Checked: 2026-11-07. Read 3 cards.\n\nWhy: x.');
  });

  test('only an open idea or issue with no check shows as unchecked (R-041)', () => {
    const isUnchecked = (text: string) => unchecked(parseCard(section('a', text)));
    const issue = '### K-1: Bug\n\nStatus: Open.\n\nSeen: here';
    assert.equal(isUnchecked(issue), true);
    assert.equal(isUnchecked(`${issue}\n\nChecked: 2026-11-07. Read 3 cards.`), false, 'a Checked line clears it');
    assert.equal(isUnchecked('### R-2: Idea\n\nStatus: Done in #12.'), false, 'a done idea needs no check');
    assert.equal(isUnchecked('### R-3: Idea\n\nStatus: Dropped on 2026-11-04.'), false, 'nor does a dropped one');
    assert.equal(isUnchecked('### D-1: Keys rotate\n\nStatus: Proposed.'), false, 'a decision is never unchecked');
  });

  test('a card without the heading is titled by its first line and has no number', () => {
    const card = parseCard(section('a', '\n## Just a note\n\nStatus: Open.\nBody'));
    assert.deepEqual([card.kind, card.number, card.title, card.status], [null, null, 'Just a note', '']);
    assert.equal(card.body, '## Just a note\n\nStatus: Open.\nBody');
  });

  test('the next free id skips the numbers in use, by kind', () => {
    const ids = ['### R-1: a', '### R-4: b', '### K-2: c', 'no heading'].map((t, i) => parseCard(section(String(i), t)).cardId);
    assert.equal(idOf(ids, 'R'), 'R-5');
    assert.equal(idOf(ids, 'K'), 'K-3');
    assert.equal(idOf(ids, 'D'), 'D-1');
  });

  test('two cards with one number are both flagged', () => {
    const cards = ['### D-1: a', '### D-1: b', '### D-2: c'].map((t, i) => parseCard(section(String(i), t)));
    assert.deepEqual([...duplicates(cards)], ['0', '1']);
  });

  test('a new id is as wide as the widest of its kind, so R-043 follows R-005 (R-040)', () => {
    assert.equal(idOf(['R-005', 'R-042', 'K-12', 'D-1'], 'R'), 'R-043');
    assert.equal(idOf(['R-005', 'K-12'], 'K'), 'K-13');
    assert.equal(idOf([], 'Q'), 'Q-1');
  });

  test('a card shows its latest run, and only an unfinished one blocks another (R-027)', () => {
    const now = 1_000_000_000;
    const ask = (id: number, section: string, extra = {}) => ({
      id,
      senderId: 1,
      clientId: `c${id}`,
      run: { kind: 'request', card: 'K-1', title: 't', docId: 'doc', section, runtime: 9, sentAt: now - 1000, ...extra },
    });
    const report = (request: number, kind: string, senderId = 9) => ({ id: request + 100, senderId, run: { kind, request } });
    const runs = (messages: unknown[], pending = {}) => cardRuns(messages, 1, 'doc', pending, now);
    const state = (messages: unknown[], pending = {}) => {
      const run = runs(messages, pending).get('a');
      return run && [run.state, GOING.has(run.state)];
    };

    assert.deepEqual(state([ask(-5, 'a')], { 'c-5': 'sending' }), ['sending', true]);
    assert.equal(state([ask(-5, 'a')], { 'c-5': 'failed' }), undefined, 'a failed send asked nothing');
    assert.deepEqual(state([ask(1, 'a')]), ['waiting', true]);
    assert.deepEqual(state([ask(1, 'a', { sentAt: now - 31 * 60_000 })]), ['unanswered', false]);
    assert.deepEqual(state([ask(1, 'a'), report(1, 'claimed')]), ['claimed', true]);
    assert.deepEqual(state([ask(1, 'a'), report(1, 'claimed'), report(1, 'done')]), ['done', false]);
    assert.deepEqual(state([ask(1, 'a'), report(1, 'done', 2)]), ['waiting', true], 'only the named agent reports');
    const cancel = { id: 2, senderId: 1, run: { kind: 'cancel', request: 1 } };
    assert.deepEqual(state([ask(1, 'a'), cancel]), ['cancelled', false]);
    const taken = [ask(1, 'a'), report(1, 'claimed'), cancel];
    assert.equal(runs(taken).get('a')?.stopping, true, 'a run the agent took is stopping until it reports (K-64)');
    assert.deepEqual(state(taken), ['claimed', true]);
    assert.equal(runs([...taken, report(1, 'failed')]).get('a')?.stopping, false);
    assert.deepEqual(state([ask(1, 'a'), report(1, 'failed'), ask(2, 'a')]), ['waiting', true], 'a new request replaces the old');
    assert.deepEqual(state([ask(1, 'a'), ask(2, 'a'), report(1, 'done')]), ['waiting', true], 'an old run reports into nothing');
    assert.equal(runs([{ ...ask(1, 'a'), senderId: 3 }, ask(2, 'b', { docId: 'other' })]).size, 0, 'only my requests on this doc');
    // A run that waits for a decision still goes; a draft after the work changes nothing; a merge
    // names the decisions the work made true, and each state names its report (R-042).
    assert.deepEqual(state([ask(1, 'a'), report(1, 'claimed'), report(1, 'decision')]), ['decision', true]);
    assert.deepEqual(state([ask(1, 'a'), report(1, 'stale')]), ['stale', false]);
    assert.deepEqual(state([ask(1, 'a'), report(1, 'done'), { ...report(1, 'draft'), id: 300 }]), ['done', false]);
    const merged = runs([ask(1, 'a'), { id: 400, senderId: 9, run: { kind: 'merged', request: 1, decisions: ['D-2'] } }]).get('a');
    assert.deepEqual([merged?.state, merged?.at, merged?.decisions], ['merged', 400, ['D-2']]);
    // The user's go on a draft that is done, as Run again sends, starts the next round at once (the card-review decision).
    const fix = (id: number, senderId = 1) => ({ id, senderId, run: { kind: 'fix', request: 1, sentAt: now } });
    const fixing = runs([ask(1, 'a'), report(1, 'done'), fix(500)]).get('a');
    assert.deepEqual([fixing?.state, fixing?.at], ['fixing', 500]);
    assert.deepEqual(statusMove(fixing, 'K-1', 'Ready', workingStatus('Ann')), [['Waiting for a decision'], workingStatus('Ann')], 'which moves nothing from Running: Ann’s agent');
    assert.deepEqual(state([ask(1, 'a'), report(1, 'done'), fix(500, 2)]), ['done', false], 'only the user’s own');
    assert.deepEqual(state([ask(1, 'a'), report(1, 'planned'), fix(500)]), ['planned', true], 'a plan’s go is as before');
    assert.deepEqual(state([ask(1, 'a'), report(1, 'decision'), fix(500)]), ['decision', true], 'and a decision’s');
    assert.deepEqual(state([ask(1, 'a'), report(1, 'done'), fix(500), { ...report(1, 'fixing'), id: 600 }, { ...report(1, 'done'), id: 700 }]), ['done', false], 'the agent’s reports land as before');
  });

  test('the cards that wait for the user, questions first, then plans, decisions, stops and requests (R-047)', () => {
    const now = 1_000_000_000;
    // Ann (1) runs cards with her agent (9); Bo (2) is a teammate.
    const ask = (id: number, section: string, senderId = 1) => ({ id, senderId, clientId: `c${id}`, run: { kind: 'request', docId: 'doc', section, runtime: 9, sentAt: now } });
    const report = (request: number, kind: string) => ({ id: request + 100, senderId: 9, run: { kind, request } });
    const card = (id: string, status: string, extra = {}) => ({ id, cardId: id, status, owner: 2, body: '', reviews: [], ...extra });
    const cards = [
      card('ready', 'Open', { owner: 1, body: 'Asked: 2026-11-12. @bo asks its owner to mark it ready.' }),
      card('review', 'In review', { reviews: [{ who: 1, verdict: 'review_required' }] }),
      card('paused', 'Running: Ann’s agent'),
      card('decision', 'Waiting for a decision'),
      card('planned', 'Running: Ann’s agent'),
      card('asking', 'Running: Ann’s agent'),
      card('done', 'In review: o/r#3'),
      card('theirs', 'Running: Bo’s agent'),
    ];
    const messages = [
      ask(1, 'paused'), report(1, 'paused'),
      ask(2, 'decision'), report(2, 'decision'),
      ask(3, 'planned'), report(3, 'planned'),
      ask(4, 'asking'), report(4, 'claimed'),
      ask(5, 'done'), report(5, 'done'),
      ask(6, 'theirs', 2), { ...report(6, 'paused'), id: 106 },
    ];
    const threads = [
      { request: 1, state: 'paused' },
      { request: 2, state: 'waiting' },
      { request: 3, state: 'planned' },
      { request: 4, state: 'asking', ask: { answered: false } },
      { request: 5, state: 'draft' },
    ];
    const needs = (list = cards, t = threads, me = 1): string[][] => needsYou(list, me, cardRuns(messages, me, 'doc', {}, now), t).map((n: { card: { id: string }; need: string }) => [n.card.id, n.need]);
    assert.deepEqual(needs(), [
      ['asking', 'asking'],
      ['planned', 'planned'],
      ['decision', 'decision'],
      ['paused', 'paused'],
      ['review', 'review'],
      ['ready', 'ready'],
    ], 'a finished run and a teammate’s run do not count');
    // The thread turns to working as the user answers, gives the go or redirects, before the agent reports.
    const answered = threads.map((t) => (t.request === 4 ? { ...t, ask: { answered: true } } : t.request === 3 ? { ...t, state: 'working' } : t));
    assert.deepEqual(needs(cards, answered).map(([id]) => id), ['decision', 'paused', 'review', 'ready']);
    assert.deepEqual(needs(cards, [{ request: 2, state: 'working' }]).map(([id]) => id), ['review', 'ready'], 'a decision added and gone on with, and runs with no thread, count for nothing');
    const stopped = cardRuns([...messages, { id: 200, senderId: 1, run: { kind: 'cancel', request: 1 } }], 1, 'doc', {}, now);
    assert.equal(needsYou(cards, 1, stopped, threads).some((n: { need: string }) => n.need === 'paused'), false, 'a stop the agent has not reported yet');
    assert.deepEqual(needs(cards, [{ request: 6, state: 'paused' }], 2), [['theirs', 'paused']], 'Bo sees his own run, and none of Ann’s runs or requests');
    assert.deepEqual(needs([card('r', 'In review', { reviews: [{ who: 1, verdict: 'approved' }] }), card('o', 'Ready', { owner: 1, body: cards[0]!.body })]), [], 'an answered review and an ask on a card marked ready do not count');
  });

  test('a status that shows another run of the card refuses a second one (K-59)', () => {
    assert.equal(otherRun('Running: Ann’s agent', 'Bob'), true, 'a teammate’s agent runs it');
    assert.equal(otherRun('Running: o/r#3', 'Ann'), true, 'a pull request claims it');
    assert.equal(otherRun(workingStatus('Ann'), 'Ann'), false, 'my own run, which the play button already holds');
    assert.equal(otherRun('In review: o/r#3', 'Ann'), true, 'a draft is open');
    assert.equal(otherRun('In review', 'Ann'), true);
    assert.equal(otherRun('Running', 'Ann'), false, 'set by hand, no run named');
    assert.equal(otherRun('Open', 'Ann'), false);
    assert.equal(otherRun('Waiting for a decision', 'Ann'), true, 'a run waits for a decision (R-042)');
  });

  test('a proposal’s draft shows where its card would land, or beside the card it changes (R-047)', () => {
    const cards = [{ id: 's1', status: 'Running: Ann’s agent' }, { id: 's2', status: 'Accepted' }];
    const draft = (kind: string, section?: string) => ({ kind, title: 't', body: '', ...(section && { replaces: { card: 'X-1', doc: 'd', section, seen: 'h' } }) });
    assert.equal(draftGroup(draft('R'), cards), 3, 'a new idea in the Open drawer');
    assert.equal(draftGroup(draft('K'), cards), 3, 'a new issue too');
    assert.equal(draftGroup(draft('D'), cards), 0, 'a new decision with the Proposed ones');
    assert.equal(draftGroup(draft('R', 's1'), cards), 1, 'a change in its card’s lane');
    assert.equal(draftGroup(draft('D', 's2'), cards), 1, 'a change to an accepted decision with it');
    assert.equal(draftGroup(draft('R', 'gone'), cards), 3, 'a change to a card that went, where a new one would land');
  });
});

describe('A card waits for the cards its After line names (docs/roadmap/new-after-edge.md)', async () => {
  const { copyOf } = await import('../shared/board.ts');
  const me = { id: 1, username: 'ann', displayName: 'Ann' };
  const board = (...texts: string[]) => cardsOf(texts.map((t, i) => ({ id: `s${i}`, text: t, pos: i, failed: false })), [1], { 1: 'ann' });
  const byId = (cards: any[], id: string): any => cards.find((c) => c.cardId === id);

  test('a card that waits cannot be picked or run, and can once the card it names is Done or Fixed', () => {
    const waiting = board('### K-12: Totals type\n\nStatus: Ready.', '### R-30: Sync it\n\nStatus: Open.', '### K-7: Sums\n\nStatus: Ready.\n\nAfter: K-12, R-30\n\nWhy: it uses the type.');
    const k7 = byId(waiting, 'K-7');
    assert.deepEqual(k7.after, ['K-12', 'R-30'], 'read as the Checked line is');
    assert.deepEqual(k7.waits, { on: ['K-12', 'R-30'], dropped: [], loop: [] });
    assert.equal(waitingFace(k7.waits), 'Waiting for K-12, R-30', "the face names the cards, in the overlap wait's words");
    assert.equal(startable(k7, 'Ann'), false, 'no run starts, from the brief or a claim');
    assert.equal(moved(k7, 'pick', me), null, 'nobody picks it');
    assert.equal(byId(waiting, 'K-12').waits, undefined);
    const done = board('### K-12: Totals type\n\nStatus: Done in o/r#3.', '### R-030: Sync it\n\nStatus: Fixed on 2026-11-18.', '### K-7: Sums\n\nStatus: Ready.\n\nAfter: K-12, R-30');
    const free = byId(done, 'K-7');
    assert.equal(free.waits, undefined, 'a padded id matches, and Fixed counts as Done');
    assert.equal(startable(free, 'Ann'), true);
    assert.ok(moved(free, 'pick', me)?.includes('Status: Running: Ann.'));
    assert.deepEqual(byId(board('### K-7: Sums\n\nStatus: Ready.\n\nAfter: K-99'), 'K-7').waits?.on, ['K-99'], 'a card the board lacks still holds it, so a typo shows');
  });

  test('a loop of After lines shows a warning on each card in it and blocks them all', () => {
    const cards = board('### K-1: One\n\nStatus: Ready.\n\nAfter: K-2', '### K-2: Two\n\nStatus: Ready.\n\nAfter: K-3', '### K-3: Three\n\nStatus: Ready.\n\nAfter: K-1', '### K-4: Four\n\nStatus: Ready.\n\nAfter: K-1');
    assert.deepEqual(byId(cards, 'K-1').waits!.loop, ['K-1', 'K-2', 'K-3', 'K-1']);
    assert.deepEqual(byId(cards, 'K-3').waits!.loop, ['K-3', 'K-1', 'K-2', 'K-3']);
    assert.deepEqual(afterWarnings(byId(cards, 'K-2').waits!), ['K-2 waits for K-3, which waits for K-1, which waits for K-2. None of them can run until one After line goes.']);
    for (const id of ['K-1', 'K-2', 'K-3']) assert.equal(startable(byId(cards, id), 'Ann'), false, id);
    assert.deepEqual(byId(cards, 'K-4').waits, { on: ['K-1'], dropped: [], loop: [] }, 'a card that waits on a loop is not in it');
    assert.deepEqual(afterWarnings(byId(board('### K-5: Self\n\nStatus: Ready.\n\nAfter: K-5'), 'K-5').waits!), ['K-5 waits for K-5. None of them can run until one After line goes.']);
    // A loop through a card that is done blocks nothing.
    assert.equal(byId(board('### K-1: One\n\nStatus: Ready.\n\nAfter: K-2', '### K-2: Two\n\nStatus: Done on 2026-11-18.\n\nAfter: K-1'), 'K-1').waits, undefined);
  });

  test('a dropped card it names shows a warning on the waiting card, and still holds it', () => {
    const k7 = byId(board('### K-12: Totals type\n\nStatus: Dropped: K-9 covers it.', '### K-7: Sums\n\nStatus: Ready.\n\nAfter: K-12'), 'K-7');
    assert.deepEqual(k7.waits, { on: ['K-12'], dropped: ['K-12'], loop: [] });
    assert.deepEqual(afterWarnings(k7.waits!), ['K-12 was dropped. Remove it from the After line, or drop this card.']);
    assert.equal(startable(k7, 'Ann'), false);
  });

  test("the repository copy keeps the After line, so a session that works from it sees the order (D-117)", () => {
    const text = '### K-7: Sums\n\nStatus: Ready.\n\nAfter: K-12';
    assert.ok(copyOf('roadmap', [text]).includes('After: K-12'));
  });
});

describe("A card owner's gates in client/src/board.ts (the card-owner decision)", async () => {
  const { copyOf } = await import('../shared/board.ts');
  const { cardStatus } = await import('../shared/types.ts');
  // As `client/src/boardLink.ts` renumbers a card, from its text.
  const renumbered = (written: string) => `${written.replace(/^###\s+[A-Z]-\d+:/, '### K-5:')}\n\nThis card was K-4.`;
  // Ann (1) opened the card; Bo (2) and Cy (3) are members.
  const [ann, bo, cy] = [
    { id: 1, username: 'ann', displayName: 'Ann' },
    { id: 2, username: 'bo', displayName: 'Bo' },
    { id: 3, username: 'cy', displayName: 'Cy' },
  ];
  const today = new Date(2026, 10, 12);
  const text = (status: string, body = 'Seen: on a phone.') => `### K-4: Fix it\n\nStatus: ${status}.\n\n${body}`;
  const word = (id: number, authorId: number, status: string, body?: string) => ({ id, authorId, text: text(status, body) });
  type Word = ReturnType<typeof word>;
  /** The card as a page shows it from these words, newest first, the newest being the section's text. */
  const card = (words: Word[], openedBy: number | null = 1, members = [1, 2, 3]) =>
    cardOf({ id: 's', text: words[0]!.text, pos: 1, failed: false, authorId: words[0]!.authorId, openedBy: openedBy ?? undefined, words }, members, { 1: 'ann', 2: 'bo', 3: 'cy' });
  const statusOf = (written: string) => parseCard(section('s', written)).status;

  test("a member who is not the owner cannot pass a gate by editing the card's Markdown", () => {
    const ready = card([word(2, 2, 'Ready'), word(1, 1, 'Open')]);
    assert.equal(ready.status, 'Open', 'the card stays in Open');
    assert.deepEqual(ready.refused, { status: 'Ready', by: 2 }, 'the opened card says who tried');
    assert.equal(ready.written, text('Ready'), 'the text as written, which the brief hashes');
    assert.equal(ready.text, text('Open'), 'the text that stands, which every page writes from');
    assert.equal(card([word(2, 2, 'Running: Bo'), word(1, 1, 'Open')]).status, 'Open', 'nobody picks a card its owner did not mark ready');
    assert.equal(card([word(2, 2, 'In review'), word(1, 1, 'Idea')]).status, 'Idea');
    assert.equal(card([word(3, 2, 'Done on 2026-11-12'), word(2, 1, 'Ready')]).status, 'Ready', 'only the owner closes it');
    assert.equal(card([word(3, 2, 'Dropped'), word(2, 1, 'Ready')]).status, 'Ready');
    assert.equal(card([word(3, 2, 'Fixed'), word(2, 3, 'Running: Cy'), word(1, 1, 'Ready')]).status, 'Running: Cy', 'the newest word that may stand');
  });

  test('once the owner marked it ready, any member moves it, and a merge closes it', () => {
    assert.equal(card([word(3, 2, 'Running: Bo'), word(2, 1, 'Ready')]).status, 'Running: Bo');
    assert.equal(card([word(3, 2, 'In review: o/r#3'), word(2, 1, 'Ready')]).status, 'In review: o/r#3');
    const merged = card([word(3, 2, 'Fixed in o/r#3'), word(2, 1, 'Ready')]);
    assert.deepEqual([merged.status, merged.refused, merged.setBy], ['Fixed in o/r#3', undefined, 2], 'a page cannot check a merge, so it names who wrote it');
    assert.equal(card([word(3, 2, 'Done in #170'), word(2, 1, 'Ready')]).status, 'Done in #170');
    assert.equal(card([word(2, 2, 'Fixed in o/r#3'), word(1, 1, 'Open')]).status, 'Open', 'not before the owner marked it ready');
    assert.equal(card([word(3, 1, 'Done on 2026-11-12'), word(2, 2, 'Running: Bo')]).status, 'Done on 2026-11-12', 'the owner closes it');
    assert.equal(card([word(3, 2, 'Open'), word(2, 1, 'Ready')]).status, 'Open', 'any member may put it back in Open');
  });

  test('a member who keeps the status that stands is refused nothing', () => {
    const edited = card([word(3, 2, 'Done on 2026-11-12', 'A typo fixed.'), word(2, 1, 'Done on 2026-11-12')]);
    assert.deepEqual([edited.status, edited.refused, edited.setBy], ['Done on 2026-11-12', undefined, 1]);
  });

  test('a card with no owner is bound by no gate: its newest word stands', () => {
    assert.deepEqual(standing([word(2, 2, 'Done on 2026-11-12'), word(1, 1, 'Open')]), { status: 'Done on 2026-11-12', by: 2 });
    assert.equal(card([word(2, 2, 'Ready'), word(1, 1, 'Open')], null).status, 'Ready', 'an imported card');
    assert.equal(card([word(2, 2, 'Ready'), word(1, 1, 'Open')], 1, [2, 3]).status, 'Ready', 'an owner who left owns nothing');
  });

  test('only the owner marks it ready or closes it', () => {
    const open = card([word(1, 1, 'Open')]);
    assert.equal(moved(open, 'ready', bo, today), null);
    assert.equal(statusOf(moved(open, 'ready', ann, today)), 'Ready');
    // Closing also takes an approval (the card-review decision).
    const approved = 'Review: @cy Approved 2026-11-12.';
    const review = card([word(4, 3, 'In review: o/r#3', approved), word(3, 2, 'In review: o/r#3'), word(2, 1, 'Ready')]);
    assert.equal(moved(review, 'close', bo, today), null);
    assert.equal(statusOf(moved(review, 'close', ann, today)), 'Fixed in o/r#3', 'an issue is fixed, in its pull request');
    assert.equal(statusOf(moved(card([word(4, 3, 'In review', approved), word(3, 2, 'In review'), word(2, 1, 'Ready')]), 'close', ann, today)), 'Fixed on 2026-11-12');
    assert.equal(moved(card([word(1, 1, 'Open')], null), 'ready', ann, today), null, 'a card with no owner is taken first');
  });

  test('any member picks a ready card and sends a running one to review, each only from its lane', () => {
    const ready = card([word(2, 1, 'Ready')]);
    assert.equal(statusOf(moved(ready, 'pick', bo, today)), 'Running: Bo');
    assert.equal(moved(card([word(1, 1, 'Open')]), 'pick', bo, today), null);
    assert.equal(moved(ready, 'review', bo, today), null);
    assert.equal(statusOf(moved(card([word(3, 2, 'Running: Bo'), word(2, 1, 'Ready')]), 'review', cy, today)), 'In review');
    assert.equal(moved(card([word(3, 2, 'Waiting for a decision'), word(2, 1, 'Ready')]), 'review', bo, today), null, 'a run that waits for a decision');
    assert.equal(moved(card([word(3, 2, 'Running: Bo’s agent'), word(2, 1, 'Ready')]), 'review', bo, today), null, 'a run moves its own card');
  });

  test('a member asks the owner once, and marking it ready drops the asks', () => {
    const open = card([word(1, 1, 'Open', 'Checked: 2026-11-10. Read the cards.\n\nSeen: on a phone.')]);
    const asked = moved(open, 'ask', bo, today);
    assert.equal(parseCard(section('s', asked)).body.split('\n')[0], 'Asked: 2026-11-12. @bo asks its owner to mark it ready.');
    assert.equal(statusOf(asked), 'Open');
    const again = card([{ id: 2, authorId: 2, text: asked }, word(1, 1, 'Open')]);
    assert.equal(moved(again, 'ask', bo, today), null, 'not twice');
    assert.equal(moved(again, 'ask', ann, today), null, 'the owner asks nobody');
    const both = moved(again, 'ask', cy, today);
    const ready = moved(card([{ id: 3, authorId: 3, text: both }, { id: 2, authorId: 2, text: asked }, word(1, 1, 'Open')]), 'ready', ann, today);
    assert.equal(parseCard(section('s', ready)).body, 'Checked: 2026-11-10. Read the cards.\n\nSeen: on a phone.');
    assert.equal(moved(card([word(1, 1, 'Open')], null), 'ask', bo, today), null, 'a card with no owner has nobody to ask');
  });

  test('every write starts from the status that stands, so it puts a refused one back', () => {
    const refused = card([word(2, 2, 'Ready'), word(1, 1, 'Open')]);
    assert.equal(statusOf(moved(refused, 'ask', cy, today)), 'Open');
    assert.equal(statusOf(refused.text), 'Open', 'what an edit and a draft start from');
    assert.ok(!copyOf('roadmap', [refused.text]).includes('## Ready'), 'Copy as Markdown shows it in Open');
    assert.equal(cardStatus(renumbered(refused.text)), 'Open', 'a renumbered card keeps the status that stands');
  });

  test('a member takes a card with no owner, only where a run may start', () => {
    assert.equal(takeable(card([word(1, 1, 'Open')], null), 'Bo'), true);
    assert.equal(takeable(card([word(1, 1, 'Ready')], null), 'Bo'), true);
    assert.equal(takeable(card([word(1, 1, 'Running: o/r#3')], null), 'Bo'), false, 'a run names its section');
    assert.equal(takeable(card([word(1, 1, 'Open')]), 'Bo'), false, 'it has an owner');
  });

  test('a run starts from a Ready card, an Open one with no owner, or the user’s own pick', () => {
    assert.equal(startable(card([word(2, 1, 'Ready')]), 'Bo'), true);
    assert.equal(startable(card([word(1, 1, 'Open')]), 'Ann'), false, 'its owner marks it ready first');
    assert.equal(startable(card([word(1, 1, 'Open')], null), 'Bo'), true);
    const picked = card([word(3, 2, 'Running: Bo'), word(2, 1, 'Ready')]);
    assert.equal(startable(picked, 'Bo'), true, 'the member who picked it hands it to their agent');
    assert.equal(startable(picked, 'Cy'), false);
    assert.equal(otherRun('Running: Bo', 'Bo'), false);
    assert.equal(otherRun('Running: Bo', 'Cy'), true);
    for (const status of ['Running: Bo’s agent', 'Running: o/r#3', 'In review', 'Done on 2026-11-12']) assert.equal(startable(card([word(3, 1, status)]), 'Bo'), false, status);
    // The request signs the status it started from, which its claim replaces and its failure puts back.
    const run = (state: string) => statusMove({ request: 1, runtime: 9, state }, 'K-4', 'Running: Bo', workingStatus('Bo'));
    assert.deepEqual(run('claimed'), [['Running: Bo'], 'Running: Bo’s agent']);
    assert.deepEqual(run('failed'), [['Running: Bo’s agent', 'Waiting for a decision'], 'Running: Bo']);
  });

  test('only a member’s pick goes to review, never a run’s or a claim’s', () => {
    for (const status of ['Running: Ann’s agent', "Running: Ann's agent", 'Running: o/r#3']) assert.equal(moved(card([word(3, 2, status), word(2, 1, 'Ready')]), 'review', bo, today), null, status);
  });

  test('a Ready the owner gave stands after they closed it, since words are not history (limit 2)', () => {
    assert.equal(card([word(3, 2, 'Ready'), word(2, 1, 'Done on 2026-11-12')]).status, 'Ready');
  });

  test('only its owner removes a card with an owner; anyone removes one with none', () => {
    const row = (id: number, authorId: number, content: object | null) => ({ revision: { id, section: 's', authorId, createdAt: id }, content });
    const opened = row(1, 1, { text: text('Ready'), pos: 1, opened: true });
    const removal = (authorId: number) => row(5, authorId, { text: text('Ready'), pos: 1, removed: true });
    const [byBo] = cardsOf(cardSections([opened, row(2, 3, { text: text('Running: Cy'), pos: 1 }), removal(2)]), [1, 2, 3], {});
    assert.deepEqual([byBo.status, byBo.refused, byBo.text], ['Running: Cy', { status: null, by: 2 }, text('Running: Cy')], 'the card stays, from the words that are no removal');
    assert.deepEqual(cardsOf(cardSections([opened, removal(1)]), [1, 2, 3], {}), [], 'the owner removed it');
    assert.deepEqual(cardsOf(cardSections([opened, removal(2)]), [2, 3], {}), [], 'its owner left, so it has none');
    assert.deepEqual(cardsOf(cardSections([row(1, 1, { text: text('Open'), pos: 1 }), removal(2)]), [1, 2, 3], {}), [], 'an imported card');
    assert.deepEqual(cardsOf(cardSections([opened, removal(1), row(6, 2, { text: text('Ready'), pos: 1 })]), [1, 2, 3], {}), [], 'nobody brings back what its owner removed');
    assert.deepEqual(cardsOf(cardSections([opened, removal(1), row(6, 2, { text: text('Ready'), pos: 1, removed: true })]), [1, 2, 3], {}), [], 'not with a removal either');
    assert.equal(cardsOf(cardSections([opened, removal(1), row(6, 1, { text: text('Ready'), pos: 1 })]), [1, 2, 3], {}).length, 1, 'but its owner does, by writing it again');
    const healed = cardSections([opened, removal(2), row(6, 3, { text: text('Ready'), pos: 1 })])[0];
    assert.equal(healed.removedBy, undefined, 'the next write brings it back');
  });

  test("a card whose owner's newest revision does not open shows nobody else's gate as passed", () => {
    const row = (id: number, authorId: number, content: object | null) => ({ revision: { id, section: 's', authorId, createdAt: id }, content });
    const [failed] = cardsOf(cardSections([row(1, 1, { text: text('Ready'), pos: 1, opened: true }), row(2, 2, { text: text('Running: Bo'), pos: 1 }), row(3, 1, null)]), [1, 2, 3], {});
    assert.deepEqual([failed.failed, failed.status, failed.refused], [true, 'Open', { status: 'Running: Bo', by: 2 }]);
  });

  test('a revision that says opened but is not the oldest gives no owner', () => {
    const row = (id: number, authorId: number, content: object) => ({ revision: { id, section: 's', authorId, createdAt: id }, content });
    const [later] = cardSections([row(1, 2, { text: text('Open'), pos: 1 }), row(2, 1, { text: text('Open'), pos: 1, opened: true })]);
    assert.equal(cardOf(later, [1, 2], {}).owner, undefined);
  });
});

describe('Reviews on a card in client/src/board.ts (the card-review decision)', () => {
  // Ann (1) opened the card; Bo (2), Cy (3) and Dan (4) are members.
  const [ann, bo, cy, dan] = [
    { id: 1, username: 'ann', displayName: 'Ann' },
    { id: 2, username: 'bo', displayName: 'Bo' },
    { id: 3, username: 'cy', displayName: 'Cy' },
    { id: 4, username: 'dan', displayName: 'Dan' },
  ];
  const names = { 1: 'ann', 2: 'bo', 3: 'cy', 4: 'dan' };
  const today = new Date(2026, 10, 13);
  type Save = [number, string];
  const text = (status: string, reviews: string[] = []) => cardText('K-4', 'Fix it', status, withReviews('Seen: on a phone.', reviews));

  test('a hand edit keeps the review lines that stood when it began', () => {
    const asked = 'Review: @dan Changes requested 2026-11-13: The empty state is missing.';
    const stood = text('In review', [asked]);
    assert.equal(keepReviews(stood, [asked]), stood, 'typed as they stand, so nothing changes');
    assert.equal(keepReviews(text('In review'), [asked]), stood, 'a change request deleted by hand comes back');
    assert.equal(keepReviews(text('In review', ['Review: @dan Approved 2026-11-12.']), [asked]), stood, 'an old draft does not revive an approval');
    assert.equal(keepReviews(text('In review', [`${asked} Accepted 2026-11-13.`]), [asked]), stood, 'an answer comes from its button');
    assert.equal(keepReviews(stood, []), text('In review'), 'a typed line with no review behind it goes');
    const typo = stood.replace('on a phone', 'on a tablet');
    assert.equal(keepReviews(typo, [asked]), typo, 'the rest of the text is as typed');
  });
  /** The card after these saves, oldest first, as every page reads it: the newest text and each member's newest save. */
  const after = (saves: Save[], members = [1, 2, 3, 4], openedBy = 1) => {
    const words = new Map(saves.map(([authorId, written], i) => [authorId, { id: i + 1, authorId, text: written }]));
    const [authorId, newest] = saves.at(-1)!;
    // As `usernamesOf` names them: the members now.
    return cardOf({ id: 's', text: newest, pos: 1, failed: false, authorId, openedBy, words: [...words.values()].sort((a, b) => b.id - a.id) }, members, Object.fromEntries(members.map((id) => [id, names[id as 1]])));
  };
  /** The saves with a member's move, made by an honest page from the card as it stands. */
  const play = (saves: Save[], user: typeof ann, move: unknown): Save[] => {
    const next = moved(after(saves), move, user, today);
    assert.ok(next, `${user.username} may ${JSON.stringify(move)}`);
    return [...saves, [user.id, next]];
  };
  const linesOf = (written: string) => written.split('\n').filter((l) => l.startsWith('Review: '));
  const verdicts = (saves: Save[], members?: number[]) => after(saves, members).reviews.map((r: { name: string; verdict: string; answer?: string }) => [r.name, r.verdict, r.answer]);
  // The card a member picked and sent to review, once its owner marked it ready.
  const inReview = play(play([[1, text('Ready')]], bo, 'pick'), bo, 'review');
  const changed = play(play(inReview, bo, { request: dan }), dan, { changes: 'The empty\nstate is missing.' });

  test('a member asks for a review, and the reviewer approves or asks for changes, in the pull request tags’ words', () => {
    const asked = play(inReview, bo, { request: dan });
    assert.deepEqual(linesOf(asked.at(-1)![1]), ['Review: @dan Review required. Asked by @bo 2026-11-13.']);
    assert.equal(moved(after(asked), { request: dan }, cy, today), null, 'not someone who has a line');
    assert.equal(moved(after(asked), 'approve', cy, today), null, 'only someone asked, or who asked themself, reviews');
    assert.deepEqual(linesOf(play(asked, dan, 'approve').at(-1)![1]), ['Review: @dan Approved 2026-11-13.']);
    assert.deepEqual(linesOf(changed.at(-1)![1]), ['Review: @dan Changes requested 2026-11-13: The empty state is missing.'], 'a note is one line');
    assert.equal(moved(after(asked), { changes: ' ' }, dan, today), null, 'a change needs a note');
    assert.equal(moved(after(play([[1, text('Ready')]], bo, 'pick')), { request: dan }, bo, today), null, 'only in review');
  });

  test('only the owner answers a requested change, runs it again or closes it', () => {
    const accepted = play(changed, ann, { accept: 4 });
    for (const move of [{ accept: 4 }, { decline: 4 }, 'close']) assert.equal(moved(after(changed), move, bo, today), null, JSON.stringify(move));
    assert.equal(moved(after(accepted), 'again', bo, today), null);
    assert.equal(moved(after(accepted), 'again', dan, today), null, 'not the reviewer either');
    assert.deepEqual(linesOf(accepted.at(-1)![1]), ['Review: @dan Changes requested 2026-11-13: The empty state is missing. Accepted 2026-11-13.']);
    assert.deepEqual(verdicts(play(changed, ann, { decline: 4 })), [['dan', 'changes_requested', 'declined']]);
    assert.equal(moved(after(accepted), { decline: 4 }, ann, today), null, 'an answer stands');
  });

  test('the owner closes only after an approval, and not while a change is pending or accepted', () => {
    assert.equal(moved(after(inReview), 'close', ann, today), null, 'no approval');
    const approved = play(play(changed, bo, { request: cy }), cy, 'approve');
    assert.equal(moved(after(approved), 'close', ann, today), null, 'a change is pending');
    assert.equal(moved(after(play(approved, ann, { accept: 4 })), 'close', ann, today), null, 'a change is accepted and not done');
    assert.equal(after(play(play(approved, ann, { decline: 4 }), ann, 'close')).status, 'Fixed on 2026-11-13', 'a declined change blocks nothing');
    assert.equal(after(play(play(changed, dan, 'approve'), ann, 'close')).status, 'Fixed on 2026-11-13', 'a reviewer who approves takes back their change');
  });

  test('a verdict in someone else’s name does not count, and the owner’s next write drops it', () => {
    // Bo's changed client writes Dan's approval and Ann's answer.
    const forged = [...changed, [2, text('In review', ['Review: @dan Approved 2026-11-13.', 'Review: @cy Approved 2026-11-13.'])] as Save];
    assert.deepEqual(verdicts(forged), [['dan', 'changes_requested', undefined]], 'Dan’s own change still stands');
    assert.equal(moved(after(forged), 'close', ann, today), null);
    const answered = [...changed, [2, text('In review', ['Review: @dan Changes requested 2026-11-13: The empty state is missing. Accepted 2026-11-13.'])] as Save];
    assert.deepEqual(verdicts(answered), [['dan', 'changes_requested', undefined]], 'an answer counts only from the owner');
    assert.equal(moved(after(answered), 'again', ann, today), null);
    assert.equal(after(forged).text, text('In review', ['Review: @dan Changes requested 2026-11-13: The empty state is missing.']), 'every page writes the reviews that stand');
    assert.deepEqual(linesOf(play(forged, ann, { decline: 4 }).at(-1)![1]), ['Review: @dan Changes requested 2026-11-13: The empty state is missing. Declined 2026-11-13.'], 'the owner signs only what stands');
  });

  test('a change request someone deleted still blocks the close', () => {
    const approved = play(play(changed, bo, { request: cy }), cy, 'approve');
    const deleted = [...approved, [2, text('In review', ['Review: @cy Approved 2026-11-13.'])] as Save];
    assert.deepEqual(verdicts(deleted), [['cy', 'approved', undefined], ['dan', 'changes_requested', undefined]]);
    assert.equal(moved(after(deleted), 'close', ann, today), null);
    // Once the owner repeats it, it stands from their word even when Dan's word is older.
    const accepted = play(deleted, ann, { accept: 4 });
    assert.deepEqual(verdicts([...accepted, [2, text('In review')] as Save]), [['cy', 'approved', undefined], ['dan', 'changes_requested', 'accepted']]);
  });

  test('Run again asks again for each accepted change and drops every other verdict, so an old approval no longer counts', () => {
    const approved = play(play(changed, bo, { request: cy }), cy, 'approve');
    assert.equal(moved(after(approved), 'again', ann, today), null, 'not while a change is unanswered');
    const rerun = play(play(approved, ann, { accept: 4 }), ann, 'again');
    assert.equal(after(rerun).status, 'Running: Ann');
    assert.deepEqual(linesOf(rerun.at(-1)![1]), ['Review: @dan Review required. Asked by @ann 2026-11-13.']);
    const back = play(rerun, bo, 'review');
    assert.deepEqual(verdicts(back), [['dan', 'review_required', undefined]]);
    assert.equal(moved(after(back), 'close', ann, today), null, 'Cy’s approval was of the work before');
    const replayed = [...back, [2, text('In review', ['Review: @cy Approved 2026-11-13.'])] as Save];
    assert.deepEqual(verdicts(replayed), [], 'nor when someone writes it back');
    assert.equal(after(play(play(back, dan, 'approve'), ann, 'close')).status, 'Fixed on 2026-11-13');
  });

  test('while a verdict stands, only the owner runs the card again', () => {
    const running = [...changed, [2, text('Running: Bo', linesOf(changed.at(-1)![1]))] as Save];
    assert.deepEqual([after(running).status, after(running).refused], ['In review', { status: 'Running: Bo', by: 2 }], 'a change stands');
    const approved = play(play(inReview, bo, { request: cy }), cy, 'approve');
    assert.equal(after([...approved, [2, text('Running: Bo')] as Save]).status, 'In review', 'an approval stands');
    assert.equal(after([...inReview, [2, text('Running: Bo')] as Save]).status, 'Running: Bo', 'with no verdict, as before');
    // Back in Open, which any member may set, its owner's Mark ready starts over without the reviews.
    const readied = play([...approved, [2, text('Open', ['Review: @cy Approved 2026-11-13.'])]], ann, 'ready');
    assert.deepEqual([linesOf(readied.at(-1)![1]), verdicts(readied)], [[], []]);
    assert.equal(after(play(readied, bo, 'pick')).status, 'Running: Bo');
  });

  test('the owner reviews their own card, and a reviewer who left counts for nothing', () => {
    const own = play(play(inReview, ann, { request: ann }), ann, 'approve');
    assert.equal(after(play(own, ann, 'close')).status, 'Fixed on 2026-11-13');
    assert.deepEqual(verdicts(changed, [1, 2, 3]), [], 'Dan left');
    assert.equal(after(changed, [1, 2, 3]).text.includes('@dan'), false, 'so pages drop his line');
  });

  test('a card with no owner reads its reviews from the newest text, and nobody closes it by button', () => {
    const saves: Save[] = [[2, text('In review', ['Review: @dan Approved 2026-11-13.', 'Review: @eve Approved 2026-11-13.'])]];
    // An opener who is no member, as when they left.
    const ownerless = after(saves, [1, 2, 3, 4], 5);
    assert.deepEqual(ownerless.reviews.map((r: { name: string }) => r.name), ['dan'], 'only members review');
    assert.equal(moved(ownerless, 'close', bo, today), null);
  });

  test('while a verdict stands, nobody but the owner moves the card off the status its reviewers saw', () => {
    const approved = play(play(inReview, bo, { request: dan }), dan, 'approve');
    // Mallory (Cy here) is no owner: she signs Ready, starts her own run, and its done writes In review.
    const ready = [...approved, [3, text('Ready', ['Review: @dan Approved 2026-11-13.'])] as Save];
    assert.deepEqual([after(ready).status, after(ready).refused], ['In review', { status: 'Ready', by: 3 }]);
    const ran = [...approved, [3, text('In review: o/r#9', ['Review: @dan Approved 2026-11-13.'])] as Save];
    assert.deepEqual([after(ran).status, after(ran).refused], ['In review', { status: 'In review: o/r#9', by: 3 }]);
    assert.equal(after([...approved, [3, text('Open')] as Save]).status, 'Open', 'Open stands from anyone');
    assert.equal(after([...approved, [3, text('Fixed in o/r#3')] as Save]).status, 'Fixed in o/r#3', 'and a merge');
    // A requester's page puts the card back where the run started when its draft closes unmerged (D-118).
    const draft = play([[1, text('Ready')]], bo, 'pick');
    const inPull = [...draft, [2, text('In review: o/r#3')] as Save];
    const reviewed = play(play(inPull, bo, { request: dan }), dan, 'approve');
    const [from, to] = statusMove({ request: 1, runtime: 9, state: 'closed', pull: { repo: 'o/r', number: 3 } }, 'K-4', 'Ready', workingStatus('Bo'));
    const card = after(reviewed);
    assert.ok(from.includes(card.status));
    const closed = [...reviewed, [2, withStatus(card.text, to)] as Save];
    assert.deepEqual([after(closed).status, after(closed).refused], ['In review: o/r#3', { status: 'Ready', by: 2 }], 'it stays in review, refused');
    // The owner's way out: Mark ready from In review, which drops the reviews.
    const readied = play(closed, ann, 'ready');
    assert.deepEqual([after(readied).status, linesOf(readied.at(-1)![1]), verdicts(readied)], ['Ready', [], []]);
    assert.equal(moved(after(closed), 'ready', bo, today), null, 'only the owner');
    assert.equal(after(play(readied, bo, 'pick')).status, 'Running: Bo');
  });

  test('a change with no note does not count', () => {
    const asked = play(inReview, bo, { request: dan });
    const bare = [...asked, [4, text('In review', ['Review: @dan Changes requested 2026-11-13.'])] as Save];
    assert.deepEqual(verdicts(bare), [], 'so it is no line at all');
    assert.equal(moved(after(bare), { accept: 4 }, ann, today), null);
  });

  test('no verdict counts while the owner has no word', () => {
    const approved = play(play(inReview, bo, { request: dan }), dan, 'approve');
    const words = new Map(approved.map(([authorId, written], i) => [authorId, { id: i + 1, authorId, text: written }]));
    words.delete(1);
    const [authorId, newest] = approved.at(-1)!;
    const card = cardOf({ id: 's', text: newest, pos: 1, failed: false, authorId, openedBy: 1, words: [...words.values()].sort((a, b) => b.id - a.id) }, [1, 2, 3, 4], names);
    assert.deepEqual(card.reviews, []);
  });

  test('an agent reviews nothing', () => {
    assert.deepEqual(usernamesOf([1, 9], { 1: { username: 'ann', agentOwner: null }, 9: { username: 'anns-agent', agentOwner: 1 } }, null), { 1: 'ann' });
  });
});

test('a run brief is the card, then the decisions the team holds, without the superseded ones (D-105)', async () => {
  const { briefText, cardStatus } = await import('../shared/types.ts');
  const card = '### K-1: Bad keys\n\nStatus: Open.\n\nSeen: on a phone.\n';
  const held = '### D-1: Keys rotate\n\nStatus: Accepted.';
  const gone = '### D-2: Keys never rotate\n\nStatus: Superseded by D-1.';
  assert.equal(cardStatus(gone), 'Superseded by D-1');
  assert.equal(briefText(card, [held, gone]), `${card.trim()}\n\n${held}`);
});
