// A card a coding agent drafted in its answer (R-035, D-104). It stays in the conversation until
// its owner adds it. Their page then writes it to the board as them: a new card with the next free
// number of its kind, taken when they press the button, or the change to the card it replaces, but
// only while that card says what the agent saw.
import { useEffect, useMemo, useState } from 'react';
import { textHash } from '../../../shared/e2ee';
import type { CardDraftDTO } from '../../../shared/types';
import type { Thread } from '../agents';
import { api } from '../api';
import { boardDocs, cardText, KIND_NAMES, NEW_STATUS, nextNumber, parseCard, type Card } from '../board';
import { noteAdded, syncNow, tellAgent } from '../chat';
import { loadSections, newSectionId, replaceSection, sectionHistory } from '../docs';
import type { ChatMessage } from '../e2ee/keyring';
import { actions, senderName, useAppState } from '../store';
import { createBoard } from './BoardView';
import { formatSince } from './format';
import { Markdown } from './Markdown';

/** Why a change cannot go on: its card changed or went since the agent drafted it. */
type Stale = { by: string; at: number } | 'deleted';

export function AgentDraft({ message, draft, thread, agentId }: { message: ChatMessage; draft: CardDraftDTO; thread: Thread; agentId: number }) {
  const projects = useAppState((s) => s.projects);
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const change = draft.replaces;
  const added = thread.added[message.clientId ?? ''];
  // A new card goes to a project the agent shares with the user; a change, to its card's board.
  const shared = useMemo(
    () => Object.values(projects).filter((p) => meId !== undefined && p.memberIds.includes(meId) && p.memberIds.includes(agentId)),
    [projects, meId, agentId],
  );
  const [picked, setPicked] = useState<number | null>(shared.length === 1 ? shared[0]!.id : null);
  const projectId = change ? (conversations[docs[change.doc]?.conversationId ?? 0]?.projectId ?? null) : picked;
  const roadmap = projectId === null ? undefined : boardDocs(docs, conversations, projectId).roadmap;
  const [cards, setCards] = useState<Card[] | null>(null);
  const [stale, setStale] = useState<Stale | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // With several boards, the one whose channel links the conversation's repository is the likely one.
  useEffect(() => {
    if (change || shared.length < 2) return;
    let live = true;
    void Promise.all(shared.map((p) => api.projectRepos(p.id).then((v) => (v.repos.some((r) => r.repo === thread.repo) ? p.id : null), () => null))).then((ids) => {
      const linked = ids.filter((id) => id !== null);
      if (live && linked.length === 1) setPicked((current) => current ?? linked[0]!);
    });
    return () => {
      live = false;
    };
  }, [change, shared, thread.repo]);

  // The board as it is now, again whenever its doc changes.
  useEffect(() => {
    let live = true;
    if (!roadmap) setCards([]);
    else void loadSections(roadmap).then((sections) => live && setCards(sections.map(parseCard)), () => live && setCards([]));
    return () => {
      live = false;
    };
  }, [roadmap?.id, roadmap?.version]);

  const current = change ? cards?.find((c) => c.id === change.section) : undefined;
  useEffect(() => {
    if (!change || !cards || added) return;
    let live = true;
    void (async () => {
      if (!current) return live && setStale('deleted');
      if ((await textHash(current.text.trim())) === change.seen) return live && setStale(null);
      const [newest] = await sectionHistory(roadmap!, current.id);
      const author = newest?.revision.authorId ?? null;
      if (live) setStale({ by: author === meId ? 'You' : senderName(users, author, 'Someone'), at: newest?.revision.createdAt ?? Date.now() });
    })();
    return () => {
      live = false;
    };
  }, [change, cards, current, added, roadmap, users, meId]);

  async function add() {
    if (projectId === null) return;
    setBusy(true);
    setError('');
    try {
      const doc = roadmap ?? (await createBoard(projectId, 'roadmap'));
      // The numbers and the card as they are now, not as the page last loaded them.
      const fresh = (await loadSections(doc)).map(parseCard);
      let id: string;
      if (change) {
        const card = fresh.find((c) => c.id === change.section);
        if (!card || (await textHash(card.text.trim())) !== change.seen) return setCards(fresh);
        await replaceSection(doc, card.id, { text: cardText(card.kind!, card.number!, draft.title, card.status, draft.body), pos: card.pos });
        id = change.card;
      } else {
        const number = nextNumber(fresh, draft.kind);
        const pos = Math.max(0, ...fresh.map((c) => c.pos)) + 1;
        await replaceSection(doc, newSectionId(), { text: cardText(draft.kind, number, draft.title, NEW_STATUS[draft.kind], draft.body), pos });
        id = `${draft.kind}-${number}`;
      }
      await noteAdded(thread.conversationId, thread.root, message.clientId!, id);
      void syncNow();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const kind = KIND_NAMES[draft.kind];
  // What the change adds or rewrites, marked so a small edit shows.
  const now = new Set((current?.body ?? '').split(/\n\s*\n/).map((p) => p.trim()));
  const paragraphs = draft.body.split(/\n\s*\n/).filter((p) => p.trim());
  const marked = (changed: boolean) => (change && changed ? 'agents-changed' : undefined);

  return (
    <div className="agents-draft">
      <p className="agents-draft-head">{change ? `A change to ${change.card}` : `A new ${kind} for the board`}</p>
      {change && current && (
        <>
          <p className="agents-draft-label">Now</p>
          <strong>
            {change.card}: {current.title}
          </strong>
          <Markdown text={current.body} />
          <p className="agents-draft-label">After</p>
        </>
      )}
      <strong className={marked(current?.title !== draft.title)}>{change ? `${change.card}: ${draft.title}` : draft.title}</strong>
      {paragraphs.map((p, i) => (
        <div key={i} className={marked(!now.has(p.trim()))}>
          <Markdown text={p} />
        </div>
      ))}
      {added ? (
        <p className="agents-draft-done">
          {change ? `Updated ${added}` : `Added as ${kind} ${added}`}.{' '}
          {projectId !== null && (
            <button className="board-card-run-link" onClick={() => actions.setBoardOpen(projectId)}>
              Open the board
            </button>
          )}
        </p>
      ) : change && stale ? (
        <>
          <p className="composer-blocked">
            {stale === 'deleted'
              ? `${change.card} was deleted from the board after this draft.`
              : `${stale.by} changed ${change.card} after this draft, at ${formatSince(stale.at)}.`}
          </p>
          <button
            className="button-secondary"
            onClick={() => void tellAgent(thread.conversationId, thread.root, 'reply', `${change.card} changed on the board since your draft. Draft the change again from what it says now.`)}
          >
            Ask it to redo this
          </button>
        </>
      ) : (
        <div className="agents-draft-actions">
          {!change && shared.length > 1 && (
            <select value={picked ?? ''} onChange={(e) => setPicked(Number(e.target.value) || null)}>
              <option value="">Pick a board</option>
              {shared.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button className="button-primary" disabled={busy || cards === null || projectId === null || (!!change && !current)} onClick={() => void add()}>
            {change ? `Update ${change.card}` : `Add as ${kind} ${draft.kind}-${nextNumber(cards ?? [], draft.kind)}`}
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
