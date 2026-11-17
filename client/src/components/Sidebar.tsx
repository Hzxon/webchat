import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
import { Stack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { AGENT_LEVEL, type ProjectDTO } from '../../../shared/types';
import { agentOf, ownAgents, proposalsWaiting, ready, THREAD_STATE, useAgentThreads } from '../agents';
import { sound } from '../alerts';
import { notificationWarning, shownWarning } from '../banner';
import { colorChoice, setColorChoice, subscribeColorMode, type ColorChoice } from '../colorMode';
import { deleteAccount, deleteChannel, openConversation, previewText, signOut } from '../chat';
import { deleteDoc } from '../docs';
import type { ChatConversation, ChatDoc } from '../e2ee/keyring';
import { actions, chatTitle, generalOf, loudUnread, otherMemberId, senderName, useAppState, type SidebarTab, type State } from '../store';
import { Avatar } from './Avatar';
import { formatListTime } from './format';
import {
  BellIcon,
  BellOffIcon,
  BellRingIcon,
  BoardIcon,
  ChatIcon,
  FileIcon,
  FolderIcon,
  GithubIcon,
  HashIcon,
  LogoutIcon,
  MoreIcon,
  PanelLeftIcon,
  PencilIcon,
  PlusIcon,
  PullRequestIcon,
  SearchIcon,
  TerminalIcon,
  Ticks,
  TrashIcon,
  UserPlusIcon,
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
  onCollapse: () => void;
}

/** Unread messages in a tab: channels count in Projects, every other chat in Chats. Muted chats count in neither. */
const unreadIn = (tab: SidebarTab) => (s: State) =>
  Object.values(s.conversations).reduce(
    (sum, c) => ((c.type === 'channel') === (tab === 'projects') ? sum + loudUnread(c) : sum),
    0,
  );

const newestFirst = (a: ChatConversation, b: ChatConversation) =>
  (b.lastMessage?.createdAt ?? b.updatedAt) - (a.lastMessage?.createdAt ?? a.updatedAt);

export function Sidebar(props: SidebarProps) {
  const {
    onNewChat,
    onNewProject,
    onNewChannel,
    onAddPeople,
    onMembers,
    onRepos,
    onNewDoc,
    onRenameDoc,
    onNotifications,
    onCollapse,
  } = props;
  const me = useAppState((s) => s.me);
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const projects = useAppState((s) => s.projects);
  const docs = useAppState((s) => s.docs);
  const tab = useAppState((s) => s.tab);
  const connected = useAppState((s) => s.connected);
  const [query, setQuery] = useState('');
  const theme = useSyncExternalStore(subscribeColorMode, colorChoice);

  const chatUnread = useAppState(unreadIn('chats'));
  const projectUnread = useAppState(unreadIn('projects'));
  const projectUpdated = useAppState((s) => Object.values(s.docs).some((d) => updatedSince(d, s.me?.id, s.docsSeen)));

  const { chats, channels } = useMemo(() => {
    const all = Object.values(conversations);
    const chats = all.filter((c) => c.type !== 'channel');
    // The chats with this user's agents show in their own pane (D-103), and count in the Chats tab.
    const listed = chats.filter((c) => !agentOf({ users, me }, c));
    const channels = all.filter((c) => c.type === 'channel');
    return { chats: listed, channels };
  }, [conversations, users, me]);

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

  async function removeAccount() {
    const warning =
      'You leave every project and group, your direct chats are deleted for both people, and your username is freed.';
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
    <aside className="sidebar">
      <Stack direction="horizontal" gap={2} vAlign="center" paddingInline={3} paddingBlock={2}>
        <IconButton
          className="collapse-button"
          variant="ghost"
          label="Collapse sidebar"
          tooltip="Collapse sidebar"
          onClick={onCollapse}
          icon={<PanelLeftIcon />}
        />
        <DropdownMenu
          renderTrigger={(trigger) => (
            <Button
              {...trigger}
              className="account-button"
              variant="ghost"
              label="Account"
              width="100%"
            >
              <Stack as="span" direction="horizontal" gap={2} vAlign="center">
                <Avatar name={me.displayName} seed={me.id} size={38} />
                <Stack as="span" gap={0} className="sidebar-me">
                  <Text weight="semibold" maxLines={1}>
                    {me.displayName}
                  </Text>
                  <Text color="secondary" type="supporting" maxLines={1}>
                    @{me.username}
                  </Text>
                </Stack>
              </Stack>
            </Button>
          )}
        >
          <DropdownMenuGroup title="Theme">
            <DropdownMenuRadioGroup
              label="Theme"
              value={theme}
              onChange={(value) => setColorChoice(value as ColorChoice)}
            >
              <DropdownMenuRadioItem value="system" label="System" />
              <DropdownMenuRadioItem value="light" label="Light" />
              <DropdownMenuRadioItem value="dark" label="Dark" />
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuDivider />
          <DropdownMenuItem label="Sign out" icon={LogoutIcon} onClick={() => void signOut()} />
          <DropdownMenuItem
            label="Delete account"
            variant="destructive"
            icon={TrashIcon}
            onClick={() => void removeAccount()}
          />
        </DropdownMenu>
        <NotificationBell onClick={onNotifications} />
        <IconButton
          variant="ghost"
          label={tab === 'projects' ? 'New project' : 'New chat'}
          tooltip={tab === 'projects' ? 'New project' : 'New chat'}
          onClick={tab === 'projects' ? onNewProject : onNewChat}
          icon={<PlusIcon />}
        />
      </Stack>
      <Divider />

      {!connected && <Banner status="info" container="section" title="Connecting…" />}
      <AlertSetupBanner onOpen={onNotifications} />

      <TabList
        value={tab}
        onChange={(value) => actions.setTab(value as 'chats' | 'projects')}
        layout="fill"
        hasDivider
        role="tablist"
      >
        <Tab
          value="chats"
          label="Chats"
          icon={<ChatIcon width={18} height={18} />}
          endContent={chatUnread > 0 && <Badge variant="info" label={chatUnread} />}
        />
        <Tab
          value="projects"
          label="Projects"
          icon={<FolderIcon width={18} height={18} />}
          endContent={
            projectUnread > 0 ? (
              <Badge variant="info" label={projectUnread} />
            ) : (
              projectUpdated && <StatusDot variant="accent" label="Updated" />
            )
          }
        />
      </TabList>

      <Stack padding={2}>
        <TextInput
          type="search"
          label={tab === 'projects' ? 'Search projects and channels' : 'Search chats'}
          isLabelHidden
          placeholder={tab === 'projects' ? 'Search projects and channels' : 'Search chats'}
          startIcon={SearchIcon}
          value={query}
          onChange={setQuery}
        />
      </Stack>

      <Stack className="sidebar-list">
        {tab === 'chats' ? (
          <>
            <List>
              {!query && <GithubListItem />}
              {!query && <AgentsListItem />}
              {sorted.map((c) => (
                <ChatListItem key={c.id} conversation={c} />
              ))}
            </List>
            {sorted.length === 0 && (
              <Stack padding={6}>
                <Text color="secondary" justify="center">
                  {query ? 'No chats match.' : 'No chats yet. Press + to message a friend.'}
                </Text>
              </Stack>
            )}
          </>
        ) : (
          <>
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
                <Stack padding={6}>
                  <Text color="secondary" justify="center">
                    No projects or channels match.
                  </Text>
                </Stack>
              ) : (
                <Stack padding={6} gap={4} hAlign="center">
                  <Text as="p" color="secondary" justify="center">
                    A project gives a team its own channels, like #general for planning and #design for drafts. Everyone
                    in the project can read every channel.
                  </Text>
                  <Button variant="primary" label="New project" onClick={onNewProject} />
                </Stack>
              ))}
          </>
        )}
      </Stack>
    </aside>
  );
}

