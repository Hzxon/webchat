// The text of a board card and of the repository files that copy the board (R-040, D-117). A card
// is Markdown in the form of this repository's docs: a "### K-12: Title" heading, a "Status:" line,
// then the body (D-082). The module imports nothing, so the page, the agent and the tests load it.

export type CardKind = 'D' | 'R' | 'K' | 'Q';

export interface CardText {
  kind: CardKind;
  number: number;
  /** The kind and number as written, since code and commits cite `R-005` with its zeros. */
  id: string;
  title: string;
  /** The status line without "Status:" and its final period, such as "Accepted 2026-11-04". */
  status: string;
  /** What is under the heading and the status line. */
  body: string;
}

type Column = 'decisions' | 'roadmap';

const HEADING = /^###\s+([DRKQ])-(\d+):\s*(.*?)\s*$/;
const STATUS = /^Status:\s*(.*?)\.?\s*$/;

/** The first non-empty line, the status line under it if there is one, and the rest as the body. */
function parts(text: string) {
  // A file checked out on Windows has \r\n.
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return null;
  let rest = lines.slice(first + 1);
  const next = rest.findIndex((l) => l.trim());
  const status = STATUS.exec(rest[next] ?? '');
  if (status) rest = rest.slice(next + 1);
  return { heading: lines[first], status: status?.[1] ?? '', body: rest.join('\n').trim() };
}

/** A card's parts, or null for a text with no "### K-12: Title" heading as its first line. */
export function readCard(text: string): CardText | null {
  const card = parts(text);
  const heading = card && HEADING.exec(card.heading);
  if (!card || !heading) return null;
  return { kind: heading[1] as CardKind, number: Number(heading[2]), id: `${heading[1]}-${heading[2]}`, title: heading[3], status: card.status, body: card.body };
}

/** What every copy says after its title, so the agent and a check can tell a copy from a file written by hand. */
export const COPY_MARK = 'This file is a copy of the';

const COPIES = {
  decisions: {
    name: 'Decisions',
    how: 'a new decision as a file under `docs/decisions/`, or a change to one as `docs/decisions/D-12.md`. Find an entry by its number, such as D-021.',
  },
  roadmap: {
    name: 'Roadmap',
    how: 'a new entry as a file under `docs/roadmap/`, named by a short name such as `new-bark-banner.md`, or a change to one as `docs/roadmap/K-12.md`.',
  },
};

const SECTIONS = ['In progress', 'Next', 'Ideas', 'Known issues', 'Open questions', 'Dropped', 'Done'];
const BY_STATUS: Array<[RegExp, string]> = [
  [/^(in (progress|review)|waiting)/i, 'In progress'],
  [/^(next|planned)/i, 'Next'],
  [/^dropped/i, 'Dropped'],
  [/^(done|fixed)/i, 'Done'],
];
// A decision typed into the roadmap goes with the ideas, so the copy never drops a card.
const BY_KIND = { D: 'Ideas', R: 'Ideas', K: 'Known issues', Q: 'Open questions' };
const sectionOf = (c: CardText) => BY_STATUS.find(([re]) => re.test(c.status))?.[1] ?? BY_KIND[c.kind];

/** Ids order by kind, as the roadmap lists them, then by number. */
const byId = (a: CardText, b: CardText) => 'DRKQ'.indexOf(a.kind) - 'DRKQ'.indexOf(b.kind) || a.number - b.number;

