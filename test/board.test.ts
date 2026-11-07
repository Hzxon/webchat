import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module. tsx still loads it.
const clientBoard = '../client/src/board.ts';

const { cardRuns, cardTemplate, GOING, duplicates, idOf, groupOf, otherRun, parseCard, unchecked, withChecked, withStatus, workingStatus } = await import(clientBoard);

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

  test('a status keeps its date and loses its final period', () => {
    const card = parseCard(section('a', '### D-7: Keep the lock\n\nStatus: Accepted 2026-11-04.\n\nWhy: it works.'));
    assert.equal(card.status, 'Accepted 2026-11-04');
    assert.equal(card.body, 'Why: it works.');
    assert.equal(groupOf('decisions', card.status), 1);
    assert.equal(groupOf('roadmap', 'In progress on branch x'), 0);
    assert.equal(groupOf('roadmap', 'In review: o/r#3'), 1);
    assert.equal(groupOf('roadmap', 'Fixed in #12'), 4);
    assert.equal(groupOf('roadmap', 'Something else'), 3);
  });

  test('a new status replaces the status line, or goes under the heading', () => {
    const card = (text: string) => parseCard(section('a', text));
    const moved = card(withStatus('### K-1: Bug\n\nStatus: Open.\n\nSeen: here', 'In review: o/r#3'));
    assert.deepEqual([moved.status, moved.body], ['In review: o/r#3', 'Seen: here']);
    const added = card(withStatus('### K-1: Bug\n\nSeen: here', 'In review'));
    assert.deepEqual([added.title, added.status, added.body], ['Bug', 'In review', 'Seen: here']);
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
  });

  test('a status that shows another run of the card refuses a second one (K-59)', () => {
    assert.equal(otherRun('In progress: Ann’s agent', 'Bob'), true, 'a teammate’s agent runs it');
    assert.equal(otherRun(workingStatus('Ann'), 'Ann'), false, 'my own run, which the play button already holds');
    assert.equal(otherRun('In review: o/r#3', 'Ann'), true, 'a draft is open');
    assert.equal(otherRun('In review', 'Ann'), true);
    assert.equal(otherRun('In progress', 'Ann'), false, 'set by hand, no run named');
    assert.equal(otherRun('Open', 'Ann'), false);
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
