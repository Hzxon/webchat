// A project's board (R-021): the Decisions column and the Roadmap column of ideas and issues, each
// a doc whose sections are cards, one column at a time behind tabs. The Roadmap shows its cards in
// lanes, each with its owner's face (the board-lanes decision). Cards are written in the section
// editor docs have, and keep its locks and history. The board docs are created the first time
// someone adds a card.
import { useEffect, useMemo, useState } from 'react';
import type { ProjectDTO, RunRequest, UserDTO } from '../../../shared/types';
import {
  boardDocs,
  cardOf,
  cardRuns,
  GOING,
  cardTemplate,
  COLUMN_TITLES,
  COLUMNS,
  duplicates,
  GROUPS,
  groupOf,
  KIND_NAMES,
  runnerOf,
  unchecked,
  WAITING,
  type BoardColumn,
  type Card,
  type CardKind,
  type CardRun,
} from '../board';
import { inOrder, ownAgents, ready, seatFor, useAgentChats } from '../agents';
import { copyOf } from '../../../shared/board';
import { askAgent, askLink, cancelRun, syncNow } from '../chat';
import { addCard, beginEditing, createBoard, loadCards, loadSections, markSeen, newSectionId, replaceSection, type DocSection, type Editing } from '../docs';
import type { ChatDoc } from '../e2ee/keyring';
import { importEntries } from '../boardLink';
import { useLinkedRepos } from '../linkedRepos';
import { actions, senderName, useAppState } from '../store';
import { Avatar } from './Avatar';
import { HistoryDialog, SectionEditor } from './DocView';
import { BackIcon, BoardIcon, CopyIcon, HistoryIcon, PencilIcon, PlayIcon, PlusIcon, StopIcon, TrashIcon } from './icons';
import { Markdown } from './Markdown';
import { RUN_TAGS, Tag, type Tone } from './PullTags';

export function BoardView({ project }: { project: ProjectDTO }) {
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const boards = useMemo(() => boardDocs(docs, conversations, project.id), [docs, conversations, project.id]);
  const [shown, setShown] = useState<BoardColumn>('roadmap');
  // Check again asks the user's own agent in the project, about its first linked repository, as the pane's Ask does (R-038, R-041).
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const agent = ownAgents(users, meId).find((a) => project.memberIds.includes(a.id));
  const linked = useLinkedRepos(agent ? [project.id] : [])[project.id];
  // With no GitHub App on the server, the pane's repositories are the agent's folders (R-038).
  const repos = (linked?.configured ? linked.repos : agent?.agentRepos.map((s) => s.repo)) ?? [];
  const repo = repos[0];
  // One repository takes one board's copy, so a repository another board copies to is not offered (R-040).
  const copied = new Set(Object.values(docs).flatMap((d) => (d.repo && d.id !== boards.roadmap?.id ? [d.repo.toLowerCase()] : [])));
  const seat = agent && seatFor(agent, repo ?? '');
  // Not before the repositories load, so a check never runs on the board alone by mistake.
  const check =
    linked && seat && ready(seat)
      ? async (id: string) =>
          actions.setAgentsOpen(
            true,
            await askAgent(seat.agent.id, project.id, repo, `Check ${id} as it is on the board now, against the other cards, the decisions, the code and the open pull requests. Then draft a change to ${id} with replaces: its text as it is, or what your check calls for.`),
          )
      : undefined;
  // Only the project's owner links its board to a repository (R-040).
  const linkedTo = boards.roadmap?.repo && boards.roadmap.title?.authorId === project.ownerId ? boards.roadmap.repo : undefined;
  const free = repos.filter((r) => !copied.has(r.toLowerCase()));
  const canLink = !linkedTo && project.ownerId === meId && !!linked && !!seat && ready(seat) && free.length > 0;

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
          <span>{project.name} · {linkedTo ? `copied to ${linkedTo}` : 'decisions, ideas and issues'}</span>
        </div>
        <div className="segmented board-tabs" role="tablist">
          {COLUMNS.map((column) => (
            <button key={column} role="tab" aria-selected={shown === column} onClick={() => setShown(column)}>
              {COLUMN_TITLES[column]}
            </button>
          ))}
        </div>
      </header>
      {canLink && <BoardLink project={project} agentId={agent!.id} repos={free} />}
      <div className={`board-columns shows-${shown}`}>
        {COLUMNS.map((column) => (
          <BoardColumnView key={column} column={column} projectId={project.id} doc={boards[column]} check={check} />
        ))}
      </div>
    </section>
  );
}

/** How long the link waits for the agent's entries before it says none came. */
const ANSWER_MS = 60_000;

