import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module. tsx still loads it.
const clientBoard = '../client/src/board.ts';

const { cardRuns, cardTemplate, GOING, columnMarkdown, duplicates, groupOf, nextNumber, parseCard, withStatus } = await import(clientBoard);

const section = (id: string, text: string) => ({ id, text, pos: 1, failed: false });

describe('Board cards in client/src/board.ts (R-021, D-082)', () => {
  test('each template reads back as its kind, number, title and status', () => {
    const d = parseCard(section('a', cardTemplate('D', 3)));
    assert.deepEqual([d.kind, d.number, d.title, d.status], ['D', 3, 'Title', 'Proposed']);
    assert.ok(d.body.startsWith('What was decided'));
    assert.deepEqual(parseCard(section('b', cardTemplate('R', 12))).status, 'Idea');
    assert.deepEqual(parseCard(section('c', cardTemplate('K', 1))).status, 'Open');
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

  test('a card without the heading is titled by its first line and has no number', () => {
    const card = parseCard(section('a', '\n## Just a note\n\nStatus: Open.\nBody'));
    assert.deepEqual([card.kind, card.number, card.title, card.status], [null, null, 'Just a note', '']);
    assert.equal(card.body, '## Just a note\n\nStatus: Open.\nBody');
  });

  test('the next free number skips the numbers in use, by kind', () => {
    const cards = ['### R-1: a', '### R-4: b', '### K-2: c', 'no heading'].map((t, i) => parseCard(section(String(i), t)));
    assert.equal(nextNumber(cards, 'R'), 5);
    assert.equal(nextNumber(cards, 'K'), 3);
    assert.equal(nextNumber(cards, 'D'), 1);
  });

  test('two cards with one number are both flagged', () => {
    const cards = ['### D-1: a', '### D-1: b', '### D-2: c'].map((t, i) => parseCard(section(String(i), t)));
    assert.deepEqual([...duplicates(cards)], ['0', '1']);
  });

  test('the column copies as the repository file, ideas before issues, in number order', () => {
    const cards = ['### K-1: issue', '### R-2: later', '### R-1: first'].map((t, i) => parseCard(section(String(i), t)));
    assert.equal(columnMarkdown('roadmap', cards), '# Roadmap\n\n### R-1: first\n\n### R-2: later\n\n### K-1: issue\n');
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
    assert.deepEqual(state([ask(1, 'a'), { id: 2, senderId: 1, run: { kind: 'cancel', request: 1 } }]), ['cancelled', false]);
    assert.deepEqual(state([ask(1, 'a'), report(1, 'failed'), ask(2, 'a')]), ['waiting', true], 'a new request replaces the old');
    assert.deepEqual(state([ask(1, 'a'), ask(2, 'a'), report(1, 'done')]), ['waiting', true], 'an old run reports into nothing');
    assert.equal(runs([{ ...ask(1, 'a'), senderId: 3 }, ask(2, 'b', { docId: 'other' })]).size, 0, 'only my requests on this doc');
  });
});
