// Keeps a card's status line in step with its run, from whichever page of its owner is open
// (D-105, D-100). Teammates see no run messages, so the status line is how they learn that a card
// runs: "In progress: Ann's agent" once the agent took it, after it checked the brief, "Waiting for
// a decision" while it waits for one, "In review: repo#N" once its work is in its draft, "Done in
// repo#N" once that is merged, and the status it had before when the run fails or the card no
// longer holds (R-042). Each move is made only from the status it expects, so a status a teammate
// set since stays, and only under the card's lock, read there, never while anyone, another tab
// included, holds it.
import { cardStatus, type BoardSyncDTO, type RunRequest } from '../../shared/types';
import { agentChats, inOrder } from './agents';
import { boardDocs, cardRuns, dateOf, GROUPS, groupOf, parseCard, WAITING, withStatus, workingStatus, type Card, type CardRun } from './board';
import { syncNow } from './chat';
import { loadSections, rewriteSection } from './docs';
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
  const cardsOf: Cards = (doc) => read.get(doc.id) ?? read.set(doc.id, loadSections(doc).then((sections) => sections.map(parseCard))).get(doc.id)!;
  for (const docId of new Set([...requests.values()].map((r) => r.docId))) {
    const doc = state.docs[docId];
    if (!doc) continue;
    for (const [section, run] of cardRuns(messages, me.id, docId, state.pending, Date.now())) {
      const request = requests.get(run.request)!;
      const was = request.was ?? '';
      const pull = run.pull ? `${run.pull.repo}#${run.pull.number}` : '';
      const review = pull ? `In review: ${pull}` : 'In review';
      const key = `${run.request}:${run.at}`;
      if (run.state === 'merged' && pull) await accept(doc, run.decisions ?? [], `Accepted ${dateOf(new Date())} in ${pull} (${request.card})`, key, cardsOf);
      // Where the card must stand for the move, and where it goes; a merge moves it only with its pull request.
      const moves: Partial<Record<CardRun['state'], [string[], string]>> = {
        claimed: [[was], working],
        decision: [[was, working], WAITING],
        fixing: [[WAITING], working],
        done: [[was, working, WAITING], review],
        failed: [[working, WAITING], was],
        stale: [[working], was],
        merged: [[was, working, WAITING, review], pull && `${request.card.startsWith('K-') ? 'Fixed' : 'Done'} in ${pull}`],
      };
      const [from, to] = moves[run.state] ?? [[], ''];
      if (!to || tried.has(key) || doc.locks.some((l) => l.section === section)) continue;
      tried.add(key);
      // Most reports moved their card already, so only a card that stands where the move starts takes its lock.
      const card = (await cardsOf(doc)).find((c) => c.id === section);
      if (card && from.includes(card.status)) await move(doc, section, (status) => from.includes(status), to);
    }
  }
  await followClaims(messages, me.id, cardsOf);
}

/** Sets a card's status under its lock, only while `from` allows the status it has there, and syncs once it moved. */
async function move(doc: ChatDoc, section: string, from: (status: string) => boolean, to: string) {
  const moved = await rewriteSection(doc, section, async (card) =>
    card && !card.failed && from(cardStatus(card.text)) ? { text: withStatus(card.text, to), pos: card.pos } : null,
  ).catch(() => false);
  if (moved) void syncNow();
}

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
 * Sets the cards that open pull requests claim to `In progress: repo#N`, as the owner's agent names
 * them for a linked board, so a claim made outside WebChat shows there too (R-040). Only an open
 * card moves, never one that runs, waits for review or is finished.
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
      if (!card || !['Next', 'Open'].includes(GROUPS.roadmap[groupOf('roadmap', card.status)]!.name) || doc.locks.some((l) => l.section === card.id)) continue;
      await move(doc, card.id, (status) => status === card.status, `In progress: ${repo}#${pull}`);
    }
  }
}
