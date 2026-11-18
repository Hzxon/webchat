// The text of a board card and of the repository files that copy the board (R-040, D-117). A card
// is Markdown in the form of this repository's docs: a "### K-12: Title" heading, a "Status:" line,
// then the body (D-082). It also holds how every page reads a card's owner, status and reviews from
// each member's word, so the agent's copy shows what the page shows. The module imports only types,
// so the page, the agent and the tests load it.
import type { DocContent } from './e2ee.js';
import type { DocRevisionDTO, UserDTO } from './types.js';

export type CardKind = 'D' | 'R' | 'K' | 'Q';

export interface CardText {
  kind: CardKind;
  number: number;
  /** The kind and number as written, since code and commits cite `R-005` with its zeros. */
  id: string;
  title: string;
  /** The status line without "Status:" and its final period, such as "Accepted 2026-11-04", in today's words (`newStatus`). */
  status: string;
  /** What is under the heading and the status line. */
  body: string;
}

type Column = 'decisions' | 'roadmap';

const HEADING = /^###\s+([DRKQ])-(\d+):\s*(.*?)\s*$/;
const STATUS = /^Status:\s*(.*?)\.?\s*$/;

/** The words from before Ready and Running (the board-lanes decision), as each status reads them. */
const OLD_WORDS: Array<[RegExp, string]> = [
  [/^in progress\b/i, 'Running'],
  [/^(next|planned)\b/i, 'Ready'],
];

/** A status in today's words: an old leading word becomes Running or Ready, and the rest of the line stays. */
export const newStatus = (status: string) => OLD_WORDS.reduce((s, [word, now]) => s.replace(word, now), status);

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
  return { kind: heading[1] as CardKind, number: Number(heading[2]), id: `${heading[1]}-${heading[2]}`, title: heading[3], status: newStatus(card.status), body: card.body };
}

export interface DocSection {
  id: string;
  text: string;
  pos: number;
  /** Its revision did not decrypt, or its signature did not check. */
  failed: boolean;
  /** Who wrote its newest revision, for the brief that marks teammates' text (D-105). */
  authorId?: number;
  /** Who wrote its first revision, when that revision says `addCard` opened it: the card's owner. */
  openedBy?: number;
  /** Each member's newest revision of it that opens and is no removal, newest first. */
  words?: Word[];
  /** Who removed it, when its newest revision is a removal; `cardOf` says whether that stands. */
  removedBy?: number;
  /** The author of its first revision removed it and wrote nothing since, whatever others wrote after. */
  openerRemoved?: true;
}

export interface Word {
  id: number;
  authorId: number;
  text: string;
}

export interface Card extends DocSection {
  kind: CardKind | null;
  number: number | null;
  /** The id as its heading writes it, such as "R-005", or '' without one. */
  cardId: string;
  title: string;
  /** The status line without "Status:" and its final period, such as "Accepted 2026-11-04". */
  status: string;
  /** What is under the heading and the status line. */
  body: string;
  /** The line after "Checked:" that an agent's check left, or '' for a card never checked (R-041). */
  checked: string;
  /** The member who opened it, while they are still in the project (the board-lanes decision). */
  owner?: number;
  /**
   * The text as its newest revision wrote it, which a brief hashes as the agent reads it (D-105).
   * `text` is the text that stands: on a refused card, with the status that stands.
   */
  written: string;
  /** For a card with an owner: who wrote the status that stands (`standing`). */
  setBy?: number;
  refused?: Refused;
  /** Its reviews as they stand (`reviewsOf`), one per reviewer, in the order the card lists them. */
  reviews: Review[];
}

/** A review's verdict, in the words of the pull request tags (`PullTags.tsx`). */
export type Verdict = 'review_required' | 'approved' | 'changes_requested';

/** A reviewer's line on a card: `Review: @dan Changes requested 2026-11-13: the empty state is missing.` */
export interface Review {
  who: number;
  name: string;
  verdict: Verdict;
  /** What a requested change asks for. */
  note: string;
  /** The owner's answer to a requested change. */
  answer?: 'accepted' | 'declined';
  /** The line as it stands, with the owner's answer. */
  line: string;
}

