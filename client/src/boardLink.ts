// Links a project's board to one of its repositories (R-040, D-117). The owner's page asks their
// agent for the repository's entries, writes them as cards with their own numbers, since code,
// commits and decisions cite them, and then names the repository in the Roadmap doc's title. From
// then on the agent keeps the repository's docs as copies of the board. Only a page writes the board
// (D-104), and only the project's owner links it.
import { readCard, type Card } from '../../shared/board';
import { api } from './api';
import { boardDocs, COLUMN_TITLES, COLUMNS, idOf, type BoardColumn } from './board';
import { boardCards, createBoard, newSectionId, replaceSection, rewriteCard, saveSection } from './docs';
import type { ChatDoc } from './e2ee/keyring';
import { store } from './store';

/**
 * Writes a repository's entries onto the board, then links the board to the repository. It holds
 * both columns' title locks throughout, so no page numbers a card meanwhile (D-116). A board card
 * whose number an entry takes moves to the next free number of its kind, and its text names the old
 * one. An entry the board has already, word for word, is left, so a link cut short can run again.
 */
export async function importEntries(projectId: number, repo: string, entries: string[], progress: (done: number) => void) {
  const found = boardDocs(store.get().docs, store.get().conversations, projectId);
  const docs: Record<BoardColumn, ChatDoc> = {
    decisions: found.decisions ?? (await createBoard(projectId, 'decisions')),
    roadmap: found.roadmap ?? (await createBoard(projectId, 'roadmap')),
  };
  const lock = () => Promise.all(COLUMNS.map((c) => api.lockSection(docs[c].id, 'title')));
  const read = entries.map((text) => ({ text: text.trim(), ...readCard(text)! }));
  await lock();
  let done = 0;
  try {
    for (const column of COLUMNS) {
      const doc = docs[column];
      const cards = await boardCards(doc);
      const incoming = read.filter((e) => (e.kind === 'D' ? 'decisions' : 'roadmap') === column);
      const kept = new Set(cards.map((c) => c.text.trim()));
      const texts = new Set(incoming.map((e) => e.text));
      const taken = new Set(incoming.map((e) => `${e.kind}-${e.number}`));
      // Every id in the column, the entries' and the cards', so a moved card takes a number nobody has.
      const ids = [...incoming.map((e) => e.id), ...cards.map((c) => c.cardId)];
      for (const card of cards.filter((c) => c.kind && taken.has(`${c.kind}-${c.number}`) && !texts.has(c.text.trim()))) {
        const id = idOf(ids, card.kind!);
        ids.push(id);
        await rewriteCard(doc, card.id, (now) => renumbered(now, id, repo));
      }
      let pos = Math.max(0, ...cards.map((c) => c.pos));
      for (const entry of incoming) {
        if (!kept.has(entry.text)) await replaceSection(doc, newSectionId(), { text: entry.text, pos: ++pos });
        progress(++done);
        // A lock lapses 2 minutes after it was taken, and an import can take longer (D-081).
        if (done % 50 === 0) await lock();
      }
    }
    await saveSection(docs.roadmap, 'title', { text: COLUMN_TITLES.roadmap, board: 'roadmap', repo });
  } finally {
    await Promise.all(COLUMNS.map((c) => api.unlockSection(docs[c].id, 'title').catch(() => undefined)));
  }
}

/** A card moved to a free id, saying which one it had. */
const renumbered = (card: Card, id: string, repo: string) =>
  `${card.text.trim().replace(/^###\s+[A-Z]-\d+:/, `### ${id}:`)}\n\nThis card was ${card.cardId} on the board until ${repo}'s ${card.cardId} took that number.`;
