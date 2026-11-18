// The Coding agents pane (R-035, D-103): the user asks their coding agent in one of their projects
// and reads its answers, listed by project with where the agent stands on each repository (R-038).
// It takes the chat's place, with a back button on phones. A conversation is a prompt and the
// messages that name it, in the user's direct chat with the agent (D-102).
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
import { Selector } from '@astryxdesign/core/Selector';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { useEffect, useMemo, useState } from 'react';
import { AGENT_LEVEL, listsSessions } from '../../../shared/types';
import {
  asleep,
  blockedBy,
  ownAgents,
  seatFor,
  short,
  THREAD_STATE,
  threadProject,
  useAgentThreads,
  type Seat,
  type Thread,
} from '../agents';
import { addProjectMembers, askAgent, forgetFolder, loadChat, loadOlder, putToSleep } from '../chat';
import type { ChatConversation } from '../e2ee/keyring';
import { useLinkedRepos } from '../linkedRepos';
import { actions, useAppState } from '../store';
import { formatListTime } from './format';
import { BackIcon, PlusIcon, SlidersIcon, TerminalIcon } from './icons';
import { AgentBrief } from './AgentBrief';
import { AgentDialog } from './AgentDialog';
import { AgentAsks } from './AgentAsks';
import { AgentSetup } from './AgentSetup';
import { AgentThread, Box } from './AgentThread';
import { TerminalSessions } from './TerminalSessions';
import { HarnessPicker, useHarnessPick } from './HarnessPicker';
import { Tag, type Tone } from './PullTags';

/** Where the agent stands on a repository, as a project lists it, and whether it has a folder to forget (R-038). */
function repoState(seat: Seat | undefined): [Tone, string, boolean?] {
  if (!seat || seat.protocol < AGENT_LEVEL.answers) return ['warn', 'Plugin too old'];
  if (!seat.online) return ['muted', 'Asleep'];
  return seat.noFolder ? ['muted', 'No copy yet'] : ['ok', 'Ready', true];
}

export function AgentsView() {
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const open = useAppState((s) => s.agentThread);
  const brief = useAppState((s) => s.agentBrief);
  const { chats, threads } = useAgentThreads();
  const agents = useMemo(() => ownAgents(users, meId), [users, meId]);
  const thread = threads.find((t) => t.root === open);
  const [connecting, setConnecting] = useState(false);
  const [setting, setSetting] = useState(false);
  // Where a conversation is answered: its agent's folder of the repository its prompt names, or its laptop.
  const seatOf = (t: Thread) => {
    const agent = agents.find((a) => conversations[t.conversationId]?.members.some((m) => m.userId === a.id));
    return agent && seatFor(agent, t.repo);
  };

  // The pane shows every chat with an agent, so it loads them, and they count as read while it shows.
  const ids = chats.map((c) => c.id).join();
  useEffect(() => {
    for (const id of ids.split(',').filter(Boolean)) void loadChat(Number(id));
  }, [ids]);

  const awake = agents.some((a) => a.online);
  // Asked to sleep: the agent finishes what runs first, so it may stay online a while (K-66).
  const [sleeping, setSleeping] = useState(false);
  useEffect(() => {
    if (!awake) setSleeping(false);
  }, [awake]);
  const sleep = () => {
    setSleeping(true);
    for (const agent of agents.filter((a) => a.online)) {
      putToSleep(agent.id).catch((err: Error) => {
        setSleeping(false);
        actions.addToast({ conversationId: null, title: 'Your agent did not get it', body: err.message });
      });
    }
  };
  let subtitle = awake ? 'Your agent is online' : asleep(Math.max(0, ...agents.map((a) => a.lastSeen ?? 0)) || null);
  if (agents.length === 0) subtitle = 'No agent connected';
  else if (thread?.kind === 'proposal')
    subtitle = `Proposed in ${short(thread.repo)} · ${THREAD_STATE[thread.state].label}`;
  else if (thread)
    // A session's head names its branch, and whether it runs in the user's own setup (R-072).
    subtitle = `${thread.kind === 'card' ? 'Runs in' : 'Asked'} ${thread.repo ? `${thread.kind === 'card' ? '' : 'in '}${short(thread.repo)}` : 'about the board'}${thread.about?.branch ? ` on ${thread.about.branch}` : ''}${thread.harness ? ` with ${thread.harness}` : ''}${thread.about?.own ? ', your own setup' : ''} · ${THREAD_STATE[thread.state].label}`;
  else if (brief) subtitle = 'Before it starts';
  // An agent runs several cards at once, so the list says how many go (R-037).
  const running = threads.filter((t) => t.kind === 'card' && t.state === 'working').length;
  if (!thread && !brief && running) subtitle += ` · ${running} ${running === 1 ? 'card' : 'cards'} running`;

  return (
    <section className="chat agents-pane">
      <header className="chat-header">
        {thread || brief ? (
          <IconButton
            variant="ghost"
            label="Back to questions"
            icon={<BackIcon />}
            onClick={() => actions.setAgentsOpen(true)}
          />
        ) : (
          <IconButton
            className="back-button"
            variant="ghost"
            label="Back to chats"
            icon={<BackIcon />}
            onClick={() => actions.setAgentsOpen(false)}
          />
        )}
        <span className="github-mark">
          <TerminalIcon />
        </span>
        <div className="chat-header-text">
          <strong>Coding agents</strong>
          <span>{subtitle}</span>
        </div>
        {!thread && !brief && agents.length > 0 && (
          <div className="header-end">
            {awake && (
              <Button label={sleeping ? 'Going to sleep…' : 'Put to sleep'} isDisabled={sleeping} onClick={sleep} />
            )}
            {/* What runs load from the owner's Claude setup (R-039). */}
            <IconButton
              variant="ghost"
              label="Agent settings"
              tooltip="Agent settings"
              icon={<SlidersIcon />}
              onClick={() => setSetting(true)}
            />
            {/* Connecting another agent, and removing one, live here (R-030, R-033). */}
            <IconButton
              variant="ghost"
              label="Connect coding agent"
              tooltip="Connect coding agent"
              icon={<PlusIcon />}
              onClick={() => setConnecting(true)}
            />
          </div>
        )}
      </header>
      {thread ? (
        <AgentThread
          key={thread.root}
          thread={thread}
          details
          seat={seatOf(thread)}
          agentId={conversations[thread.conversationId]?.members.find((m) => m.userId !== meId)?.userId ?? 0}
        />
      ) : brief ? (
        <AgentBrief brief={brief} />
      ) : agents.length === 0 ? (
        <div className="messages agents-list-view">
          <p className="agents-empty">
            Your coding agent is Claude Code on your laptop. It answers your questions about your team’s code and works
            on the roadmap cards you hand it.
          </p>
          <Button variant="primary" label="Connect coding agent" onClick={() => setConnecting(true)} />
        </div>
      ) : (
        <>
          <AgentAsks />
          <ProjectList threads={threads} chats={chats} />
        </>
      )}
      {connecting && <AgentDialog onClose={() => setConnecting(false)} />}
      {setting && <AgentSetup onClose={() => setSetting(false)} />}
    </section>
  );
}

