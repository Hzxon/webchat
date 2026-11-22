// A project's board (R-021): the Decisions column and the Roadmap column of ideas and issues, each
// a doc whose sections are cards, one column at a time behind tabs. The Roadmap shows its cards in
// lanes, each with its owner's face (the board-lanes decision). Cards are written in the section
// editor docs have, and keep its locks and history. The board docs are created the first time
// someone adds a card.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  cardsOf,
  cardText,
  copyOf,
  groupOf,
  keepReviews,
  laneOf,
  parseCard,
  usernamesOf,
  WAITING,
  withReviews,
  withStatus,
  type Card,
  type DocSection,
} from '../../../shared/board';
import { cardKey, lineChoice, waitsOn, withChoice, type Choice } from '../../../shared/overlap';
import { LIMITS, type CardDraftDTO, type CardNoteDTO, type ProjectDTO, type UserDTO } from '../../../shared/types';
import {
  afterWarnings,
  boardDocs,
  cardRuns,
  GOING,
  cardTemplate,
  withChecked,
  withSession,
  sessionOf,
  COLUMN_TITLES,
  columnOf,
  COLUMNS,
  draftGroup,
  duplicates,
  KIND_NAMES,
  MOVE_FROM,
  moved,
  NEEDS,
  needsYou,
  NEW_STATUS,
  openChange,
  runnerOf,
  takeable,
  threadOf,
  unchecked,
  waitingFace,
  workingStatus,
  type BoardColumn,
  type CardKind,
  type CardRun,
  type Move,
} from '../board';
import { inOrder, ownAgents, ready, seatFor, short, useAgentChats, useAgentThreads, waitingProposals, type Seat, type Thread } from '../agents';
import { askAgent, askFix, askLink, noteAdded, sendCardNote, startDirectChat, syncNow, tellAgent } from '../chat';
import {
  addCard,
  beginEditing,
  boardCards,
  createBoard,
  loadCards,
  loadSections,
  markSeen,
  newSectionId,
  replaceSection,
  rewriteCard,
  stopEditing,
  takeCard,
  type Editing,
} from '../docs';
import type { ChatDoc, ChatMessage } from '../e2ee/keyring';
import { importEntries } from '../boardLink';
import { useLinkedRepos } from '../linkedRepos';
import { holdReloadWhile } from '../build';
import { actions, senderName, useAppState } from '../store';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { IconButton } from '@astryxdesign/core/IconButton';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Stack, StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { AgentDraft } from './AgentDraft';
import { AgentThread, Box } from './AgentThread';
import {
  BoardGroup,
  BoardLane,
  BoardLanes,
  BoardMenu,
  CardFace,
  CardRow,
  DotsIcon,
  Face,
  FoldChip,
  LaneIcon,
  LanesIcon,
  ListIcon,
  ProposalFace,
  PullNumber,
  StateChip,
  useNarrow,
  type Chip,
  type LaneKind,
  type MenuEntry,
  type Person,
  type PullMark,
} from './BoardParts';
import { CardPeek, type PeekTool } from './CardPeek';
import { RunAgent } from './RunPanel';
import { SectionEditor, SectionHistory } from './DocView';
import { BackIcon, HistoryIcon, PlusIcon, TrashIcon } from './icons';
import { Markdown } from './Markdown';
import { REVIEWS, RUN_TAGS, Tag, type Tone } from './PullTags';
import { confirmAction } from './ConfirmHost';

