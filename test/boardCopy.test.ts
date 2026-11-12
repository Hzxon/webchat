import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COPY_MARK, copyOf, entriesOf, proposalOf, readCard } from '../shared/board.ts';

// A card in the form the board writes it: heading, status line, then the body if there is one.
const card = (id: string, title: string, status: string, body = '') => `### ${id}: ${title}\n\nStatus: ${status}.${body && `\n\n${body}`}`;

const decisionsHeader = `# Decisions\n\n${COPY_MARK} Decisions column of the project's board in WebChat, which its owner's agent writes. Do not edit it by hand: a pull request proposes a new decision as a file under \`docs/decisions/\`, or a change to one as \`docs/decisions/D-12.md\`. Find an entry by its number, such as D-021.`;
const roadmapHeader = `# Roadmap\n\n${COPY_MARK} Roadmap column of the project's board in WebChat, which its owner's agent writes. Do not edit it by hand: a pull request proposes a new entry as a file under \`docs/roadmap/\`, named by a short name such as \`new-bark-banner.md\`, or a change to one as \`docs/roadmap/K-12.md\`.`;

test('a status in the old words reads in the new ones, with the rest of its line kept (the board-lanes decision)', () => {
  const status = (line: string) => readCard(`### K-1: Bug\n\nStatus: ${line}.`)!.status;
  assert.equal(status('In progress: Ann’s agent'), 'Running: Ann’s agent');
  assert.equal(status('IN PROGRESS on branch x'), 'Running on branch x');
  assert.equal(status('Next'), 'Ready');
  assert.equal(status('Planned for June'), 'Ready for June');
  assert.equal(status('Nextcloud is done'), 'Nextcloud is done', 'only a whole word');
  assert.equal(status('Open'), 'Open');
});

test('a card reads as its id, number, title, status and body, and keeps its zero padding (R-040)', () => {
  assert.deepEqual(readCard('\n### R-005: Photos and files\n\nStatus: Ready. Set aside.\n\nWhy: x.\n\nScope: y.\n'), {
    kind: 'R',
    number: 5,
    id: 'R-005',
    title: 'Photos and files',
    status: 'Ready. Set aside',
    body: 'Why: x.\n\nScope: y.',
  });
  assert.deepEqual(readCard('### Q-1: Does it?\n\nIt might.'), { kind: 'Q', number: 1, id: 'Q-1', title: 'Does it?', status: '', body: 'It might.' });
  assert.deepEqual(readCard('### D-13: Only a heading'), { kind: 'D', number: 13, id: 'D-13', title: 'Only a heading', status: '', body: '' });
});

test('a text without a card heading as its first line is no card (R-040)', () => {
  for (const text of ['', '\n\n', 'Status: Open.', '## K-1: Two hashes', '### Title only', '### X-1: Unknown kind', '### K: No number', 'Text\n### K-1: Not first']) {
    assert.equal(readCard(text), null, JSON.stringify(text));
  }
});

test('the decisions copy lists the held decisions in number order, then the superseded ones (R-040)', () => {
  const d1 = card('D-001', 'First', 'Accepted 2026-11-01', 'One.');
  const d2 = card('D-2', 'Replaced', 'superseded by D-12 in #5', 'Two.');
  const d3 = card('D-3', 'Third', 'Partly superseded by D-12', 'Three.');
  const d12 = card('D-12', 'Twelfth', 'Proposed');
  const d13 = card('D-13', 'Gone too', 'Superseded by D-12');
  const copy = copyOf('decisions', [`\n${d12}\n\n`, d13, d3, d2, 'Not a card.', d1]);
  assert.equal(copy, `${decisionsHeader}\n\n${d1}\n\n${d3}\n\n${d12}\n\n## Superseded\n\n${d2}\n\n${d13}\n`);
});

