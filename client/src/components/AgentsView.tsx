// The Coding agents window (R-035, D-103): a sidebar of what waits for the user, their projects with
// each one's conversations and card runs, and those in no project, beside the open conversation or
// a new question. A conversation is a prompt and the messages that name it, in the user's direct
// chat with the agent (D-102). On a phone the list, a conversation and a new question each take the
// whole screen.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AGENT_LEVEL, asksAnywhere, listsSessions, type PermissionMode, type UserDTO } from '../../../shared/types';
import {
  asleep,
  blockedBy,
  ownAgents,
  seatFor,
  short,
  THREAD_STATE,
  threadCard,
  threadProject,
  useAgentThreads,
  type Seat,
  type Thread,
} from '../agents';
import { askAgent, forgetFolder, loadChat, loadOlder, pickFolder, putToSleep } from '../chat';
import type { ChatConversation } from '../e2ee/keyring';
import { useLinkedRepos } from '../linkedRepos';
import { actions, useAppState } from '../store';
import { BackIcon, BellIcon, CloseIcon, FolderIcon, NewChatIcon, PlusIcon, SearchIcon } from './icons';
import { AgentBrief } from './AgentBrief';
import { AgentDialog } from './AgentDialog';
import { AgentAsks } from './AgentAsks';
import { AgentSetup } from './AgentSetup';
import { AgentThread, Box, LaptopIcon, BranchIcon } from './AgentThread';
import { TerminalSessions } from './TerminalSessions';
import { effortsOf, ModelButton, useHarnessPick } from './HarnessPicker';
import { Popover, SetupButton } from './SessionControls';

/** Where the agent stands on a folder it has, as Add folder lists it (R-038). */
function folderState(seat: Seat | undefined): [string, boolean?] {
  if (!seat || seat.protocol < AGENT_LEVEL.answers) return ['Plugin too old'];
  if (!seat.online) return ['Asleep'];
  return seat.noFolder ? ['No copy yet'] : ['Ready', true];
}

/** A conversation's line in the sidebar: a card by its id and title, anything else by its first words. */
const titleOf = (t: Thread) => t.messages[0]!.text.replace(/^Run /, '');

/** States that wait for the user: a question, a review's go, a plan's go, or a draft to add. */
const WAITS: ReadonlySet<Thread['state']> = new Set(['asking', 'waiting', 'planned']);

export function AgentsView() {
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const open = useAppState((s) => s.agentThread);
  const brief = useAppState((s) => s.agentBrief);
  const { chats, threads } = useAgentThreads();
  const agents = useMemo(() => ownAgents(users, meId), [users, meId]);
  const thread = threads.find((t) => t.root === open);
  const [dialog, setDialog] = useState<'connect' | 'settings' | null>(null);
  // A new question: the main pane's default on a wide screen, a screen of its own on a phone.
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (open || brief) setComposing(false);
  }, [open, brief]);
  const agentOf = (t: Thread) => agents.find((a) => conversations[t.conversationId]?.members.some((m) => m.userId === a.id));
  // Where a conversation is answered: its agent's folder of the repository its prompt names, or its laptop.
  const seatOf = (t: Thread) => {
    const agent = agentOf(t);
    return agent && seatFor(agent, t.repo);
  };

  // The window shows every chat with an agent, so it loads them, and they count as read while it shows.
  const ids = chats.map((c) => c.id).join();
  useEffect(() => {
    for (const id of ids.split(',').filter(Boolean)) void loadChat(Number(id));
  }, [ids]);

  const back = () => {
    setComposing(false);
    actions.setAgentsOpen(true);
  };
  const shown = thread ? 'thread' : brief ? 'brief' : composing ? 'new' : null;
  const [width, setWidth] = useState(300);
  const resize = (w: number) => setWidth(Math.max(220, Math.min(480, w)));
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => resize(w0 + ev.clientX - x0);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <section className={`chat agents-window${shown ? ' is-main' : ''}`} style={{ '--agents-side': `${width}px` } as React.CSSProperties}>
      <AgentsSidebar
        threads={threads}
        chats={chats}
        agents={agents}
        selected={thread?.root ?? (brief ? '' : 'new')}
        onNew={() => {
          actions.setAgentsOpen(true);
          setComposing(true);
        }}
        onConnect={() => setDialog('connect')}
        onSettings={() => setDialog('settings')}
      />
      <div
        className="agents-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={220}
        aria-valuemax={480}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
          if (d) {
            e.preventDefault();
            resize(width + d);
          }
        }}
      />
      <div className="agents-main">
        {thread ? (
          <>
            <ThreadHead thread={thread} agent={agentOf(thread)} onBack={back} />
            <AgentThread
              key={thread.root}
              thread={thread}
              details
              seat={seatOf(thread)}
              agentId={conversations[thread.conversationId]?.members.find((m) => m.userId !== meId)?.userId ?? 0}
            />
          </>
        ) : brief ? (
          <>
            <header className="agents-head">
              <span className="agents-back"><IconButton variant="ghost" label="Back to the list" icon={<BackIcon />} onClick={back} /></span>
              <div className="agents-head-text">
                <strong>Before it starts</strong>
              </div>
            </header>
            <AgentBrief brief={brief} />
          </>
        ) : agents.length === 0 ? (
          <div className="agents-new">
            <h1>Connect your coding agent</h1>
            <p className="agents-empty">
              Your coding agent is Claude Code, Codex or another harness on your laptop. It answers your questions about
              your team’s code and works on the roadmap cards you hand it.
            </p>
            <Button variant="primary" label="Connect agent" onClick={() => setDialog('connect')} />
          </div>
        ) : (
          <NewChat threads={threads} onClose={back} />
        )}
      </div>
      {dialog === 'connect' && <AgentDialog onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <AgentSetup onClose={() => setDialog(null)} />}
    </section>
  );
}