function NotificationBell({ onClick }: { onClick: () => void }) {
  const ready = useAppState((s) => s.push?.permission === 'granted');
  return (
    <IconButton
      variant="ghost"
      label="Notification settings"
      tooltip="Notification settings"
      onClick={onClick}
      icon={
        ready ? (
          <BellRingIcon />
        ) : (
          <span className="bell-warn">
            <BellIcon />
            <span className="dot" />
          </span>
        )
      }
    />
  );
}

/** The collapsed sidebar on a wide screen: a tab's button opens the sidebar on that tab. Unread shows as a dot. */
export function SidebarRail({ onExpand, onNotifications }: { onExpand: () => void; onNotifications: () => void }) {
  return (
    <Stack as="aside" className="sidebar-rail" gap={1} padding={2} hAlign="center">
      <IconButton variant="ghost" label="Expand sidebar" tooltip="Expand sidebar" onClick={onExpand} icon={<PanelLeftIcon />} />
      <RailTab tab="chats" label="Chats" icon={<ChatIcon />} onExpand={onExpand} />
      <RailTab tab="projects" label="Projects" icon={<FolderIcon />} onExpand={onExpand} />
      <NotificationBell onClick={onNotifications} />
    </Stack>
  );
}

function RailTab({ tab, label, icon, onExpand }: { tab: SidebarTab; label: string; icon: ReactNode; onExpand: () => void }) {
  const unread = useAppState(unreadIn(tab)) > 0;
  return (
    <IconButton
      variant="ghost"
      label={unread ? `${label}, unread messages` : label}
      tooltip={label}
      onClick={() => {
        actions.setTab(tab);
        onExpand();
      }}
      icon={
        <span className="icon-dot">
          {icon}
          {unread && <span className="dot" />}
        </span>
      }
    />
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
  const { project, channels, docs, boards, onNewChannel, onAddPeople, onMembers, onRepos, onNewDoc, onRenameDoc } =
    props;
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
  const updated = (d: ChatDoc) => updatedSince(d, meId, docsSeen);
  const boardUpdated = boards.some(updated);

  return (
    <Stack as="section" className="project" gap={0.5} paddingBlock={2}>
      <ListItem
        startContent={<Avatar name={project.name} seed={project.id + 5} size={34} square />}
        label={project.name}
        description={`${people} ${people === 1 ? 'member' : 'members'}`}
        endContent={
          <Stack direction="horizontal" gap={0.5}>
            <DropdownMenu
              alignment="end"
              renderTrigger={(trigger) => (
                <IconButton
                  {...trigger}
                  variant="ghost"
                  size="sm"
                  label={`Add to ${project.name}`}
                  tooltip="Add"
                  icon={<PlusIcon width={18} height={18} />}
                />
              )}
              items={[
                {
                  label: 'New channel',
                  icon: <HashIcon width={16} height={16} />,
                  onClick: onNewChannel,
                },
                {
                  label: 'New doc',
                  icon: <FileIcon width={16} height={16} />,
                  onClick: onNewDoc,
                },
              ]}
            />
            <DropdownMenu
              alignment="end"
              renderTrigger={(trigger) => (
                <IconButton
                  {...trigger}
                  variant="ghost"
                  size="sm"
                  label={`Options for ${project.name}`}
                  tooltip="Options"
                  icon={<MoreIcon width={18} height={18} />}
                />
              )}
              items={[
                {
                  label: 'Members',
                  icon: <UsersIcon width={16} height={16} />,
                  onClick: onMembers,
                },
                {
                  label: 'Add people',
                  icon: <UserPlusIcon width={16} height={16} />,
                  onClick: onAddPeople,
                },
                ...(github
                  ? [
                      {
                        label: 'GitHub repositories',
                        icon: <GithubIcon width={16} height={16} />,
                        onClick: onRepos,
                      },
                    ]
                  : []),
              ]}
            />
          </Stack>
        }
      />
      <List density="compact">
        {channels.map((c) => {
          const hasUrgent = urgent.some((m) => m.conversationId === c.id);
          // #general stays as long as the project: its key opens the docs and the board (D-081).
          const deletable = owner && c.id !== generalId;
          return (
            <ListItem
              key={c.id}
              className={rowClass(loudUnread(c) > 0, hasUrgent)}
              startContent={<HashIcon width={16} height={16} />}
              label={c.title ?? ''}
              isSelected={activeId === c.id}
              onClick={() => void openConversation(c.id)}
              endContent={
                (hasUrgent || c.unread > 0 || c.muted || deletable) && (
                  <Stack direction="horizontal" gap={1} vAlign="center">
                    {hasUrgent && <Badge variant="error" label="URGENT" />}
                    <UnreadMark unread={c.unread} muted={c.muted} />
                    {deletable && (
                      <RowMenu
                        name={`#${c.title}`}
                        question={{
                          title: `Delete #${c.title} for everyone?`,
                          body: `Every message in it will be deleted for all members.${github ? ' A repository linked to it will be unlinked.' : ''} This cannot be undone.`,
                        }}
                        onDelete={() => deleteChannel(project.id, c.id)}
                      />
                    )}
                  </Stack>
                )
              }
            />
          );
        })}
        <ListItem
          className={rowClass(boardUpdated)}
          startContent={<BoardIcon width={16} height={16} />}
          label="Board"
          isSelected={boardOpen === project.id}
          onClick={() => actions.setBoardOpen(project.id)}
          endContent={boardUpdated && <StatusDot variant="accent" label="Updated" />}
        />
        {docs.map((d) => {
          const isUpdated = updated(d);
          return (
            <ListItem
              key={d.id}
              className={rowClass(isUpdated)}
              startContent={<FileIcon width={16} height={16} />}
              label={d.name}
              isSelected={docOpen === d.id}
              onClick={() => actions.setDocOpen(d.id)}
              endContent={
                <Stack direction="horizontal" gap={1} vAlign="center">
                  {isUpdated && <StatusDot variant="accent" label="Updated" />}
                  <RowMenu
                    name={d.name}
                    question={{
                      title: `Delete “${d.name}” for everyone in the project?`,
                      body: 'This cannot be undone.',
                    }}
                    onRename={() => onRenameDoc(d)}
                    onDelete={d.createdBy === meId || owner ? () => deleteDoc(d.id) : undefined}
                  />
                </Stack>
              }
            />
          );
        })}
      </List>
      <Divider />
    </Stack>
  );
}

/** Someone else saved the doc since this device last showed it: a row's dot, and the Projects tab's. */
const updatedSince = (d: ChatDoc, meId: number | undefined, docsSeen: State['docsSeen']) =>
  d.updatedBy !== meId && d.version > (docsSeen[d.id] ?? 0);

/** Bold for something new, and the red row for an urgent message, which Astryx's rows have no prop for. */
const rowClass = (unread: boolean, urgent = false) =>
  [unread && 'row-unread', urgent && 'row-urgent'].filter(Boolean).join(' ') || undefined;

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
        <IconButton
          {...trigger}
          variant="ghost"
          size="sm"
          label={`Options for ${name}`}
          tooltip="Options"
          icon={<MoreIcon width={18} height={18} />}
        />
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
            // A private window shows it again on the next load; the bell's dot stays either way.
          }
        }}
      />
    );
  }
  if (!soundUnlocked)
    return (
      <Banner
        key="sound"
        status="info"
        container="section"
        title="Click anywhere on the page to enable alert sounds."
      />
    );
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
    <ListItem
      startContent={
        <span className="github-mark">
          <PullRequestIcon />
        </span>
      }
      label="Pull requests"
      description={preview}
      isSelected={open}
      onClick={() => actions.setGithubOpen(true)}
      endContent={
        <Stack gap={1} hAlign="end">
          {github.account && (
            <Text type="supporting" color="secondary">
              @{github.account.login}
            </Text>
          )}
          {waiting > 0 && <Badge variant="info" label={waiting} />}
        </Stack>
      }
    />
  );
}

