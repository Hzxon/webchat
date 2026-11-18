// The project board (R-021, D-082): two docs, Decisions and Roadmap, whose sections are cards in
// the format of this repository's docs/decisions.md and docs/roadmap.md. A card is Markdown that
// starts with "### D-3: Title" and a "Status:" line. This module only reads and writes that text,
// so the tests run it without a browser.
import { cardText, CHECKED, laneOf, WAITING, withReviews, type Card, type CardKind, type Lane, type Review } from '../../shared/board';
import type { DocContent } from '../../shared/e2ee';
import { RUN_PICKUP_MS, type RunReport, type UserDTO } from '../../shared/types';
import type { Thread } from './agents';
import type { ChatConversation, ChatDoc, ChatMessage } from './e2ee/keyring';
import type { PendingStatus } from './store';

export type BoardColumn = NonNullable<DocContent['board']>;
/** Decisions are D-n. Ideas, R-n, issues, K-n, and questions, Q-n, share the Roadmap column. */
export type { CardKind };

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

/** A requested change its owner did not decline, which keeps the card from closing. */
export const openChange = (reviews: Review[]) => reviews.some((r) => r.verdict === 'changes_requested' && r.answer !== 'declined');

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
    } else if (run.kind !== 'clone' && run.kind !== 'draft' && run.kind !== 'note') {
      const target = latest(run.request);
      if (target && m.senderId === target.runtime) Object.assign(target, { state: run.kind, note: run.note, pull: run.pull, decisions: run.decisions, at: m.id, stopping: false });
    }
  }
  return runs;
}

/** The thread of the user's run of a card, which holds what the run's reports alone cannot say, such as a waiting question. */
export const threadOf = (run: CardRun | undefined, threads: Thread[]) => run && threads.find((t) => t.request === run.request);

/** Why a card waits for the user, in the order the board lists them, with the words its face and the Needs you row show (R-047). */
export const NEEDS = {
  asking: 'Asking you',
  planned: 'Plan ready',
  decision: 'Waiting for a decision',
  paused: 'Stopped',
  review: 'Asks for your review',
  ready: 'Asks you to mark it ready',
} as const;
export type Need = keyof typeof NEEDS;
const ORDER = Object.keys(NEEDS);

/**
 * The Roadmap's cards that wait for the user, and why, questions first (R-047). A run counts from its
 * thread, which turns to working the moment the user answers, gives the go or redirects it, while
 * the run's state waits for the agent's next report. A request counts while the card holds it: a
 * review line of theirs with no verdict, on a card in review, or an ask on their own open card,
 * which marking it ready drops.
 */
export function needsYou(cards: Card[], meId: number, runs: Map<string, CardRun>, threads: Thread[]) {
  const needOf = (card: Card): Need | undefined => {
    const run = runs.get(card.id);
    const thread = run && !run.stopping ? threadOf(run, threads) : undefined;
    if (thread?.state === 'asking' && !thread.ask?.answered) return 'asking';
    if (thread?.state === 'planned' || thread?.state === 'paused') return thread.state;
    // A waiting thread can wait for a review or a clone too, which the run's state tells apart.
    if (thread?.state === 'waiting' && run!.state === 'decision') return 'decision';
    const lane = laneOf(card.status);
    if (lane === 'review' && card.reviews.some((r) => r.who === meId && r.verdict === 'review_required')) return 'review';
    if (lane === 'open' && card.owner === meId && card.body.match(ASKED)) return 'ready';
  };
  return cards
    .flatMap((card) => {
      const need = needOf(card);
      return need ? [{ card, need }] : [];
    })
    .sort((a, b) => ORDER.indexOf(a.need) - ORDER.indexOf(b.need));
}