/** The open conversation's head: its title, where it runs, and its card on the board. */
function ThreadHead({ thread, agent, onBack }: { thread: Thread; agent: UserDTO | undefined; onBack: () => void }) {
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const card = thread.kind === 'card' ? threadCard(thread, docs, conversations) : undefined;
  // Where it runs, as "Ann's laptop · Claude Code"; a proposal is its repository's.
  const where =
    thread.kind === 'proposal'
      ? `Proposed in ${short(thread.repo)}`
      : [agent?.displayName, thread.harness].filter(Boolean).join(' · ');
  return (
    <header className="agents-head">
      <span className="agents-back"><IconButton variant="ghost" label="Back to the list" icon={<BackIcon />} onClick={onBack} /></span>
      <div className="agents-head-text">
        <strong>{titleOf(thread)}</strong>
        <span>{where}</span>
      </div>
      {card && <Button label="Open card" onClick={() => actions.setBoardOpen(card.projectId, card.section)} />}
    </header>
  );
}

/** The pull request a card's run opened, and whether it is a draft, ready, or merged. */
function usePullOf() {
  const pulls = useAppState((s) => s.github?.pulls);
  const drafts = useMemo(
    () => new Map([...(pulls?.authored ?? []), ...(pulls?.reviewRequested ?? [])].map((p) => [`${p.repo.toLowerCase()}#${p.number}`, p.draft])),
    [pulls],
  );
  return (t: Thread) => {
    const run = t.messages.findLast((m) => m.run && 'pull' in m.run && m.run.pull)?.run;
    const pull = run && 'pull' in run ? run.pull : undefined;
    if (!pull) return undefined;
    if (t.messages.some((m) => m.run?.kind === 'merged')) return { ...pull, state: 'merged' as const };
    // A run opens its pull request as a draft; GitHub's list says once it is ready.
    return { ...pull, state: drafts.get(`${pull.repo.toLowerCase()}#${pull.number}`) === false ? ('ready' as const) : ('draft' as const) };
  };
}

function PullMark({ pull }: { pull: { number: number; state: 'draft' | 'ready' | 'merged' } }) {
  const words = { draft: 'Draft pull request', ready: 'Pull request ready for review', merged: 'Merged pull request' }[pull.state];
  return (
    <span className="agents-pr" title={`${words} #${pull.number}`} aria-label={`${words} #${pull.number}`}>
      {pull.state === 'merged' ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M6 21V9a9 9 0 0 0 9 9" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={pull.state === 'draft' ? '3 2.5' : undefined} aria-hidden="true">
          <path d="M6 3v12" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="18" r="3" />
          <path d="M18 15V8a2 2 0 0 0-2-2h-5" />
          <polyline points="13 3 10 6 13 9" />
        </svg>
      )}
      #{pull.number}
    </span>
  );
}

