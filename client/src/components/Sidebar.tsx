import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import type { ProjectDTO } from '../../../shared/types';
import { agentOf, proposalsWaiting, useAgentThreads } from '../agents';
import { sound } from '../alerts';
import { notificationWarning, shownWarning } from '../banner';
import { colorChoice, setColorChoice, subscribeColorMode, type ColorChoice } from '../colorMode';
import { deleteAccount, deleteChannel, openConversation, previewText, signOut } from '../chat';
import { deleteDoc } from '../docs';
import type { ChatConversation, ChatDoc } from '../e2ee/keyring';
import {
  actions,
  chatTitle,
  generalOf,
  loudUnread,
  otherMemberId,
  senderName,
  store,
  useAppState,
  type SidebarTab,
  type State,
} from '../store';
import { Avatar } from './Avatar';
import { formatListTime } from './format';
import {
  BellIcon,
  BellOffIcon,
  BoardIcon,
  ChatIcon,
  DownIcon,
  FileIcon,
  FolderIcon,
  GithubIcon,
  HashIcon,
  LogoutIcon,
  MoreIcon,
  NewChatIcon,
  PencilIcon,
  PlusIcon,
  PullRequestIcon,
  SearchIcon,
  TerminalIcon,
  Ticks,
  TrashIcon,
  UsersIcon,
} from './icons';
import { receiptState } from './receipts';
import { confirmAction } from './ConfirmHost';

interface SidebarProps {
  onNewChat: () => void;
  onNewProject: () => void;
  onNewChannel: (projectId: number) => void;
  onAddPeople: (projectId: number) => void;
  onMembers: (projectId: number) => void;
  onRepos: (projectId: number) => void;
  onNewDoc: (projectId: number) => void;
  onRenameDoc: (doc: ChatDoc) => void;
  onNotifications: () => void;
}

/** Unread messages in a tab: channels count in Projects, every other chat in Chats. Muted chats count in neither. */
const unreadIn = (tab: SidebarTab) => (s: State) =>
  Object.values(s.conversations).reduce((sum, c) => ((c.type === 'channel') === (tab === 'projects') ? sum + loudUnread(c) : sum), 0);

const newestFirst = (a: ChatConversation, b: ChatConversation) =>
  (b.lastMessage?.createdAt ?? b.updatedAt) - (a.lastMessage?.createdAt ?? a.updatedAt);

/** Someone else saved the doc since this device last showed it: a row's dot, and the Projects place's. */
const updatedSince = (d: ChatDoc, meId: number | undefined, docsSeen: State['docsSeen']) =>
  d.updatedBy !== meId && d.version > (docsSeen[d.id] ?? 0);

/**
 * A chat holds an unread urgent message while its alert waits, or while its newest message is
 * urgent and unread: dismissing the alert leaves the row red until the chat is opened.
 */
const urgentIn = (urgent: State['urgent'], meId: number | undefined, c: ChatConversation) =>
  urgent.some((m) => m.conversationId === c.id) || (c.unread > 0 && !!c.lastMessage?.urgent && c.lastMessage.senderId !== meId);

const GearIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

/** A project's tile: its first letter on one of the palette's soft tones, so it never looks like a person. */
const ProjectTile = ({ project, size }: { project: ProjectDTO; size: number }) => (
  <span className={`ptile tone-${project.id % 4}`} style={{ width: size, height: size }} aria-hidden="true">
    {project.name.trim().charAt(0).toUpperCase() || '?'}
  </span>
);

const CheckMark = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-label="Current project"
    role="img"
  >
    <polyline points="5 12.5 10 17 19 7" />
  </svg>
);

/**
 * WebChat's places on the app's frame: a labelled rail on a wide screen, a tab bar at a phone's
 * foot (layout.css). A dot says something waits in a place.
 */
