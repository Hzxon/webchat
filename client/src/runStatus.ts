// Keeps a card's status line in step with its run, from whichever page of its owner is open
// (D-105, D-100). Teammates see no run messages, so the status line is how they learn that a card
// runs: "Running: Ann's agent" once the agent took it, after it checked the brief, "Waiting for
// a decision" while it waits for one, "Waiting for K-12: Ann and Bob choose" while its files overlap
// an earlier draft's, "In review: repo#N" once its work is in its draft, "Done in
// repo#N" once that is merged, and the status it had before when the run fails, the card no
// longer holds (R-042) or the draft is closed unmerged. Each move is made only from the status it
// expects, so a status a teammate set since stays, and only under the card's lock, read there,
// never while anyone, another tab included, holds it.
import { newStatus, WAITING, withStatus, type Card } from '../../shared/board';
import { choiceLine, choosers } from '../../shared/overlap';
import type { BoardSyncDTO, RunRequest } from '../../shared/types';
import { agentChats, inOrder } from './agents';
import { boardDocs, cardRuns, dateOf, standsAt, startable, statusMove, waitsFor, workingStatus } from './board';
import { sendCardNote, startDirectChat } from './chat';
import { boardCards, rewriteCard } from './docs';
import type { ChatDoc, ChatMessage } from './e2ee/keyring';
import { store } from './store';

const tried = new Set<string>();

/** A board doc's cards, read once a pass, and only when a move may need them. */
type Cards = (doc: ChatDoc) => Promise<Card[]>;

export async function followRuns() {
  const state = store.get();
  const me = state.me;
  if (!me) return;
  // In id order across chats, so the newest request of a card is the one that counts.
  const messages = inOrder(agentChats(state).flatMap((c) => state.messages[c.id] ?? []));
  const requests = new Map<number, RunRequest>(messages.flatMap((m) => (m.run?.kind === 'request' && m.senderId === me.id ? [[m.id, m.run] as const] : [])));
  const working = workingStatus(me.displayName);
  const read = new Map<string, Promise<Card[]>>();
  const cardsOf: Cards = (doc) => read.get(doc.id) ?? read.set(doc.id, boardCards(doc)).get(doc.id)!;
  for (const docId of new Set([...requests.values()].map((r) => r.docId))) {
    const doc = state.docs[docId];
    if (!doc) continue;
    for (const [section, run] of cardRuns(messages, me.id, docId, state.pending, Date.now())) {
      const request = requests.get(run.request)!;
      // An older page signed the status it saw in the old words, and the cards read in today's.
      const was = newStatus(request.was ?? '');
      const key = `${run.request}:${run.at}`;
      if (run.state === 'merged' && run.pull) await accept(doc, run.decisions ?? [], `Accepted ${dateOf(new Date())} in ${run.pull.repo}#${run.pull.number} (${request.card})`, key, cardsOf);
      const [from, target] = statusMove(run, request.card, was, working);
      if (!target || tried.has(key) || doc.locks.some((l) => l.section === section)) continue;
      tried.add(key);
      // Most reports moved their card already, so only a card that stands where the move starts takes its lock.
      const cards = await cardsOf(doc);
      const card = cards.find((c) => c.id === section);
      if (!card || !standsAt(from, card.status)) continue;
      // Both card owners choose for a card that waits for another, and each but the user gets a push (docs/roadmap/new-overlap-gate.md).
      const owners = run.state === 'overlap' ? choosers(card.owner, cards.find((c) => c.cardId.replace(/-0+(?=\d)/, '-') === run.waits)?.owner, me.id) : [];
      const to = owners.length ? waitsFor(target, owners.map((id) => (id === me.id ? me.displayName : (state.users[id]?.displayName ?? 'someone')))) : target;
      if (!(await move(doc, section, (status) => standsAt(from, status), to))) continue;
      for (const owner of owners.filter((id) => id !== me.id))
        await startDirectChat(owner)
          .then((chat) => sendCardNote(chat, { kind: 'waiting', card: card.cardId, docId, section }, `${card.cardId} waits for ${run.waits}: both change the same files. Choose on ${card.cardId} with the line "${choiceLine(run.waits!, 'wait')}", or stack or fold in place of wait.`))
          .catch(() => undefined);
      // The owner decides for the card, so they get a push; only the requester's go resumes the run (D-118). A second tab finds it moved and sends none.
      // With a verdict on the card, a WAITING of anyone but its owner would not stand.
      if (to === WAITING && card.owner !== undefined && card.owner !== me.id && card.reviews.every((r) => r.verdict === 'review_required'))
        await startDirectChat(card.owner)
          .then((chat) => sendCardNote(chat, { kind: 'waiting', card: card.cardId, docId, section }, `${card.cardId} waits for your decision: ${card.title}`))
          .catch(() => undefined);
    }
  }
  await followClaims(messages, me.id, cardsOf);
}

/** Sets a card's status under its lock, only while `from` allows the status that stands there, and syncs once it moved. Returns whether it moved. */
const move = (doc: ChatDoc, section: string, from: (status: string) => boolean, to: string) =>
  rewriteCard(doc, section, (card) => (from(card.status) ? withStatus(card.text, to) : null)).catch(() => false);

const PROPOSED = /^Proposed\b/i;

/** Marks Accepted the Proposed decisions a merged run made true, on its card's board, each once (R-042). */
async function accept(card: ChatDoc, ids: string[], status: string, key: string, cardsOf: Cards) {
  const state = store.get();
  const doc = boardDocs(state.docs, state.conversations, state.conversations[card.conversationId]?.projectId ?? 0).decisions;
  if (!doc) return;
  for (const id of ids) {
    if (tried.has(`${key}:${id}`)) continue;
    const decision = (await cardsOf(doc)).find((d) => d.cardId === id);
    if (decision && doc.locks.some((l) => l.section === decision.id)) continue;
    tried.add(`${key}:${id}`);
    if (decision && PROPOSED.test(decision.status)) await move(doc, decision.id, (status) => PROPOSED.test(status), status);
  }
}

/**
 * Sets the cards that open pull requests claim to `Running: repo#N`, as the owner's agent names
 * them for a linked board, so a claim made outside WebChat shows there too (R-040). Only a ready
 * card moves, or an open one with no owner, since only an owner marks theirs ready (the card-owner
 * decision); never one that runs, waits for review or is finished.
 */
async function followClaims(messages: ChatMessage[], meId: number, cardsOf: Cards) {
  const state = store.get();
  const newest = new Map<number, Extract<BoardSyncDTO, { kind: 'claims' }>>();
  for (const m of messages) if (m.board?.kind === 'claims' && m.senderId !== meId) newest.set(m.board.project, m.board);
  for (const { project, repo, claims } of newest.values()) {
    const doc = boardDocs(state.docs, state.conversations, project).roadmap;
    const fresh = claims.filter((c) => !tried.has(`${doc?.id}:${c.card}:${c.pull}`));
    if (!doc || !fresh.length) continue;
    const cards = await cardsOf(doc);
    for (const { card: id, pull } of fresh) {
      tried.add(`${doc.id}:${id}:${pull}`);
      const card = cards.find((c) => c.cardId === id);
      if (!card || !startable(card, state.me?.displayName ?? '') || doc.locks.some((l) => l.section === card.id)) continue;
      await move(doc, card.id, (status) => status === card.status, `Running: ${repo}#${pull}`);
    }
  }
}