/**
 * The window's sidebar (R-038): New chat, what waits for the user, each of their projects with its
 * conversations and card runs, folding on its own, and those in no project. Its foot holds the
 * agents' own actions; on a phone they drop from the gear in its head instead.
 */
function AgentsSidebar({
  threads: all,
  chats,
  agents,
  selected,
  onNew,
  onConnect,
  onSettings,
}: {
  threads: Thread[];
  chats: ChatConversation[];
  agents: UserDTO[];
  selected: string;
  onNew: () => void;
  onConnect: () => void;
  onSettings: () => void;
}) {
  const meId = useAppState((s) => s.me?.id);
  const projects = useAppState((s) => s.projects);
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  // Which chats have loaded only their newest page, as one string, so a new message renders nothing here.
  const partial = useAppState((s) => chats.filter((c) => s.messages[c.id] && !s.historyComplete[c.id]).map((c) => c.id).join());
  const pullOf = usePullOf();
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  // Searching narrows every list to the chats whose title holds the words.
  const [query, setQuery] = useState<string | null>(null);
  const q = query?.trim().toLowerCase();
  const shown = useMemo(() => (q ? all.filter((t) => titleOf(t).toLowerCase().includes(q)) : all), [all, q]);
  const [menu, setMenu] = useState<'folder' | 'sleep' | 'gear' | null>(null);
  const toggle = (m: NonNullable<typeof menu>) => setMenu(menu === m ? null : m);
  // Only projects one of the user's agents is in: an agent reads a project's board only as its member (rule 5).
  const mine = useMemo(
    () =>
      Object.values(projects)
        .filter((p) => meId !== undefined && p.memberIds.includes(meId) && agents.some((a) => p.memberIds.includes(a.id)))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects, meId, agents],
  );
  // Each project's conversations, and those in none of the user's projects.
  const { byProject, loose } = useMemo(() => {
    const byProject = new Map<number, Thread[]>();
    const loose: Thread[] = [];
    for (const t of shown) {
      const id = threadProject(t, docs, conversations);
      if (id == null || !mine.some((p) => p.id === id)) {
        loose.push(t);
        continue;
      }
      byProject.set(id, [...(byProject.get(id) ?? []), t]);
    }
    return { byProject, loose };
  }, [shown, docs, conversations, mine]);
  const waiting = shown.filter((t) => WAITS.has(t.state));
  const waitingAll = all.filter((t) => WAITS.has(t.state));

  const awake = agents.some((a) => a.online);
  // An agent runs several cards at once, so the head says how many go (R-037).
  const running = all.filter((t) => t.kind === 'card' && t.state === 'working').length;
  const status =
    agents.length === 0
      ? 'No agent connected'
      : awake
        ? `Online${running ? ` · ${running} ${running === 1 ? 'card' : 'cards'} running` : ''}`
        : asleep(Math.max(0, ...agents.map((a) => a.lastSeen ?? 0)) || null);

  const row = (t: Thread, nested: boolean, start?: ReactNode, end?: ReactNode) => {
    const pull = pullOf(t);
    return (
      <button
        key={t.root}
        type="button"
        className={`agents-row${nested ? ' is-nested' : ''}`}
        aria-current={selected === t.root || undefined}
        onClick={() => actions.setAgentsOpen(true, t.root)}
      >
        {start}
        <span className="agents-row-title">{titleOf(t)}</span>
        {end ?? (pull && <PullMark pull={pull} />)}
      </button>
    );
  };
  // The agents' own actions: in the foot, or on a phone in the gear's menu.
  const own = (role?: 'menuitem') => (
    <>
      <button type="button" role={role} className="agents-row" onClick={() => (setMenu(null), onConnect())}>
        <PlusIcon width={18} height={18} />
        Connect agent
      </button>
      {agents.length > 0 && (
        <>
          <button type="button" role={role} className="agents-row" aria-haspopup="dialog" aria-expanded={menu === 'sleep'} onClick={() => toggle('sleep')}>
            <MoonIcon />
            <span className="agents-row-title">Put to sleep</span>
            <span className="agents-row-end">{agents.filter((a) => a.online).length} awake</span>
          </button>
          <button type="button" role={role} className="agents-row" onClick={() => (setMenu(null), onSettings())}>
            <BotIcon />
            Agent settings
          </button>
        </>
      )}
    </>
  );

  return (
    <aside className="agents-side" aria-label="Coding agents">
      <header className="agents-side-head">
        <div className="agents-side-title">
          <strong>Coding agents</strong>
          <span>
            <span className={`agents-dot${awake ? ' is-on' : ''}`} aria-hidden="true" />
            {status}
          </span>
        </div>
        {/* The bell opens the oldest chat that waits for the user. */}
        <span className="agents-bell">
          <IconButton
            variant="ghost"
            label={`What waits for you, ${waitingAll.length}`}
            icon={<BellIcon width={18} height={18} />}
            isDisabled={waitingAll.length === 0}
            onClick={() => actions.setAgentsOpen(true, waitingAll.at(-1)!.root)}
          />
          {waitingAll.length > 0 && <span className="agents-bell-dot" aria-hidden="true" />}
        </span>
        <IconButton
          variant="ghost"
          label="Search chats"
          aria-expanded={query !== null}
          icon={<SearchIcon width={18} height={18} />}
          onClick={() => setQuery(query === null ? '' : null)}
        />
        <span className="agents-gear-wrap">
          <IconButton
            variant="ghost"
            label="Agent options"
            aria-haspopup="menu"
            aria-expanded={menu === 'gear'}
            icon={<GearIcon />}
            onClick={() => toggle('gear')}
          />
          {menu === 'gear' && (
            <Popover className="agents-gear-menu" role="menu" label="Agent options" onClose={() => setMenu(null)}>
              {own('menuitem')}
            </Popover>
          )}
        </span>
      </header>
      {query !== null && (
        <label className="agents-folder-search agents-side-search">
          <SearchIcon width={16} height={16} />
          <input
            type="search"
            autoFocus
            value={query}
            placeholder="Search chats"
            aria-label="Search chats"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery(null)}
          />
        </label>
      )}
      <div className="agents-side-list">
        <button type="button" className="agents-row" aria-current={selected === 'new' || undefined} onClick={onNew}>
          <NewChatIcon width={18} height={18} />
          New chat
        </button>
        {waiting.length > 0 && (
          <>
            <h3 className="agents-side-h">Waiting for you</h3>
            {waiting.map((t) => row(t, false, <AskIcon />, <span className="agents-row-end is-warn">{THREAD_STATE[t.state].label}</span>))}
          </>
        )}
        <div className="agents-side-h agents-side-h-row">
          <h3>Projects</h3>
          <IconButton
              variant="ghost"
              label="Add folder"
              tooltip="Add folder"
              aria-expanded={menu === 'folder'}
              icon={<FolderPlusIcon />}
              onClick={() => toggle('folder')}
            />
        </div>
        {mine.map((p) => {
          const isOpen = !closed[p.id];
          const own = byProject.get(p.id) ?? [];
          return (
            <div key={p.id} className="agents-project">
              <button
                type="button"
                className="agents-row"
                aria-expanded={isOpen}
                onClick={() => setClosed({ ...closed, [p.id]: isOpen })}
              >
                <FolderIcon width={18} height={18} />
                <span className="agents-row-title">{p.name}</span>
              </button>
              {isOpen && own.map((t) => row(t, true))}
            </div>
          );
        })}
        {loose.length > 0 && (
          <>
            <h3 className="agents-side-h">No project</h3>
            {loose.map((t) => row(t, false))}
          </>
        )}
        {/* A chat loads its newest page first, so older conversations wait for a tap. */}
        {partial && (
          <Button variant="ghost" size="sm" label="Show earlier chats" onClick={() => partial.split(',').forEach((id) => void loadOlder(Number(id)))} />
        )}
      </div>
      <footer className="agents-side-foot">{own()}</footer>
      {/* Outside the list, whose scrolling would cut them. */}
      {menu === 'folder' && <AddFolder agents={agents} onClose={() => setMenu(null)} />}
      {menu === 'sleep' && <SleepPanel agents={agents} threads={all} onClose={() => setMenu(null)} />}
    </aside>
  );
}