/**
 * The owner's link of the board to one of the project's repositories (R-040, D-117): their agent
 * sends the repository's entries, the page writes them as cards, then names the repository on the
 * board. From then on the agent keeps the repository's docs as copies.
 */
function BoardLink({ project, agentId, repos }: { project: ProjectDTO; agentId: number; repos: string[] }) {
  const chats = useAgentChats();
  const messages = useAppState((s) => s.messages);
  const [repo, setRepo] = useState(repos[0]!);
  const [asked, setAsked] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [late, setLate] = useState(false);
  const answers = asked ? chats.flatMap((c) => messages[c.id] ?? []).filter((m) => m.senderId === agentId && m.board && 'to' in m.board && m.board.to === asked) : [];
  const failed = answers.find((m) => m.board?.kind === 'failed');
  const parts = new Map(answers.flatMap((m) => (m.board?.kind === 'entries' ? [[m.board.part, m.board] as const] : [])));
  const complete = parts.size > 0 && parts.size === [...parts.values()][0]!.parts;

  useEffect(() => {
    if (!asked || complete || failed) return;
    const timer = setTimeout(() => setLate(true), ANSWER_MS);
    return () => clearTimeout(timer);
  }, [asked, complete, failed]);
  useEffect(() => {
    if (!complete) return;
    const entries = [...parts.entries()].sort(([a], [b]) => a - b).flatMap(([, part]) => part.entries);
    importEntries(project.id, repo, entries, (done) => setNote(`Importing ${done} of ${entries.length} entries…`)).catch((err: Error) => {
      setError(err.message);
      setAsked(null);
    });
  }, [complete]);

  return (
    <div className="board-link">
      <p>
        Keep <code>docs/roadmap.md</code> and <code>docs/decisions.md</code> of{' '}
        <select value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!!asked} aria-label="Repository">
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>{' '}
        as copies of this board. Their entries come onto the board first. Card text is then plain text in the repository, which everyone who can read it reads.
      </p>
      <button
        className="button-secondary"
        disabled={!!asked}
        onClick={() => {
          setError('');
          setLate(false);
          askLink(agentId, project.id, repo).then(setAsked, (err: Error) => setError(err.message));
        }}
      >
        Link
      </button>
      {asked && !complete && !failed && <span className="doc-note">{late ? 'Your agent did not answer. Keep Claude Code open on your laptop, then link again.' : 'Asking your agent for the repository’s entries…'}</span>}
      {note && <span className="doc-note">{note}</span>}
      {(failed || error) && <p className="form-error">{failed?.text ?? error}</p>}
    </div>
  );
}

const NO_MEMBERS: number[] = [];
const RUN_STATES: Record<CardRun['state'], [Tone, string]> = {
  ...RUN_TAGS,
  sending: ['muted', 'Sending…'],
  waiting: ['muted', 'Waiting for the agent'],
  unanswered: ['warn', 'No answer'],
  cancelled: ['muted', 'Cancelled'],
};
const FILTERS = { all: 'All', R: 'Ideas', K: 'Issues' };
type Filter = keyof typeof FILTERS;