/** What a member wrote on a card with an owner that only its owner may: a status, or the card's removal (`status` null). */
export interface Refused {
  status: string | null;
  by: number;
}

/** Reads a card's kind, number, title and status from its heading and the status line under it, as `readCard` does. */
export function parseCard(section: DocSection): Card {
  const card = readCard(section.text);
  const body = card ? card.body : section.text.trim();
  return {
    ...section,
    kind: card?.kind ?? null,
    number: card?.number ?? null,
    cardId: card?.id ?? '',
    // A section without a card heading is titled by its first line, bare of Markdown heading marks.
    title: card ? card.title : (section.text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? ''),
    status: card?.status ?? '',
    body,
    checked: CHECKED.exec(body)?.[1]?.trim() ?? '',
    written: section.text,
    reviews: [],
  };
}

export const CHECKED = /^Checked:(.*)$/m;

/** A revision with what it holds, or null when it does not open. */
export interface Opened {
  revision: DocRevisionDTO;
  content: DocContent | null;
}

/** A section as one of its revisions gives it. */
export const sectionOf = ({ revision, content }: Opened): DocSection => ({
  id: revision.section,
  text: content?.text ?? '',
  // A section that does not open keeps its place among the others by when it was written.
  pos: content?.pos ?? revision.createdAt,
  failed: !content,
  authorId: revision.authorId,
});

/**
 * A board doc's cards from the rows `GET /docs/:id/words` gives, in id order: each section's oldest
 * revision and each author's newest (the board-lanes decision). The newest gives the card, the
 * oldest its opener when it says `opened`, and each author's newest their word. A section whose
 * newest revision removes it keeps who removed it and shows its newest other revision, since only
 * `cardOf`, which knows the owner, can tell whether the removal stands (the card-owner decision).
 */
export function cardSections(rows: Opened[]): DocSection[] {
  const bySection = new Map<string, Opened[]>();
  for (const row of rows) if (row.revision.section !== 'title') (bySection.get(row.revision.section) ?? bySection.set(row.revision.section, []).get(row.revision.section)!).push(row);
  return [...bySection.values()]
    .map((list) => {
      const newest = list.at(-1)!;
      // Rows come in id order, so each author's last row is their word, not the oldest row the list also holds.
      const wordOf = new Map(list.map((row) => [row.revision.authorId, row]));
      return {
        ...sectionOf([...list].reverse().find((row) => !row.content?.removed) ?? newest),
        openedBy: list[0]!.content?.opened ? list[0]!.revision.authorId : undefined,
        words: [...wordOf.values()]
          .sort((a, b) => b.revision.id - a.revision.id)
          .flatMap(({ revision, content }) => (content && !content.removed ? [{ id: revision.id, authorId: revision.authorId, text: content.text }] : [])),
        ...(newest.content?.removed && { removedBy: newest.revision.authorId }),
        ...(wordOf.get(list[0]!.revision.authorId)?.content?.removed && { openerRemoved: true as const }),
      };
    })
    .sort((a, b) => a.pos - b.pos);
}

/**
 * A card with its owner, the member who opened it while they are still among `members`, the status
 * and reviews that stand, or null when it was removed by its owner, or by anyone when it has none.
 * `text` and `body` hold the status and reviews that stand, so every page writes from them.
 * `usernames` names the members who are people, whom review lines name.
 */
