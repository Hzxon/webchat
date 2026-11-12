import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module. tsx still loads it.
const clientBoard = '../client/src/board.ts';

const { cardOf, cardsOf, cardRuns, cardSections, cardTemplate, cardText, statusMove, GOING, duplicates, idOf, groupOf, moved, otherRun, parseCard, runnerOf, standing, startable, takeable, unchecked, withChecked, withStatus, workingStatus } = await import(clientBoard);

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
    assert.equal(cardOf(opened, [3, 4]).owner, 4);
    assert.equal(cardOf(opened, [3]).owner, undefined, 'an owner who left owns nothing');
    assert.equal(cardOf(section('a', '### K-1: Bug'), [3, 4]).owner, undefined, 'an imported card has no owner');
    assert.equal(cardOf(opened, [4]).title, 'Bug');
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
    assert.equal(cardOf(c, [1, 2, 3]), null, 'its owner removed it, so it is gone');
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
    cardOf({ id: 's', text: words[0]!.text, pos: 1, failed: false, authorId: words[0]!.authorId, openedBy: openedBy ?? undefined, words }, members);
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
    const review = card([word(3, 2, 'In review: o/r#3'), word(2, 1, 'Ready')]);
    assert.equal(moved(review, 'close', bo, today), null);
    assert.equal(statusOf(moved(review, 'close', ann, today)), 'Fixed in o/r#3', 'an issue is fixed, in its pull request');
    assert.equal(statusOf(moved(card([word(3, 2, 'In review'), word(2, 1, 'Ready')]), 'close', ann, today)), 'Fixed on 2026-11-12');
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
    const [byBo] = cardsOf(cardSections([opened, row(2, 3, { text: text('Running: Cy'), pos: 1 }), removal(2)]), [1, 2, 3]);
    assert.deepEqual([byBo.status, byBo.refused, byBo.text], ['Running: Cy', { status: null, by: 2 }, text('Running: Cy')], 'the card stays, from the words that are no removal');
    assert.deepEqual(cardsOf(cardSections([opened, removal(1)]), [1, 2, 3]), [], 'the owner removed it');
    assert.deepEqual(cardsOf(cardSections([opened, removal(2)]), [2, 3]), [], 'its owner left, so it has none');
    assert.deepEqual(cardsOf(cardSections([row(1, 1, { text: text('Open'), pos: 1 }), removal(2)]), [1, 2, 3]), [], 'an imported card');
    assert.deepEqual(cardsOf(cardSections([opened, removal(1), row(6, 2, { text: text('Ready'), pos: 1 })]), [1, 2, 3]), [], 'nobody brings back what its owner removed');
    assert.deepEqual(cardsOf(cardSections([opened, removal(1), row(6, 2, { text: text('Ready'), pos: 1, removed: true })]), [1, 2, 3]), [], 'not with a removal either');
    assert.equal(cardsOf(cardSections([opened, removal(1), row(6, 1, { text: text('Ready'), pos: 1 })]), [1, 2, 3]).length, 1, 'but its owner does, by writing it again');
    const healed = cardSections([opened, removal(2), row(6, 3, { text: text('Ready'), pos: 1 })])[0];
    assert.equal(healed.removedBy, undefined, 'the next write brings it back');
  });

  test("a card whose owner's newest revision does not open shows nobody else's gate as passed", () => {
    const row = (id: number, authorId: number, content: object | null) => ({ revision: { id, section: 's', authorId, createdAt: id }, content });
    const [failed] = cardsOf(cardSections([row(1, 1, { text: text('Ready'), pos: 1, opened: true }), row(2, 2, { text: text('Running: Bo'), pos: 1 }), row(3, 1, null)]), [1, 2, 3]);
    assert.deepEqual([failed.failed, failed.status, failed.refused], [true, 'Open', { status: 'Running: Bo', by: 2 }]);
  });

  test('a revision that says opened but is not the oldest gives no owner', () => {
    const row = (id: number, authorId: number, content: object) => ({ revision: { id, section: 's', authorId, createdAt: id }, content });
    const [later] = cardSections([row(1, 2, { text: text('Open'), pos: 1 }), row(2, 1, { text: text('Open'), pos: 1, opened: true })]);
    assert.equal(cardOf(later, [1, 2]).owner, undefined);
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
