// A project's board (R-021): the Decisions column and the Roadmap column of ideas and issues, each
// a doc whose sections are cards, one column at a time behind tabs. The Roadmap shows its cards in
// lanes, each with its owner's face (the board-lanes decision). Cards are written in the section
// editor docs have, and keep its locks and history. The board docs are created the first time
// someone adds a card.
import { useEffect, useMemo, useState } from 'react';
import { cardsOf, copyOf, GROUPS, groupOf, keepReviews, laneOf, usernamesOf, WAITING, withReviews, withStatus, type Card, type DocSection } from '../../../shared/board';
import type { CardNoteDTO, ProjectDTO, RunRequest, UserDTO } from '../../../shared/types';
import {
  boardDocs,
  cardRuns,
  GOING,
  cardTemplate,
  COLUMN_TITLES,
  COLUMNS,
  duplicates,
  KIND_NAMES,
  MOVE_FROM,
  moved,
  openChange,
  runnerOf,
  takeable,
  unchecked,
  workingStatus,
  type BoardColumn,
  type CardKind,
  type CardRun,
  type Move,
} from '../board';
import { inOrder, ownAgents, ready, seatFor, useAgentChats, useAgentThreads, waitingProposals } from '../agents';
import { askAgent, askFix, askLink, cancelRun, sendCardNote, startDirectChat, syncNow } from '../chat';
import { addCard, beginEditing, boardCards, createBoard, loadCards, loadSections, markSeen, newSectionId, replaceSection, rewriteCard, stopEditing, takeCard, type Editing } from '../docs';
import type { ChatDoc, ChatMessage } from '../e2ee/keyring';
import { importEntries } from '../boardLink';
import { useLinkedRepos } from '../linkedRepos';
import { actions, senderName, useAppState } from '../store';
import { Avatar } from './Avatar';
import { HistoryDialog, SectionEditor } from './DocView';
import { BackIcon, BoardIcon, CopyIcon, HistoryIcon, PencilIcon, PlayIcon, PlusIcon, StopIcon, TrashIcon } from './icons';
import { Markdown } from './Markdown';
import { REVIEWS, RUN_TAGS, Tag, type Tone } from './PullTags';