export function cardOf(section: DocSection, members: number[], usernames: Record<number, string>): Card | null {
  const owner = section.openedBy !== undefined && members.includes(section.openedBy) ? section.openedBy : undefined;
  // An owner's removal stands whatever anyone saved after it, or a changed client could bring the card back.
  if (owner === undefined ? section.removedBy !== undefined : section.openerRemoved) return null;
  const parsed = parseCard(section);
  const card = { ...parsed, owner, reviews: parsed.kind ? reviewsOf(section.text, section.words, owner, usernames) : [] };
  // Only the Roadmap's cards come with words.
  if (owner === undefined || !section.words) return card;
  // The statuses the words that hold a verdict say, which is what its reviewer saw.
  const seen = card.reviews.flatMap((r) => (r.verdict === 'review_required' ? [] : [readCard(section.words!.find((w) => w.authorId === r.who)!.text)?.status ?? '']));
  const stands = standing(section.words, owner, seen);
  const refused = section.removedBy !== undefined ? { status: null, by: section.removedBy } : stands.refused;
  const body = withReviews(card.body, card.reviews.map((r) => r.line));
  // Rewritten only when the review lines differ from those that stand, so a card nobody reviewed keeps its text as written.
  const text = body !== card.body ? cardText(card.cardId, card.title, stands.status, body) : refused ? withStatus(card.text, stands.status) : card.text;
  return { ...card, status: stands.status, setBy: stands.by, refused, body, text };
}

/** A board doc's cards from its sections, without the ones whose removal stands. */
export const cardsOf = (sections: DocSection[], members: number[], usernames: Record<number, string>) => sections.flatMap((s) => cardOf(s, members, usernames) ?? []);

/** The usernames of a project's members who are people, by id: an agent reviews nothing. The store's `users` leave out `me`. */
export function usernamesOf(members: number[], users: Record<number, Pick<UserDTO, 'username' | 'agentOwner'>>, me: Pick<UserDTO, 'id' | 'username' | 'agentOwner'> | null) {
  const all = me ? { ...users, [me.id]: me } : users;
  return Object.fromEntries(members.flatMap((id) => (all[id] && all[id].agentOwner === null ? [[id, all[id].username]] : [])));
}

const VERDICTS: Record<string, Verdict> = { 'Review required': 'review_required', Approved: 'approved', 'Changes requested': 'changes_requested' };
// The owner's answer ends the line, so a reviewer's note never holds one that counts.
const REVIEW = /^Review: @(\S+) (Review required|Approved|Changes requested)\b(.*?)( (Accepted|Declined) \d{4}-\d{2}-\d{2}\.)?$/;

/** A review line as written: `base` without the answer, and the answer's word and `suffix`. */
interface Line {
  verdict: Verdict;
  base: string;
  note: string;
  answer?: string;
  suffix: string;
}

/** A text's review lines, the first per username. */
function reviewLines(text: string) {
  const found = new Map<string, Line>();
  for (const l of text.split('\n')) {
    const m = REVIEW.exec(l.trim());
    const note = (/: (.*?)\.?$/.exec(m?.[3] ?? '')?.[1] ?? '').trim();
    // A change counts only with what to change, which Run again sends the agent.
    if (m && !found.has(m[1]!) && (note || m[2] !== 'Changes requested')) found.set(m[1]!, { verdict: VERDICTS[m[2]!]!, base: `Review: @${m[1]} ${m[2]}${m[3]}`, note, answer: m[5], suffix: m[4] ?? '' });
  }
  return found;
}

/**
 * A card's text as typed, with these review lines under its status line in place of the typed ones:
 * only the buttons change a review, so a hand edit or an old draft neither drops nor revives one.
 */
export function keepReviews(text: string, lines: string[]) {
  const typed = text.split('\n');
  if (typed.filter((l) => REVIEW.test(l.trim())).map((l) => l.trim()).join('\n') === lines.join('\n')) return text;
  const rest = typed.filter((l) => !REVIEW.test(l.trim()));
  const at = rest.findIndex((l) => STATUS.test(l)) + 1;
  return (lines.length ? [...rest.slice(0, at), '', ...lines, '', ...rest.slice(at)] : rest).join('\n').replace(/\n{3,}/g, '\n\n');
}

/** A card body with these review lines on top, in place of the ones it had. */
export const withReviews = (body: string, lines: string[]) =>
  [lines.join('\n'), body.split('\n').filter((l) => !REVIEW.test(l.trim())).join('\n').trim()].filter(Boolean).join('\n\n');