/**
 * The pane's list (R-038): an Ask box that asks in one of the user's projects, then each project
 * with its repositories, where the agent stands on each, and its conversations, newest first.
 */
function ProjectList({ threads, chats }: { threads: Thread[]; chats: ChatConversation[] }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const projects = useAppState((s) => s.projects);
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const messages = useAppState((s) => s.messages);
  const complete = useAppState((s) => s.historyComplete);
  const [picked, setPicked] = useState<{ project?: number; repo?: string }>({});
  // A chat loads its newest page first, so older conversations wait for a tap.
  const older = chats.filter((c) => messages[c.id] && !complete[c.id]);
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
  const projectOf = (t: Thread) => threadProject(t, docs, conversations);

  // The project picked, else the newest conversation's, else the first; then its repository picked, or its first.
  const askable = mine.filter((p) => agentIn(p.id));
  const project =
    askable.find((p) => p.id === picked.project) ??
    askable.find((p) => threads[0] && p.id === projectOf(threads[0])) ??
    askable[0];
  const repos = project ? choicesOf(project.id) : [];
  const repo = repos.find((r) => r === picked.repo) ?? repos[0];
  const agent = project && agentIn(project.id);
  const { list, harness, pick } = useHarnessPick(agent, true);
  // With no repository, the agent answers from the board alone, on its laptop (R-038).
  const blocked = !agent
    ? 'Add your agent to one of your projects first: Add it, below.'
    : blockedBy(seatFor(agent, repo ?? ''));
  const loading = !!project && !linked[project.id];
  // Until a project's repositories load, the box speaks of code, as most questions are about it.
  const code = !!repo || loading;

  async function ask(text: string) {
    try {
      actions.setAgentsOpen(true, await askAgent(agent!.id, project!.id, repo || undefined, text, harness, true));
    } catch (err) {
      actions.addToast({ conversationId: null, title: 'Question not sent', body: (err as Error).message });
      throw err;
    }
  }

  const item = (t: Thread, several: boolean) => (
    <ListItem
      key={t.root}
      label={t.messages[0]!.text}
      onClick={() => actions.setAgentsOpen(true, t.root)}
      endContent={
        <Stack direction="horizontal" gap={2} vAlign="center">
          <Tag tone={THREAD_STATE[t.state].tone}>{THREAD_STATE[t.state].label}</Tag>
          {several && <Text color="secondary">{t.repo ? short(t.repo) : 'Board'}</Text>}
          <Text color="secondary">{formatListTime(t.last)}</Text>
        </Stack>
      }
    />
  );
  const elsewhere = threads.filter((t) => !mine.some((p) => p.id === projectOf(t)));

  return (
    <div className="messages agents-list-view">
      <div className="composer agents-ask">
        {project && (
          <div className="agents-repo">
            Asks in
            {askable.length > 1 ? (
              <Selector
                label="Project"
                isLabelHidden
                value={String(project.id)}
                onChange={(v) => setPicked({ project: Number(v) })}
                options={askable.map((p) => ({ value: String(p.id), label: p.name }))}
              />
            ) : (
              <strong>{project.name}</strong>
            )}
            {repos.length > 1 ? (
              <Selector
                label="Repository"
                isLabelHidden
                value={repo ?? ''}
                onChange={(v) => setPicked({ project: project.id, repo: v })}
                options={repos.map((r) => ({ value: r, label: r ? short(r) : 'its board' }))}
              />
            ) : (
              <span>{repo ? short(repo) : 'its board'}</span>
            )}
            <HarnessPicker list={list} value={harness} onChange={pick} />
          </div>
        )}
        {blocked && <Banner status="warning" title={blocked} />}
        <Box
          name="agents:ask"
          placeholder={code ? 'Ask about your code' : 'Ask about your project'}
          canSend={!blocked && !loading}
          onSend={ask}
        />
        <p className="agents-hint">
          {code
            ? 'It reads your team’s code as it is on GitHub, and catches up on each reply.'
            : 'Your agent answers from the project’s board alone: its decisions and cards.'}
        </p>
        {/* A terminal's session, continued here, in the user's own setup (R-072). */}
        {agent && project && repo && listsSessions(seatFor(agent, repo)?.protocol ?? 0) && (
          <TerminalSessions key={`${project.id}:${repo}`} agent={agent} project={project} repo={repo} />
        )}
      </div>
      {mine.map((p) => {
        const inIt = agentIn(p.id);
        const own = threads.filter((t) => projectOf(t) === p.id);
        const list = reposOf(p.id);
        return (
          <section key={p.id} className="agents-project">
            <h3 className="agents-project-head">{p.name}</h3>
            {!inIt ? (
              <List edge="flush">
                <ListItem
                  label="Your agent is not in this project, so it cannot read its board."
                  endContent={
                    <Button
                      variant="ghost"
                      size="sm"
                      label="Add it"
                      onClick={() =>
                        void addProjectMembers(p.id, [agents[0]!.id]).catch((err: Error) =>
                          actions.addToast({ conversationId: null, title: 'Agent not added', body: err.message }),
                        )
                      }
                    />
                  }
                />
              </List>
            ) : linked[p.id] && list.length === 0 ? (
              <Text as="p" color="secondary">
                No repository linked, so your agent answers from the board.
              </Text>
            ) : (
              <List edge="flush">
                {list.map((r) => {
                  const [tone, label, ready] = repoState(seatFor(inIt, r));
                  return (
                    <ListItem
                      key={r}
                      label={short(r)}
                      endContent={
                        <Stack direction="horizontal" gap={2} vAlign="center">
                          <Tag tone={tone}>{label}</Tag>
                          {/* Forgetting takes the folder's mark only, never its files (D-101). */}
                          {ready && (
                            <Button
                              variant="ghost"
                              size="sm"
                              label="Forget"
                              aria-label={`Forget the folder of ${short(r)}`}
                              onClick={() => void forgetFolder(inIt.id, r)}
                            />
                          )}
                        </Stack>
                      }
                    />
                  );
                })}
              </List>
            )}
            {own.length > 0 && <List edge="flush">{own.map((t) => item(t, list.length > 1))}</List>}
          </section>
        );
      })}
      {elsewhere.length > 0 && (
        <section className="agents-project">
          <h3 className="agents-project-head">Earlier questions</h3>
          <List edge="flush">{elsewhere.map((t) => item(t, true))}</List>
        </section>
      )}
      {threads.length === 0 && (
        <p className="agents-empty">
          Ask how something in your team’s code works, where a bug comes from, or what a change would take. Your agent
          reads the code, or the board of a project with no code, and answers here. To change the code, hand it a card
          on the board.
        </p>
      )}
      {older.length > 0 && (
        <Button
          variant="ghost"
          label="Show earlier questions"
          onClick={() => older.forEach((c) => void loadOlder(c.id))}
        />
      )}
    </div>
  );
}
