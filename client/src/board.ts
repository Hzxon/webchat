// The project board (R-021, D-082): two docs, Decisions and Roadmap, whose sections are cards in
// the format of this repository's docs/decisions.md and docs/roadmap.md. A card is Markdown that
// starts with "### D-3: Title" and a "Status:" line. This module only reads and writes that text,
// so the tests run it without a browser.
import { readCard, type CardKind } from '../../shared/board';
import type { DocContent } from '../../shared/e2ee';
import { RUN_PICKUP_MS, type DocRevisionDTO, type RunReport, type UserDTO } from '../../shared/types';
import type { DocSection, Word } from './docs';
import type { ChatConversation, ChatDoc, ChatMessage } from './e2ee/keyring';
import type { PendingStatus } from './store';

export type BoardColumn = NonNullable<DocContent['board']>;
/** Decisions are D-n. Ideas, R-n, issues, K-n, and questions, Q-n, share the Roadmap column. */
export type { CardKind };

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

export const COLUMNS: BoardColumn[] = ['decisions', 'roadmap'];
export const COLUMN_TITLES: Record<BoardColumn, string> = {
  decisions: 'Decisions',
  roadmap: 'Roadmap',
};
export const KIND_NAMES: Record<CardKind, string> = {
  D: 'decision',
  R: 'idea',
  K: 'issue',
  Q: 'question',
};

const STATUS = /^Status:\s*(.*?)\.?\s*$/;

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

const CHECKED = /^Checked:(.*)$/m;

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

/** A requested change its owner did not decline, which keeps the card from closing. */
export const openChange = (reviews: Review[]) => reviews.some((r) => r.verdict === 'changes_requested' && r.answer !== 'declined');

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

/**
 * A card's moves by button, which write its status line or a review line, and the lane each starts
 * from (the card-owner and card-review decisions). A move on a review starts in review.
 */
export type Move = keyof typeof MOVE_FROM | { request: Pick<UserDTO, 'id' | 'username'> } | { changes: string } | { accept: number } | { decline: number };
// The owner marks a card in review ready too, which drops its reviews, as their way out of a review.
export const MOVE_FROM: Record<'ask' | 'ready' | 'pick' | 'review' | 'close' | 'approve' | 'again', Lane[]> = {
  ask: ['open'],
  ready: ['open', 'review'],
  pick: ['ready'],
  review: ['running'],
  close: ['review'],
  approve: ['review'],
  again: ['review'],
};

const ASKED = /^Asked: \d{4}-\d{2}-\d{2}\. @\S+ asks its owner to mark it ready\.$/gm;