/**
 * A card's reviews as every page reads them (the card-review decision). A request, `Review required`,
 * is read from the newest text and not checked. A verdict counts only when its reviewer's own word
 * holds it, and that word is newer than the owner's or the owner's word repeats the line: so nobody
 * writes a verdict for someone else, nobody deletes one, and an approval from before the owner ran
 * the card again, which drops it from the owner's word, stops counting. The owner's answer to a
 * requested change counts only from the owner's word. Only members who are people review. On a card
 * with no owner, everything is read from the newest text.
 */
export function reviewsOf(text: string, words: Word[] | undefined, owner: number | undefined, usernames: Record<number, string>): Review[] {
  const ids = new Map(Object.entries(usernames).map(([id, name]) => [name, Number(id)]));
  const review = (name: string, r: Line, answered: boolean): Review => ({
    who: ids.get(name)!,
    name,
    verdict: r.verdict,
    note: r.note,
    ...(answered && r.answer && { answer: r.answer.toLowerCase() as Review['answer'] }),
    line: answered ? r.base + r.suffix : r.base,
  });
  const newest = reviewLines(text);
  if (owner === undefined || !words) return [...newest].flatMap(([name, r]) => (ids.has(name) ? [review(name, r, true)] : []));
  const own = words.find((w) => w.authorId === owner);
  const owners = reviewLines(own?.text ?? '');
  const counted = new Map<string, Review>();
  for (const [name, id] of ids) {
    const word = words.find((w) => w.authorId === id);
    const r = word && reviewLines(word.text).get(name);
    const repeated = owners.get(name);
    if (!r || r.verdict === 'review_required') continue;
    if (repeated?.base === r.base) counted.set(name, review(name, { ...r, answer: repeated.answer, suffix: repeated.suffix }, r.verdict === 'changes_requested'));
    // With no word of the owner's, as when theirs does not open, nothing says which verdicts came after it.
    else if (own && word!.id > own.id) counted.set(name, review(name, r, false));
  }
  const names = [...new Set([...newest.keys(), ...counted.keys()])];
  return names.flatMap((name) => {
    const r = newest.get(name);
    return counted.get(name) ?? (ids.has(name) && r?.verdict === 'review_required' ? [review(name, r, false)] : []);
  });
}

/** A merge's status, which its run's page writes for any member (D-118); a page cannot check the merge. */
const MERGED = /^(Done|Fixed) in \S*#\d+/;

/** The Roadmap's lane a status puts a card in. */
export const laneOf = (status: string) => GROUPS.roadmap[groupOf('roadmap', status)]!.key!;

/**
 * The status a card shows, from each member's word on it, newest first (the card-owner decision).
 * The server cannot read a card, so every page holds the owner's gates: a card with an owner shows
 * the newest word whose author may set its status. Any member may set Open; Ready, Running and In
 * review stand once the owner's own word left Open; Done only from the owner, or as a merge once it
 * left Open. With no owner the newest word stands. Words are not history: a Ready the owner gave
 * stands until the owner takes it back. While a verdict stands, a word of anyone else's stands, but
 * for Open and a merge, only with an In review status that a verdict's word says: only the owner,
 * whose Run again or Mark ready drops the verdicts, moves the card on from the work its reviewers
 * saw (the card-review decision). `seen` holds the statuses of the words that hold a verdict.
 */
export function standing(words: Word[], owner?: number, seen: string[] = []): { status: string; by?: number; refused?: Refused } {
  const statusOf = (word: Word) => readCard(word.text)?.status ?? '';
  const own = words.find((w) => w.authorId === owner);
  const passed = !!own && laneOf(statusOf(own)) !== 'open';
  const stands = (word: Word) => {
    const status = statusOf(word);
    const lane = laneOf(status);
    if (owner === undefined || lane === 'open') return true;
    if (lane === 'done') return word.authorId === owner || (passed && MERGED.test(status));
    if (seen.length && word.authorId !== owner) return passed && lane === 'review' && seen.includes(status);
    return passed;
  };
  const word = words.find(stands);
  // Only an owner's word that does not open, when no other stands, leaves none.
  const status = word ? statusOf(word) : 'Open';
  const newest = words[0];
  return { status, by: word?.authorId, ...(newest && statusOf(newest) !== status && { refused: { status: statusOf(newest), by: newest.authorId } }) };
}

