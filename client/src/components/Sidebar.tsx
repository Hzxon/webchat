import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ProjectDTO } from '../../../shared/types';
import { sound } from '../alerts';
import { deleteAccount, deleteChannel, openConversation, previewText, signOut } from '../chat';
import { deleteDoc } from '../docs';
import type { ChatConversation, ChatDoc } from '../e2ee/keyring';
import { actions, chatTitle, generalOf, otherMemberId, senderName, useAppState } from '../store';
import { Avatar } from './Avatar';
import { formatListTime } from './format';
import {
  BellIcon,
  BellRingIcon,
  BoardIcon,
  ChatIcon,
  FileIcon,
  FolderIcon,
  GithubIcon,
  HashIcon,
  LogoutIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  PullRequestIcon,
  SearchIcon,
  Ticks,
  TrashIcon,
  UserPlusIcon,
  UsersIcon,
} from './icons';
import { receiptState } from './receipts';

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

const newestFirst = (a: ChatConversation, b: ChatConversation) =>
  (b.lastMessage?.createdAt ?? b.updatedAt) - (a.lastMessage?.createdAt ?? a.updatedAt);

export function Sidebar(props: SidebarProps) {
  const { onNewChat, onNewProject, onNewChannel, onAddPeople, onMembers, onRepos, onNewDoc, onRenameDoc, onNotifications } = props;
  const me = useAppState((s) => s.me);
  const conversations = useAppState((s) => s.conversations);
  const projects = useAppState((s) => s.projects);
  const docs = useAppState((s) => s.docs);
  const tab = useAppState((s) => s.tab);
  const connected = useAppState((s) => s.connected);
  const push = useAppState((s) => s.push);
  const [query, setQuery] = useState('');

  const { chats, channels, chatUnread, projectUnread } = useMemo(() => {
    const all = Object.values(conversations);
    const chats = all.filter((c) => c.type !== 'channel');
    const channels = all.filter((c) => c.type === 'channel');
    const total = (list: ChatConversation[]) => list.reduce((sum, c) => sum + c.unread, 0);
    return { chats, channels, chatUnread: total(chats), projectUnread: total(channels) };
  }, [conversations]);

  const q = query.trim().toLowerCase();
  const sorted = useMemo(
    () => chats.filter((c) => !q || chatTitle(c).toLowerCase().includes(q)).sort(newestFirst),
    [chats, q],
  );

  /** Projects A to Z, each with its channels and docs A to Z. A search matches project, channel or doc names. */
  const projectList = useMemo(() => {
    const byProject = new Map<number, ChatConversation[]>();
    for (const c of channels) byProject.set(c.projectId!, [...(byProject.get(c.projectId!) ?? []), c]);
    const docsBy = new Map<number, ChatDoc[]>();
    const boardsBy = new Map<number, ChatDoc[]>();
    for (const d of Object.values(docs)) {
      const projectId = conversations[d.conversationId]?.projectId;
      const by = d.board ? boardsBy : docsBy;
      if (projectId) by.set(projectId, [...(by.get(projectId) ?? []), d]);
    }
    return Object.values(projects)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => {
        const own = (byProject.get(project.id) ?? []).sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
        const ownDocs = (docsBy.get(project.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
        const projectMatches = !q || project.name.toLowerCase().includes(q);
        return {
          project,
          channels: projectMatches ? own : own.filter((c) => (c.title ?? '').includes(q)),
          docs: projectMatches ? ownDocs : ownDocs.filter((d) => d.name.toLowerCase().includes(q)),
          boards: boardsBy.get(project.id) ?? [],
        };
      })
      .filter((entry) => entry.channels.length > 0 || entry.docs.length > 0 || !q);
  }, [projects, channels, docs, conversations, q]);

  if (!me) return null;
  const notificationsReady = push?.permission === 'granted';

  async function removeAccount() {
    const warning = 'You leave every project and group, your direct chats are deleted for both people, and your username is freed.';
    if (!confirm(`Delete your account? ${warning} This cannot be undone.`)) return;
    try {
      await deleteAccount();
    } catch (err) {
      actions.addToast({ conversationId: null, title: 'Delete account', body: (err as Error).message });
    }
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <Avatar name={me.displayName} seed={me.id} size={38} />
        <div className="sidebar-me">
          <strong>{me.displayName}</strong>
          <span>@{me.username}</span>
        </div>
        <button
          className={`icon-button ${notificationsReady ? '' : 'icon-button-warn'}`}
          onClick={onNotifications}
          title="Notification settings"
          aria-label="Notification settings"
        >
          {notificationsReady ? <BellRingIcon /> : <BellIcon />}
          {!notificationsReady && <span className="dot" />}
        </button>
        <button
          className="icon-button"
          onClick={tab === 'projects' ? onNewProject : onNewChat}
          title={tab === 'projects' ? 'New project' : 'New chat'}
          aria-label={tab === 'projects' ? 'New project' : 'New chat'}
        >
          <PlusIcon />
        </button>
        <button className="icon-button" onClick={() => void signOut()} title="Sign out" aria-label="Sign out">
          <LogoutIcon />
        </button>
        <button className="icon-button" onClick={() => void removeAccount()} title="Delete account" aria-label="Delete account">
          <TrashIcon />
        </button>
      </header>

      {!connected && <div className="connection-bar">Connecting…</div>}
      <AlertSetupBanner onOpen={onNotifications} />

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chats'} onClick={() => actions.setTab('chats')}>
          <ChatIcon width={18} height={18} />
          Chats
          {chatUnread > 0 && <span className="tab-count">{chatUnread}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'projects'} onClick={() => actions.setTab('projects')}>
          <FolderIcon width={18} height={18} />
          Projects
          {projectUnread > 0 && <span className="tab-count">{projectUnread}</span>}
        </button>
      </div>

      <label className="search">
        <SearchIcon width={18} height={18} />
        <input
          placeholder={tab === 'projects' ? 'Search projects and channels' : 'Search chats'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {tab === 'chats' ? (
        <ul className="chat-list">
          {!query && <GithubListItem />}
          {sorted.map((c) => (
            <ChatListItem key={c.id} conversation={c} />
          ))}
          {sorted.length === 0 && (
            <li className="chat-list-empty">
              {query ? 'No chats match.' : 'No chats yet. Press + to message a friend.'}
            </li>
          )}
        </ul>
      ) : (
        <ul className="chat-list">
          {projectList.map(({ project, channels, docs, boards }) => (
            <ProjectSection
              key={project.id}
              project={project}
              channels={channels}
              docs={docs}
              boards={boards}
              onNewChannel={() => onNewChannel(project.id)}
              onAddPeople={() => onAddPeople(project.id)}
              onMembers={() => onMembers(project.id)}
              onRepos={() => onRepos(project.id)}
              onNewDoc={() => onNewDoc(project.id)}
              onRenameDoc={onRenameDoc}
            />
          ))}
          {projectList.length === 0 &&
            (query ? (
              <li className="chat-list-empty">No projects or channels match.</li>
            ) : (
              <li className="chat-list-empty projects-empty">
                <p>
                  A project gives a team its own channels, like #general for planning and #design for drafts. Everyone in
                  the project can read every channel.
                </p>
                <button className="button-primary" onClick={onNewProject}>
                  New project
                </button>
              </li>
            ))}
        </ul>
      )}
    </aside>
  );
}

function ProjectSection(props: {
  project: ProjectDTO;
  channels: ChatConversation[];
  docs: ChatDoc[];
  /** The docs behind the project board (R-021), for its updated dot. */
  boards: ChatDoc[];
  onNewChannel: () => void;
  onAddPeople: () => void;
  onMembers: () => void;
  onRepos: () => void;
  onNewDoc: () => void;
  onRenameDoc: (doc: ChatDoc) => void;
}) {
  const { project, channels, docs, boards, onNewChannel, onAddPeople, onMembers, onRepos, onNewDoc, onRenameDoc } = props;
  const activeId = useAppState((s) => s.activeId);
  const docOpen = useAppState((s) => s.docOpen);
  const boardOpen = useAppState((s) => s.boardOpen);
  const docsSeen = useAppState((s) => s.docsSeen);
  const meId = useAppState((s) => s.me?.id);
  const urgent = useAppState((s) => s.urgent);
  // Linking a repository only does something where the GitHub App is set up.
  const github = useAppState((s) => s.github?.appConfigured ?? false);
  // Not from `channels`, which a search may have left without #general.
  const generalId = useAppState((s) => generalOf(s, project.id)?.id);
  const owner = project.ownerId === meId;
  const people = project.memberIds.length;
  /** Someone else saved it since this device last showed it. */
  const updatedSince = (d: ChatDoc) => d.updatedBy !== meId && d.version > (docsSeen[d.id] ?? 0);
  const boardUpdated = boards.some(updatedSince);

  return (
    <li className="project">
      <div className="project-header">
        <Avatar name={project.name} seed={project.id + 5} size={34} square />
        <span className="project-name">
          <strong>{project.name}</strong>
          <small>
            {people} {people === 1 ? 'member' : 'members'}
          </small>
        </span>
        <button className="icon-button icon-button-small" onClick={onMembers} title="Members" aria-label={`Members of ${project.name}`}>
          <UsersIcon width={18} height={18} />
        </button>
        <button className="icon-button icon-button-small" onClick={onAddPeople} title="Add people" aria-label={`Add people to ${project.name}`}>
          <UserPlusIcon width={18} height={18} />
        </button>
        {github && (
          <button className="icon-button icon-button-small" onClick={onRepos} title="GitHub repositories" aria-label={`GitHub repositories of ${project.name}`}>
            <GithubIcon width={18} height={18} />
          </button>
        )}
        <button className="icon-button icon-button-small" onClick={onNewChannel} title="New channel" aria-label={`New channel in ${project.name}`}>
          <PlusIcon width={18} height={18} />
        </button>
      </div>
      <ul className="channel-list">
        {channels.map((c) => {
          const hasUrgent = urgent.some((m) => m.conversationId === c.id);
          // #general stays as long as the project: its key opens the docs and the board (D-081).
          const deletable = owner && c.id !== generalId;
          return (
            <li key={c.id} className={deletable ? 'menu-row' : undefined}>
              <button
                className={`channel-item ${activeId === c.id ? 'is-active' : ''} ${c.unread > 0 ? 'has-unread' : ''} ${hasUrgent ? 'is-urgent' : ''}`}
                onClick={() => void openConversation(c.id)}
              >
                <HashIcon width={16} height={16} />
                <span className="channel-name">{c.title}</span>
                {hasUrgent && <span className="urgent-chip">URGENT</span>}
                {c.unread > 0 && <span className="unread-badge">{c.unread}</span>}
              </button>
              {deletable && (
                <RowMenu
                  name={`#${c.title}`}
                  question={`Delete #${c.title} for everyone? Every message in it will be deleted for all members.${github ? ' A repository linked to it will be unlinked.' : ''} This cannot be undone.`}
                  onDelete={() => deleteChannel(project.id, c.id)}
                />
              )}
            </li>
          );
        })}
        <li>
          <button
            className={`channel-item ${boardOpen === project.id ? 'is-active' : ''} ${boardUpdated ? 'has-unread' : ''}`}
            onClick={() => actions.setBoardOpen(project.id)}
          >
            <BoardIcon width={16} height={16} />
            <span className="channel-name">Board</span>
            {boardUpdated && <span className="doc-dot" aria-label="Updated" />}
          </button>
        </li>
        {docs.map((d) => {
          const updated = updatedSince(d);
          return (
            <li key={d.id} className="menu-row">
              <button
                className={`channel-item ${docOpen === d.id ? 'is-active' : ''} ${updated ? 'has-unread' : ''}`}
                onClick={() => actions.setDocOpen(d.id)}
              >
                <FileIcon width={16} height={16} />
                <span className="channel-name">{d.name}</span>
                {updated && <span className="doc-dot" aria-label="Updated" />}
              </button>
              <RowMenu
                name={d.name}
                question={`Delete “${d.name}” for everyone in the project? This cannot be undone.`}
                onRename={() => onRenameDoc(d)}
                onDelete={d.createdBy === meId || owner ? () => deleteDoc(d.id) : undefined}
              />
            </li>
          );
        })}
        <li>
          <button className="channel-item channel-add" onClick={onNewDoc}>
            <PlusIcon width={16} height={16} />
            <span className="channel-name">New doc</span>
          </button>
        </li>
      </ul>
    </li>
  );
}

/**
 * The "⋮" at the end of a doc's or channel's row: Rename, when it can be renamed, and Delete, for
 * those who may. Delete asks the question first, and shows a failure as a toast.
 */
function RowMenu(props: { name: string; question: string; onRename?: () => void; onDelete?: () => Promise<void> }) {
  const { name, question, onRename, onDelete } = props;
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  // A press outside the menu, or Escape, closes it.
  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => menu.current?.contains(e.target as Node) || setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onPress);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPress);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function remove(run: () => Promise<void>) {
    if (!confirm(question)) return;
    try {
      await run();
    } catch (err) {
      actions.addToast({ conversationId: null, title: name, body: (err as Error).message });
    }
  }

  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="menu" ref={menu}>
      <button
        className="icon-button icon-button-small"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Options for ${name}`}
        title="Options"
      >
        <MoreIcon width={18} height={18} />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {onRename && (
            <button role="menuitem" onClick={pick(onRename)}>
              <PencilIcon width={16} height={16} /> Rename
            </button>
          )}
          {onDelete && (
            <button role="menuitem" className="is-danger" onClick={pick(() => void remove(onDelete))}>
              <TrashIcon width={16} height={16} /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Nudges the user until alerts can reach them: notifications allowed and sound unlocked. */
function AlertSetupBanner({ onOpen }: { onOpen: () => void }) {
  const push = useAppState((s) => s.push);
  const soundUnlocked = useSyncExternalStore(sound.subscribe, sound.unlocked);

  if (push && push.permission !== 'granted') {
    const text =
      push.permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser’s site settings.'
        : push.oldIos
          ? 'Notifications on iPhone need iOS 16.4. Tap to get alerts through the Bark app instead.'
          : push.needsInstall
            ? 'On iPhone, add this site to your Home Screen to get notifications.'
            : 'Turn on notifications so urgent messages reach you when this tab is closed.';
    return (
      <button className="banner banner-warn" onClick={onOpen}>
        <BellIcon width={18} height={18} />
        <span>{text}</span>
      </button>
    );
  }
  if (!soundUnlocked) {
    return (
      <div className="banner">
        <span>Click anywhere on the page to enable alert sounds.</span>
      </div>
    );
  }
  return null;
}

/** Opens the pull requests pane. Shown once the server owner has set up the GitHub connector. */
function GithubListItem() {
  const github = useAppState((s) => s.github);
  const open = useAppState((s) => s.githubOpen);
  if (!github?.configured) return null;

  const waiting = github.pulls?.reviewRequested.length ?? 0;
  let preview = 'Connect GitHub to follow your pull requests';
  if (github.reconnect) preview = 'Connect GitHub again';
  else if (github.account && !github.pulls) preview = github.error ?? 'Loading pull requests…';
  else if (github.pulls) {
    const mine = github.pulls.authored.length;
    preview = `${waiting > 0 ? `${waiting} waiting for your review` : 'No reviews waiting'} · ${mine} of yours open`;
  }

  return (
    <li>
      <button className={`chat-item ${open ? 'is-active' : ''}`} onClick={() => actions.setGithubOpen(true)}>
        <span className="github-mark">
          <PullRequestIcon />
        </span>
        <span className="chat-item-main">
          <span className="chat-item-row">
            <strong className="chat-item-title">Pull requests</strong>
            {github.account && <time>@{github.account.login}</time>}
          </span>
          <span className="chat-item-row">
            <span className="chat-item-preview">{preview}</span>
            {waiting > 0 && <span className="unread-badge">{waiting}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

function ChatListItem({ conversation }: { conversation: ChatConversation }) {
  const meId = useAppState((s) => s.me?.id);
  const users = useAppState((s) => s.users);
  const activeId = useAppState((s) => s.activeId);
  const urgent = useAppState((s) => s.urgent);

  const title = chatTitle(conversation);
  const otherId = otherMemberId(conversation, meId);
  const other = otherId === undefined ? undefined : users[otherId];
  const last = conversation.lastMessage;
  const hasUrgent = urgent.some((m) => m.conversationId === conversation.id);

  let preview: ReactNode = 'No messages yet';
  if (last) {
    const mine = last.senderId === meId;
    const prefix =
      conversation.type !== 'direct' && !mine ? `${senderName(users, last.senderId).split(' ')[0]}: ` : '';
    preview = (
      <>
        {mine && <Ticks state={receiptState(conversation, last.id, meId)} />}
        {last.urgent && <span className="urgent-chip">URGENT</span>}
        {prefix}
        {previewText(last)}
      </>
    );
  }

  return (
    <li>
      <button
        className={`chat-item ${activeId === conversation.id ? 'is-active' : ''} ${hasUrgent ? 'is-urgent' : ''}`}
        onClick={() => void openConversation(conversation.id)}
      >
        <Avatar name={title} seed={otherId ?? conversation.id + 3} online={other?.online} />
        <span className="chat-item-main">
          <span className="chat-item-row">
            <strong className="chat-item-title">{title}</strong>
            {last && (
              <time className={conversation.unread > 0 ? 'has-unread' : ''}>{formatListTime(last.createdAt)}</time>
            )}
          </span>
          <span className="chat-item-row">
            <span className="chat-item-preview">{preview}</span>
            {conversation.unread > 0 && <span className="unread-badge">{conversation.unread}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}