export function Rail({ onNotifications }: { onNotifications: () => void }) {
  const tab = useAppState((s) => s.tab);
  const agentsOpen = useAppState((s) => s.agentsOpen);
  const chatsDot = useAppState(unreadIn('chats')) > 0;
  const projectsDot = useAppState(
    (s) => unreadIn('projects')(s) > 0 || Object.values(s.docs).some((d) => updatedSince(d, s.me?.id, s.docsSeen)),
  );
  const { chats, threads } = useAgentThreads();
  const agentsDot = chats.some((c) => c.unread > 0) || proposalsWaiting(threads) > 0;

  const go = (place: SidebarTab) => {
    if (agentsOpen) actions.setAgentsOpen(false);
    actions.setTab(place);
  };
  return (
    <nav className="rail" aria-label="Places">
      <RailItem
        label="Chats"
        icon={<ChatIcon />}
        current={!agentsOpen && tab === 'chats'}
        dot={chatsDot && 'accent'}
        onClick={() => go('chats')}
      />
      <RailItem
        label="Projects"
        icon={<FolderIcon />}
        current={!agentsOpen && tab === 'projects'}
        dot={projectsDot && 'accent'}
        onClick={() => go('projects')}
      />
      <RailItem
        label="Agents"
        icon={<TerminalIcon />}
        current={agentsOpen}
        dot={agentsDot && 'warn'}
        onClick={() => actions.setAgentsOpen(true)}
      />
      <AccountMenu className="rail-account" onNotifications={onNotifications} />
    </nav>
  );
}

function RailItem(props: { label: string; icon: ReactNode; current: boolean; dot: false | 'accent' | 'warn'; onClick: () => void }) {
  const { label, icon, current, dot, onClick } = props;
  return (
    <button type="button" className="rail-item" aria-current={current ? 'page' : undefined} onClick={onClick}>
      <span className="rail-tile">
        {icon}
        {dot && <span className={`rail-dot ${dot}`} aria-label="New" role="img" />}
      </span>
      <span className="rail-label">{label}</span>
    </button>
  );
}

/** The account's menu: theme, alerts, sign out. Its avatar carries a dot while alerts cannot reach the user. */
function AccountMenu({ className, onNotifications }: { className: string; onNotifications: () => void }) {
  const me = useAppState((s) => s.me);
  const alertsReady = useAppState((s) => s.push?.permission === 'granted');
  const theme = useSyncExternalStore(subscribeColorMode, colorChoice);
  if (!me) return null;

  async function removeAccount() {
    const warning = 'You leave every project and group, your direct chats are deleted for both people, and your username is freed.';
    if (
      !(await confirmAction({
        title: 'Delete your account?',
        body: `${warning} This cannot be undone.`,
        confirmLabel: 'Delete account',
      }))
    )
      return;
    try {
      await deleteAccount();
    } catch (err) {
      actions.addToast({
        conversationId: null,
        title: 'Delete account',
        body: (err as Error).message,
      });
    }
  }

  return (
    <DropdownMenu
      placement="end"
      alignment="end"
      renderTrigger={(trigger) => (
        <button {...trigger} type="button" className={`account-tile ${className}`} aria-label={`Your account, ${me.displayName}`}>
          <Avatar name={me.displayName} seed={me.id} size={36} />
          {!alertsReady && <span className="rail-dot danger" aria-label="Alerts are off" role="img" />}
        </button>
      )}
    >
      <DropdownMenuGroup title={`${me.displayName} · @${me.username}`}>
        <DropdownMenuItem label="Notifications" icon={BellIcon} onClick={onNotifications} />
      </DropdownMenuGroup>
      <DropdownMenuDivider />
      <DropdownMenuGroup title="Theme">
        <DropdownMenuRadioGroup label="Theme" value={theme} onChange={(value) => setColorChoice(value as ColorChoice)}>
          <DropdownMenuRadioItem value="system" label="System" />
          <DropdownMenuRadioItem value="light" label="Light" />
          <DropdownMenuRadioItem value="dark" label="Dark" />
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuDivider />
      <DropdownMenuItem label="Sign out" icon={LogoutIcon} onClick={() => void signOut()} />
      <DropdownMenuItem label="Delete account" variant="destructive" icon={TrashIcon} onClick={() => void removeAccount()} />
    </DropdownMenu>
  );
}