/** Who picked a running card by hand, or '' when an agent runs it (`workingStatus`) or a pull request claims it (`Running: repo#N`). */
const pickedBy = (status: string) => (status.startsWith('Running:') && !/['’]s agent$|#\d+$/.test(status) ? runnerOf(status) : '');

/**
 * The card's text after a member's move, or null when the move is not theirs or the card is not
 * where it starts. Any member asks its owner to mark it ready, picks it, sends it to review or asks
 * anyone who has no line on it for a review; a reviewer approves or asks for changes; only its owner
 * marks it ready, which drops its asks and reviews, answers a requested change, runs it again once
 * every change is answered and one accepted, which asks those reviewers again and drops every other
 * verdict, and closes it, after an approval and with no change open. The text starts from the
 * status and reviews that stand, so what someone could not write goes with the next move.
 */
export function moved(card: Card, move: Move, me: Pick<UserDTO, 'id' | 'username' | 'displayName'>, today = new Date()): string | null {
  // A card that does not open has no kind.
  if (!card.kind || !(typeof move === 'string' ? MOVE_FROM[move] : ['review']).includes(laneOf(card.status))) return null;
  const mine = card.owner === me.id;
  const asks = `@${me.username} asks its owner to mark it ready.`;
  const write = (status: string, body = card.body) => cardText(card.cardId, card.title, status, body);
  const date = dateOf(today);
  const asked = (name: string) => `Review: @${name} Review required. Asked by @${me.username} ${date}.`;
  /** The card with one reviewer's line set, in place of the one they had. */
  const review = (who: number, line: string) => write(card.status, withReviews(card.body, [...card.reviews.filter((r) => r.who !== who).map((r) => r.line), line]));
  const reviewer = card.reviews.find((r) => r.who === me.id);
  if (typeof move === 'object') {
    if ('request' in move) return card.reviews.some((r) => r.who === move.request.id) ? null : review(move.request.id, asked(move.request.username));
    if ('changes' in move) {
      const note = move.changes.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
      return reviewer && note ? review(me.id, `Review: @${me.username} Changes requested ${date}: ${note}.`) : null;
    }
    const [who, answer] = 'accept' in move ? [move.accept, 'Accepted'] : [move.decline, 'Declined'];
    const change = card.reviews.find((r) => r.who === who && r.verdict === 'changes_requested' && !r.answer);
    return mine && change ? review(who, `${change.line} ${answer} ${date}.`) : null;
  }
  switch (move) {
    case 'ask':
      return card.owner === undefined || mine || card.body.includes(asks) ? null : write(card.status, `Asked: ${date}. ${asks}\n\n${card.body}`);
    case 'ready':
      return mine ? write('Ready', withReviews(card.body.replace(ASKED, '').trim(), [])) : null;
    case 'pick':
      return write(`Running: ${me.displayName}`);
    // Only a member's pick: a run moves its own card to review, and would no longer find it (D-100).
    case 'review':
      return pickedBy(card.status) ? write('In review') : null;
    case 'close': {
      const pull = runnerOf(card.status);
      const approved = card.reviews.some((r) => r.verdict === 'approved');
      return mine && approved && !openChange(card.reviews) ? write(`${card.kind === 'K' ? 'Fixed' : 'Done'} ${pull ? `in ${pull}` : `on ${date}`}`) : null;
    }
    case 'approve':
      return reviewer ? review(me.id, `Review: @${me.username} Approved ${date}.`) : null;
    // Only once every requested change is answered and one was accepted.
    case 'again':
      if (!mine || !card.reviews.some((r) => r.answer === 'accepted') || card.reviews.some((r) => r.verdict === 'changes_requested' && !r.answer)) return null;
      return write(
        `Running: ${me.displayName}`,
        withReviews(card.body, card.reviews.flatMap((r) => (r.answer === 'accepted' ? [asked(r.name)] : r.verdict === 'review_required' ? [r.line] : []))),
      );
  }
}

/**
 * Whether a run may start from the card as it stands, as the user's agent, a claim or a take starts
 * one (the card-owner decision): a Ready card, an Open one with no owner, or one the user picked by
 * hand (`Running: <name>`), which their agent then runs and a failure puts back.
 */
export function startable(card: Card, name: string) {
  const lane = laneOf(card.status);
  return !!card.kind && (lane === 'ready' || (lane === 'open' && card.owner === undefined) || card.status === `Running: ${name}`);
}

/** Whether the user may take the card, which has no owner: only where a run may start, since a run names its section (D-100). */
export const takeable = (card: Card, name: string) => card.owner === undefined && startable(card, name);

/**
 * A card body with this check's line on top, in place of any it had: "Checked: 2026-11-07. Read the
 * cards, …", as `scripts/claim.sh -c` records a check (R-041, D-116). An edit keeps it.
 */
export const withChecked = (body: string, checked: string, today = new Date()) =>
  [`Checked: ${dateOf(today)}. ${checked}`, body.replace(new RegExp(CHECKED.source, 'gm'), '').trim()].filter(Boolean).join('\n\n');

/** A day as the cards write it, 2026-11-07, in the user's time zone. */
export const dateOf = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;

/** Whether a card shows as Unchecked: an idea or issue still open that no agent has checked (R-041). */
export const unchecked = (card: Card) => (card.kind === 'R' || card.kind === 'K') && !card.checked && laneOf(card.status) !== 'done';

/** The status of a card whose run waits for a decision nobody foresaw, so teammates see why it is held (R-042). */
export const WAITING = 'Waiting for a decision';

/** The groups a column shows, in order. A folded group opens on a click. */
/** A Roadmap group's fixed key, which code compares; its name is only what the board shows. */
export type Lane = 'ready' | 'running' | 'review' | 'open' | 'done';

export const GROUPS: Record<BoardColumn, Array<{ name: string; statuses: string[]; folded?: true; lane?: true; key?: Lane }>> = {
  decisions: [
    { name: 'Proposed', statuses: ['Proposed'] },
    { name: 'Accepted', statuses: ['Accepted'] },
    { name: 'Superseded', statuses: ['Superseded'], folded: true },
  ],
  // Ready, Running and In review are the lanes, side by side; Open stays fourth, where a status
  // outside the list goes.
  roadmap: [
    { key: 'ready', name: 'Ready', statuses: ['Ready'], lane: true },
    { key: 'running', name: 'Running', statuses: ['Running', WAITING], lane: true },
    // A run that ended in a draft pull request waits here for its owner to review and merge it.
    { key: 'review', name: 'In review', statuses: ['In review'], lane: true },
    { key: 'open', name: 'Open', statuses: ['Idea', 'Open'] },
    { key: 'done', name: 'Done', statuses: ['Done', 'Fixed', 'Dropped'], folded: true },
  ],
};

/** The group a status belongs to. A status outside the list goes with the open items. */
export function groupOf(column: BoardColumn, status: string): number {
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

/** The status a user's page sets on a card once their agent takes it (D-100). */
export const workingStatus = (name: string) => `Running: ${name}’s agent`;

/** Who runs a running card, such as "Ann’s agent" or "o/r#3", or the pull request a card in review waits in, or ''. */
export const runnerOf = (status: string) => /^(?:Running|In review):\s*(.*)$/.exec(status)?.[1] ?? '';

/**
 * Whether a card's status shows a run other than the user's own that still goes: a teammate's
 * agent, or a draft in review. Teammates see no run messages, only this line (D-100), and a second
 * agent would open a second draft (K-59). The user's own pick is theirs to hand to their agent.
 */
export const otherRun = (status: string, name: string) =>
  status.startsWith('In review') ||
  status.startsWith(WAITING) ||
  (status.startsWith('Running:') && status !== workingStatus(name) && status !== `Running: ${name}`);

/** A new card's id: the next free number of its kind, as wide as the widest id of that kind, so R-043 follows R-005 (R-040). */
export function idOf(ids: string[], kind: CardKind) {
  const own = ids.filter((id) => id.startsWith(`${kind}-`));
  const next = Math.max(0, ...own.map((id) => Number(id.slice(2)))) + 1;
  return `${kind}-${String(next).padStart(Math.max(1, ...own.map((id) => id.length - 2)), '0')}`;
}

/** The ids of cards that share a number with another, as two tabs that added a card at once do. */
export function duplicates(cards: Card[]): Set<string> {
  const count = new Map<string, number>();
  for (const c of cards) if (c.kind) count.set(`${c.kind}-${c.number}`, (count.get(`${c.kind}-${c.number}`) ?? 0) + 1);
  return new Set(cards.filter((c) => c.kind && count.get(`${c.kind}-${c.number}`)! > 1).map((c) => c.id));
}

/** The status a new card of each kind starts with. */
export const NEW_STATUS: Record<CardKind, string> = { D: 'Proposed', R: 'Idea', K: 'Open', Q: 'Open' };

/**
 * A card's text: the heading with its id and title, the status line, then what is under them. A
 * status line the body starts with goes, as an agent's draft may write one: the card would show
 * both, and a run moves only the first (K-1 in #170).
 */
export const cardText = (id: string, title: string, status: string, body: string) =>
  `### ${id}: ${title}\n\nStatus: ${status}.\n\n${body.replace(/^\s*Status:[^\n]*\n*/, '')}`;

/** What a new card starts with: the heading with its id, the status, and the fields of its kind. */
export function cardTemplate(kind: CardKind, id: string): string {
  const body = {
    D: 'What was decided, in one or two sentences.\n\nWhy: the reason, and what else was considered.\n\nCost: what this makes harder or rules out.',
    R: 'Why: who needs this, and what they do today instead.\n\nScope:\n\n- \n\nDone when: ',
    K: 'Seen: where and when, and how to make it happen again.\n\nCause: \n\nFix: ',
    Q: 'What is open, and what would settle it.',
  }[kind];
  return cardText(id, 'Title', NEW_STATUS[kind], body);
}

/** The project's board docs, one per column. Where two tabs made one at the same moment, the oldest counts. */
export function boardDocs(docs: Record<string, ChatDoc>, conversations: Record<number, ChatConversation>, projectId: number) {
  const found: Partial<Record<BoardColumn, ChatDoc>> = {};
  for (const d of Object.values(docs)) {
    if (!d.board || conversations[d.conversationId]?.projectId !== projectId) continue;
    const have = found[d.board];
    if (!have || d.createdAt < have.createdAt || (d.createdAt === have.createdAt && d.id < have.id)) found[d.board] = d;
  }
  return found;
}

/** Where the user's latest run of a card stands, as the run messages in #general tell it (R-027, R-030). */
export interface CardRun {
  /** The request's message id, negative while it is being sent. */
  request: number;
  runtime: number;
  repo?: string;
  /** The harness the request named, or none for the laptop's host. */
  harness?: string;
  state: 'sending' | 'waiting' | 'unanswered' | 'cancelled' | RunReport['kind'];
  note?: string;
  /** The pull request a run that is done opened. */
  pull?: RunReport['pull'];
  /** The message id of the report that set the state, so the page acts on each report once. */
  at?: number;
  /** For a merged run: the Proposed decisions its work made true (R-042). */
  decisions?: string[];
  /** The user asked to stop a run the agent took, and the agent has not reported since. */
  stopping?: boolean;
}

/**
 * Where a card must stand for its run's report to move it, and where it goes, or no move: so a
 * status a teammate set since stays (D-100, D-118). `was` is the status before the run.
 */
export function statusMove(run: CardRun, card: string, was: string, working: string): [string[], string] {
  const pull = run.pull ? `${run.pull.repo}#${run.pull.number}` : '';
  const review = pull ? `In review: ${pull}` : 'In review';
  const moves: Partial<Record<CardRun['state'], [string[], string]>> = {
    claimed: [[was], working],
    decision: [[was, working], WAITING],
    fixing: [[WAITING], working],
    done: [[was, working, WAITING], review],
    failed: [[working, WAITING], was],
    stale: [[working], was],
    // A merge moves it only with its pull request.
    merged: [[was, working, WAITING, review], pull && `${card.startsWith('K-') ? 'Fixed' : 'Done'} in ${pull}`],
    closed: [[review], was],
  };
  return moves[run.state] ?? [[], ''];
}

/**
 * The states in which a run may still go, so the page asks for no second one. A paused run goes on
 * with the owner's words, or ends on a second stop; a planned one goes on with their go or words.
 */
export const GOING = new Set<CardRun['state']>(['sending', 'waiting', 'claimed', 'fixing', 'nocopy', 'decision', 'paused', 'planned']);

/**
 * The user's latest run of each card of a board doc, by section id. A request that failed to send
 * asked nothing, and a cancel ends a request no agent took. Only the agent a request names reports
 * on it, as in the chat.
 */
export function cardRuns(messages: ChatMessage[], meId: number, docId: string, pending: Record<string, PendingStatus>, now: number) {
  const runs = new Map<string, CardRun>();
  const sections = new Map<number, string>();
  const latest = (request: number) => {
    const run = runs.get(sections.get(request) ?? '');
    return run?.request === request ? run : undefined;
  };
  for (const m of messages) {
    const run = m.run;
    if (!run) continue;
    if (run.kind === 'request') {
      const status = m.clientId ? pending[m.clientId] : undefined;
      if (m.senderId !== meId || run.docId !== docId || status === 'failed') continue;
      sections.set(m.id, run.section);
      const state = status === 'sending' ? 'sending' : now - (run.sentAt ?? 0) < RUN_PICKUP_MS ? 'waiting' : 'unanswered';
      runs.set(run.section, { request: m.id, runtime: run.runtime, repo: run.repo, harness: run.harness, state });
    } else if (run.kind === 'cancel') {
      const target = m.senderId === meId ? latest(run.request) : undefined;
      if (target?.state === 'waiting') target.state = 'cancelled';
      else if (target) target.stopping = true;
    } else if (run.kind === 'progress') {
      // A note on the state, not a state: the card keeps claimed or fixing, and its status line stays.
      const target = latest(run.request);
      if (target && m.senderId === target.runtime) target.note = run.note;
    } else if (run.kind === 'fix') {
      // The user's go for another round on a draft that is done, as Run again sends: the run fixes from
      // here, so a page that reloads before the agent says so does not move the card back to review.
      const target = m.senderId === meId ? latest(run.request) : undefined;
      if (target?.state === 'done') Object.assign(target, { state: 'fixing', at: m.id });
    } else if (run.kind !== 'clone' && run.kind !== 'draft') {
      const target = latest(run.request);
      if (target && m.senderId === target.runtime) Object.assign(target, { state: run.kind, note: run.note, pull: run.pull, decisions: run.decisions, at: m.id, stopping: false });
    }
  }
  return runs;
}