/** The Coding agents row, where agents connect too (D-103). Its unread count is their agents' chats'. */
function AgentsListItem() {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const open = useAppState((s) => s.agentsOpen);
  const agents = useMemo(() => ownAgents(users, meId), [users, meId]);
  const { chats, threads } = useAgentThreads();
  const newest = threads[0];
  const unread = chats.reduce((sum, c) => sum + c.unread, 0);
  const waiting = proposalsWaiting(threads);
  // A laptop that serves every folder is online with or without one (R-036).
  const online = agents.some((agent) =>
    agent.protocol >= AGENT_LEVEL.answers ? agent.online : agent.agentRepos.some(ready),
  );

  return (
    <ListItem
      className={rowClass(unread > 0)}
      startContent={
        <span className="github-mark agents-mark">
          <TerminalIcon />
          {online && <span className="avatar-online" aria-label="online" />}
        </span>
      }
      label="Coding agents"
      description={
        waiting > 0
          ? `${waiting} ${waiting === 1 ? 'proposal waits' : 'proposals wait'} for the board`
          : newest
            ? `${THREAD_STATE[newest.state].label} · ${newest.messages[0]!.text}`
            : agents.length
              ? 'Ask about your code'
              : 'Connect your coding agent'
      }
      isSelected={open}
      onClick={() => actions.setAgentsOpen(true)}
      endContent={<ListEnd time={newest?.last} unread={unread} />}
    />
  );
}