export function BoardView({ project }: { project: ProjectDTO }) {
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const boards = useMemo(() => boardDocs(docs, conversations, project.id), [docs, conversations, project.id]);
  const [shown, setShown] = useState<BoardColumn>('roadmap');
  // The column that holds the open editor. A tab keeps one lock alive, so a second editor would let the first one's lapse unseen.
  const [editingIn, setEditingIn] = useState<BoardColumn | null>(null);
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
  // Proposals on main reach only the owner, as drafts in the Coding agents pane, so their board says they wait (D-117, K-72).
  const { threads } = useAgentThreads();
  const proposals = linkedTo && project.ownerId === meId ? waitingProposals(threads, project.id, linkedTo) : [];

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
      {proposals.length > 0 && (
        <div className="board-link">
          <p>Drafts from proposal files on main wait in Coding agents until you add them.</p>
          <button className="button-secondary" onClick={() => actions.setAgentsOpen(true, proposals[0]!.root)}>
            {proposals.length === 1 ? '1 proposal waits' : `${proposals.length} proposals wait`}
          </button>
        </div>
      )}
      {canLink && <BoardLink project={project} agentId={agent!.id} repos={free} />}
      <div className={`board-columns shows-${shown}`}>
        {COLUMNS.map((column) => (
          <BoardColumnView
            key={column}
            column={column}
            projectId={project.id}
            doc={boards[column]}
            check={check}
            elsewhere={editingIn && editingIn !== column ? COLUMN_TITLES[editingIn] : undefined}
            onEditing={(on) => setEditingIn(on ? column : null)}
          />
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
// Pick shows on a Ready card's face; the others in the opened card.
const MOVES: Array<[keyof typeof MOVE_FROM, string]> = [
  ['ask', 'Ask owner'],
  ['ready', 'Mark ready'],
  ['review', 'Send to review'],
  ['again', 'Run again'],
  ['close', 'Close'],
];
type Filter = keyof typeof FILTERS;

function BoardColumnView({
  column,
  projectId,
  doc,
  check,
  elsewhere,
  onEditing,
}: {
  column: BoardColumn;
  projectId: number;
  doc: ChatDoc | undefined;
  check?: (id: string) => Promise<void>;
  /** The other column's title while it holds the open editor. */
  elsewhere?: string;
  onEditing: (on: boolean) => void;
}) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const me = useAppState((s) => s.me);
  const meName = me?.displayName ?? '';
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
  const usernames = useMemo(() => usernamesOf(memberIds, users, me), [memberIds, users, me]);
  // An owner or a reviewer who left the project counts for nothing, so cards follow the members without a reload.
  const cards = useMemo(() => cardsOf(sections, memberIds, usernames), [sections, memberIds, usernames]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // A request about a card opens the board on it, and a request to mark it ready finds it in the Open drawer.
  const boardCard = useAppState((s) => s.boardCard);
  const [open, setOpen] = useState<string | null>(boardCard);
  // Whether the Open drawer is open, once the cards first load or the user toggles it; until then it follows the lanes.
  const [drawer, setDrawer] = useState<boolean | null>(boardCard ? true : null);
  // The doc is kept with the editing state, because the first card's doc is made just before it.
  const [editing, setEditing] = useState<{
    doc: ChatDoc;
    section: Editing;
    /** The card's review lines that stood when its lock was taken, which no save changes. */
    lines: string[];
  } | null>(null);
  const [historyOf, setHistoryOf] = useState<Card | null>(null);
  // In the open card: the member picked to ask for a review, and the note of a requested change being written.
  const [asking, setAsking] = useState('');
  const [changes, setChanges] = useState<string | null>(null);
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
  /** Only a card's owner deletes it, or anyone a card with no owner, since only then does the removal stand (the card-owner decision). */
  const canDelete = (card: Card) => card.owner === undefined || card.owner === meId;
  /** A member as a sentence names them. */
  const whom = (id: number) => (id === meId ? 'you' : senderName(users, id));
  const avatarOf = (id: number, size: number) => <Avatar name={id === meId ? meName : senderName(users, id)} seed={id} size={size} />;

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
    // Told before the lock is asked for, so the other column cannot open an editor meanwhile.
    onEditing(true);
    try {
      const section = await beginEditing(target.id, id, saved, pos, isNew);
      // Read again under the lock: the card may have changed since it was shown, and a draft on the device may be older still.
      const card =
        column === 'roadmap'
          ? await boardCards(target).then(
              (all) => all.find((c) => c.id === id),
              async (err) => {
                await stopEditing(target.id, id).catch(() => undefined);
                throw err;
              },
            )
          : undefined;
      const lines = card?.reviews.map((r) => r.line) ?? [];
      setEditing({ doc: target, lines, section: card ? { ...section, saved: card.text, text: section.text === saved ? card.text : keepReviews(section.text, lines) } : section });
    } catch (err) {
      onEditing(false);
      throw err;
    }
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

  /** Makes a move on a card under its lock, from the card as it stands there (the card-owner decision). */
  async function move(card: Card, kind: Move) {
    await rewriteCard(doc!, card.id, (now) => moved(now, kind, me!));
  }

  /** Asks a member about a card, to mark it ready or to review it: a line on the card, then a message in the direct chat with them, so only they get a push. */
  async function ask(card: Card, to: number, kind: Move, note: CardNoteDTO['kind'], text: string) {
    // First: a new chat needs a key for them, which a person whose keys changed and are unchecked cannot get (D-018), and then nothing is written.
    const chat = to === meId ? null : await startDirectChat(to);
    if ((await rewriteCard(doc!, card.id, (now) => moved(now, kind, me!))) && chat !== null)
      await sendCardNote(chat, { kind: note, card: card.cardId, docId: doc!.id, section: card.id }, text);
  }

  /**
   * Runs a card again after its owner accepted a change: their own run's open draft gets another
   * round with the changes as their words (D-105), or else the card is their pick, which they run or
   * hand to whoever ran it (the card-review decision).
   */
  async function again(card: Card, draft?: ChatMessage) {
    let notes = '';
    const wrote = await rewriteCard(doc!, card.id, (now) => {
      notes = now.reviews.flatMap((r) => (r.answer === 'accepted' ? [r.note] : [])).join('\n');
      const text = moved(now, 'again', me!);
      return text && draft ? withStatus(text, workingStatus(meName)) : text;
    });
    if (wrote && draft) await askFix(draft.conversationId, draft.id, notes);
  }

  async function copy() {
    // The same text as a linked repository's copy (D-117).
    await navigator.clipboard.writeText(copyOf(column, cards.map((c) => c.text)));
    setNote('Copied');
    setTimeout(() => setNote(''), 2000);
  }

  const kinds: CardKind[] = column === 'decisions' ? ['D'] : ['R', 'K'];
  const edited = editing && cards.find((c) => c.id === editing.section.id);

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
    // A page cannot check a merge, so it says who wrote a status that is not the owner's.
    const about = face
      ? [card.status, card.setBy !== undefined && card.setBy !== card.owner && laneOf(card.status) !== 'open' && `set by ${whom(card.setBy)}`, card.owner !== undefined && `opened by ${whom(card.owner)}`].filter(Boolean).join(' · ')
      : '';
    const canMove = face && me && !lock;
    const inReview = face && laneOf(card.status) === 'review';
    const pick = canMove && moved(card, 'pick', me);
    const take = canMove && takeable(card, meName);
    const moves = canMove
      ? MOVES.filter(
          ([kind]) =>
            MOVE_FROM[kind].includes(laneOf(card.status)) &&
            (kind !== 'ask' || (card.owner !== undefined && card.owner !== me.id)) &&
            (kind !== 'ready' || !inReview || card.owner === me.id) &&
            (kind !== 'again' || card.reviews.some((r) => r.answer === 'accepted')),
        )
      : [];
    // Members who are people and have no line on the card yet, whom anyone may ask for a review.
    const askable = canMove && inReview ? Object.keys(usernames).map(Number).filter((id) => !card.reviews.some((r) => r.who === id)) : [];
    // As `moved` allows approve and ask for changes.
    const reviewer = canMove && inReview && !!card.kind && card.reviews.some((r) => r.who === me.id);
    // Its review lines show above the rest, as who said what.
    const shown = isOpen && face ? withReviews(card.body, []) : card.body;
    const head = (
      <button
        className={`board-card-head ${face ? 'board-face' : ''}`}
        onClick={() => {
          setOpen(isOpen ? null : card.id);
          setChanges(null);
          setAsking('');
        }}
        aria-expanded={isOpen}
      >
        {!face ? (
          card.kind && <span className="board-card-id">{card.cardId}</span>
        ) : card.owner !== undefined ? (
          avatarOf(card.owner, 24)
        ) : (
          <span className="board-no-owner" role="img" title="No owner" aria-label="No owner" />
        )}
        <strong>{card.failed ? 'This card could not be decrypted.' : card.title || 'Untitled'}</strong>
        {inReview && card.reviews.length > 0 ? (
          <span className="board-reviewers">
            {card.reviews.map((r) => {
              const [tone, label] = REVIEWS[r.verdict];
              return (
                <span key={r.who} className={`board-reviewer tag-${tone}`} role="img" title={`${nameOf(r.who)}: ${label}`} aria-label={`${nameOf(r.who)}: ${label}`}>
                  {avatarOf(r.who, 20)}
                </span>
              );
            })}
          </span>
        ) : (
          right && <span className="board-card-status">{right}</span>
        )}
        {face && cardRun && !isOpen && <Tag tone={runTone}>{runLabel}</Tag>}
      </button>
    );
    return (
      <article key={card.id} className={`board-card ${lock ? 'is-locked' : ''} ${isOpen ? 'is-open' : ''} ${face && card.status.startsWith(WAITING) ? 'is-waiting' : ''}`}>
        {pick ? (
          <div className="board-face-row">
            {head}
            <button className="button-secondary board-new board-pick" onClick={() => run(move(card, 'pick'))}>
              Pick
            </button>
          </div>
        ) : (
          head
        )}
        {same.has(card.id) && <p className="board-card-warn">Another card has this number. Renumber one of them.</p>}
        {isOpen && (
          <div className="board-card-body">
            <div className="doc-section-tools">
              {lock && <span className="doc-lock">{nameOf(lock.userId)} is editing</span>}
              <button
                className="icon-button icon-button-small"
                // From the text that stands, so a typo fix never signs a status someone could not set.
                onClick={() => run(edit(doc!, card.id, card.text, card.pos))}
                disabled={editing !== null || !!elsewhere || !!lock || card.failed}
                title={elsewhere ? `Close the editor in ${elsewhere} first` : 'Edit'}
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
              {canDelete(card) && (
                <button
                  className="icon-button icon-button-small"
                  onClick={() => run(remove(card))}
                  disabled={editing !== null || !!lock}
                  title="Delete"
                  aria-label="Delete card"
                >
                  <TrashIcon width={18} height={18} />
                </button>
              )}
            </div>
            {card.refused && (
              <p className="board-card-warn">
                {nameOf(card.refused.by)} {card.refused.status === null ? 'deleted this card' : `set “${card.refused.status}”`}. Only {whom(card.owner!)}, who opened it, can do that.
              </p>
            )}
            {(moves.length > 0 || take) && (
              <p className="board-card-run">
                {take && (
                  <button className="button-secondary board-new" onClick={() => run(takeCard(doc!, card.id))} title="Become its owner, who marks it ready and closes it">
                    Take
                  </button>
                )}
                {moves.map(([kind, label]) => {
                  const ok = moved(card, kind, me!) !== null;
                  const why =
                    kind === 'ask'
                      ? 'You asked already'
                      : kind === 'review'
                        ? 'An agent or a pull request runs it'
                        : card.owner === undefined
                          ? 'It has no owner'
                          : card.owner !== meId
                            ? `Only ${whom(card.owner)} can`
                            : kind === 'again'
                              ? 'Answer every requested change first'
                              : openChange(card.reviews)
                                ? 'A requested change is open'
                                : 'It needs an approval';
                  const act = () =>
                    kind === 'ask'
                      ? ask(card, card.owner!, 'ask', 'ready', `Asks you to mark ${card.cardId} ready: ${card.title}`)
                      : kind === 'again'
                        ? // Only the run whose pull request the card waits in: another draft of the user's is not this work.
                          again(card, cardRun?.state === 'done' && cardRun.pull && runnerOf(card.status) === `${cardRun.pull.repo}#${cardRun.pull.number}` ? request : undefined)
                        : move(card, kind);
                  return (
                    <button key={kind} className="button-secondary board-new" disabled={!ok} title={ok ? undefined : why} onClick={() => run(act())}>
                      {label}
                    </button>
                  );
                })}
              </p>
            )}
            {card.reviews.map((r) => (
              <p key={r.who} className="board-card-run">
                {avatarOf(r.who, 20)}
                <span>{nameOf(r.who)}</span>
                <Tag tone={REVIEWS[r.verdict][0]}>{REVIEWS[r.verdict][1]}</Tag>
                {r.note && <span className="board-review-note">{r.note}</span>}
                {r.answer && <span>{r.answer === 'accepted' ? 'Accepted' : 'Declined'}</span>}
                {canMove && moved(card, { accept: r.who }, me) !== null && (
                  <>
                    <button className="button-secondary board-new" onClick={() => run(move(card, { accept: r.who }))}>
                      Accept
                    </button>
                    <button className="button-secondary board-new" onClick={() => run(move(card, { decline: r.who }))}>
                      Decline
                    </button>
                  </>
                )}
              </p>
            ))}
            {(reviewer || askable.length > 0) && (
              <p className="board-card-run">
                {reviewer && changes === null && (
                  <>
                    <button className="button-secondary board-new" onClick={() => run(move(card, 'approve'))}>
                      Approve
                    </button>
                    <button className="button-secondary board-new" onClick={() => setChanges('')}>
                      Ask for changes
                    </button>
                  </>
                )}
                {reviewer && changes !== null && (
                  <>
                    <input className="field-input board-review-input" value={changes} onChange={(e) => setChanges(e.target.value)} maxLength={200} placeholder="What to change, in one line" aria-label="What to change" autoFocus />
                    <button className="button-secondary board-new" disabled={!changes.trim()} onClick={() => run(move(card, { changes }).then(() => setChanges(null)))}>
                      Send
                    </button>
                    <button className="button-secondary board-new" onClick={() => setChanges(null)}>
                      Cancel
                    </button>
                  </>
                )}
                {askable.length > 0 && changes === null && (
                  <>
                    <select className="field-input board-review-input" value={asking} onChange={(e) => setAsking(e.target.value)} aria-label="Reviewer">
                      <option value="">Ask for a review…</option>
                      {askable.map((id) => (
                        <option key={id} value={id}>
                          {nameOf(id)}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button-secondary board-new"
                      disabled={!asking}
                      onClick={() => {
                        const id = Number(asking);
                        setAsking('');
                        run(ask(card, id, { request: { id, username: usernames[id]! } }, 'review', `Asks you to review ${card.cardId}: ${card.title}`));
                      }}
                    >
                      Ask
                    </button>
                  </>
                )}
              </p>
            )}
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
            {shown ? <Markdown text={shown} /> : <p className="doc-note">Nothing more.</p>}
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
            <button
              key={kind}
              className="button-secondary board-new"
              onClick={() => run(add(kind))}
              disabled={editing !== null || !!elsewhere}
              title={elsewhere ? `Close the editor in ${elsewhere} first` : undefined}
            >
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
            canDelete={!edited || canDelete(edited)}
            toSave={column === 'roadmap' ? (text) => keepReviews(text, editing.lines) : undefined}
            onClose={(message) => {
              setEditing(null);
              onEditing(false);
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
              open={group.key === 'open' ? drawerOpen : !group.folded}
              // Only a toggle that differs from what was rendered is the user's.
              onToggle={(e) => group.key === 'open' && e.currentTarget.open !== drawerOpen && setDrawer(e.currentTarget.open)}
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

