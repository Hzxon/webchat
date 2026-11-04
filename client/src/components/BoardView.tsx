// A project's board (R-021): the Decisions column and the Roadmap column of ideas and issues, each
// a doc whose sections are cards. Cards are written in the section editor docs have, and keep its
// locks and history. The board docs are created the first time someone adds a card.
import { useEffect, useMemo, useState } from 'react';
import type { ProjectDTO, UserDTO } from '../../../shared/types';
import {
  boardDocs,
  cardTemplate,
  columnMarkdown,
  COLUMN_TITLES,
  COLUMNS,
  duplicates,
  GROUPS,
  groupOf,
  KIND_NAMES,
  nextNumber,
  parseCard,
  type BoardColumn,
  type Card,
  type CardKind,
} from '../board';
import { requestRun, syncNow } from '../chat';
import { beginEditing, createDoc, loadSections, markSeen, newSectionId, replaceSection, type Editing } from '../docs';
import type { ChatDoc } from '../e2ee/keyring';
import { actions, senderName, store, useAppState } from '../store';
import { HistoryDialog, SectionEditor } from './DocView';
import { BackIcon, BoardIcon, CopyIcon, HistoryIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from './icons';
import { Markdown } from './Markdown';

export function BoardView({ project }: { project: ProjectDTO }) {
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const boards = useMemo(() => boardDocs(docs, conversations, project.id), [docs, conversations, project.id]);
  // At phone width the columns are tabs.
  const [shown, setShown] = useState<BoardColumn>('decisions');

  return (
    <section className="chat board-view">
      <header className="chat-header">
        <button className="icon-button back-button" onClick={() => actions.setBoardOpen(null)} aria-label="Back to projects">
          <BackIcon />
        </button>
        <span className="avatar avatar-square doc-avatar">
          <BoardIcon />
        </span>
        <div className="chat-header-text">
          <strong>Board</strong>
          <span>{project.name} · decisions, ideas and issues</span>
        </div>
        <div className="segmented board-tabs" role="tablist">
          {COLUMNS.map((column) => (
            <button key={column} role="tab" aria-selected={shown === column} onClick={() => setShown(column)}>
              {COLUMN_TITLES[column]}
            </button>
          ))}
        </div>
      </header>
      <div className={`board-columns shows-${shown}`}>
        {COLUMNS.map((column) => (
          <BoardColumnView key={column} column={column} projectId={project.id} doc={boards[column]} />
        ))}
      </div>
    </section>
  );
}

const NO_MEMBERS: number[] = [];
const FILTERS = { all: 'All', R: 'Ideas', K: 'Issues' };
type Filter = keyof typeof FILTERS;

function BoardColumnView({ column, projectId, doc }: { column: BoardColumn; projectId: number; doc: ChatDoc | undefined }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const memberIds = useAppState((s) => s.projects[projectId]?.memberIds ?? NO_MEMBERS);
  // The coding agents in the project (R-027). A card can be handed to one that is online.
  const agents = useMemo(() => memberIds.map((id) => users[id]).filter((u): u is UserDTO => !!u?.agent), [memberIds, users]);
  const [cards, setCards] = useState<Card[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  // The doc is kept with the editing state, because the first card's doc is made just before it.
  const [editing, setEditing] = useState<{
    doc: ChatDoc;
    section: Editing;
  } | null>(null);
  const [historyOf, setHistoryOf] = useState<Card | null>(null);

  // Every save grows the version, so the cards load again whenever anyone saves.
  useEffect(() => {
    if (!doc) return;
    let live = true;
    loadSections(doc).then(
      (loaded) => live && setCards(loaded.map(parseCard)),
      (err: Error) => live && setError(err.message),
    );
    markSeen(doc);
    return () => {
      live = false;
    };
  }, [doc?.id, doc?.version]);

  const nameOf = (id: number) => (id === meId ? 'You' : senderName(users, id));
  const lockOf = (section: string) => doc?.locks.find((l) => l.section === section && l.userId !== meId);
  const same = useMemo(() => duplicates(cards), [cards]);
  const listed = filter === 'all' ? cards : cards.filter((c) => c.kind === filter);
  const groups = GROUPS[column].map((group, i) => ({
    ...group,
    cards: listed.filter((c) => groupOf(column, c.status) === i).sort((a, b) => (b.number ?? -1) - (a.number ?? -1)),
  }));

  /** Runs an action and shows what went wrong, such as a lock someone else holds. */
  function run(work: Promise<unknown>) {
    setError('');
    work.catch((err: Error) => setError(err.message));
  }

  async function edit(target: ChatDoc, id: string, saved: string, pos: number, isNew = false, start = saved) {
    setEditing({
      doc: target,
      section: await beginEditing(target.id, id, saved, pos, isNew, start),
    });
  }

  async function add(kind: CardKind) {
    const target = doc ?? (await createBoard(projectId, column));
    const pos = Math.max(0, ...cards.map((c) => c.pos)) + 1;
    await edit(target, newSectionId(), '', pos, true, cardTemplate(kind, nextNumber(cards, kind)));
  }

  /** Removes a card in an editing session of its own. Its revisions stay in the history. */
  async function remove(card: Card) {
    if (!confirm(`Delete ${card.kind ? `${card.kind}-${card.number}` : 'this card'} for everyone? Its history stays.`)) return;
    await replaceSection(doc!, card.id, { text: card.text, pos: card.pos, removed: true });
    void syncNow();
  }

  async function copy() {
    await navigator.clipboard.writeText(columnMarkdown(column, cards));
    setNote('Copied');
    setTimeout(() => setNote(''), 2000);
  }

  async function handOver(card: Card, agent: UserDTO) {
    if (!doc) return;
    await requestRun(projectId, doc.id, card, agent);
    setNote(`Asked ${agent.displayName}. Its reports show in #general.`);
    setTimeout(() => setNote(''), 4000);
  }

  const kinds: CardKind[] = column === 'decisions' ? ['D'] : ['R', 'K'];

  return (
    <div className={`board-column board-${column}`}>
      <header className="board-column-head">
        <h2>{COLUMN_TITLES[column]}</h2>
        <span className="doc-note">{note}</span>
        <button
          className="icon-button icon-button-small"
          onClick={() => run(copy())}
          disabled={cards.length === 0}
          title="Copy as Markdown"
          aria-label={`Copy ${COLUMN_TITLES[column]} as Markdown`}
        >
          <CopyIcon width={18} height={18} />
        </button>
      </header>
      <div className="board-cards">
        <div className="board-tools">
          {column === 'roadmap' && (
            <div className="segmented board-filter" role="tablist">
              {(Object.keys(FILTERS) as Filter[]).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
                  {FILTERS[f]}
                </button>
              ))}
            </div>
          )}
          {kinds.map((kind) => (
            <button key={kind} className="button-secondary board-new" onClick={() => run(add(kind))} disabled={editing !== null}>
              <PlusIcon width={16} height={16} /> {KIND_NAMES[kind]}
            </button>
          ))}
        </div>
        {error && <p className="form-error">{error}</p>}
        {/* The card being edited shows here, whatever its group, so its editor keeps its text and its lock. */}
        {editing && (
          <SectionEditor
            key={editing.section.id}
            doc={editing.doc}
            editing={editing.section}
            onClose={(message) => {
              setEditing(null);
              setError(message ?? '');
            }}
          />
        )}
        {!doc && !editing && <p className="doc-note">No {column === 'decisions' ? 'decisions' : 'ideas or issues'} yet.</p>}
        {groups
          .filter((group) => group.cards.length > 0)
          .map((group) => (
            <details key={group.name} className="board-group" open={!group.folded}>
              <summary>
                {group.name} <small>{group.cards.length}</small>
              </summary>
              {group.cards.map((card) => {
                if (editing?.section.id === card.id) return null;
                const lock = lockOf(card.id);
                const isOpen = open === card.id;
                return (
                  <article key={card.id} className={`board-card ${lock ? 'is-locked' : ''} ${isOpen ? 'is-open' : ''}`}>
                    <button className="board-card-head" onClick={() => setOpen(isOpen ? null : card.id)} aria-expanded={isOpen}>
                      {card.kind && (
                        <span className="board-card-id">
                          {card.kind}-{card.number}
                        </span>
                      )}
                      <strong>{card.failed ? 'This card could not be decrypted.' : card.title || 'Untitled'}</strong>
                      {card.status && <span className="board-card-status">{card.status}</span>}
                    </button>
                    {same.has(card.id) && <p className="board-card-warn">Another card has this number. Renumber one of them.</p>}
                    {isOpen && (
                      <div className="board-card-body">
                        <div className="doc-section-tools">
                          {lock && <span className="doc-lock">{nameOf(lock.userId)} is editing</span>}
                          <button
                            className="icon-button icon-button-small"
                            onClick={() => run(edit(doc!, card.id, card.text, card.pos))}
                            disabled={editing !== null || !!lock || card.failed}
                            title="Edit"
                            aria-label="Edit card"
                          >
                            <PencilIcon width={18} height={18} />
                          </button>
                          <button className="icon-button icon-button-small" onClick={() => setHistoryOf(card)} title="History" aria-label="Card history">
                            <HistoryIcon width={18} height={18} />
                          </button>
                          {column === 'roadmap' && card.kind && !card.failed && agents.length > 0 && (
                            <details className="run-menu">
                              <summary className="icon-button icon-button-small" title="Run with an agent" aria-label="Run with an agent">
                                <PlayIcon width={18} height={18} />
                              </summary>
                              <div className="run-menu-list">
                                {agents.map((agent) => (
                                  <button key={agent.id} onClick={() => run(handOver(card, agent))} disabled={!agent.online}>
                                    {agent.displayName}
                                    {!agent.online && <small> offline</small>}
                                  </button>
                                ))}
                              </div>
                            </details>
                          )}
                          <button
                            className="icon-button icon-button-small"
                            onClick={() => run(remove(card))}
                            disabled={editing !== null || !!lock}
                            title="Delete"
                            aria-label="Delete card"
                          >
                            <TrashIcon width={18} height={18} />
                          </button>
                        </div>
                        {card.body ? <Markdown text={card.body} /> : <p className="doc-note">Nothing more.</p>}
                      </div>
                    )}
                  </article>
                );
              })}
            </details>
          ))}
      </div>
      {historyOf && doc && <HistoryDialog doc={doc} section={historyOf} nameOf={nameOf} onClose={() => setHistoryOf(null)} />}
    </div>
  );
}

/** Makes the doc behind a column, empty. Its first card is the section written right after. */
async function createBoard(projectId: number, column: BoardColumn): Promise<ChatDoc> {
  const id = await createDoc(projectId, COLUMN_TITLES[column], [], column);
  return store.get().docs[id]!;
}
