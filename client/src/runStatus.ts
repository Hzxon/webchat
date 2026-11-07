// Keeps a card's status line in step with its run, from whichever page of its owner is open
// (D-105, D-100). Teammates see no run messages, so the status line is how they learn that a card
// runs: "In progress: Ann's agent" once the agent took it, after it checked the brief, "In review:
// repo#N" once its draft is open, and the status it had before when the run fails. Each move is
// made only from the status it expects, so a status a teammate set since stays, and only under the
// card's lock, read there, never while anyone, another tab included, holds it.
import { cardStatus, type BoardSyncDTO, type RunRequest } from '../../shared/types';
import { agentChats, inOrder } from './agents';
import { boardDocs, cardRuns, GROUPS, groupOf, parseCard, withStatus, workingStatus } from './board';
import { syncNow } from './chat';
import { loadSections, rewriteSection } from './docs';
import type { ChatMessage } from './e2ee/keyring';
import { store } from './store';

const tried = new Set<string>();

export async function followRuns() {
  const state = store.get();
  const me = state.me;
  if (!me) return;
  // In id order across chats, so the newest request of a card is the one that counts.
  const messages = inOrder(agentChats(state).flatMap((c) => state.messages[c.id] ?? []));
  const requests = new Map<number, RunRequest>(messages.flatMap((m) => (m.run?.kind === 'request' && m.senderId === me.id ? [[m.id, m.run] as const] : [])));
  const working = workingStatus(me.displayName);
  for (const docId of new Set([...requests.values()].map((r) => r.docId))) {
    const doc = state.docs[docId];
    if (!doc) continue;
    for (const [section, run] of cardRuns(messages, me.id, docId, state.pending, Date.now())) {
      const was = requests.get(run.request)?.was ?? '';
      // Where the card must stand for the move, and where it goes.
      let from: string[] = [];
      let to = '';
      if (run.state === 'claimed') [from, to] = [[was], working];
      else if (run.state === 'done') [from, to] = [[was, working], run.pull ? `In review: ${run.pull.repo}#${run.pull.number}` : 'In review'];
      else if (run.state === 'failed') [from, to] = [[working], was];
      const key = `${run.request}:${run.state}`;
      if (!to || tried.has(key) || doc.locks.some((l) => l.section === section)) continue;
      tried.add(key);
      const moved = await rewriteSection(doc, section, async (card) =>
        card && !card.failed && from.includes(cardStatus(card.text)) ? { text: withStatus(card.text, to), pos: card.pos } : null,
      ).catch(() => false);
      if (moved) void syncNow();
    }
  }
  await followClaims(messages, me.id);
}

/**
 * Sets the cards that open pull requests claim to `In progress: repo#N`, as the owner's agent names
 * them for a linked board, so a claim made outside WebChat shows there too (R-040). Only an open
 * card moves, never one that runs, waits for review or is finished.
 */
async function followClaims(messages: ChatMessage[], meId: number) {
  const state = store.get();
  const newest = new Map<number, Extract<BoardSyncDTO, { kind: 'claims' }>>();
  for (const m of messages) if (m.board?.kind === 'claims' && m.senderId !== meId) newest.set(m.board.project, m.board);
  for (const { project, repo, claims } of newest.values()) {
    const doc = boardDocs(state.docs, state.conversations, project).roadmap;
    const fresh = claims.filter((c) => !tried.has(`${doc?.id}:${c.card}:${c.pull}`));
    if (!doc || !fresh.length) continue;
    const cards = (await loadSections(doc)).map(parseCard);
    for (const { card: id, pull } of fresh) {
      tried.add(`${doc.id}:${id}:${pull}`);
      const card = cards.find((c) => c.cardId === id);
      if (!card || !['Next', 'Open'].includes(GROUPS.roadmap[groupOf('roadmap', card.status)]!.name) || doc.locks.some((l) => l.section === card.id)) continue;
      const moved = await rewriteSection(doc, card.id, async (now) =>
        now && cardStatus(now.text) === card.status ? { text: withStatus(now.text, `In progress: ${repo}#${pull}`), pos: now.pos } : null,
      ).catch(() => false);
      if (moved) void syncNow();
    }
  }
}