/** The status of a card whose run waits for a decision nobody foresaw, so teammates see why it is held (R-042). */
export const WAITING = 'Waiting for a decision';
/** What every waiting status starts with: for a decision, or for another card whose files a run needs (docs/roadmap/new-overlap-gate.md). */
export const WAITS = 'Waiting for ';

/** The groups a column shows, in order. A folded group opens on a click. */
/** A Roadmap group's fixed key, which code compares; its name is only what the board shows. */
export type Lane = 'ready' | 'running' | 'review' | 'open' | 'done';

export const GROUPS: Record<Column, Array<{ name: string; statuses: string[]; folded?: true; lane?: true; key?: Lane }>> = {
  decisions: [
    { name: 'Proposed', statuses: ['Proposed'] },
    { name: 'Accepted', statuses: ['Accepted'] },
    { name: 'Superseded', statuses: ['Superseded'], folded: true },
  ],
  // Ready, Running and In review are the lanes, side by side; Open stays fourth, where a status
  // outside the list goes.
  roadmap: [
    { key: 'ready', name: 'Ready', statuses: ['Ready'], lane: true },
    { key: 'running', name: 'Running', statuses: ['Running', WAITS], lane: true },
    // A run that ended in a draft pull request waits here for its owner to review and merge it.
    { key: 'review', name: 'In review', statuses: ['In review'], lane: true },
    { key: 'open', name: 'Open', statuses: ['Idea', 'Open'] },
    { key: 'done', name: 'Done', statuses: ['Done', 'Fixed', 'Dropped'], folded: true },
  ],
};

/** The group a status belongs to. A status outside the list goes with the open items. */
export function groupOf(column: Column, status: string): number {
  const found = GROUPS[column].findIndex((g) => g.statuses.some((s) => status.toLowerCase().startsWith(s.toLowerCase())));
  return found >= 0 ? found : column === 'decisions' ? 0 : 3;
}

/** The card's text with this status line under its heading, replacing the one it has. */
export function withStatus(text: string, status: string): string {
  const lines = text.split('\n');
  const heading = lines.findIndex((l) => l.trim() !== '');
  const next = lines.findIndex((l, i) => i > heading && l.trim() !== '');
  const line = `Status: ${status}.`;
  if (next >= 0 && STATUS.test(lines[next]!)) lines[next] = line;
  else lines.splice(heading + 1, 0, '', line);
  return lines.join('\n');
}

/**
 * A card's text: the heading with its id and title, the status line, then what is under them. A
 * status line the body starts with goes, as an agent's draft may write one: the card would show
 * both, and a run moves only the first (K-1 in #170).
 */
export const cardText = (id: string, title: string, status: string, body: string) =>
  `### ${id}: ${title}\n\nStatus: ${status}.\n\n${body.replace(/^\s*Status:[^\n]*\n*/, '')}`;

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

const SECTIONS = ['Running', 'Ready', 'Ideas', 'Known issues', 'Open questions', 'Dropped', 'Done'];
const BY_STATUS: Array<[RegExp, string]> = [
  [/^(running|in review|waiting)/i, 'Running'],
  [/^ready/i, 'Ready'],
  [/^dropped/i, 'Dropped'],
  [/^(done|fixed)/i, 'Done'],
];
// A decision typed into the roadmap goes with the ideas, so the copy never drops a card.
const BY_KIND = { D: 'Ideas', R: 'Ideas', K: 'Known issues', Q: 'Open questions' };
const headingOf = (c: CardText) => BY_STATUS.find(([re]) => re.test(c.status))?.[1] ?? BY_KIND[c.kind];

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
      : SECTIONS.map((name) => [name, cards.filter((c) => headingOf(c) === name)]);
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
    ...(card.status && { status: newStatus(card.status) }),
    body: card.body,
  };
}