/** The sidebar of the place the rail picked: the chat list, or one project. */
export function Sidebar(props: SidebarProps) {
  const me = useAppState((s) => s.me);
  const tab = useAppState((s) => s.tab);
  const connected = useAppState((s) => s.connected);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setSearching(true);
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The field shows only once searching, so it takes focus after it renders.
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  // Each place searches its own list.
  useEffect(() => {
    setQuery('');
    setSearching(false);
  }, [tab]);

  if (!me) return null;
  const toggleSearch = () => {
    setSearching(!searching);
    setQuery('');
  };
  const search = searching && (
    <label className="side-search">
      <SearchIcon width={16} height={16} />
      <input
        ref={searchRef}
        type="search"
        placeholder={tab === 'projects' ? 'Search channels and docs' : 'Search chats'}
        aria-label={tab === 'projects' ? 'Search channels and docs' : 'Search chats'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && toggleSearch()}
      />
    </label>
  );
  const banners = (
    <>
      {!connected && <Banner status="info" container="section" title="Connecting…" />}
      <AlertSetupBanner onOpen={props.onNotifications} />
    </>
  );

  return (
    <aside className="sidebar" aria-label={tab === 'projects' ? 'Project' : 'Chats'}>
      {tab === 'chats' ? (
        <ChatsSide {...props} query={query} search={search} banners={banners} onSearch={toggleSearch} />
      ) : (
        <ProjectSide {...props} query={query} search={search} banners={banners} onSearch={toggleSearch} />
      )}
    </aside>
  );
}

interface SideProps extends SidebarProps {
  query: string;
  search: ReactNode;
  banners: ReactNode;
  onSearch: () => void;
}

const SearchButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className="btn btn-icon" aria-label={label} title={label} onClick={onClick}>
    <SearchIcon width={18} height={18} />
  </button>
);

function ChatsSide({ query, search, banners, onSearch, onNewChat, onNotifications }: SideProps) {
  const me = useAppState((s) => s.me);
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const q = query.trim().toLowerCase();
  // The chats with this user's agents show in their own place (D-103).
  const sorted = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.type !== 'channel' && !agentOf({ users, me }, c))
        .filter((c) => !q || chatTitle(c).toLowerCase().includes(q))
        .sort(newestFirst),
    [conversations, users, me, q],
  );

  return (
    <>
      <header className="side-head">
        <h1 className="side-title">Chats</h1>
        <SearchButton label="Search chats" onClick={onSearch} />
        <button type="button" className="btn btn-icon" aria-label="New chat" title="New chat" onClick={onNewChat}>
          <NewChatIcon width={18} height={18} />
        </button>
        <AccountMenu className="phone-account" onNotifications={onNotifications} />
      </header>
      {banners}
      {search}
      <div className="side-list">
        {sorted.map((c) => (
          <ChatRow key={c.id} conversation={c} />
        ))}
        {sorted.length === 0 && <p className="side-empty">{query ? 'No chats match.' : 'No chats yet. Press + to message a friend.'}</p>}
      </div>
    </>
  );
}

/** A count of unread messages, or the quieter bell of a muted chat with its own count. */
function UnreadMark({ unread, muted }: { unread: number; muted: boolean }) {
  return (
    <>
      {muted && <BellOffIcon width={14} height={14} role="img" aria-hidden={false} aria-label="Muted" className="side-muted" />}
      {unread > 0 && <span className={`side-count ${muted ? 'muted' : ''}`}>{unread}</span>}
    </>
  );
}