/**
 * Put to sleep, per agent (K-66, D-113): each agent finishes the cards it runs first, then takes no
 * new work until `webchat-agent wake` on its laptop. A panel above the foot, a sheet on a phone.
 */
function SleepPanel({ agents, threads, onClose }: { agents: UserDTO[]; threads: Thread[]; onClose: () => void }) {
  const conversations = useAppState((s) => s.conversations);
  const [asked, setAsked] = useState<Set<number>>(new Set());
  const runningOf = (agent: UserDTO) =>
    threads.filter(
      (t) => t.kind === 'card' && t.state === 'working' && conversations[t.conversationId]?.members.some((m) => m.userId === agent.id),
    ).length;
  const sleep = (agent: UserDTO) => {
    setAsked((s) => new Set(s).add(agent.id));
    putToSleep(agent.id).catch((err: Error) => {
      setAsked((s) => {
        const next = new Set(s);
        next.delete(agent.id);
        return next;
      });
      actions.addToast({ conversationId: null, title: `${agent.displayName} did not get it`, body: err.message });
    });
  };
  const awake = agents.filter((a) => a.online && !asked.has(a.id));
  return (
    <>
      <button type="button" className="agents-sheet-backdrop" aria-label="Close" onClick={onClose} />
      <Popover className="agents-sleep" label="Put agents to sleep" onClose={onClose}>
        <span className="agents-popover-h">Your agents</span>
        {agents.map((a) => {
          const running = runningOf(a);
          const going = asked.has(a.id) && a.online;
          const sub = !a.online
            ? 'Asleep'
            : going
              ? running
                ? `Finishes ${running} ${running === 1 ? 'card' : 'cards'}, then sleeps`
                : 'Going to sleep…'
              : running
                ? `${running} ${running === 1 ? 'card' : 'cards'} running`
                : 'Online, idle';
          return (
            <div key={a.id} className="agents-sleep-row">
              <span className={`agents-dot${a.online ? (going ? ' is-going' : ' is-on') : ''}`} aria-hidden="true" />
              <span className="agents-sleep-text">
                <strong>{a.displayName}</strong>
                <span className={going ? 'is-warn' : undefined}>{sub}</span>
              </span>
              {a.online && !going && <Button size="sm" label="Sleep" aria-label={`Put ${a.displayName} to sleep`} onClick={() => sleep(a)} />}
            </div>
          );
        })}
        <button type="button" className="agents-row" disabled={awake.length === 0} onClick={() => awake.forEach(sleep)}>
          <MoonIcon />
          Sleep all
        </button>
      </Popover>
    </>
  );
}