/** Done cards are one row each, as in this repository's roadmap: git history keeps the rest. */
function doneTable(cards: CardText[]): string {
  const rows = cards.map((c) => {
    const prs = c.status.match(/#\d+/g);
    return { c, first: prs ? Number(prs[0].slice(1)) : Infinity, where: prs ? prs.join(', ') : c.status };
  });
  rows.sort((a, b) => a.first - b.first || byId(a.c, b.c));
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  return ['| Work | Where |', '| --- | --- |', ...rows.map((r) => `| ${cell(`${r.c.id}: ${r.c.title}`)} | ${cell(r.where)} |`)].join('\n');
}

/**
 * The repository file for a column, rebuilt whole from the texts of its cards, since nobody edits
 * it by hand. A text that is no card is left out.
 */
export function copyOf(column: Column, texts: string[]): string {
  const cards = texts
    .flatMap((t) => {
      const card = readCard(t);
      return card ? [{ ...card, text: t.trim() }] : [];
    })
    .sort(byId);
  const superseded = (c: CardText) => /^superseded/i.test(c.status);
  const sections: Array<[string, typeof cards]> =
    column === 'decisions'
      ? [['', cards.filter((c) => !superseded(c))], ['Superseded', cards.filter(superseded)]]
      : SECTIONS.map((name) => [name, cards.filter((c) => sectionOf(c) === name)]);
  const { name, how } = COPIES[column];
  const blocks = [`# ${name}`, `${COPY_MARK} ${name} column of the project's board in WebChat, which its owner's agent writes. Do not edit it by hand: a pull request proposes ${how}`];
  for (const [heading, list] of sections) {
    if (!list.length) continue;
    if (heading) blocks.push(`## ${heading}`);
    blocks.push(...(heading === 'Done' ? [doneTable(list)] : list.map((c) => c.text)));
  }
  return blocks.join('\n\n') + '\n';
}

const KINDS: Record<Column, string> = { decisions: 'D', roadmap: 'RKQ' };

/** An entry's text in the form `readCard` reads: heading, status line, body. */
function entryText(column: Column, heading: RegExpExecArray, lines: string[]): string {
  const rest = lines.join('\n').trim();
  // The first paragraph is the status when it has one, joined: it can wrap over lines, but a
  // card's status is one line. A decision's has no label.
  const end = rest.search(/\n[ \t]*\n/);
  const first = (end < 0 ? rest : rest.slice(0, end)).split('\n').map((l) => l.trim()).join(' ');
  const after = end < 0 ? '' : rest.slice(end).trim();
  const [status, body] = /^Status:/.test(first)
    ? [first, after]
    : column === 'decisions'
      ? [`Status: ${first}`, after]
      : [`Status: ${heading[1] === 'R' ? 'Idea' : 'Open'}.`, rest];
  return [`### ${heading[1]}-${heading[2]}: ${heading[3]}`, status, body].filter(Boolean).join('\n\n');
}

/** A row of the Done table, such as `| K-36: Title | #66 |`, as the card it stands for, or null. */
function doneRow(line: string): string | null {
  const row = line.trim();
  if (!row.startsWith('|')) return null;
  // Cells split at a `|` that is not escaped; a title writes its own as `\|`.
  const cells = (row.match(/(?:\\.|[^|\\])+/g) ?? []).map((c) => c.replace(/\\\|/g, '|').trim());
  const id = /^([RKQ]-\d+)(?:\s+to\s+[RKQ]-\d+)?:\s*(.*)$/.exec(cells[0] ?? '');
  return id && `### ${id[1]}: ${id[2]}\n\nStatus: Done${cells[1] ? ` in ${cells[1]}` : ''}.`;
}

/**
 * The one-time import when a board is linked: a repository's file as card texts `readCard` reads.
 * What is outside the entries, such as the introduction and the topic headings, has no card to go to.
 */
export function entriesOf(column: Column, markdown: string): string[] {
  // A full entry beats a Done row of the same card, and the later of two equals wins, in the place
  // of the first.
  const found = new Map<string, { text: string; full: boolean }>();
  const add = (text: string, full: boolean) => {
    const { kind, number } = readCard(text)!;
    const key = `${kind}-${number}`;
    if (!(found.get(key)?.full && !full)) found.set(key, { text, full });
  };
  let entry: { heading: RegExpExecArray; lines: string[] } | null = null;
  let inDone = false;
  const close = () => {
    if (entry) add(entryText(column, entry.heading, entry.lines), true);
    entry = null;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const level = /^(#{2,3})\s/.exec(line)?.[1];
    if (level) {
      close();
      const heading = HEADING.exec(line);
      if (heading && KINDS[column].includes(heading[1])) entry = { heading, lines: [] };
      if (level === '##') inDone = /^##\s+Done\s*$/i.test(line);
    } else if (entry) {
      entry.lines.push(line);
    } else if (inDone && column === 'roadmap') {
      const row = doneRow(line);
      if (row) add(row, false);
    }
  }
  close();
  return [...found.values()].map((e) => e.text);
}

/**
 * A pull request's file under docs/roadmap/ or docs/decisions/ as a card proposal. A heading with
 * an id, `### K-12: Title`, changes that card. One without, `### K: Title` or `### Title`, asks for
 * a new card, which the board numbers (D-116).
 */
export function proposalOf(path: string, markdown: string): { kind: CardKind; id?: string; title: string; status?: string; body: string } | null {
  const card = /(^|\/)README\.md$/i.test(path) ? null : parts(markdown);
  const heading = card && /^###\s+(?:([DRKQ])(?:-(\d+))?:\s*)?(.*?)\s*$/.exec(card.heading);
  if (!card || !heading) return null;
  const [, kind, digits, title] = heading;
  return {
    kind: (kind ?? (path.startsWith('docs/decisions/') ? 'D' : 'R')) as CardKind,
    ...(digits && { id: `${kind}-${digits}` }),
    title,
    ...(card.status && { status: card.status }),
    body: card.body,
  };
}