/** An unread urgent message tints its chat's row red until the chat is opened. */
function ChatRow({ conversation }: { conversation: ChatConversation }) {
  const meId = useAppState((s) => s.me?.id);
  const users = useAppState((s) => s.users);
  const active = useAppState((s) => s.activeId === conversation.id);
  const urgent = useAppState((s) => urgentIn(s.urgent, s.me?.id, conversation));

  const title = chatTitle(conversation);
  const otherId = otherMemberId(conversation, meId);
  const last = conversation.lastMessage;
  const loud = loudUnread(conversation) > 0;
  const mine = last?.senderId === meId;
  const prefix = last && conversation.type !== 'direct' && !mine ? `${senderName(users, last.senderId).split(' ')[0]}: ` : '';
  const state = [active && 'is-active', loud && 'is-unread', urgent && 'is-urgent'].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={`side-row chat-row ${state}`}
      aria-current={active || undefined}
      onClick={() => void openConversation(conversation.id)}
    >
      <Avatar name={title} seed={otherId ?? conversation.id + 3} size={36} online={otherId !== undefined && users[otherId]?.online} />
      <span className="chat-row-main">
        <span className="chat-row-line">
          <span className="chat-row-title">{title}</span>
          {last && <time>{formatListTime(last.createdAt)}</time>}
        </span>
        <span className="chat-row-line">
          <span className="chat-row-preview">
            {mine && last && <Ticks state={receiptState(conversation, last.id, meId)} />}
            {last ? `${prefix}${previewText(last)}` : 'No messages yet'}
          </span>
          {/* The urgent tag takes the count's place, as the design draws it. */}
          {urgent ? <span className="urgent-chip">URGENT</span> : <UnreadMark unread={conversation.unread} muted={conversation.muted} />}
        </span>
      </span>
    </button>
  );
}

const PICKED_KEY = 'webchat.project';

function rememberedProject() {
  try {
    return Number(localStorage.getItem(PICKED_KEY)) || null;
  } catch {
    return null;
  }
}

/** The project the sidebar shows: the one whose board, doc or channel is open, else the last one picked. */
function useCurrentProject(picked: number | null) {
  return useAppState((s) => {
    const open =
      s.boardOpen ??
      (s.docOpen !== null ? s.conversations[s.docs[s.docOpen]?.conversationId ?? -1]?.projectId : undefined) ??
      (s.activeId !== null ? s.conversations[s.activeId]?.projectId : undefined);
    const id = [open, picked].find((p) => p != null && s.projects[p]);
    if (id != null) return s.projects[id];
    return Object.values(s.projects).sort((a, b) => a.name.localeCompare(b.name))[0];
  });
}

function ProjectSide(props: SideProps) {
  const { query, search, banners, onSearch, onNewProject, onNewChannel, onNewDoc, onRenameDoc, onRepos, onAddPeople, onMembers } = props;
  const [picked, setPicked] = useState(rememberedProject);
  const project = useCurrentProject(picked);
  const projects = useAppState((s) => s.projects);
  const conversations = useAppState((s) => s.conversations);
  const githubApp = useAppState((s) => s.github?.appConfigured ?? false);

  const pick = (id: number) => {
    setPicked(id);
    try {
      localStorage.setItem(PICKED_KEY, String(id));
    } catch {
      // A private window shows the first project on the next load.
    }
    const general = generalOf(store.get(), id);
    if (general) void openConversation(general.id);
  };

  const sortedProjects = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const unreadOf = (id: number) => Object.values(conversations).reduce((n, c) => (c.projectId === id ? n + loudUnread(c) : n), 0);

  if (!project) {
    return (
      <>
        <header className="side-head">
          <h1 className="side-title">Projects</h1>
        </header>
        {banners}
        <div className="side-list side-intro">
          <p>
            A project gives a team its own channels, like #general for planning and #design for drafts. Everyone in the project can read
            every channel.
          </p>
          <Button variant="primary" label="New project" onClick={onNewProject} />
        </div>
      </>
    );
  }

  return (
    <>
      <header className="side-head">
        <DropdownMenu
          menuWidth="min(320px, calc(100vw - 32px))"
          renderTrigger={(trigger) => (
            <button {...trigger} type="button" className="switcher" aria-label={`Switch project, now ${project.name}`}>
              <ProjectTile project={project} size={28} />
              <span className="switcher-name">{project.name}</span>
              <DownIcon width={14} height={14} />
            </button>
          )}
        >
          <DropdownMenuGroup title="Your projects">
            {sortedProjects.map((p) => (
              <DropdownMenuItem
                key={p.id}
                icon={<ProjectTile project={p} size={26} />}
                label={p.name}
                description={`${p.memberIds.length} ${p.memberIds.length === 1 ? 'member' : 'members'}${unreadOf(p.id) ? ` · ${unreadOf(p.id)} new` : ''}`}
                endContent={
                  p.id === project.id ? <CheckMark /> : unreadOf(p.id) > 0 && <span className="side-dot" aria-label="Unread" role="img" />
                }
                onClick={() => pick(p.id)}
              />
            ))}
          </DropdownMenuGroup>
          <DropdownMenuDivider />
          <DropdownMenuItem label="New project" icon={PlusIcon} onClick={onNewProject} />
          <DropdownMenuDivider />
          <DropdownMenuItem label={`${project.name} settings`} icon={<GearIcon />} onClick={() => onMembers(project.id)} />
          {githubApp && <DropdownMenuItem label="GitHub repositories" icon={GithubIcon} onClick={() => onRepos(project.id)} />}
        </DropdownMenu>
        <SearchButton label="Search this project" onClick={onSearch} />
      </header>
      {banners}
      {search}
      <ProjectList
        project={project}
        query={query}
        onNewChannel={() => onNewChannel(project.id)}
        onNewDoc={() => onNewDoc(project.id)}
        onRenameDoc={onRenameDoc}
      />
      <MembersFoot project={project} onAddPeople={() => onAddPeople(project.id)} onMembers={() => onMembers(project.id)} />
    </>
  );
}