/**
 * Add folder: the folders each agent works in, with where it stands on each and Forget, which takes
 * the folder's mark only, never its files (D-101). Choose folder opens a folder window on that laptop,
 * and the folder picked comes back as a connect request to approve (docs/decisions/connect-approval.md).
 */
function AddFolder({ agents, onClose }: { agents: UserDTO[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const folders = agents.flatMap((agent) =>
    agent.agentRepos
      .filter((s) => !q || s.repo.toLowerCase().includes(q))
      .map((s) => ({ agent, repo: s.repo, state: folderState(seatFor(agent, s.repo)) })),
  );
  return (
    <Popover className="agents-folder" label="Add folder" onClose={onClose}>
      <label className="agents-folder-search">
        <SearchIcon width={18} height={18} />
        <input type="search" value={query} placeholder="Search folders and repositories…" aria-label="Search folders and repositories" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <span className="agents-popover-h">Recents</span>
      {folders.map(({ agent, repo, state: [label, ready] }) => (
        <div key={`${agent.id}:${repo}`} className="agents-folder-row">
          <FolderIcon width={18} height={18} />
          <span className="agents-sleep-text">
            <strong>{short(repo)}</strong>
            <span>
              {repo} · {agent.displayName} · {label}
            </span>
          </span>
          {ready && <Button size="sm" label="Forget" aria-label={`Forget the folder of ${short(repo)}`} onClick={() => void forgetFolder(agent.id, repo)} />}
        </div>
      ))}
      {folders.length === 0 && <p className="agents-popover-note">{q ? 'No folder matches.' : 'No folder yet.'}</p>}
      <hr />
      <span className="agents-popover-h">Laptops</span>
      {agents.map((a) => (
        <div key={a.id} className="agents-folder-row">
          <LaptopIcon />
          <span className="agents-row-title">{a.displayName}</span>
          <span className={`agents-dot${a.online ? ' is-on' : ''}`} aria-hidden="true" />
          {a.online && (
            <Button
              size="sm"
              label="Choose folder"
              aria-label={`Choose a folder on ${a.displayName}`}
              onClick={() =>
                void pickFolder(a.id).then(
                  () => actions.addToast({ conversationId: null, title: 'Look at that laptop', body: 'A folder window opens there. Pick a copy of a repository, then approve it here.' }),
                  (err: Error) => actions.addToast({ conversationId: null, title: 'Folder window not opened', body: err.message }),
                )
              }
            />
          )}
        </div>
      ))}
      <p className="agents-popover-note">Choose folder opens a folder window on that laptop. Your agent asks you here before it works there.</p>
    </Popover>
  );
}

/**
 * A new question (R-038): the box asks in one of the user's projects, about one of its repositories
 * or its board alone, or in No project, about one of the agent's folders or none, with the harness and model picked, in the user's own setup or restricted.
 */
function NewChat({ threads, onClose }: { threads: Thread[]; onClose: () => void }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const projects = useAppState((s) => s.projects);
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const [picked, setPicked] = useState<{ project?: number; repo?: string }>({});
  const agents = useMemo(() => ownAgents(users, meId), [users, meId]);
  const mine = useMemo(
    () =>
      Object.values(projects)
        .filter((p) => meId !== undefined && p.memberIds.includes(meId))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects, meId],
  );
  const linked = useLinkedRepos(mine.map((p) => p.id));
  // The agent that works in a project: the user's own that is a member, since it reads a board only as one (rule 5).
  const agentIn = (projectId: number) => agents.find((a) => projects[projectId]?.memberIds.includes(a.id));
  // A project's repositories: those it links (D-050), or on a server with no GitHub App, the agent's folders.
  const reposOf = (projectId: number) => {
    const view = linked[projectId];
    return view && !view.configured ? (agentIn(projectId)?.agentRepos.map((s) => s.repo) ?? []) : (view?.repos ?? []);
  };
  // What a question can be about: a repository, or '' for the board alone, which a project that links
  // none always offers, and on a server with no GitHub App, every project.
  const choicesOf = (projectId: number) => {
    const repos = reposOf(projectId);
    return repos.length && linked[projectId]?.configured !== false ? repos : [...repos, ''];
  };
  const askable = mine.filter((p) => agentIn(p.id));
  // Outside every project, a chat runs in one of the user's agents' folders, or with No folder in an
  // empty one on the first agent's laptop, with no board in its brief.
  const folders = agents.flatMap((a) => a.agentRepos.map((s) => ({ agent: a, repo: s.repo })));
  const outside = picked.project === 0 || !askable.length;
  // The project picked, else the newest conversation's, else the first; then its repository picked, or its first.
  const project = outside
    ? undefined
    : (askable.find((p) => p.id === picked.project) ??
      askable.find((p) => threads[0] && p.id === threadProject(threads[0], docs, conversations)) ??
      askable[0]);
  const folder = outside ? (folders.find((f) => `${f.agent.id} ${f.repo}` === picked.repo) ?? (picked.repo === '' ? undefined : folders[0])) : undefined;
  const repos = project ? choicesOf(project.id) : [];
  const repo = outside ? folder?.repo : (repos.find((r) => r === picked.repo) ?? repos[0]);
  const agent = folder?.agent ?? (outside ? agents[0] : project && agentIn(project.id));
  const { list, harness, pick, own: owns } = useHarnessPick(agent, true);
  const [model, setModel] = useState<string>();
  const [effort, setEffort] = useState<string>();
  const [mode, setMode] = useState<PermissionMode>('auto');
  // A typed question runs in the user's own setup when Agent settings turn it on for its harness (D-157); this switches one chat back.
  const [restricted, setRestricted] = useState(false);
  const canOwn = !!harness && owns.includes(harness);
  const own = canOwn && !restricted;
  // With no repository, the agent answers from the board alone, on its laptop (R-038).
  const blocked = !agent
    ? 'Connect your agent first: Connect agent, below the list.'
    : outside && !repo && !asksAnywhere(agent.protocol)
      ? 'Your agent is too old to answer with no folder. Run webchat-agent setup in a terminal on your laptop to update it.'
      : blockedBy(seatFor(agent, repo ?? ''));
  const loading = !!project && !linked[project.id];
  // Until a project's repositories load, the box speaks of code, as most questions are about it.
  const code = !!repo || loading;

  async function ask(text: string) {
    try {
      actions.setAgentsOpen(
        true,
        await askAgent(agent!.id, project?.id, repo || undefined, text, {
          harness,
          ...(model && { model }),
          ...(effort && { effort }),
          ...(own ? { own: true, mode } : {}),
        }),
      );
    } catch (err) {
      actions.addToast({ conversationId: null, title: 'Question not sent', body: (err as Error).message });
      throw err;
    }
  }

  const modelButton = harness && list && (
    <ModelButton
      list={list}
      value={{ harness, model }}
      effort={effort}
      onEffort={setEffort}
      onPick={(p) => {
        // Another model may not take it.
        if (effort && !effortsOf(list, p).includes(effort)) setEffort(undefined);
        pick(p.harness);
        setModel(p.model);
      }}
    />
  );
  const modeButton = <SetupButton own={own} canOwn={canOwn} harness={harness} mode={mode} onOwn={(to) => setRestricted(!to)} onMode={setMode} />;

  return (
    <div className="agents-new">
      <header className="agents-head agents-new-head">
        <IconButton variant="ghost" label="Close" icon={<CloseIcon />} onClick={onClose} />
        <div className="agents-head-text">
          <strong>New chat</strong>
        </div>
      </header>
      <div className="agents-new-body">
        <AgentAsks />
        <h1>What should your agent look at?</h1>
        <div className="agents-new-form">
          {/* A terminal's session, continued here, in the user's own setup (R-072). */}
          {agent && repo && listsSessions(seatFor(agent, repo)?.protocol ?? 0) && (
            <div className="agents-new-sessions">
              <TerminalSessions key={`${project?.id ?? ''}:${repo}`} agent={agent} project={project} repo={repo} />
            </div>
          )}
          {blocked && <Banner status="warning" title={blocked} />}
          <div className="agents-new-chips">
            {modelButton}
            {modeButton}
          </div>
          <div className="agents-new-box">
            <Box
              name="agents:ask"
              pill
              placeholder={code ? 'Ask about your code' : project ? 'Ask about your project' : 'Ask anything'}
              canSend={!blocked && !loading}
              onSend={ask}
              model={modelButton}
            />
          </div>
          {(project || (outside && agent)) && (
            <div className="agents-where agents-new-where">
              <span>
                <FolderIcon width={16} height={16} />
                <select aria-label="Project" value={String(project?.id ?? 0)} onChange={(e) => setPicked({ project: Number(e.target.value) })}>
                  {askable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value={0}>No project</option>
                </select>
              </span>
              <span>
                <BranchIcon />
                {project ? (
                  <select aria-label="Repository" value={repo ?? ''} onChange={(e) => setPicked({ project: project.id, repo: e.target.value })}>
                    {repos.map((r) => (
                      <option key={r} value={r}>
                        {r ? short(r) : 'Its board'}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select aria-label="Folder" value={folder ? `${folder.agent.id} ${folder.repo}` : ''} onChange={(e) => setPicked({ project: 0, repo: e.target.value })}>
                    {folders.map((f) => (
                      <option key={`${f.agent.id} ${f.repo}`} value={`${f.agent.id} ${f.repo}`}>
                        {short(f.repo)}
                      </option>
                    ))}
                    <option value="">No folder</option>
                  </select>
                )}
              </span>
              {agent && (
                <span>
                  <LaptopIcon />
                  {agent.displayName}
                </span>
              )}
              {modeButton}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const icon = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const AskIcon = () =>
  icon(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1v.5" />
      <circle cx="12" cy="17" r=".6" fill="currentColor" />
    </>,
  );
const FolderPlusIcon = () =>
  icon(
    <>
      <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="9.5" y1="13.5" x2="14.5" y2="13.5" />
    </>,
  );
const MoonIcon = () => icon(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />);
const BotIcon = () =>
  icon(
    <>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </>,
  );
const GearIcon = () =>
  icon(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>,
  );