test('the decisions copy has no Superseded heading when nothing is superseded, and ends in one newline (R-040)', () => {
  const copy = copyOf('decisions', [card('D-2', 'Two', 'Proposed'), card('D-1', 'One', 'Accepted')]);
  assert.ok(copy.startsWith(`# Decisions\n\n${COPY_MARK} Decisions column`));
  assert.ok(!copy.includes('## Superseded'));
  assert.ok(copy.endsWith('Status: Proposed.\n') && !copy.endsWith('\n\n'));
  assert.equal(copyOf('decisions', []), `${decisionsHeader}\n`, 'an empty column is its header');
});

test('the roadmap copy files each card by its status, or by its kind, in the order of its sections (R-040)', () => {
  const copy = copyOf('roadmap', [
    card('R-9', 'Late idea', 'Idea', 'Why.'),
    card('Q-2', 'Question', 'Open'),
    card('K-4', 'Issue', 'Open'),
    card('R-2', 'Early idea', 'Blocked on Q-2'),
    card('K-3', 'Reviewed', 'In review: o/r#3'),
    card('K-2', 'Held', 'Waiting for a decision'),
    card('R-5', 'Working', 'IN PROGRESS on branch x'),
    card('R-6', 'Picked', 'Running: Ann’s agent'),
    card('R-7', 'Waiting to be picked', 'Ready'),
    card('Q-7', 'Held up', 'Planned'),
    card('K-8', 'Next up', 'next'),
    card('K-1', 'Gone', 'Dropped on 2026-11-04'),
    card('R-4', 'Shipped', 'Done in #3', 'Left out of the copy.'),
    card('K-6', 'Repaired', 'Fixed in #4', 'Left out too.'),
    card('Q-1', 'First question', 'Open'),
  ]);
  const outline = copy.split('\n').filter((l) => /^#{1,3} /.test(l));
  assert.deepEqual(outline, [
    '# Roadmap',
    '## Running',
    '### R-5: Working',
    '### R-6: Picked',
    '### K-2: Held',
    '### K-3: Reviewed',
    '## Ready',
    '### R-7: Waiting to be picked',
    '### K-8: Next up',
    '### Q-7: Held up',
    '## Ideas',
    '### R-2: Early idea',
    '### R-9: Late idea',
    '## Known issues',
    '### K-4: Issue',
    '## Open questions',
    '### Q-1: First question',
    '### Q-2: Question',
    '## Dropped',
    '### K-1: Gone',
    '## Done',
  ]);
  assert.ok(copy.startsWith(`${roadmapHeader}\n\n## Running\n\n### R-5: Working\n\nStatus: IN PROGRESS on branch x.\n\n### R-6`));
  assert.ok(copy.endsWith('\n') && !copy.endsWith('\n\n'));
  assert.ok(!copy.includes('Left out'), 'a Done card is only its row');
});

test('the roadmap copy shows only the sections that have cards (R-040)', () => {
  const idea = card('R-1', 'Idea', 'Idea', 'Why.');
  const done = card('R-021', 'Project board of decisions and roadmap cards', 'Done in #75', 'Gone from the copy.');
  assert.equal(copyOf('roadmap', [done, idea]), `${roadmapHeader}\n\n## Ideas\n\n${idea}\n\n## Done\n\n| Work | Where |\n| --- | --- |\n| R-021: Project board of decisions and roadmap cards | #75 |\n`);
  assert.equal(copyOf('roadmap', []), `${roadmapHeader}\n`);
  assert.ok(copyOf('roadmap', [card('D-1', 'Typed in the wrong column', 'Accepted')]).includes('## Ideas\n\n### D-1: '), 'a decision in the roadmap is not dropped');
});

test('the Done table gives the pull requests as Where, escapes pipes and orders its rows (R-040)', () => {
  const rows = copyOf('roadmap', [
    card('K-12', 'Late', 'Fixed in #43'),
    card('R-27', 'Several', 'Done in #85, #86 and #89'),
    card('K-10', 'Same pull request', 'Done in #7'),
    card('K-9', 'Same pull request, lower number', 'Done in #7'),
    card('R-3', 'Same pull request, an idea', 'Done in #7'),
    card('K-5', 'Pipes | in the title', 'Done in #1'),
    card('K-20', 'No number', 'Fixed in 74d53ff'),
    card('R-1', 'No number either', 'Done on 2026-11-06 by a|b'),
    card('K-21', 'The first number counts', 'Done in #90, then #2'),
  ])
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Work') && !l.startsWith('| ---'));
  assert.deepEqual(rows, [
    '| K-5: Pipes \\| in the title | #1 |',
    '| R-3: Same pull request, an idea | #7 |',
    '| K-9: Same pull request, lower number | #7 |',
    '| K-10: Same pull request | #7 |',
    '| K-12: Late | #43 |',
    '| R-27: Several | #85, #86, #89 |',
    '| K-21: The first number counts | #90, #2 |',
    '| R-1: No number either | Done on 2026-11-06 by a\\|b |',
    '| K-20: No number | Fixed in 74d53ff |',
  ]);
});

const decisionsFile = `# Decisions

This is the log. It has prose, and mentions a heading, \`### D-9: Not an entry\`.

## How to add an entry

- A list item.

## Product and scope

### D-001: Audience and product direction

Accepted 2026-11-01.

WebChat exists because x.

#### A sub-heading stays in the body

Cost: y.

### D-039: Owners remove people

Partly superseded by D-044 and D-045: removal gives each chat a new key.
Accepted 2026-11-01 in #4. Replaces D-028.

Body line.

### R-1: Not a decision

Status: Idea.

### D-040: Already has a status

Status: Accepted 2026-11-02 in #6.

## Superseded

Decisions that no longer hold.

### D-028: No leaving or removal before key rotation

Superseded by D-039. Accepted 2026-11-01 in #2.

### D-041: Only a status

Accepted 2026-11-01 in #7.
`;

test('decisions import without their topics and prose, with a wrapped status joined and a superseded one kept (R-040)', () => {
  const cards = entriesOf('decisions', decisionsFile);
  assert.deepEqual(cards, [
    '### D-001: Audience and product direction\n\nStatus: Accepted 2026-11-01.\n\nWebChat exists because x.\n\n#### A sub-heading stays in the body\n\nCost: y.',
    '### D-039: Owners remove people\n\nStatus: Partly superseded by D-044 and D-045: removal gives each chat a new key. Accepted 2026-11-01 in #4. Replaces D-028.\n\nBody line.',
    '### D-040: Already has a status\n\nStatus: Accepted 2026-11-02 in #6.',
    '### D-028: No leaving or removal before key rotation\n\nStatus: Superseded by D-039. Accepted 2026-11-01 in #2.',
    '### D-041: Only a status\n\nStatus: Accepted 2026-11-01 in #7.',
  ]);
  const [one, two] = cards.map((t) => readCard(t));
  assert.equal(one?.status, 'Accepted 2026-11-01');
  assert.equal(two?.status, 'Partly superseded by D-044 and D-045: removal gives each chat a new key. Accepted 2026-11-01 in #4. Replaces D-028');
  assert.equal(two?.body, 'Body line.');
});

const roadmapFile = `# Roadmap

Intro prose.

## How to use this file

- Status values: Next, Planned.

## Planned

### R-005: Photos and files

Status: Planned.

Why: students share drafts.

### K-59: Two agents can run one card

Status: Fixed in #143. Found on 2026-11-06 while reading a file for
the design of R-036.

The board disables the button.

### R-006: An idea with no status

A mention.

## Open questions

### Q-1: Should updates move to WebSockets?

Vercel Functions can now hold WebSockets.

### Q-9: A question with a status

Status: Answered in #117.

## Done

Finished work.

| Work | Where |
| --- | --- |
| Chat with push notifications and urgent alerts | 74d53ff |
| K-36: A deploy reloads a tab only when the page changes | #66 |
| R-005: Photos and files, finished early | #200 |
| K-53 to K-56: The plugin refuses runs; the guard resolves links | #118 |
| Known issues K-1 to K-4: reload after deploy | #6 |
| K-40: Keyring \\| exists twice | #147
| K-36: A deploy reloads a tab only when the page changes, again | #67 |
`;

test('roadmap entries and Done rows import as cards, and a full entry beats a row of the same id (R-040)', () => {
  assert.deepEqual(entriesOf('roadmap', roadmapFile), [
    '### R-005: Photos and files\n\nStatus: Planned.\n\nWhy: students share drafts.',
    '### K-59: Two agents can run one card\n\nStatus: Fixed in #143. Found on 2026-11-06 while reading a file for the design of R-036.\n\nThe board disables the button.',
    '### R-006: An idea with no status\n\nStatus: Idea.\n\nA mention.',
    '### Q-1: Should updates move to WebSockets?\n\nStatus: Open.\n\nVercel Functions can now hold WebSockets.',
    '### Q-9: A question with a status\n\nStatus: Answered in #117.',
    // The later row wins, in the place of the first.
    '### K-36: A deploy reloads a tab only when the page changes, again\n\nStatus: Done in #67.',
    '### K-53: The plugin refuses runs; the guard resolves links\n\nStatus: Done in #118.',
    '### K-40: Keyring | exists twice\n\nStatus: Done in #147.',
  ]);
});

test('one id is one card, zeros aside: an entry beats a row wherever it stands, and the later of two entries wins (R-040)', () => {
  const file = '## Done\n\n| K-1: A row | #1 |\n| K-2: Another row | #2 |\n\n## Known issues\n\n### K-01: An entry\n\nStatus: Open.\n\n### K-3: First\n\nStatus: Open.\n\n### K-3: Second\n\nStatus: Open.\n';
  assert.deepEqual(entriesOf('roadmap', file), ['### K-01: An entry\n\nStatus: Open.', '### K-2: Another row\n\nStatus: Done in #2.', '### K-3: Second\n\nStatus: Open.']);
});

test('only the rows of the Done table become cards, and a row with no Where is Done with no pull request (R-040)', () => {
  const file = '## Planned\n\n| R-7: A table in prose | Next |\n\n## Done\n\n| Work | Where |\n| --- | --- |\n| R-8: No where |\n| R-9: Empty where | |\n\n## Notes\n\n| R-10: Another table | #10 |\n';
  assert.deepEqual(entriesOf('roadmap', file), ['### R-8: No where\n\nStatus: Done.', '### R-9: Empty where\n\nStatus: Done.']);
});

test('text with Windows line endings reads the same as text without (R-040)', () => {
  assert.deepEqual(entriesOf('decisions', decisionsFile.replace(/\n/g, '\r\n')), entriesOf('decisions', decisionsFile));
  assert.deepEqual(entriesOf('roadmap', roadmapFile.replace(/\n/g, '\r\n')), entriesOf('roadmap', roadmapFile));
  const text = '### K-12: Push fails\n\nStatus: Fixed in #43.\n\nSeen: here.\nMore.\n';
  assert.deepEqual(readCard(text.replace(/\n/g, '\r\n')), readCard(text));
  assert.deepEqual(proposalOf('docs/roadmap/K-12.md', text.replace(/\n/g, '\r\n')), proposalOf('docs/roadmap/K-12.md', text));
  assert.equal(readCard(text.replace(/\n/g, '\r\n'))?.body, 'Seen: here.\nMore.');
});

test('the copy of a column imports back as the same cards (R-040)', () => {
  const sorted = (texts: string[]) => [...texts].sort();
  const decisions = [
    card('D-001', 'Held', 'Accepted 2026-11-01 in #2', 'What.\n\nWhy: x.\n\nCost: y.'),
    card('D-2', 'Replaced', 'Superseded by D-3 in #9'),
    card('D-3', 'Pipes | are fine', 'Proposed', 'Body.'),
  ];
  assert.deepEqual(sorted(entriesOf('decisions', copyOf('decisions', decisions))), sorted(decisions));
  // A Done card comes back only without a body, and with a status of the form `Done in #N`.
  const roadmap = [
    card('R-1', 'Idea', 'Idea', 'Why: x.\n\n- a\n- b'),
    card('K-2', 'Issue', 'Open', 'Seen: y.'),
    card('Q-3', 'Question', 'Open'),
    card('R-004', 'Working', 'In progress: Ann’s agent', 'Body.'),
    card('R-006', 'Picked', 'Running: Ann’s agent', 'Body.'),
    card('K-7', 'Waiting', 'Ready', 'Seen: z.'),
    card('K-5', 'Gone', 'Dropped on 2026-11-04', 'Why.'),
    card('R-021', 'Project board of decisions and roadmap cards', 'Done in #75'),
    card('K-36', 'Pipes | in a Done title', 'Done in #66'),
  ];
  assert.deepEqual(sorted(entriesOf('roadmap', copyOf('roadmap', roadmap))), sorted(roadmap));
});

const docs = (name: string) => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');

test("this repository's decisions import as one card per decision heading, each with a status (R-040)", () => {
  const file = docs('decisions.md');
  const ids = (file.match(/^### D-\d+/gm) ?? []).map((h) => h.slice(4));
  const cards = entriesOf('decisions', file).map((t) => readCard(t));
  assert.ok(ids.length > 0);
  assert.deepEqual(cards.map((c) => c?.id), ids);
  for (const c of cards) assert.ok(c?.status, `${c?.id} has a status`);
});

test("this repository's roadmap imports a card for each idea, issue and question heading (R-040)", () => {
  const file = docs('roadmap.md');
  const ids = (file.match(/^### [RKQ]-\d+/gm) ?? []).map((h) => h.slice(4));
  const cards = entriesOf('roadmap', file).map((t) => readCard(t));
  assert.ok(ids.length > 0);
  assert.ok(cards.every((c) => c !== null));
  const have = new Set(cards.map((c) => c?.id));
  assert.deepEqual(ids.filter((id) => !have.has(id)), []);
  assert.ok(cards.length >= ids.length);
});

test('a file named by an id proposes a change to that card (R-040)', () => {
  assert.deepEqual(proposalOf('docs/roadmap/K-12.md', '\n### K-12: Push fails with bad keys\n\nStatus: Fixed in #43.\n\nSeen: here.\n'), {
    kind: 'K',
    id: 'K-12',
    title: 'Push fails with bad keys',
    status: 'Fixed in #43',
    body: 'Seen: here.',
  });
  assert.deepEqual(proposalOf('docs/decisions/D-012.md', '### D-012: Keys rotate'), { kind: 'D', id: 'D-012', title: 'Keys rotate', body: '' });
});

test('a heading without an id proposes a new card of the kind it names, or of its folder (R-040)', () => {
  assert.deepEqual(proposalOf('docs/roadmap/new-bark-banner.md', '### Bark banner\n\nWhy: x.'), { kind: 'R', title: 'Bark banner', body: 'Why: x.' });
  assert.deepEqual(proposalOf('docs/roadmap/new-question.md', '### Q: Should it?\n\nStatus: Open.\n\nMaybe.'), { kind: 'Q', title: 'Should it?', status: 'Open', body: 'Maybe.' });
  assert.deepEqual(proposalOf('docs/decisions/x.md', '### D: Keep it\n\nWhy: it works.'), { kind: 'D', title: 'Keep it', body: 'Why: it works.' });
  assert.equal(proposalOf('docs/decisions/y.md', '### Keep it too')?.kind, 'D');
});

test('the README and a file with no heading propose nothing (R-040)', () => {
  assert.equal(proposalOf('docs/roadmap/README.md', '### R-1: Looks like a card\n\nStatus: Idea.'), null);
  assert.equal(proposalOf('README.md', '### Title'), null);
  assert.equal(proposalOf('docs/roadmap/notes.md', 'Just text.\n\n### Title later'), null);
  assert.equal(proposalOf('docs/roadmap/notes.md', '## Two hashes\n'), null);
  assert.equal(proposalOf('docs/roadmap/empty.md', ''), null);
});