type Proposal = ReturnType<typeof waitingProposals>[number];

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
  const copied = new Set(
    Object.values(docs).flatMap((d) => (d.repo && d.id !== boards.roadmap?.id ? [d.repo.toLowerCase()] : [])),
  );
  const seat = agent && seatFor(agent, repo ?? '');
  // Not before the repositories load, so a check never runs on the board alone by mistake.
  const check =
    linked && seat && ready(seat)
      ? async (id: string) =>
          actions.setAgentsOpen(
            true,
            await askAgent(
              seat.agent.id,
              project.id,
              repo,
              `Check ${id} as it is on the board now, against the other cards, the decisions, the code and the open pull requests. Then draft a change to ${id} with replaces: its text as it is, or what your check calls for.`,
            ),
          )
      : undefined;
  // Only the project's owner links its board to a repository (R-040).
  const linkedTo =
    boards.roadmap?.repo && boards.roadmap.title?.authorId === project.ownerId ? boards.roadmap.repo : undefined;
  const free = repos.filter((r) => !copied.has(r.toLowerCase()));
  const canLink = !linkedTo && project.ownerId === meId && !!linked && !!seat && ready(seat) && free.length > 0;
  // Proposals on main reach only the owner, as drafts in their chat with their agent, so only their board shows them (D-117, R-047).
  const { threads } = useAgentThreads();
  const proposals = linkedTo && project.ownerId === meId ? waitingProposals(threads, project.id, linkedTo) : [];
  const [layout, setLayout] = useState<Layout>('board');
  // The project's people, not its agents, as the header's faces.
  const me = useAppState((s) => s.me);
  const people = project.memberIds.flatMap((id) => {
    const user = id === meId ? me : users[id];
    return user && user.agentOwner === null ? [{ name: user.displayName, seed: id }] : [];
  });

  return (
    <section className="chat board-view">
      {canLink && <BoardLink project={project} agentId={agent!.id} repos={free} />}
      <div className={`board-columns shows-${shown}`}>
        {COLUMNS.map((column) => (
          <BoardColumnView
            key={column}
            column={column}
            switcher={
              <SegmentedControl label="Show" size="sm" value={shown} onChange={(v) => setShown(v as BoardColumn)}>
                {(['roadmap', 'decisions'] as const).map((c) => (
                  <SegmentedControlItem key={c} value={c} label={COLUMN_TITLES[c]} />
                ))}
              </SegmentedControl>
            }
            layout={layout}
            onLayout={setLayout}
            people={people}
            linkedTo={linkedTo}
            projectId={project.id}
            doc={boards[column]}
            proposals={proposals.filter((p) => columnOf(p.draft.kind) === column)}
            check={check}
            // The user's own agent drafts a new card from the form, in the project's first repository (R-071).
            asker={linked && seat && ready(seat) ? { seat, repo } : undefined}
            elsewhere={editingIn && editingIn !== column ? COLUMN_TITLES[editingIn] : undefined}
            onEditing={(on) => setEditingIn(on ? column : null)}
            onPeek={() => setShown(column)}
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
  const answers = asked
    ? chats
        .flatMap((c) => messages[c.id] ?? [])
        .filter((m) => m.senderId === agentId && m.board && 'to' in m.board && m.board.to === asked)
    : [];
  const failed = answers.find((m) => m.board?.kind === 'failed');
  const parts = new Map(
    answers.flatMap((m) => (m.board?.kind === 'entries' ? [[m.board.part, m.board] as const] : [])),
  );
  const complete = parts.size > 0 && parts.size === [...parts.values()][0]!.parts;

  useEffect(() => {
    if (!asked || complete || failed) return;
    const timer = setTimeout(() => setLate(true), ANSWER_MS);
    return () => clearTimeout(timer);
  }, [asked, complete, failed]);
  useEffect(() => {
    if (!complete) return;
    const entries = [...parts.entries()].sort(([a], [b]) => a - b).flatMap(([, part]) => part.entries);
    importEntries(project.id, repo, entries, (done) =>
      setNote(`Importing ${done} of ${entries.length} entries…`),
    ).catch((err: Error) => {
      setError(err.message);
      setAsked(null);
    });
  }, [complete]);

  return (
    <div className="board-link">
      <Text as="p" color="secondary">
        Keep <code>docs/roadmap.md</code> and <code>docs/decisions.md</code> of{' '}
        <Selector
          label="Repository"
          isLabelHidden
          options={repos.map((r) => ({ value: r, label: r }))}
          value={repo}
          onChange={setRepo}
          isDisabled={!!asked}
        />{' '}
        as copies of this board. Their entries come onto the board first. Card text is then plain text in the
        repository, which everyone who can read it reads.
      </Text>
      <Button
        label="Link"
        isDisabled={!!asked}
        onClick={() => {
          setError('');
          setLate(false);
          askLink(agentId, project.id, repo).then(setAsked, (err: Error) => setError(err.message));
        }}
      />
      {asked && !complete && !failed && (
        <span className="doc-note">
          {late
            ? 'Your agent did not answer. Keep Claude Code open on your laptop, then link again.'
            : 'Asking your agent for the repository’s entries…'}
        </span>
      )}
      {note && <span className="doc-note">{note}</span>}
      {(failed || error) && <Banner status="error" title={failed?.text ?? error} />}
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
type Layout = 'board' | 'list';
type Sort = 'newest' | 'oldest' | 'owner' | 'id';
type Show = 'all' | 'mine' | 'none';
const SORTS: Array<[Sort, string]> = [
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
  ['owner', 'Owner'],
  ['id', 'Id'],
];
const SHOWS: Array<[Show, string]> = [
  ['all', 'All cards'],
  ['mine', 'Mine'],
  ['none', 'No owner'],
];
/**
 * A lane: the group of `GROUPS` it shows, by index, and its name, which the phone's tabs may shorten.
 * `starts` marks a lane a new card can start in, with the status it starts with, or its kind's own.
 */
type LaneSpec = { group: number; name: string; tab?: string; kind: LaneKind; starts?: { status?: string } };
// The Roadmap's Open group is its Idea lane, first, as an idea is where a card starts.
const LANES: Record<BoardColumn, { lanes: LaneSpec[]; finished: LaneSpec }> = {
  roadmap: {
    lanes: [
      { group: 3, name: 'Idea', kind: 'idea', starts: {} },
      { group: 0, name: 'Ready', kind: 'ready', starts: { status: 'Ready' } },
      { group: 1, name: 'Running', kind: 'running' },
      { group: 2, name: 'In review', tab: 'Review', kind: 'review' },
    ],
    finished: { group: 4, name: 'Done', kind: 'done' },
  },
  decisions: {
    lanes: [
      { group: 0, name: 'Proposed', kind: 'idea', starts: {} },
      { group: 1, name: 'Accepted', kind: 'done' },
    ],
    finished: { group: 2, name: 'Superseded', kind: 'dropped' },
  },
};
/** How many cards the finished lane shows before Show all. */
const FINISHED_FEW = 3;
const ROADMAP_KINDS: Record<string, LaneKind> = { open: 'idea', ready: 'ready', running: 'running', review: 'review', done: 'done' };
/** The icon of the lane a status puts a card in. */
const kindOf = (column: BoardColumn, status: string): LaneKind =>
  column === 'decisions'
    ? [...LANES.decisions.lanes, LANES.decisions.finished].find((l) => l.group === groupOf(column, status))!.kind
    : status.startsWith('Dropped')
      ? 'dropped'
      : ROADMAP_KINDS[laneOf(status)]!;
/** Three lines of a card's text for its face, as plain words: no Markdown marks and no lines for agents. */
const excerpt = (body: string) =>
  body
    .split('\n')
    .filter((line) => line.trim() && !/^\s*(After|Checked|Session|Review):/.test(line))
    .map((line) => line.replace(/^\s*([-+*]|\d+\.)\s+/, '').replace(/[*_`#>]/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
/** The pull request a card's status or the user's run names, as its face and peek mark it. */
function pullOf(column: BoardColumn, card: Card, cardRun?: CardRun): PullMark | undefined {
  if (column !== 'roadmap') return undefined;
  // Only where a status names its pull request: "Running: o/r#3", "In review: o/r#3", "Done in o/r#3".
  const named = /^(?:Running:|In review:|Done in|Fixed in)\s*([\w.-]+\/[\w.-]+)?#(\d+)/.exec(card.status);
  const repo = named ? named[1] : cardRun?.pull?.repo;
  const number = named ? Number(named[2]) : cardRun?.pull?.number;
  if (!number) return undefined;
  const lane = laneOf(card.status);
  return {
    number,
    state: lane === 'done' ? 'merged' : lane === 'review' ? 'review' : 'draft',
    href: repo ? `https://github.com/${repo}/pull/${number}` : undefined,
  };
}
// Pick shows on a Ready card's face; the others in the opened card.
const MOVES: Array<[keyof typeof MOVE_FROM, string]> = [
  ['ask', 'Ask owner to mark ready'],
  ['ready', 'Mark ready'],
  ['review', 'Send to review'],
  ['again', 'Run again'],
  ['close', 'Close'],
];
/** What the owners of a card that waits for another can choose, with what each does (docs/roadmap/new-overlap-gate.md). */
const CHOICES: Array<[Choice, (waits: string) => string, (waits: string) => string]> = [
  ['wait', (w) => `Wait for ${w}`, (w) => `The run goes on once ${w}'s draft no longer holds the files`],
  ['stack', (w) => `Stack on ${w}`, (w) => `The run goes on now, on ${w}'s branch`],
  ['fold', (w) => `Fold into ${w}`, (w) => `The run ends and its draft closes; its work goes into ${w}`],
];

function BoardColumnView({
  column,
  switcher,
  layout,
  onLayout,
  people,
  linkedTo,
  projectId,
  doc,
  proposals,
  check,
  asker,
  elsewhere,
  onEditing,
  onPeek,
}: {
  column: BoardColumn;
  /** The Roadmap and Decisions switch, which the board's header holds. */
  switcher: ReactNode;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  /** The project's people, as faces in the header. */
  people: Person[];
  /** The repository the board is copied to, once linked (R-040). */
  linkedTo?: string;
  projectId: number;
  doc: ChatDoc | undefined;
  /** The drafts from proposal files that wait for the user to add them to this column. */
  proposals: Proposal[];
  check?: (id: string) => Promise<void>;
  /** The user's own agent in the project, which drafts a new card from the form's prompt box (R-071). */
  asker?: Asker;
  /** The other column's title while it holds the open editor. */
  elsewhere?: string;
  onEditing: (on: boolean) => void;
  /** Shows this column, whose card the peek opened, as a reload or a request may open a card of either. */
  onPeek: () => void;
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
          agent.agentRepos.length
            ? agent.agentRepos.map((seat) => ({ agent, ...seat }))
            : [{ agent, online: agent.online, lastSeen: agent.lastSeen }],
        ),
    [memberIds, users, meId],
  );
  const [sections, setSections] = useState<DocSection[]>([]);
  const usernames = useMemo(() => usernamesOf(memberIds, users, me), [memberIds, users, me]);
  // An owner or a reviewer who left the project counts for nothing, so cards follow the members without a reload.
  const cards = useMemo(() => cardsOf(sections, memberIds, usernames), [sections, memberIds, usernames]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // The card open in the peek, which a request about it or a reload names.
  const boardCard = useAppState((s) => s.boardCard);
  const phone = useNarrow();
  // How each lane sorts and whose cards it shows, by its group; the lanes folded into the header; the finished lane.
  const [views, setViews] = useState<Record<number, { sort: Sort; show: Show }>>({});
  // The Idea lane starts folded into the header, as the design has it, so the lanes that move lead.
  const [folded, setFolded] = useState<number[]>(column === 'roadmap' ? [3] : []);
  const [finished, setFinished] = useState(false);
  const [allFinished, setAllFinished] = useState(false);
  // The lane a phone shows, by its group, and whether its sort and show sheet is open.
  const [tab, setTab] = useState<number | null>(null);
  const [sheet, setSheet] = useState(false);
  // The doc is kept with the editing state, because the first card's doc is made just before it.
  const [editing, setEditing] = useState<{
    doc: ChatDoc;
    section: Editing;
    /** The card's review lines that stood when its lock was taken, which no save changes. */
    lines: string[];
  } | null>(null);
  // The kind of card the new-card form is writing, and the status of the lane it starts in.
  const [adding, setAdding] = useState<{ kind: CardKind; status?: string } | null>(null);
  // The session that drafts the new card, by its prompt's client id (R-071).
  const [session, setSession] = useState<string | null>(null);
  const editorOpen = editing !== null || adding !== null;
  const [history, setHistory] = useState(false);
  // In the open card: the member picked to ask for a review, and the note of a requested change being written.
  const [asking, setAsking] = useState('');
  const [changes, setChanges] = useState<string | null>(null);
  // The proposal open in the peek, in place of a card.
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const pending = useAppState((s) => s.pending);
  const messages = useAppState((s) => s.messages);
  // A card's runs are messages in the user's chats with their agents, which load at start (D-105).
  const { chats, threads } = useAgentThreads();
  // Make a card on a session opens this form for it, on the column of its kind (R-071).
  const newCard = useAppState((s) => s.newCard);
  useEffect(() => {
    if (!newCard || newCard.projectId !== projectId || columnOf(newCard.kind) !== column || editing || adding) return;
    actions.openNewCard(null);
    setAdding({ kind: newCard.kind });
    setSession(newCard.session);
    onEditing(true);
  }, [newCard]);
  const sessionThread = session ? threads.find((t) => t.root === session) : undefined;
  // In id order across chats, so the newest request of a card is the one that counts.
  const agentMessages = useMemo(() => inOrder(chats.flatMap((c) => messages[c.id] ?? [])), [chats, messages]);
  // Read on every render, so a request nobody answered stops blocking once its time is up.
  const runs = doc && meId && column === 'roadmap' ? cardRuns(agentMessages, meId, doc.id, pending, Date.now()) : null;
  const needs = runs ? needsYou(cards, meId!, runs, threads) : [];
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
  /** A lane's cards as its menu sorts and filters them, and the drafts that wait in it. */
  const laneView = (spec: LaneSpec) => {
    const { sort, show } = views[spec.group] ?? { sort: 'newest', show: 'all' };
    const ownerName = (c: Card) => (c.owner === undefined ? '\uffff' : senderName(users, c.owner));
    const order: Record<Sort, (a: Card, b: Card) => number> = {
      newest: (a, b) => (b.number ?? -1) - (a.number ?? -1),
      oldest: (a, b) => (a.number ?? -1) - (b.number ?? -1),
      owner: (a, b) => ownerName(a).localeCompare(ownerName(b)) || (b.number ?? -1) - (a.number ?? -1),
      id: (a, b) => a.cardId.localeCompare(b.cardId, undefined, { numeric: true }),
    };
    return {
      ...spec,
      sort,
      show,
      cards: cards
        .filter((c) => groupOf(column, c.status) === spec.group)
        .filter((c) => show === 'all' || (show === 'mine' ? c.owner === meId : c.owner === undefined))
        .sort(order[sort]),
      drafts: proposals.filter((p) => draftGroup(p.draft, cards) === spec.group),
    };
  };
  type LaneView = ReturnType<typeof laneView>;
  const lanes = LANES[column].lanes.map(laneView);
  const done = laneView(LANES[column].finished);
  // A phone shows every lane behind its tabs, so it folds none.
  const shownLanes = [...lanes.filter((l) => phone || !folded.includes(l.group)), ...(finished ? [done] : [])];
  const tabbed = shownLanes.find((l) => l.group === tab) ?? shownLanes.find((l) => l.cards.length > 0) ?? shownLanes[0]!;
  const peek = cards.find((c) => c.id === boardCard);
  // A new card's editor opens before its card loads.
  const editsPeek = editing?.section.id === boardCard;
  // The user's own run of the open card shows beside it; run messages reach only their owner, so a teammate sees the card alone (D-100).
  // The open card as its peek's page, with its id, buttons and facts, unless its editor or history shows instead.
  const page = peek && !editsPeek && !history ? peek : undefined;
  const peekRun = peek && runs?.get(peek.id);
  const runThread = threadOf(peekRun, threads);
  const peekLock = peek && lockOf(peek.id);
  // The agent panel's switch opens the card's editor where it could open today, and closes it.
  const editOff = editsPeek
    ? undefined
    : elsewhere
      ? `Close the editor in ${elsewhere} first`
      : editorOpen
        ? 'Close the other editor first'
        : peekLock
          ? `${nameOf(peekLock.userId)} is editing it`
          : peek?.failed
            ? 'This card could not be decrypted.'
            : undefined;
  useEffect(() => {
    if (peek || editsPeek) onPeek();
  }, [!!peek || editsPeek]);
  // Once the owner adds the open proposal, the peek shows the card it became, as soon as it loads.
  const addedAs = Object.values(threads.find((t) => t.root === proposal?.thread.root)?.added ?? {})[0];
  useEffect(() => {
    const card = addedAs && cards.find((c) => c.cardId === addedAs);
    if (card) openCard(card.id);
  }, [addedAs, cards]);
  /** Only a card's owner deletes it, or anyone a card with no owner, since only then does the removal stand (the card-owner decision). */
  const canDelete = (card: Card) => card.owner === undefined || card.owner === meId;
  /** A member as a sentence names them. */
  const whom = (id: number) => (id === meId ? 'you' : senderName(users, id));
  /** A member as a face draws them. */
  const personOf = (id: number) => ({ name: id === meId ? meName : senderName(users, id), seed: id });
  const avatarOf = (id: number, size: number) => <Face person={personOf(id)} size={size} />;
  const titleOf = (card: Card) => (card.failed ? 'This card could not be decrypted.' : card.title || 'Untitled');

  /** Opens a card in the peek, or closes it, which closes its editor too: the editor saves and frees the card as it goes. */
  function openCard(id: string | null) {
    if (editing) {
      setEditing(null);
      onEditing(false);
    }
    actions.setBoardCard(id);
    setProposal(null);
    setChanges(null);
    setAsking('');
    setHistory(false);
  }

  /** Runs an action and shows what went wrong, such as a lock someone else holds. */
  function run(work: Promise<unknown>) {
    setError('');
    work.catch((err: Error) => setError(err.message));
  }

  async function edit(target: ChatDoc, id: string, saved: string, pos: number) {
    // Told before the lock is asked for, so the other column cannot open an editor meanwhile.
    onEditing(true);
    try {
      const section = await beginEditing(target.id, id, saved, pos, false);
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
      setEditing({
        doc: target,
        lines,
        section: card
          ? {
              ...section,
              saved: card.text,
              text: section.text === saved ? card.text : keepReviews(section.text, lines),
            }
          : section,
      });
    } catch (err) {
      onEditing(false);
      throw err;
    }
  }

  function closeForm() {
    setAdding(null);
    setSession(null);
    onEditing(false);
  }

  /**
   * Saves the new card once, with the next free number, which it takes under the column's lock
   * (D-116). One drafted in a session carries the check's line and a line naming the session, and
   * the session hears it was added, so the draft waits nowhere (R-071).
   */
  async function add(kind: CardKind, status: string | undefined, title: string, body: string, from?: Drafted) {
    const target = doc ?? (await createBoard(projectId, column));
    const id = newSectionId();
    const text = from ? withSession(from.draft.checked ? withChecked(body, from.draft.checked) : body, from.thread.root) : body;
    const { id: cardId } = await addCard(target, id, kind, (cardId) => cardText(cardId, title, status ?? NEW_STATUS[kind], text));
    if (from) await noteAdded(from.thread.conversationId, from.thread.root, from.message.clientId!, cardId);
    // Its peek shows once it loads.
    closeForm();
    openCard(id);
    void syncNow();
  }

  /** Removes a card in an editing session of its own. Its revisions stay in the history. */
  async function remove(card: Card) {
    if (
      !(await confirmAction({
        title: `Delete ${card.cardId || 'this card'}?`,
        body: 'The card leaves the board for everyone. Its history stays.',
        confirmLabel: 'Delete card',
      }))
    )
      return;
    await replaceSection(doc!, card.id, { text: card.text, pos: card.pos, removed: true });
    openCard(null);
    void syncNow();
  }

  /**
   * Writes a card owner's choice for a card that waits for another, as a line the waiting run's agent
   * reads from their signed revision (docs/roadmap/new-overlap-gate.md, D-081). A fold ends the run.
   */
  async function choose(card: Card, waits: string, choice: Choice) {
    if (
      choice === 'fold' &&
      !(await confirmAction({
        title: `Fold ${card.cardId} into ${waits}?`,
        body: `The run of ${card.cardId} ends and its draft closes. Its branch stays, and its work goes into ${waits}.`,
        confirmLabel: 'Fold',
      }))
    )
      return;
    await rewriteCard(doc!, card.id, (now) => withChoice(now.text, waits, choice));
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
    await navigator.clipboard.writeText(
      copyOf(
        column,
        cards.map((c) => c.text),
      ),
    );
    setNote('Copied');
    setTimeout(() => setNote(''), 2000);
  }

  /** Opens a proposal's draft in the peek, where its owner reads it and adds it. */
  function openProposal(p: Proposal) {
    openCard(null);
    setProposal(p);
  }

  const proposalTag = (p: Proposal) => (p.draft.replaces ? `Proposed change to ${p.draft.replaces.card}` : 'Proposal');
  const draftView = (p: Proposal) => (
    <ProposalFace key={p.thread.root} title={p.draft.title} tag={proposalTag(p)} repo={short(p.thread.repo)} onOpen={() => openProposal(p)} />
  );
  const draftRow = (p: Proposal) => (
    <CardRow
      key={p.thread.root}
      title={p.draft.title}
      id={short(p.thread.repo)}
      chips={[{ tone: 'muted', label: proposalTag(p) }]}
      onOpen={() => openProposal(p)}
    />
  );

  const kinds: CardKind[] = column === 'decisions' ? ['D'] : ['R', 'K'];
  const edited = editing && cards.find((c) => c.id === editing.section.id);

  /** What a card's peek lists about it, each a name and its value: where it stands, whose it is, and its run. */
  const factsOf = (card: Card): Array<[string, ReactNode]> => {
    const lock = lockOf(card.id);
    const cardRun = runs?.get(card.id);
    const need = needs.find((n) => n.card === card)?.need;
    const pull = pullOf(column, card, cardRun);
    const person = (id: number) => (
      <>
        {avatarOf(id, 20)} {nameOf(id)}
      </>
    );
    return [
      [
        'Status',
        <>
          <LaneIcon kind={kindOf(column, card.status)} />
          {/* The lane's name; who runs it and its pull request have rows of their own. */}
          {card.status.startsWith('Dropped') ? card.status : [...LANES[column].lanes, LANES[column].finished].find((l) => l.group === groupOf(column, card.status))!.name}
          {card.waits ? (
            <StateChip chip={{ tone: 'muted', label: waitingFace(card.waits) }} />
          ) : (
            card.status.startsWith(WAITING) && <StateChip chip={{ tone: 'muted', label: WAITING }} />
          )}
          {/* A run says where it stands on its own line. */}
          {need && !cardRun && <StateChip chip={{ tone: 'warn', label: NEEDS[need] }} />}
        </>,
      ],
      ['Owner', card.owner !== undefined && person(card.owner)],
      // A page cannot check a merge, so it says who wrote a status that is not the owner's.
      ['Set by', card.setBy !== undefined && card.setBy !== card.owner && laneOf(card.status) !== 'open' && person(card.setBy)],
      // Its note, such as a plan or why it failed, is in the run beside the card.
      ['Run', cardRun && <StateChip chip={need === 'asking' ? { tone: 'warn', label: NEEDS.asking } : { tone: RUN_STATES[cardRun.state][0], label: RUN_STATES[cardRun.state][1] }} />],
      // An agent is often named after its harness.
      // A teammate's run is only the line on the card (D-100).
      ['Runs it', cardRun ? [...new Set([nameOf(cardRun.runtime), cardRun.harness])].filter(Boolean).join(' · ') : !pull && runnerOf(card.status)],
      ['Repository', cardRun?.repo],
      ['Pull request', pull && <PullNumber pull={pull} title={titleOf(card)} />],
      // No agent checked it against the board, the code and the open pull requests yet (R-041).
      ['Checked', column === 'roadmap' && unchecked(card) && <StateChip chip={{ tone: 'muted', label: 'Not checked by an agent yet' }} />],
      ['Editing', lock && nameOf(lock.userId)],
    ];
  };

  /** The card's own buttons in its peek's header. */
  const toolsOf = (card: Card): PeekTool[] => [
    { label: 'History', icon: <HistoryIcon width={18} height={18} />, onClick: () => setHistory(true) },
    ...(canDelete(card)
      ? [
          {
            label: 'Delete card',
            icon: <TrashIcon width={18} height={18} />,
            onClick: () => run(remove(card)),
            isDisabled: editorOpen || !!lockOf(card.id),
          },
        ]
      : []),
  ];

  /** A card's face in its lane, or its row in the List view, or what stands under its facts in its peek. */
  const cardView = (card: Card, part: 'face' | 'row' | 'body') => {
    const lock = lockOf(card.id);
    const cardRun = runs?.get(card.id);
    const need = needs.find((n) => n.card === card)?.need;
    // A Roadmap card's face shows its owner and its state; who runs it is inside (the board-lanes decision).
    const face = column === 'roadmap';
    const canMove = face && me && !lock;
    const inReview = face && laneOf(card.status) === 'review';
    // Pick only where it stands: a card with no owner, or the user's own (the card-owner decision).
    const pick = canMove && (card.owner === undefined || card.owner === me.id) && moved(card, 'pick', me);
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
    const askable =
      canMove && inReview
        ? Object.keys(usernames)
            .map(Number)
            .filter((id) => !card.reviews.some((r) => r.who === id))
        : [];
    // The two card owners choose for a card that waits for another; the user's own run stands in for a card with no owner.
    const waits = face ? waitsOn(card.status) : undefined;
    const chooses =
      !!waits &&
      canMove &&
      (card.owner === me.id || cards.find((c) => cardKey(c.cardId) === waits)?.owner === me.id || (card.owner === undefined && !!cardRun));
    const chosen = waits ? lineChoice(card.text, waits) : undefined;
    // As `moved` allows approve and ask for changes.
    const reviewer = canMove && inReview && !!card.kind && card.reviews.some((r) => r.who === me.id);
    if (part !== 'body') {
      // State chips only: why it waits for the user, else where the user's run stands, a wait on another card, and the review.
      const verdict = inReview && (['changes_requested', 'approved', 'review_required'] as const).find((v) => card.reviews.some((r) => r.verdict === v));
      const chips: Chip[] = [
        ...(need ? [{ tone: 'warn' as const, label: NEEDS[need] }] : cardRun ? [{ tone: RUN_STATES[cardRun.state][0], label: RUN_STATES[cardRun.state][1] }] : []),
        ...(card.waits ? [{ tone: 'muted' as const, label: waitingFace(card.waits) }] : card.status.startsWith(WAITING) ? [{ tone: 'muted' as const, label: WAITING }] : []),
        ...(verdict ? [{ tone: 'muted' as const, label: REVIEWS[verdict][1] }] : []),
      ];
      const props = {
        title: titleOf(card),
        id: card.kind ? card.cardId : undefined,
        owner: !face ? undefined : card.owner !== undefined ? personOf(card.owner) : null,
        chips,
        pull: pullOf(column, card, cardRun),
        action: pick && (
          <button type="button" className="board-small-button" onClick={() => run(move(card, 'pick'))}>
            Pick
          </button>
        ),
        isWaiting: face && !!need,
        isLocked: !!lock,
        onOpen: () => openCard(card.id),
      };
      if (part === 'row') return <CardRow key={card.id} {...props} />;
      return (
        <CardFace key={card.id} {...props} text={card.failed ? undefined : excerpt(face ? withReviews(card.body, []) : card.body)}>
          {same.has(card.id) && <Banner status="warning" title="Another card has this number. Renumber one of them." />}
          {face && card.waits && afterWarnings(card.waits).map((w) => <Banner key={w} status="warning" title={w} />)}
        </CardFace>
      );
    }
    const request = cardRun && agentMessages.find((m) => m.id === cardRun.request);
    // Its review lines show above the rest, as who said what.
    const shown = face ? withReviews(card.body, []) : card.body;
    return (
      <div className="board-card-body">
        {card.refused && (
          <Banner
            status="warning"
            title={`${nameOf(card.refused.by)} ${card.refused.status === null ? 'deleted this card' : `set “${card.refused.status}”`}. Only ${whom(card.owner!)}, who opened it, can do that.`}
          />
        )}
        {(moves.length > 0 || take) && (
          <p className="board-card-run">
            {take && (
              <Button
                size="sm"
                label="Take"
                tooltip="Become its owner, who marks it ready and closes it"
                onClick={() => run(takeCard(doc!, card.id))}
              />
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
                      again(
                        card,
                        cardRun?.state === 'done' &&
                          cardRun.pull &&
                          runnerOf(card.status) === `${cardRun.pull.repo}#${cardRun.pull.number}`
                          ? request
                          : undefined,
                      )
                    : move(card, kind);
              return (
                <Button
                  key={kind}
                  size="sm"
                  label={label}
                  isDisabled={!ok}
                  tooltip={
                    ok
                      ? kind === 'ask'
                        ? 'Sends the card’s owner a message asking them to mark it ready'
                        : undefined
                      : why
                  }
                  onClick={() => run(act())}
                />
              );
            })}
          </p>
        )}
        {chooses && waits && (
          <p className="board-card-run">
            {CHOICES.map(([choice, label, tip]) => (
              <Button
                key={choice}
                size="sm"
                label={label(waits)}
                isDisabled={chosen === choice}
                tooltip={chosen === choice ? 'Chosen' : tip(waits)}
                onClick={() => run(choose(card, waits, choice))}
              />
            ))}
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
                <Button size="sm" label="Accept" onClick={() => run(move(card, { accept: r.who }))} />
                <Button size="sm" label="Decline" onClick={() => run(move(card, { decline: r.who }))} />
              </>
            )}
          </p>
        ))}
        {(reviewer || askable.length > 0) && (
          <p className="board-card-run">
            {reviewer && changes === null && (
              <>
                <Button size="sm" label="Approve" onClick={() => run(move(card, 'approve'))} />
                <Button size="sm" label="Ask for changes" onClick={() => setChanges('')} />
              </>
            )}
            {reviewer && changes !== null && (
              <>
                <TextInput
                  label="What to change"
                  isLabelHidden
                  value={changes}
                  onChange={(v) => setChanges(v.slice(0, 200))}
                  placeholder="What to change, in one line"
                  hasAutoFocus
                />
                <Button
                  size="sm"
                  label="Send"
                  isDisabled={!changes.trim()}
                  onClick={() => run(move(card, { changes }).then(() => setChanges(null)))}
                />
                <Button size="sm" label="Cancel" onClick={() => setChanges(null)} />
              </>
            )}
            {askable.length > 0 && changes === null && (
              <>
                <Selector
                  label="Reviewer"
                  isLabelHidden
                  placeholder="Ask for a review…"
                  options={askable.map((id) => ({ value: String(id), label: nameOf(id) }))}
                  value={asking}
                  onChange={setAsking}
                />
                <Button
                  size="sm"
                  label="Ask"
                  isDisabled={!asking}
                  onClick={() => {
                    const id = Number(asking);
                    setAsking('');
                    run(
                      ask(
                        card,
                        id,
                        { request: { id, username: usernames[id]! } },
                        'review',
                        `Asks you to review ${card.cardId}: ${card.title}`,
                      ),
                    );
                  }}
                />
              </>
            )}
          </p>
        )}
        {/* A card drafted in a session names it; only its owner has the session, in their pane (R-071). */}
        {threads.some((t) => t.root === sessionOf(card.body)) && (
          <p className="board-card-run">
            <span>Drafted in a session with your agent.</span>
            <Button variant="ghost" size="sm" label="Open the session" onClick={() => actions.setAgentsOpen(true, sessionOf(card.body)!)} />
          </p>
        )}
        {check && card.kind && !card.failed && (
          <p className="board-card-run">
            <span>Your agent checks it against the board, the code and the open pull requests.</span>
            <Button variant="ghost" size="sm" label="Check again" onClick={() => run(check(card.cardId))} />
          </p>
        )}
        {shown ? <Markdown text={shown} /> : <p className="doc-note">Nothing more.</p>}
      </div>
    );
  };

  const startAdding = (kind: CardKind, status?: string) => {
    setAdding({ kind, status });
    onEditing(true);
  };
  /** What a lane's + offers: a card of each kind of its column, starting in it. A card starts as an idea or ready; a run moves it on. */
  const addOf = (lane: LaneView): MenuEntry[] | undefined => {
    if (!lane.starts || editorOpen || elsewhere) return undefined;
    const { status } = lane.starts;
    return kinds.map((kind) => ({ label: `New ${KIND_NAMES[kind]}`, onSelect: () => startAdding(kind, status) }));
  };
  /** A lane's menu: how it sorts, whose cards it shows, folding it, and copying the board. On a phone it starts with the lane's new cards. */
  const menuOf = (lane: LaneView): MenuEntry[] => [
    ...(phone && addOf(lane) ? [...addOf(lane)!, null] : []),
    { heading: 'Sort by' },
    ...SORTS.filter(([sort]) => column === 'roadmap' || sort !== 'owner').map(([sort, label]) => ({
      label,
      isChecked: lane.sort === sort,
      onSelect: () => setViews((v) => ({ ...v, [lane.group]: { sort, show: lane.show } })),
    })),
    ...(column === 'roadmap'
      ? [
          null,
          { heading: 'Show' },
          ...SHOWS.map(([show, label]) => ({
            label,
            isChecked: lane.show === show,
            onSelect: () => setViews((v) => ({ ...v, [lane.group]: { sort: lane.sort, show } })),
          })),
        ]
      : []),
    null,
    ...(phone || lane === done ? [] : [{ label: 'Fold lane', onSelect: () => setFolded((f) => [...f, lane.group]) }]),
    ...(cards.length ? [{ label: 'Copy the board as Markdown', onSelect: () => run(copy()) }] : []),
  ];
  const count = (lane: LaneView) => lane.cards.length + lane.drafts.length;
  /** A lane's cards, as faces or rows; the finished lane shows its newest few until Show all. */
  const laneCards = (lane: LaneView, part: 'face' | 'row') => {
    const few = lane === done && !allFinished ? lane.cards.slice(0, FINISHED_FEW) : lane.cards;
    return (
      <>
        {lane.drafts.map((p) => (part === 'face' ? draftView(p) : draftRow(p)))}
        {few.map((card) => cardView(card, part))}
        {count(lane) === 0 && <p className="board-empty">No cards</p>}
        {few.length < lane.cards.length && (
          <button type="button" className="board-quiet-button board-show-all" onClick={() => setAllFinished(true)}>
            Show all {lane.cards.length}
          </button>
        )}
      </>
    );
  };
  const finishedButton = (
    <button
      type="button"
      className="board-quiet-button"
      aria-pressed={finished}
      aria-label={`${finished ? 'Hide' : 'Show'} ${done.cards.length} ${done.name.toLowerCase()}`}
      onClick={() => {
        setFinished(!finished);
        if (!finished) setTab(done.group);
      }}
    >
      <LaneIcon kind={done.kind} />
      {done.name}
      <span className="board-count">{done.cards.length}</span>
    </button>
  );
  const layoutSwitch = (
    <SegmentedControl label="Layout" size="sm" value={layout} onChange={(v) => onLayout(v as Layout)}>
      <SegmentedControlItem value="list" label="List" icon={<ListIcon />} isLabelHidden />
      <SegmentedControlItem value="board" label="Board" icon={<LanesIcon />} isLabelHidden />
    </SegmentedControl>
  );
  const back = (
    <IconButton
      className="back-button"
      variant="ghost"
      label="Back to projects"
      tooltip="Back to projects"
      icon={<BackIcon />}
      onClick={() => actions.setBoardOpen(null)}
    />
  );

  // Decisions read as one list of rows, newest first: the id, the title and a line of the text, and where each stands.
  const decisionName = (card: Card) => [...LANES.decisions.lanes, LANES.decisions.finished].find((l) => l.group === groupOf(column, card.status))!.name;
  const decisionsList = () => (
    <div className="board-list">
      <div className="board-decisions">
        {proposals.map(draftRow)}
        {[...cards]
          .sort((a, b) => (b.number ?? -1) - (a.number ?? -1))
          .map((card) => (
            <button key={card.id} type="button" className="board-decision" aria-haspopup="dialog" onClick={() => openCard(card.id)}>
              <span className="board-decision-id">{card.cardId || 'D'}</span>
              <span className="board-decision-text">
                <strong>{titleOf(card)}</strong>
                {!card.failed && <small>{excerpt(card.body)}</small>}
              </span>
              <span className="board-decision-status">{decisionName(card)}</span>
            </button>
          ))}
      </div>
    </div>
  );
  const newDecision = column === 'decisions' && !editorOpen && !elsewhere && (
    <button type="button" className="board-quiet-button" onClick={() => startAdding('D')}>
      <PlusIcon width={16} height={16} />
      New decision
    </button>
  );
  // The Roadmap's lane controls: its folded lanes, its finished lane and its layout.
  const roadmapOnly = column === 'roadmap';

  return (
    <div className={`board-column board-${column}`}>
      {phone ? (
        <>
          <header className="board-head">
            {back}
            <h1 className="board-title">Board</h1>
            {roadmapOnly && layout === 'board' && (
              <IconButton variant="ghost" label="Sort and show" tooltip="Sort and show" icon={<DotsIcon />} onClick={() => setSheet(true)} />
            )}
          </header>
          <div className="board-controls">
            {switcher}
            <span className="board-gap" />
            {roadmapOnly ? (
              <>
                {finishedButton}
                {layoutSwitch}
              </>
            ) : (
              newDecision
            )}
          </div>
        </>
      ) : (
        <header className="board-head">
          {back}
          <strong className="board-title">Board</strong>
          {switcher}
          <span className="board-gap" title={linkedTo && `Copied to ${linkedTo}`}>
            {note && <span className="doc-note">{note}</span>}
          </span>
          {newDecision}
          {lanes
            .filter((lane) => roadmapOnly && folded.includes(lane.group))
            .map((lane) => (
              <FoldChip
                key={lane.group}
                name={lane.name}
                kind={lane.kind}
                count={count(lane)}
                onUnfold={() => setFolded((f) => f.filter((g) => g !== lane.group))}
              />
            ))}
          {roadmapOnly && finishedButton}
          <span className="board-people" aria-label="Members">
            {people.slice(0, 3).map((p) => (
              <Face key={p.seed} person={p} size={26} />
            ))}
          </span>
          {roadmapOnly && layoutSwitch}
        </header>
      )}
      {error && <Banner status="error" title={error} />}
      {!doc && !editorOpen && <p className="doc-note board-none">No {column === 'decisions' ? 'decisions' : 'ideas or issues'} yet.</p>}
      {!roadmapOnly ? (
        decisionsList()
      ) : layout === 'list' ? (
        <div className="board-list">
          {/* A folded lane keeps its head here, without its rows. */}
          {[...lanes, ...(finished ? [done] : [])].map((lane) => (
            <BoardGroup key={lane.group} name={lane.name} kind={lane.kind} count={count(lane)} add={addOf(lane)}>
              {!folded.includes(lane.group) && laneCards(lane, 'row')}
            </BoardGroup>
          ))}
        </div>
      ) : phone ? (
        <>
          <nav className="board-tabs" aria-label="Lanes">
            {shownLanes.map((lane) => (
              <button key={lane.group} type="button" aria-pressed={lane === tabbed} onClick={() => setTab(lane.group)}>
                {lane.tab ?? lane.name}
                <small>{count(lane)}</small>
              </button>
            ))}
          </nav>
          <div className="board-lane-cards is-alone">{laneCards(tabbed, 'face')}</div>
          {sheet && <BoardMenu label="Sort and show" entries={menuOf(tabbed)} onClose={() => setSheet(false)} />}
        </>
      ) : (
        <BoardLanes>
          {shownLanes.map((lane) => (
            <BoardLane
              key={lane.group}
              name={lane.name}
              kind={lane.kind}
              count={count(lane)}
              add={lane === done ? undefined : addOf(lane)}
              menu={lane === done ? undefined : menuOf(lane)}
              onHide={lane === done ? () => setFinished(false) : undefined}
            >
              {laneCards(lane, 'face')}
            </BoardLane>
          ))}
        </BoardLanes>
      )}
      {adding && (
        <NewCardForm
          kind={adding.kind}
          projectId={projectId}
          asker={asker}
          thread={sessionThread}
          onSession={setSession}
          onDone={(title, body, from) => add(adding.kind, adding.status, title, body, from)}
          onCancel={closeForm}
        />
      )}
      {proposal && (
        <CardPeek
          title={proposal.draft.title}
          onClose={() => setProposal(null)}
          isEditing={false}
          editOff="Add it to the board to edit it"
        >
          <AgentDraft
            message={proposal.message}
            draft={proposal.draft}
            // The live thread, which says once the draft is added.
            thread={threads.find((t) => t.root === proposal.thread.root) ?? proposal.thread}
            agentId={proposal.message.senderId!}
          />
        </CardPeek>
      )}
      {(peek || editsPeek) && (
        <CardPeek
          title={peek ? titleOf(peek) : 'New card'}
          // The card reads as a page; its editor and its history take the peek alone.
          id={page?.cardId || undefined}
          tools={page && toolsOf(page)}
          facts={page && factsOf(page)}
          onClose={() => openCard(null)}
          isEditing={editsPeek}
          editOff={editOff}
          onEditing={(on) => {
            if (!on) {
              setEditing(null);
              onEditing(false);
              return;
            }
            setHistory(false);
            // From the text that stands, so a typo fix never signs a status someone could not set.
            run(edit(doc!, peek!.id, peek!.text, peek!.pos));
          }}
          // The brief starts a run (D-105); with no agent in the project, the button points to the Coding agents pane.
          onRun={
            column !== 'roadmap' || !peek?.kind || peek.failed || (peekRun && GOING.has(peekRun.state))
              ? undefined
              : canRun
                ? () => actions.openBrief({ projectId, docId: doc!.id, section: peek.id })
                : () => actions.setAgentsOpen(true)
          }
          runLabel={canRun ? undefined : 'Connect coding agent'}
          run={
            runThread && (
              <RunAgent.Provider value={nameOf(peekRun!.runtime)}>
                <AgentThread
                  key={runThread.root}
                  thread={runThread}
                  seat={users[peekRun!.runtime] && seatFor(users[peekRun!.runtime]!, runThread.repo)}
                  agentId={peekRun!.runtime}
                  panel
                />
              </RunAgent.Provider>
            )
          }
        >
          {/* The card being edited shows here, whatever its group, so its editor keeps its text and its lock. */}
          {editsPeek ? (
            <SectionEditor
              key={editing!.section.id}
              doc={editing!.doc}
              editing={editing!.section}
              canDelete={!edited || canDelete(edited)}
              toSave={column === 'roadmap' ? (text) => keepReviews(text, editing!.lines) : undefined}
              onClose={(message) => {
                setEditing(null);
                onEditing(false);
                setError(message ?? '');
              }}
            />
          ) : history ? (
            <>
              <Button label="Back to the card" onClick={() => setHistory(false)} />
              <SectionHistory doc={doc!} section={peek!} nameOf={nameOf} onClose={() => setHistory(false)} />
            </>
          ) : (
            cardView(peek!, 'body')
          )}
        </CardPeek>
      )}
    </div>
  );
}

/** A new card's title and details. Nothing reaches the server, and no number is taken, until Done (D-116). */
/** The user's own agent in a project, ready to answer, and the repository it reads. */
type Asker = { seat: Seat; repo?: string };
/** The session's draft that filled the form, which the card that goes on the board came from. */
type Drafted = { message: ChatMessage; draft: CardDraftDTO; thread: Thread };

function NewCardForm({
  kind,
  projectId,
  asker,
  thread,
  onSession,
  onDone,
  onCancel,
}: {
  kind: CardKind;
  projectId: number;
  asker?: Asker;
  /** The session that drafts this card, once there is one. */
  thread?: Thread;
  onSession: (root: string) => void;
  onDone: (title: string, body: string, from?: Drafted) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  // The session's newest new draft of this kind fills the fields, once each, over what they held (R-071).
  const message = thread?.messages.findLast(
    (m) => m.prompt?.kind === 'answer' && m.prompt.card?.kind === kind && !m.prompt.card.replaces,
  );
  const draft = message?.prompt?.kind === 'answer' ? message.prompt.card : undefined;
  const [filled, setFilled] = useState<string>();
  useEffect(() => {
    if (!draft || !message?.clientId || message.clientId === filled) return;
    setTitle(draft.title);
    setBody(draft.body);
    setFilled(message.clientId);
  }, [message?.clientId]);
  // Each prompt carries the fields as they stand, so the agent builds on the user's edits.
  async function ask(text: string) {
    const card = { kind: kind as 'R' | 'K' | 'D', title, body };
    if (thread) return tellAgent(thread.conversationId, thread.root, 'reply', text, { card });
    onSession(await askAgent(asker!.seat.agent.id, projectId, asker!.repo, text, { own: true, card }));
  }
  const working = thread?.state === 'working' || thread?.state === 'asking';
  // Preview reads the fields as the card would; nothing is saved until Done (D-116).
  const [preview, setPreview] = useState(false);
  const [needTitle, setNeedTitle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The template's fields: an empty Details keeps them, so the card still asks for what it lacks.
  const prompts = parseCard({ id: '', text: cardTemplate(kind, `${kind}-1`), pos: 0, failed: false }).body;
  // A reload would lose what was typed (K-63).
  useEffect(() => holdReloadWhile(() => true), []);

  async function done() {
    if (!title.trim()) return setNeedTitle(true);
    setBusy(true);
    try {
      await onDone(title.trim(), body.trim() || prompts, draft && thread && message ? { message, draft, thread } : undefined);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <CardPeek
      title={`New ${KIND_NAMES[kind]}`}
      onClose={onCancel}
      isEditing={!preview}
      onEditing={(on) => setPreview(!on)}
      run={
        // The session drafts the card from its box, which carries the fields as they stand (R-071).
        thread ? (
          <AgentThread key={thread.root} thread={thread} seat={asker?.seat} agentId={asker?.seat.agent.id ?? 0} inForm={ask} />
        ) : (
          <>
            <StackItem size="fill">
              <Stack padding={5}>
                <Text as="p" color="secondary">
                  {asker
                    ? 'Your agent drafts this card from what you tell it.'
                    : 'To draft cards with your coding agent, connect it in the Coding agents pane.'}
                </Text>
              </Stack>
            </StackItem>
            {asker && (
              <footer className="composer">
                <Box
                  name={`newcard:${projectId}:${kind}`}
                  placeholder="Describe it to your agent, which drafts it here"
                  canSend={!working}
                  onSend={ask}
                />
              </footer>
            )}
          </>
        )
      }
    >
      <div
        className="doc-section doc-editor"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      >
        {preview ? (
          <>
            <Heading level={2}>{title.trim() || 'Untitled'}</Heading>
            <div className="board-card-body">
              <Markdown text={body.trim() || prompts} />
            </div>
          </>
        ) : (
          <>
            <TextInput
              label="Title"
              value={title}
              onChange={(v) => {
                setTitle(v);
                setNeedTitle(false);
              }}
              status={needTitle ? { type: 'error', message: 'A card needs a title.' } : undefined}
              hasAutoFocus
            />
            <textarea
              className="field-input doc-textarea"
              aria-label="Details"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={Math.max(6, body.split('\n').length + 1)}
              maxLength={LIMITS.docSectionLength}
              placeholder={prompts}
            />
          </>
        )}
        {draft?.checked && <Text color="secondary">Checked: {draft.checked}</Text>}
        {/* Nothing is blocked: the user weighs what the check found, a conflict as a warning (R-041). */}
        {draft?.related?.map((r) => (
          <Banner
            key={r.id}
            status={r.kind === 'conflict' ? 'warning' : 'info'}
            title={`${r.kind === 'conflict' ? 'Goes against' : 'Repeats'} ${r.id}${r.why ? `: ${r.why}` : ''}`}
          />
        ))}
        <div className="doc-editor-actions">
          <Text color="secondary" className="doc-editor-status">
            {error}
          </Text>
          <Button label="Cancel" onClick={onCancel} />
          <Button variant="primary" label="Done" isDisabled={busy} onClick={() => void done()} />
        </div>
      </div>
    </CardPeek>
  );
}
