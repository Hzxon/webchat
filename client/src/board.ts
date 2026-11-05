// The project board (R-021, D-082): two docs, Decisions and Roadmap, whose sections are cards in
// the format of this repository's docs/decisions.md and docs/roadmap.md. A card is Markdown that
// starts with "### D-3: Title" and a "Status:" line. This module only reads and writes that text,
// so the tests run it without a browser.
import type { DocContent } from '../../shared/e2ee';
import { RUN_PICKUP_MS, type RunReport } from '../../shared/types';
import type { DocSection } from './docs';
import type { ChatConversation, ChatDoc, ChatMessage } from './e2ee/keyring';
import type { PendingStatus } from './store';

export type BoardColumn = NonNullable<DocContent['board']>;
/** Decisions are D-n. Ideas, R-n, and issues, K-n, share the Roadmap column. */
export type CardKind = 'D' | 'R' | 'K';

export interface Card extends DocSection {
  kind: CardKind | null;
  number: number | null;
  title: string;
  /** The status line without "Status:" and its final period, such as "Accepted 2026-11-04". */
  status: string;
  /** What is under the heading and the status line. */
  body: string;
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
};

const HEADING = /^###\s+([DRK])-(\d+):\s*(.*?)\s*$/;
const STATUS = /^Status:\s*(.*?)\.?\s*$/;

/** Reads a card's kind, number, title and status from its heading and the status line under it. */
export function parseCard(section: DocSection): Card {
  const lines = section.text.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  const heading = first >= 0 ? HEADING.exec(lines[first]!) : null;
  let rest = first >= 0 ? lines.slice(first + 1) : [];
  const next = rest.findIndex((l) => l.trim() !== '');
  const status = heading && next >= 0 ? STATUS.exec(rest[next]!) : null;
  if (status) rest = rest.slice(next + 1);
  return {
    ...section,
    kind: heading ? (heading[1] as CardKind) : null,
    number: heading ? Number(heading[2]) : null,
    // A card without the heading is titled by its first line, bare of Markdown heading marks.
    title: heading ? heading[3]! : (lines[first]?.replace(/^#+\s*/, '') ?? ''),
    status: status?.[1] ?? '',
    body: (heading ? rest : lines).join('\n').trim(),
  };
}

/** The groups a column shows, in order. A folded group opens on a click. */
export const GROUPS: Record<BoardColumn, Array<{ name: string; statuses: string[]; folded?: true }>> = {
  decisions: [
    { name: 'Proposed', statuses: ['Proposed'] },
    { name: 'Accepted', statuses: ['Accepted'] },
    { name: 'Superseded', statuses: ['Superseded'], folded: true },
  ],
  roadmap: [
    { name: 'In progress', statuses: ['In progress'] },
    // A run that ended in a draft pull request waits here for its owner to review and merge it.
    { name: 'In review', statuses: ['In review'] },
    { name: 'Next', statuses: ['Next', 'Planned'] },
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

/** The next free number of a kind among these cards. */
export const nextNumber = (cards: Card[], kind: CardKind) => Math.max(0, ...cards.filter((c) => c.kind === kind).map((c) => c.number!)) + 1;

/** The ids of cards that share a number with another, as two tabs that added a card at once do. */
export function duplicates(cards: Card[]): Set<string> {
  const count = new Map<string, number>();
  for (const c of cards) if (c.kind) count.set(`${c.kind}-${c.number}`, (count.get(`${c.kind}-${c.number}`) ?? 0) + 1);
  return new Set(cards.filter((c) => c.kind && count.get(`${c.kind}-${c.number}`)! > 1).map((c) => c.id));
}

/** The status a new card of each kind starts with. */
export const NEW_STATUS: Record<CardKind, string> = { D: 'Proposed', R: 'Idea', K: 'Open' };

/** A card's text: the heading with its number and title, the status line, then what is under them. */
export const cardText = (kind: CardKind, number: number, title: string, status: string, body: string) =>
  `### ${kind}-${number}: ${title}\n\nStatus: ${status}.\n\n${body.trim()}`;

/** What a new card starts with: the heading with its number, the status, and the fields of its kind. */
export function cardTemplate(kind: CardKind, number: number): string {
  const body = {
    D: 'What was decided, in one or two sentences.\n\nWhy: the reason, and what else was considered.\n\nCost: what this makes harder or rules out.',
    R: 'Why: who needs this, and what they do today instead.\n\nScope:\n\n- \n\nDone when: ',
    K: 'Seen: where and when, and how to make it happen again.\n\nCause: \n\nFix: ',
  }[kind];
  return `### ${kind}-${number}: Title\n\nStatus: ${NEW_STATUS[kind]}.\n\n${body}`;
}

const kindOrder = (c: Card) => (c.kind ? 'DRK'.indexOf(c.kind) : 3);

/** The column as the text of docs/decisions.md or docs/roadmap.md: a heading, then the cards in number order. */
export function columnMarkdown(column: BoardColumn, cards: Card[]): string {
  const sorted = [...cards].sort((a, b) => kindOrder(a) - kindOrder(b) || (a.number ?? Infinity) - (b.number ?? Infinity));
  return [`# ${COLUMN_TITLES[column]}`, ...sorted.map((c) => c.text.trim())].join('\n\n') + '\n';
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
  state: 'sending' | 'waiting' | 'unanswered' | 'cancelled' | RunReport['kind'];
  note?: string;
  /** The pull request a run that is done opened. */
  pull?: RunReport['pull'];
}

/** The states in which a run may still go, so the page asks for no second one. */
export const GOING = new Set<CardRun['state']>(['sending', 'waiting', 'claimed', 'fixing']);

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
      runs.set(run.section, { request: m.id, runtime: run.runtime, repo: run.repo, state });
    } else if (run.kind === 'cancel') {
      const target = m.senderId === meId ? latest(run.request) : undefined;
      if (target?.state === 'waiting') target.state = 'cancelled';
    } else {
      const target = latest(run.request);
      if (target && m.senderId === target.runtime) Object.assign(target, { state: run.kind, note: run.note, pull: run.pull });
    }
  }
  return runs;
}
