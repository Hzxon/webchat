// The project board (R-021, D-082): two docs, Decisions and Roadmap, whose sections are cards in
// the format of this repository's docs/decisions.md and docs/roadmap.md. A card is Markdown that
// starts with "### D-3: Title" and a "Status:" line. This module only reads and writes that text,
// so the tests run it without a browser.
import { readCard, type CardKind } from '../../shared/board';
import type { DocContent } from '../../shared/e2ee';
import { RUN_PICKUP_MS, type DocRevisionDTO, type RunReport } from '../../shared/types';
import type { DocSection } from './docs';
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
 * oldest its opener when it says `opened`, and each author's newest their word.
 */
export function cardSections(rows: Opened[]): DocSection[] {
  const bySection = new Map<string, Opened[]>();
  for (const row of rows) if (row.revision.section !== 'title') (bySection.get(row.revision.section) ?? bySection.set(row.revision.section, []).get(row.revision.section)!).push(row);
  return [...bySection.values()]
    .filter((list) => !list.at(-1)!.content?.removed)
    .map((list) => {
      // Rows come in id order, so each author's last row is their word, not the oldest row the list also holds.
      const wordOf = new Map(list.map((row) => [row.revision.authorId, row]));
      return {
        ...sectionOf(list.at(-1)!),
        openedBy: list[0]!.content?.opened ? list[0]!.revision.authorId : undefined,
        words: [...wordOf.values()]
          .sort((a, b) => b.revision.id - a.revision.id)
          .flatMap(({ revision, content }) => (content ? [{ id: revision.id, authorId: revision.authorId, text: content.text }] : [])),
      };
    })
    .sort((a, b) => a.pos - b.pos);
}

/** A card with its owner: the member who opened it, while they are still among `members`. */
export const cardOf = (section: DocSection, members: number[]): Card => ({
  ...parseCard(section),
  owner: section.openedBy !== undefined && members.includes(section.openedBy) ? section.openedBy : undefined,
});

/**
 * A card body with this check's line on top, in place of any it had: "Checked: 2026-11-07. Read the
 * cards, …", as `scripts/claim.sh -c` records a check (R-041, D-116). An edit keeps it.
 */
export const withChecked = (body: string, checked: string, today = new Date()) =>
  [`Checked: ${dateOf(today)}. ${checked}`, body.replace(new RegExp(CHECKED.source, 'gm'), '').trim()].filter(Boolean).join('\n\n');

/** A day as the cards write it, 2026-11-07, in the user's time zone. */
export const dateOf = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;

/** Whether a card shows as Unchecked: an idea or issue still open that no agent has checked (R-041). */
export const unchecked = (card: Card) => (card.kind === 'R' || card.kind === 'K') && !card.checked && GROUPS.roadmap[groupOf('roadmap', card.status)]!.name !== 'Done';

/** The status of a card whose run waits for a decision nobody foresaw, so teammates see why it is held (R-042). */
export const WAITING = 'Waiting for a decision';

/** The groups a column shows, in order. A folded group opens on a click. */
export const GROUPS: Record<BoardColumn, Array<{ name: string; statuses: string[]; folded?: true; lane?: true }>> = {
  decisions: [
    { name: 'Proposed', statuses: ['Proposed'] },
    { name: 'Accepted', statuses: ['Accepted'] },
    { name: 'Superseded', statuses: ['Superseded'], folded: true },
  ],
  // Ready, Running and In review are the lanes, side by side; Open stays fourth, where a status
  // outside the list goes.
  roadmap: [
    { name: 'Ready', statuses: ['Ready'], lane: true },
    { name: 'Running', statuses: ['Running', WAITING], lane: true },
    // A run that ended in a draft pull request waits here for its owner to review and merge it.
    { name: 'In review', statuses: ['In review'], lane: true },
    { name: 'Open', statuses: ['Idea', 'Open'] },
    { name: 'Done', statuses: ['Done', 'Fixed', 'Dropped'], folded: true },
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
 * agent would open a second draft (K-59).
 */
export const otherRun = (status: string, name: string) =>
  status.startsWith('In review') ||
  status.startsWith(WAITING) ||
  (status.startsWith('Running:') && status !== workingStatus(name));

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
    } else if (run.kind !== 'fix' && run.kind !== 'clone' && run.kind !== 'draft') {
      const target = latest(run.request);
      if (target && m.senderId === target.runtime) Object.assign(target, { state: run.kind, note: run.note, pull: run.pull, decisions: run.decisions, at: m.id, stopping: false });
    }
  }
  return runs;
}