/** A row's time and unread count, stacked at its end. */
function ListEnd({ time, unread, muted = false }: { time?: number; unread: number; muted?: boolean }) {
  if (time === undefined && unread === 0 && !muted) return null;
  const loud = unread > 0 && !muted;
  return (
    <Stack gap={1} hAlign="end">
      {time !== undefined && (
        <Text type="supporting" color={loud ? 'accent' : 'secondary'} weight={loud ? 'semibold' : undefined}>
          {formatListTime(time)}
        </Text>
      )}
      {(unread > 0 || muted) && (
        <Stack direction="horizontal" gap={1} vAlign="center">
          <UnreadMark unread={unread} muted={muted} />
        </Stack>
      )}
    </Stack>
  );
}

/** A muted chat keeps its own unread count, in a quieter badge beside the muted bell. */
function UnreadMark({ unread, muted }: { unread: number; muted: boolean }) {
  return (
    <>
      {muted && (
        <Text type="supporting" color="secondary">
          <BellOffIcon width={14} height={14} role="img" aria-hidden={false} aria-label="Muted" />
        </Text>
      )}
      {unread > 0 && <Badge variant={muted ? 'neutral' : 'info'} label={unread} />}
    </>
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
    const prefix = conversation.type !== 'direct' && !mine ? `${senderName(users, last.senderId).split(' ')[0]}: ` : '';
    preview = (
      <Stack direction="horizontal" gap={1} vAlign="center">
        {mine && <Ticks state={receiptState(conversation, last.id, meId)} />}
        {last.urgent && <Badge variant="error" label="URGENT" />}
        <Text color="secondary" maxLines={1}>
          {prefix}
          {previewText(last)}
        </Text>
      </Stack>
    );
  }

  return (
    <ListItem
      className={rowClass(loudUnread(conversation) > 0, hasUrgent)}
      startContent={<Avatar name={title} seed={otherId ?? conversation.id + 3} size={36} online={other?.online} />}
      label={title}
      description={preview}
      isSelected={activeId === conversation.id}
      onClick={() => void openConversation(conversation.id)}
      endContent={<ListEnd time={last?.createdAt} unread={conversation.unread} muted={conversation.muted} />}
    />
  );
}
