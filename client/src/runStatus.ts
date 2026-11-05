// Keeps a card's status line in step with its run, from whichever page of its owner is open
// (D-105, D-100). Teammates see no run messages, so the status line is how they learn that a card
// runs: "In progress: Ann's agent" once the agent took it, after it checked the brief, "In review:
// repo#N" once its draft is open, and the status it had before when the run fails. Each request's
// state is written once, and never under a teammate's lock.
import { cardStatus } from '../../shared/types';
import { agentChats } from './agents';
import { cardRuns, withStatus } from './board';
import { syncNow } from './chat';
import { loadSections, replaceSection, type DocSection } from './docs';
import { store } from './store';

const written = new Set<string>();

export async function followRuns() {
  const state = store.get();
  const me = state.me;
  if (!me) return;
  const messages = agentChats(state).flatMap((c) => state.messages[c.id] ?? []);
  const requests = new Map(messages.flatMap((m) => (m.run?.kind === 'request' && m.senderId === me.id ? [[m.id, m.run] as const] : [])));
  for (const docId of new Set([...requests.values()].map((r) => r.docId))) {
    const doc = state.docs[docId];
    if (!doc) continue;
    let sections: DocSection[] | undefined;
    for (const [section, run] of cardRuns(messages, me.id, docId, state.pending, Date.now())) {
      let status: string | undefined;
      if (run.state === 'claimed') status = `In progress: ${me.displayName}’s agent`;
      else if (run.state === 'done') status = run.pull ? `In review: ${run.pull.repo}#${run.pull.number}` : 'In review';
      else if (run.state === 'failed') status = requests.get(run.request)?.was;
      const key = `${run.request}:${run.state}`;
      if (status === undefined || written.has(key) || doc.locks.some((l) => l.section === section && l.userId !== me.id)) continue;
      written.add(key);
      sections ??= await loadSections(doc);
      const card = sections.find((s) => s.id === section);
      const now = card ? cardStatus(card.text) : '';
      // A failed run puts back only its own "In progress", and nothing moves a card that is done.
      if (!card || now === status || (run.state === 'failed' && !now.startsWith('In progress')) || /^(done|fixed|dropped)/i.test(now)) continue;
      await replaceSection(doc, section, { text: withStatus(card.text, status), pos: card.pos });
      void syncNow();
    }
  }
}