function BoardColumnView({ column, projectId, doc, check }: { column: BoardColumn; projectId: number; doc: ChatDoc | undefined; check?: (id: string) => Promise<void> }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const meName = useAppState((s) => s.me?.displayName ?? '');
  const memberIds = useAppState((s) => s.projects[projectId]?.memberIds ?? NO_MEMBERS);
  // This user's coding agents in the project (D-089), one choice per repository a Claude Code
  // session of theirs is open in (D-094). A card can be handed to one that is online.
  const choices = useMemo(
    () =>
      memberIds
        .map((id) => users[id])
        .filter((u): u is UserDTO => !!u && u.agentOwner === meId)
        .flatMap((agent): Array<{ agent: UserDTO; repo?: string; online: boolean; lastSeen: number | null }> =>
          agent.agentRepos.length ? agent.agentRepos.map((seat) => ({ agent, ...seat })) : [{ agent, online: agent.online, lastSeen: agent.lastSeen }],
        ),
    [memberIds, users, meId],
  );
  const [sections, setSections] = useState<DocSection[]>([]);
  // An owner who left the project owns nothing, so owners follow the members without a reload.
  const cards = useMemo(() => sections.map((s) => cardOf(s, memberIds)), [sections, memberIds]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string | null>(null);
  // Whether the Open drawer is open, once the cards first load or the user toggles it; until then it follows the lanes.
  const [drawer, setDrawer] = useState<boolean | null>(null);
  // The doc is kept with the editing state, because the first card's doc is made just before it.
  const [editing, setEditing] = useState<{
    doc: ChatDoc;
    section: Editing;
  } | null>(null);
  const [historyOf, setHistoryOf] = useState<Card | null>(null);
  const pending = useAppState((s) => s.pending);
  const messages = useAppState((s) => s.messages);
  // A card's runs are messages in the user's chats with their agents, which load at start (D-105).
  const chats = useAgentChats();
  // In id order across chats, so the newest request of a card is the one that counts.
  const agentMessages = useMemo(() => inOrder(chats.flatMap((c) => messages[c.id] ?? [])), [chats, messages]);
  // Read on every render, so a request nobody answered stops blocking once its time is up.
  const runs = doc && meId && column === 'roadmap' ? cardRuns(agentMessages, meId, doc.id, pending, Date.now()) : null;
  const canRun = column === 'roadmap' && !!doc && choices.length > 0;

  // Every save grows the version, so the cards load again whenever anyone saves.
  useEffect(() => {
    if (!doc) return;
    let live = true;
    // Only the Roadmap's cards have owners, which takes each card's first revision too.
    (column === 'roadmap' ? loadCards : loadSections)(doc).then(
      (loaded) => live && setSections(loaded),
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
  // The Roadmap's lanes sit side by side; Open and Done are drawers under them.
  const lanes = groups.filter((group) => group.lane);
  const drawers = groups.filter((group) => !group.lane);
  const lanesHold = lanes.some((lane) => lane.cards.length > 0);
  const drawerOpen = drawer ?? !lanesHold;
  // Open while the lanes are empty, so a new board's first card does not hide in it; then it stays as it was, so it never shuts on a reader.
  useEffect(() => {
    if (sections.length) setDrawer((d) => d ?? !lanesHold);
  }, [sections]);
  /** A member as a sentence names them. */
  const whom = (id: number) => (id === meId ? 'you' : senderName(users, id));

  /** What a Roadmap card's face shows at its right: who runs it, or the pull request it waits in. */
  function moveOf(card: Card) {
    if (!card.status.startsWith(WAITING)) return runnerOf(card.status);
    return card.owner === undefined ? card.status : `Waiting for ${whom(card.owner)}`;
  }

  /** Runs an action and shows what went wrong, such as a lock someone else holds. */
  function run(work: Promise<unknown>) {
    setError('');
    work.catch((err: Error) => setError(err.message));
  }

  async function edit(target: ChatDoc, id: string, saved: string, pos: number, isNew = false) {
    setEditing({
      doc: target,
      section: await beginEditing(target.id, id, saved, pos, isNew),
    });
  }

  async function add(kind: CardKind) {
    const target = doc ?? (await createBoard(projectId, column));
    // Saved at once, under the column's lock on numbers, so no other page gives its number; Cancel takes it back (D-116).
    const id = newSectionId();
    const { text, pos } = await addCard(target, id, kind, (cardId) => cardTemplate(kind, cardId));
    // A new card is open, so it shows in the Open drawer once its editor closes.
    setDrawer(true);
    await edit(target, id, text, pos, true);
  }

  /** Removes a card in an editing session of its own. Its revisions stay in the history. */
  async function remove(card: Card) {
    if (!confirm(`Delete ${card.cardId || 'this card'} for everyone? Its history stays.`)) return;
    await replaceSection(doc!, card.id, { text: card.text, pos: card.pos, removed: true });
    void syncNow();
  }

  async function copy() {
    // The same text as a linked repository's copy (D-117).
    await navigator.clipboard.writeText(copyOf(column, cards.map((c) => c.text)));
    setNote('Copied');
    setTimeout(() => setNote(''), 2000);
  }

  const kinds: CardKind[] = column === 'decisions' ? ['D'] : ['R', 'K'];

  const cardView = (card: Card) => {
    if (editing?.section.id === card.id) return null;
    const lock = lockOf(card.id);
    const isOpen = open === card.id;
    const cardRun = runs?.get(card.id);
    const [runTone, runLabel] = RUN_STATES[cardRun?.state ?? 'waiting'];
    const request = cardRun && agentMessages.find((m) => m.id === cardRun.request);
    // A request still being sent has no id that a cancel could name.
    const stoppable = !!request && cardRun!.state !== 'sending' && GOING.has(cardRun!.state);
    // A Roadmap card's face shows its owner and whose move it is; its id and status are inside (the board-lanes decision).
    const face = column === 'roadmap';
    const right = face ? moveOf(card) : card.status;
    const about = face ? [card.status, card.owner !== undefined && `opened by ${whom(card.owner)}`].filter(Boolean).join(' · ') : '';
    return (
      <article key={card.id} className={`board-card ${lock ? 'is-locked' : ''} ${isOpen ? 'is-open' : ''}`}>
        <button className={`board-card-head ${face ? 'board-face' : ''}`} onClick={() => setOpen(isOpen ? null : card.id)} aria-expanded={isOpen}>
          {!face ? (
            card.kind && <span className="board-card-id">{card.cardId}</span>
          ) : card.owner !== undefined ? (
            // The users in the store leave out the user themself.
            <Avatar name={card.owner === meId ? meName : senderName(users, card.owner)} seed={card.owner} size={24} />
          ) : (
            <span className="board-no-owner" role="img" title="No owner" aria-label="No owner" />
          )}
          <strong>{card.failed ? 'This card could not be decrypted.' : card.title || 'Untitled'}</strong>
          {right && <span className="board-card-status">{right}</span>}
          {face && cardRun && !isOpen && <Tag tone={runTone}>{runLabel}</Tag>}
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
              {stoppable && (
                // The agent stops the run and reports it failed; a request it never took ends here (R-030).
                <button
                  className="icon-button icon-button-small"
                  disabled={cardRun!.stopping}
                  onClick={() => run(cancelRun({ ...request!, run: request!.run as RunRequest }))}
                  title={cardRun!.stopping ? 'Stopping…' : `Stop · ${nameOf(cardRun!.runtime)}`}
                  aria-label="Stop the run"
                >
                  <StopIcon width={18} height={18} />
                </button>
              )}
              {!stoppable && canRun && card.kind && !card.failed && (
                // The brief says what the agent will follow and who wrote it, and starts it (D-105).
                <button
                  className="icon-button icon-button-small"
                  disabled={!!cardRun && GOING.has(cardRun.state)}
                  onClick={() => actions.openBrief({ projectId, docId: doc!.id, section: card.id })}
                  title={cardRun && GOING.has(cardRun.state) ? `${runLabel} · ${nameOf(cardRun.runtime)}` : 'Run with your agent'}
                  aria-label="Run with your agent"
                >
                  <PlayIcon width={18} height={18} />
                </button>
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
            {face && (card.kind || about) && (
              <p className="board-card-run">
                {card.kind && <span className="board-card-id">{card.cardId}</span>}
                {about && <span>{about}</span>}
                {/* No agent checked it against the board, the code and the open pull requests yet (R-041). */}
                {unchecked(card) && <Tag tone="muted">Unchecked</Tag>}
              </p>
            )}
            {cardRun && (
              <p className="board-card-run">
                <Tag tone={runTone}>{runLabel}</Tag>
                <span>
                  {nameOf(cardRun.runtime)}
                  {cardRun.repo && ` in ${cardRun.repo}`}
                  {cardRun.harness && ` with ${cardRun.harness}`}
                  {cardRun.note && ` · ${cardRun.note}`}
                </span>
                <button
                  className="board-card-run-link"
                  onClick={() => actions.setAgentsOpen(true, request?.clientId ?? null)}
                >
                  Open the conversation
                </button>
              </p>
            )}
            {check && card.kind && !card.failed && (
              <p className="board-card-run">
                <span>Your agent checks it against the board, the code and the open pull requests.</span>
                <button className="board-card-run-link" onClick={() => run(check(card.cardId))}>
                  Check again
                </button>
              </p>
            )}
            {card.body ? <Markdown text={card.body} /> : <p className="doc-note">Nothing more.</p>}
          </div>
        )}
      </article>
    );
  };

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
          {/* Agents connect in the Coding agents pane; the board points there until one is in the project. */}
          {column === 'roadmap' && choices.length === 0 && (
            <button className="button-secondary board-new" onClick={() => actions.setAgentsOpen(true)}>
              <PlayIcon width={16} height={16} /> Connect coding agent
            </button>
          )}
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
        {lanes.length > 0 && (
          <div className="board-lanes">
            {lanes.map((lane) => (
              <section key={lane.name} className="board-lane">
                <h3>
                  {lane.name} <small>{lane.cards.length}</small>
                </h3>
                {lane.cards.map((card) => cardView(card))}
              </section>
            ))}
          </div>
        )}
        {drawers
          .filter((group) => group.cards.length > 0)
          .map((group) => (
            <details
              key={group.name}
              className="board-group"
              open={group.name === 'Open' ? drawerOpen : !group.folded}
              // Only a toggle that differs from what was rendered is the user's.
              onToggle={(e) => group.name === 'Open' && e.currentTarget.open !== drawerOpen && setDrawer(e.currentTarget.open)}
            >
              <summary>
                {group.name} <small>{group.cards.length}</small>
              </summary>
              {group.cards.map((card) => cardView(card))}
            </details>
          ))}
      </div>
      {historyOf && doc && <HistoryDialog doc={doc} section={historyOf} nameOf={nameOf} onClose={() => setHistoryOf(null)} />}
    </div>
  );
}