function ProjectList(props: {
  project: ProjectDTO;
  query: string;
  onNewChannel: () => void;
  onNewDoc: () => void;
  onRenameDoc: (doc: ChatDoc) => void;
}) {
  const { project, query, onNewChannel, onNewDoc, onRenameDoc } = props;
  const conversations = useAppState((s) => s.conversations);
  const allDocs = useAppState((s) => s.docs);
  const activeId = useAppState((s) => s.activeId);
  const docOpen = useAppState((s) => s.docOpen);
  const boardOpen = useAppState((s) => s.boardOpen === project.id);
  const githubOpen = useAppState((s) => s.githubOpen);
  const github = useAppState((s) => s.github);
  const docsSeen = useAppState((s) => s.docsSeen);
  const meId = useAppState((s) => s.me?.id);
  const urgent = useAppState((s) => s.urgent);
  // Not from the filtered list, which a search may have left without #general.
  const generalId = useAppState((s) => generalOf(s, project.id)?.id);
  const owner = project.ownerId === meId;
  const q = query.trim().toLowerCase();

  const { channels, docs, boards } = useMemo(() => {
    const channels = Object.values(conversations)
      .filter((c) => c.type === 'channel' && c.projectId === project.id)
      .filter((c) => !q || (c.title ?? '').includes(q))
      .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
    const own = Object.values(allDocs).filter((d) => conversations[d.conversationId]?.projectId === project.id);
    const docs = own.filter((d) => !d.board && (!q || d.name.toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
    return { channels, docs, boards: own.filter((d) => d.board) };
  }, [conversations, allDocs, project.id, q]);

  const updated = (d: ChatDoc) => updatedSince(d, meId, docsSeen);
  const reviews = github?.pulls?.reviewRequested.length ?? 0;

  return (
    <div className="side-list">
      {!q && (
        <>
          <button
            type="button"
            className={`side-row ${boardOpen ? 'is-active' : ''}`}
            aria-current={boardOpen || undefined}
            onClick={() => actions.setBoardOpen(project.id)}
          >
            <BoardIcon width={18} height={18} />
            <span className="side-label">Board</span>
            {boards.some(updated) && <span className="side-dot" aria-label="Updated" role="img" />}
          </button>
          {github?.configured && (
            <button
              type="button"
              className={`side-row ${githubOpen ? 'is-active' : ''}`}
              aria-current={githubOpen || undefined}
              onClick={() => actions.setGithubOpen(true)}
            >
              <PullRequestIcon width={18} height={18} />
              <span className="side-label">Pull requests</span>
              {reviews > 0 && <span className="side-note">{reviews}</span>}
            </button>
          )}
        </>
      )}
      <div className="side-heading">
        <h3>Channels</h3>
        <button type="button" className="btn btn-icon sm" aria-label="New channel" title="New channel" onClick={onNewChannel}>
          <PlusIcon width={18} height={18} />
        </button>
      </div>
      {channels.map((c) => {
        const isActive = activeId === c.id;
        const hasUrgent = urgentIn(urgent, meId, c);
        const state = [isActive && 'is-active', loudUnread(c) > 0 && 'is-unread', hasUrgent && 'is-urgent'].filter(Boolean).join(' ');
        // #general stays as long as the project: its key opens the docs and the board (D-081).
        const deletable = owner && c.id !== generalId;
        return (
          <div key={c.id} className={`side-item ${state}`}>
            <button type="button" className="side-row" aria-current={isActive || undefined} onClick={() => void openConversation(c.id)}>
              <HashIcon width={18} height={18} className="side-icon" />
              <span className="side-label">{c.title}</span>
              {hasUrgent ? <span className="urgent-chip">URGENT</span> : <UnreadMark unread={c.unread} muted={c.muted} />}
            </button>
            {deletable && (
              <RowMenu
                name={`#${c.title}`}
                question={{
                  title: `Delete #${c.title} for everyone?`,
                  body: `Every message in it will be deleted for all members.${github?.appConfigured ? ' A repository linked to it will be unlinked.' : ''} This cannot be undone.`,
                }}
                onDelete={() => deleteChannel(project.id, c.id)}
              />
            )}
          </div>
        );
      })}
      {q && channels.length === 0 && docs.length === 0 && <p className="side-empty">No channels or docs match.</p>}
      <div className="side-heading">
        <h3>Docs</h3>
        <button type="button" className="btn btn-icon sm" aria-label="New doc" title="New doc" onClick={onNewDoc}>
          <PlusIcon width={18} height={18} />
        </button>
      </div>
      {docs.map((d) => {
        const isActive = docOpen === d.id;
        const isUpdated = updated(d);
        return (
          <div key={d.id} className={`side-item ${isActive ? 'is-active' : ''} ${isUpdated ? 'is-unread' : ''}`}>
            <button type="button" className="side-row" aria-current={isActive || undefined} onClick={() => actions.setDocOpen(d.id)}>
              <FileIcon width={18} height={18} />
              <span className="side-label">{d.name}</span>
              {isUpdated && <span className="side-dot" aria-label="Updated" role="img" />}
            </button>
            <RowMenu
              name={d.name}
              question={{
                title: `Delete “${d.name}” for everyone in the project?`,
                body: 'This cannot be undone.',
              }}
              onRename={() => onRenameDoc(d)}
              onDelete={d.createdBy === meId || owner ? () => deleteDoc(d.id) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

/** The sidebar's foot: Members opens upward, with each member's role and the ways to add and manage them. */
function MembersFoot({ project, onAddPeople, onMembers }: { project: ProjectDTO; onAddPeople: () => void; onMembers: () => void }) {
  const me = useAppState((s) => s.me);
  const users = useAppState((s) => s.users);
  const count = project.memberIds.length;
  const people = project.memberIds
    .map((id) => ({ id, user: id === me?.id ? me : users[id] }))
    .sort(
      (a, b) =>
        Number(b.id === project.ownerId) - Number(a.id === project.ownerId) ||
        (a.user?.displayName ?? '').localeCompare(b.user?.displayName ?? ''),
    );

  return (
    <div className="side-foot">
      <DropdownMenu
        placement="above"
        header={
          <div className="member-peek" aria-label={`${count} members`}>
            <p className="member-peek-label">
              {count} {count === 1 ? 'member' : 'members'}
            </p>
            {people.map(({ id, user }) => (
              <div key={id} className="member-peek-row">
                <Avatar name={user?.displayName ?? 'Someone'} seed={id} size={26} />
                <span className="member-peek-name">
                  {user?.displayName ?? 'Someone'}
                  {id === me?.id && <small>You</small>}
                </span>
                <small>{id === project.ownerId ? 'Owner' : user?.agentOwner != null ? 'Agent' : 'Member'}</small>
              </div>
            ))}
          </div>
        }
        renderTrigger={(trigger) => (
          <button {...trigger} type="button" className="side-row">
            <UsersIcon width={18} height={18} />
            <span className="side-label">Members</span>
            <span className="side-note">{count}</span>
          </button>
        )}
      >
        <DropdownMenuItem label="Add Member" icon={PlusIcon} onClick={onAddPeople} />
        <DropdownMenuDivider />
        <DropdownMenuItem label="Manage members" icon={<GearIcon />} onClick={onMembers} />
      </DropdownMenu>
    </div>
  );
}

/**
 * The "⋮" at the end of a doc's or channel's row: Rename, when it can be renamed, and Delete, for
 * those who may. Delete asks the question first, and shows a failure as a toast.
 */
function RowMenu(props: {
  name: string;
  question: { title: string; body: string };
  onRename?: () => void;
  onDelete?: () => Promise<void>;
}) {
  const { name, question, onRename, onDelete } = props;

  async function remove(run: () => Promise<void>) {
    if (!(await confirmAction({ ...question, confirmLabel: 'Delete' }))) return;
    try {
      await run();
    } catch (err) {
      actions.addToast({
        conversationId: null,
        title: name,
        body: (err as Error).message,
      });
    }
  }

  return (
    <DropdownMenu
      alignment="end"
      renderTrigger={(trigger) => (
        <button {...trigger} type="button" className="btn btn-icon sm side-more" aria-label={`Options for ${name}`} title="Options">
          <MoreIcon width={18} height={18} />
        </button>
      )}
      items={[
        ...(onRename
          ? [
              {
                label: 'Rename',
                icon: <PencilIcon width={16} height={16} />,
                onClick: onRename,
              },
            ]
          : []),
        ...(onDelete
          ? [
              {
                label: 'Delete',
                icon: <TrashIcon width={16} height={16} />,
                onClick: () => void remove(onDelete),
              },
            ]
          : []),
      ]}
    />
  );
}

const CLOSED_WARNING_KEY = 'webchat.closedWarning';

function closedWarning() {
  try {
    return localStorage.getItem(CLOSED_WARNING_KEY);
  } catch {
    return null;
  }
}

/** Nudges the user until alerts can reach them: notifications allowed and sound unlocked. */
function AlertSetupBanner({ onOpen }: { onOpen: () => void }) {
  const push = useAppState((s) => s.push);
  const bark = useAppState((s) => s.bark);
  const soundUnlocked = useSyncExternalStore(sound.subscribe, sound.unlocked);
  const [closed, setClosed] = useState(closedWarning);

  const text = push && shownWarning(notificationWarning(push, bark), closed);
  if (text) {
    return (
      <Banner
        // Each banner keeps its own closed state, so a new warning is not born closed.
        key={text}
        status="warning"
        container="section"
        title={text}
        endContent={<Button size="sm" label="Set up" onClick={onOpen} />}
        isDismissable
        dismissLabel="Hide this warning"
        onDismiss={() => {
          setClosed(text);
          try {
            localStorage.setItem(CLOSED_WARNING_KEY, text);
          } catch {
            // A private window shows it again on the next load; the account's dot stays either way.
          }
        }}
      />
    );
  }
  if (!soundUnlocked)
    return <Banner key="sound" status="info" container="section" title="Click anywhere on the page to enable alert sounds." />;
  return null;
}

/**
 * The divider between the sidebar and the pane: drag it, or focus it and press the arrow keys, to
 * size the sidebar between SIDE_MIN and SIDE_MAX pixels.
 */
export const SIDE_MIN = 220;
export const SIDE_MAX = 480;
export const clampSide = (w: number) => Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(w)));

export function SidebarResizer({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className="resizer"
      onPointerDown={(e) => {
        e.preventDefault();
        const x0 = e.clientX;
        const move = (ev: PointerEvent) => onChange(clampSide(width + ev.clientX - x0));
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
        if (!step) return;
        e.preventDefault();
        onChange(clampSide(width + step));
      }}
    />
  );
}
