// A card a coding agent drafted in its answer (R-035, D-104). It stays in the conversation until
// its owner adds it. Their page then writes it to the board as them: a new card with the next free
// number of its kind, taken under its column's lock when they press the button (D-116), or the
// change to the card it replaces, but only while that card says what the agent saw. Above the
// button stand the cards, decisions and pull requests the agent's check found it repeats or goes
// against, and the card it writes carries the check's line (R-041).
import { useEffect, useMemo, useState } from 'react';
import { textHash } from '../../../shared/e2ee';
import type { CardDraftDTO } from '../../../shared/types';
import type { Thread } from '../agents';
import { boardDocs, cardText, COLUMNS, idOf, KIND_NAMES, NEW_STATUS, parseCard, withChecked, type Card } from '../board';
import { noteAdded, syncNow, tellAgent } from '../chat';
import { addCard, createBoard, loadSections, newSectionId, rewriteSection, sectionHistory } from '../docs';
import type { ChatMessage } from '../e2ee/keyring';
import { actions, senderName, useAppState } from '../store';
import { formatSince } from './format';
import { Markdown } from './Markdown';

/** A text's paragraphs, split at blank lines outside code fences, so a block of code stays whole. */
function paragraphsOf(text: string) {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && !line.trim()) {
      if (current.length) out.push(current.join('\n').trim());
      current = [];
    } else current.push(line);
  }
  if (current.length) out.push(current.join('\n').trim());
  return out.filter(Boolean);
}

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
  // A new card goes to the board the question was about, else one the agent shares with the user;
  // a change, to its card's board.
  const shared = useMemo(
    () => Object.values(projects).filter((p) => meId !== undefined && p.memberIds.includes(meId) && p.memberIds.includes(agentId)),
    [projects, meId, agentId],
  );
  const [picked, setPicked] = useState<number | null>(null);
  const first = thread.messages[0]!;
  const named =
    first.prompt?.kind === 'prompt' ? first.prompt.project : first.run?.kind === 'request' ? conversations[docs[first.run.docId]?.conversationId ?? 0]?.projectId : thread.project;
  const board = named !== undefined && shared.some((p) => p.id === named) ? named : shared.length === 1 ? shared[0]!.id : null;
  const projectId = change ? (conversations[docs[change.doc]?.conversationId ?? 0]?.projectId ?? null) : (picked ?? board);
  const [redone, setRedone] = useState(false);
  // A decision goes in the Decisions column, an idea or issue in the Roadmap.
  const column = draft.kind === 'D' ? 'decisions' : 'roadmap';
  const columns = projectId === null ? {} : boardDocs(docs, conversations, projectId);
  const target = columns[column];
  const [cards, setCards] = useState<Card[] | null>(null);
  const [stale, setStale] = useState<Stale | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The draft's column, and the other one only when a related id is there, so most drafts load one doc.
  const needed = COLUMNS.filter((c) => c === column || draft.related?.some((r) => (r.id.startsWith('D-') ? 'decisions' : 'roadmap') === c && !r.id.startsWith('#')));

  // The board as it is now, again whenever a column it reads changes, and whether a change's card
  // still says what the agent saw. A draft already added needs neither.
  useEffect(() => {
    if (added) return;
    let live = true;
    void (async () => {
      const fresh = (await Promise.all(needed.map(async (c) => (columns[c] ? (await loadSections(columns[c]!)).map(parseCard) : [])))).flat();
      const card = change && fresh.find((c) => c.id === change.section);
      let gone: Stale | null = null;
      if (change && !card) gone = 'deleted';
      else if (change && card && (await textHash(card.text.trim())) !== change.seen) {
        const [newest] = await sectionHistory(target!, card.id);
        const author = newest?.revision.authorId ?? null;
        gone = { by: author === meId ? 'You' : senderName(users, author, 'Someone'), at: newest?.revision.createdAt ?? Date.now() };
      }
      if (!live) return;
      setCards(fresh);
      setStale(gone);
    })().catch(() => live && setCards([]));
    return () => {
      live = false;
    };
  }, [...needed.flatMap((c) => [columns[c]?.id, columns[c]?.version]), added]);

  const current = change ? cards?.find((c) => c.id === change.section) : undefined;
  // A card or decision the board no longer has is left out; a pull request the page cannot look up stays (R-041).
  const related = (draft.related ?? []).filter((r) => r.id.startsWith('#') || cards?.some((c) => c.cardId === r.id));

  async function add() {
    if (projectId === null) return;
    setBusy(true);
    setError('');
    try {
      const doc = target ?? (await createBoard(projectId, column));
      // The check's line goes on top, so the board shows the card checked (R-041).
      const body = draft.checked ? withChecked(draft.body.trim(), draft.checked) : draft.body.trim();
      let id: string;
      if (change) {
        // Read and written under the card's lock, so nobody's save lands in between.
        const written = await rewriteSection(doc, change.section, async (section) => {
          const card = section && parseCard(section);
          if (!card || (await textHash(card.text.trim())) !== change.seen) return null;
          // A proposal's file may set a new status, as one that finishes its card does (R-040).
          return { text: cardText(card.cardId, draft.title, draft.status ?? card.status, body), pos: card.pos };
        });
        // Changed since the page last looked: the next load says how.
        if (!written) return void syncNow();
        id = change.card;
      } else {
        ({ id } = await addCard(doc, newSectionId(), draft.kind, (cardId) => cardText(cardId, draft.title, NEW_STATUS[draft.kind], body)));
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
  const now = new Set(paragraphsOf(current?.body ?? ''));
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
      {draft.status && <p className={marked(current?.status !== draft.status)}>Status: {draft.status}.</p>}
      {paragraphsOf(draft.body).map((p, i) => (
        <div key={i} className={marked(!now.has(p))}>
          <Markdown text={p} />
        </div>
      ))}
      {draft.checked && <p className="agents-draft-label">Checked: {draft.checked}</p>}
      {/* Nothing is blocked: the owner weighs what the check found (R-041). */}
      {!added && related.length > 0 && (
        <ul className="agents-related">
          {related.map((r) => (
            <li key={r.id} className={r.kind === 'conflict' ? 'agents-related-conflict' : undefined}>
              <strong>
                {r.kind === 'conflict' ? 'Goes against' : 'Repeats'}{' '}
                {r.id.startsWith('#') && thread.repo ? (
                  <a href={`https://github.com/${thread.repo}/pull/${r.id.slice(1)}`} target="_blank" rel="noopener noreferrer">
                    {r.id}
                  </a>
                ) : (
                  r.id
                )}
              </strong>
              {r.why && `: ${r.why}`}
            </li>
          ))}
        </ul>
      )}
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
          {thread.kind === 'question' && <button
            className="button-secondary"
            disabled={redone || thread.state === 'working' || thread.state === 'ended'}
            onClick={() => {
              setRedone(true);
              void tellAgent(thread.conversationId, thread.root, 'reply', `${change.card} changed on the board since your draft. Draft the change again from what it says now.`);
            }}
          >
            Ask it to redo this
          </button>}
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
          {!change && shared.length === 0 && <p className="composer-blocked">Add your agent to a project first, under the project’s people.</p>}
          <button className="button-primary" disabled={busy || cards === null || projectId === null || (!!change && !current)} onClick={() => void add()}>
            {change ? `Update ${change.card}` : `Add as ${kind} ${idOf((cards ?? []).map((c) => c.cardId), draft.kind)}`}
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
