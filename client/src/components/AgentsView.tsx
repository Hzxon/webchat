// The Coding agents pane (R-035, D-103): the user asks their coding agent in one of their projects
// and reads its answers, listed by project with where the agent stands on each repository (R-038).
// It takes the chat's place, with a back button on phones. A conversation is a prompt and the
// messages that name it, in the user's direct chat with the agent (D-102).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AGENT_LEVEL, LIMITS, type RunRequest } from '../../../shared/types';
import { asleep, blockedBy, ownAgents, seatFor, short, THREAD_STATE, threadProject, useAgentThreads, WAKE, type Seat, type Thread } from '../agents';
import { addProjectMembers, askAgent, askClone, askFix, cancelRun, discardMessage, forgetFolder, loadChat, loadOlder, putToSleep, retryMessage, saveDraft, tellAgent } from '../chat';
import type { ChatConversation, ChatMessage } from '../e2ee/keyring';
import { useLinkedRepos } from '../linkedRepos';
import { actions, useAppState } from '../store';
import { useAutoGrow, useDraft } from './ChatView';
import { formatListTime, formatTime } from './format';
import { AlertIcon, BackIcon, PlusIcon, SendIcon, SlidersIcon, TerminalIcon } from './icons';
import { AgentBrief } from './AgentBrief';
import { AgentDialog } from './AgentDialog';
import { AgentDraft } from './AgentDraft';
import { AgentSetup } from './AgentSetup';
import { Markdown } from './Markdown';
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
  else if (thread?.kind === 'proposal') subtitle = `Proposed in ${short(thread.repo)} · ${THREAD_STATE[thread.state].label}`;
  else if (thread) subtitle = `${thread.kind === 'card' ? 'Runs in' : 'Asked'} ${thread.repo ? `${thread.kind === 'card' ? '' : 'in '}${short(thread.repo)}` : 'about the board'} · ${THREAD_STATE[thread.state].label}`;
  else if (brief) subtitle = 'Before it starts';
  // An agent runs several cards at once, so the list says how many go (R-037).
  const running = threads.filter((t) => t.kind === 'card' && t.state === 'working').length;
  if (!thread && !brief && running) subtitle += ` · ${running} ${running === 1 ? 'card' : 'cards'} running`;

  return (
    <section className="chat agents-pane">
      <header className="chat-header">
        {thread || brief ? (
          <button className="icon-button" onClick={() => actions.setAgentsOpen(true)} aria-label="Back to questions">
            <BackIcon />
          </button>
        ) : (
          <button className="icon-button back-button" onClick={() => actions.setAgentsOpen(false)} aria-label="Back to chats">
            <BackIcon />
          </button>
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
              <button className="button-secondary" disabled={sleeping} onClick={sleep}>
                {sleeping ? 'Going to sleep…' : 'Put to sleep'}
              </button>
            )}
            {/* What runs load from the owner's Claude setup (R-039). */}
            <button className="icon-button" onClick={() => setSetting(true)} title="Agent settings" aria-label="Agent settings">
              <SlidersIcon />
            </button>
            {/* Connecting another agent, and removing one, live here (R-030, R-033). */}
            <button className="icon-button" onClick={() => setConnecting(true)} title="Connect coding agent" aria-label="Connect coding agent">
              <PlusIcon />
            </button>
          </div>
        )}
      </header>
      {thread ? (
        <ThreadView key={thread.root} thread={thread} seat={seatOf(thread)} agentId={conversations[thread.conversationId]?.members.find((m) => m.userId !== meId)?.userId ?? 0} />
      ) : brief ? (
        <AgentBrief brief={brief} />
      ) : agents.length === 0 ? (
        <div className="messages agents-list-view">
          <p className="agents-empty">
            Your coding agent is Claude Code on your laptop. It answers your questions about your team’s code and works on
            the roadmap cards you hand it.
          </p>
          <button className="button-primary agents-connect" onClick={() => setConnecting(true)}>
            Connect coding agent
          </button>
        </div>
      ) : (
        <ProjectList threads={threads} chats={chats} />
      )}
      {connecting && <AgentDialog onClose={() => setConnecting(false)} />}
      {setting && <AgentSetup onClose={() => setSetting(false)} />}
    </section>
  );
}

/**
 * A message box that sends on Enter, as the chat's does, and grows with its text. While the agent
 * works, Send turns into Stop, and the text waits.
 */
function Box(props: { name: string; placeholder: string; canSend: boolean; onSend: (text: string) => Promise<unknown>; stop?: { stopping: boolean; onStop: () => void } }) {
  const { name, placeholder, canSend, onSend, stop } = props;
  const [text, edit] = useDraft(name);
  const input = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(input, text);
  function send() {
    if (!text.trim() || !canSend) return;
    edit('');
    // Text that could not even be kept as an unsent message comes back into the box.
    onSend(text).catch(() => edit(text));
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }
  return (
    <div className="composer-row">
      <textarea ref={input} rows={1} value={text} maxLength={LIMITS.messageLength} placeholder={placeholder} onChange={(e) => edit(e.target.value)} onKeyDown={onKeyDown} />
      {stop ? (
        <button className="button-secondary agents-stop" disabled={stop.stopping} onClick={stop.onStop}>
          Stop
        </button>
      ) : (
        <button className="send-button" onClick={send} disabled={!text.trim() || !canSend} aria-label="Send">
          <SendIcon />
        </button>
      )}
    </div>
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
  const mine = useMemo(() => Object.values(projects).filter((p) => meId !== undefined && p.memberIds.includes(meId)).sort((a, b) => a.name.localeCompare(b.name)), [projects, meId]);
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
  const project = askable.find((p) => p.id === picked.project) ?? askable.find((p) => threads[0] && p.id === projectOf(threads[0])) ?? askable[0];
  const repos = project ? choicesOf(project.id) : [];
  const repo = repos.find((r) => r === picked.repo) ?? repos[0];
  const agent = project && agentIn(project.id);
  // With no repository, the agent answers from the board alone, on its laptop (R-038).
  const blocked = !agent ? 'Add your agent to one of your projects first: Add it, below.' : blockedBy(seatFor(agent, repo ?? ''));
  const loading = !!project && !linked[project.id];
  // Until a project's repositories load, the box speaks of code, as most questions are about it.
  const code = !!repo || loading;

  async function ask(text: string) {
    try {
      actions.setAgentsOpen(true, await askAgent(agent!.id, project!.id, repo || undefined, text));
    } catch (err) {
      actions.addToast({ conversationId: null, title: 'Question not sent', body: (err as Error).message });
      throw err;
    }
  }

  const item = (t: Thread, several: boolean) => (
    <li key={t.root}>
      <button className="agents-item" onClick={() => actions.setAgentsOpen(true, t.root)}>
        <span className="agents-item-text">{t.messages[0]!.text}</span>
        <span className="agents-item-meta">
          <Tag tone={THREAD_STATE[t.state].tone}>{THREAD_STATE[t.state].label}</Tag>
          {several && <span>{t.repo ? short(t.repo) : 'Board'}</span>}
          <time>{formatListTime(t.last)}</time>
        </span>
      </button>
    </li>
  );
  const elsewhere = threads.filter((t) => !mine.some((p) => p.id === projectOf(t)));

  return (
    <div className="messages agents-list-view">
      <div className="composer agents-ask">
        {project && (
          <div className="agents-repo">
            Asks in
            {askable.length > 1 ? (
              <select value={project.id} onChange={(e) => setPicked({ project: Number(e.target.value) })} aria-label="Project">
                {askable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <strong>{project.name}</strong>
            )}
            {repos.length > 1 ? (
              <select value={repo} onChange={(e) => setPicked({ project: project.id, repo: e.target.value })} aria-label="Repository">
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r ? short(r) : 'its board'}
                  </option>
                ))}
              </select>
            ) : (
              <span>{repo ? short(repo) : 'its board'}</span>
            )}
          </div>
        )}
        {blocked && <p className="composer-blocked">{blocked}</p>}
        <Box name="agents:ask" placeholder={code ? 'Ask about your code' : 'Ask about your project'} canSend={!blocked && !loading} onSend={ask} />
        <p className="agents-hint">
          {code ? 'It reads your team’s code as it is on GitHub, and catches up on each reply.' : 'Your agent answers from the project’s board alone: its decisions and cards.'}
        </p>
      </div>
      {mine.map((p) => {
        const inIt = agentIn(p.id);
        const own = threads.filter((t) => projectOf(t) === p.id);
        const list = reposOf(p.id);
        return (
          <section key={p.id} className="agents-project">
            <h3 className="agents-project-head">{p.name}</h3>
            {!inIt ? (
              <p className="agents-repos">
                Your agent is not in this project, so it cannot read its board.
                <button className="agents-forget" onClick={() => void addProjectMembers(p.id, [agents[0]!.id]).catch((err: Error) => actions.addToast({ conversationId: null, title: 'Agent not added', body: err.message }))}>
                  Add it
                </button>
              </p>
            ) : linked[p.id] && list.length === 0 ? (
              <p className="agents-repos">No repository linked, so your agent answers from the board.</p>
            ) : (
              <ul className="agents-repos">
                {list.map((r) => {
                  const [tone, label, ready] = repoState(seatFor(inIt, r));
                  return (
                    <li key={r}>
                      {short(r)} <Tag tone={tone}>{label}</Tag>
                      {/* Forgetting takes the folder's mark only, never its files (D-101). */}
                      {ready && (
                        <button className="agents-forget" onClick={() => void forgetFolder(inIt.id, r)} aria-label={`Forget the folder of ${short(r)}`}>
                          Forget
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {own.length > 0 && <ul className="agents-list">{own.map((t) => item(t, list.length > 1))}</ul>}
          </section>
        );
      })}
      {elsewhere.length > 0 && (
        <section className="agents-project">
          <h3 className="agents-project-head">Earlier questions</h3>
          <ul className="agents-list">{elsewhere.map((t) => item(t, true))}</ul>
        </section>
      )}
      {threads.length === 0 && (
        <p className="agents-empty">
          Ask how something in your team’s code works, where a bug comes from, or what a change would take. Your agent
          reads the code, or the board of a project with no code, and answers here. To change the code, hand it a card on the board.
        </p>
      )}
      {older.length > 0 && (
        <button className="load-older" onClick={() => older.forEach((c) => void loadOlder(c.id))}>
          Show earlier questions
        </button>
      )}
    </div>
  );
}

const isCancel = (m: ChatMessage) => m.prompt?.kind === 'cancel' || m.run?.kind === 'cancel';

function ThreadView({ thread, seat, agentId }: { thread: Thread; seat: Seat | undefined; agentId: number }) {
  const pending = useAppState((s) => s.pending);
  const meId = useAppState((s) => s.me?.id);
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const list = useRef<HTMLDivElement>(null);
  const [notNow, setNotNow] = useState(false);
  const working = thread.state === 'working';
  const paused = thread.state === 'paused';
  const last = thread.messages.at(-1)!;
  const stopping = (working || paused) && isCancel(last) && pending[last.clientId ?? ''] !== 'failed';
  // A card's conversation: its request, which a stop and the owner's go name (D-105).
  const request = thread.kind === 'card' ? (thread.messages[0] as ChatMessage & { run: RunRequest }) : undefined;
  const review = thread.state === 'waiting' ? thread.messages.findLast((m) => m.run?.kind === 'review') : undefined;
  // The laptop has no copy of the repository, and the run or turn waits for the owner's word (R-036).
  const nocopy = thread.state === 'waiting' ? thread.messages.findLast((m) => m.run?.kind === 'nocopy' || m.prompt?.kind === 'nocopy') : undefined;
  // A run that waits for a decision goes on once its owner added the decision and gave the go (R-042).
  const decision = thread.state === 'waiting' ? thread.messages.findLast((m) => m.run?.kind === 'decision' && m.run.card) : undefined;
  const decided = decision && thread.added[decision.clientId ?? ''];
  const stop = () => void (request ? cancelRun(request) : tellAgent(thread.conversationId, thread.root, 'cancel', 'Stop'));
  const again = () => {
    const projectId = threadProject(thread, docs, conversations);
    if (projectId) actions.openBrief({ projectId, docId: request!.run.docId, section: request!.run.section });
  };
  // A turn can take long, so the time it has taken shows, a minute at a time.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The newest message stays in view as answers come in.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.messages.length]);

  const blocked = blockedBy(seat);
  let waiting: string;
  if (stopping) waiting = 'Stopping…';
  else if (!seat?.online) {
    waiting = `Your laptop isn’t answering, so no answer can come yet. ${WAKE} If this waits more than 10 minutes, your agent will ask you to send it again.`;
  } else {
    const minutes = Math.floor((now - (thread.messages.findLast((m) => m.senderId === meId && !isCancel(m))?.createdAt ?? thread.last)) / 60_000);
    waiting = `${minutes > 0 ? `Working… ${minutes} min` : 'Working…'}${thread.progress ? ` · ${thread.progress}` : ''}`;
  }

  return (
    <>
      <div className="messages" ref={list}>
        {thread.messages.map((message, i) => {
          const status = message.clientId ? pending[message.clientId] : undefined;
          const unsent = status === 'failed' && (
            <div className="send-failed-row">
              <button className="send-failed" onClick={() => retryMessage(message)}>
                <AlertIcon width={14} height={14} /> Not sent. Tap to retry.
              </button>
              <button className="send-discard" onClick={() => discardMessage(message)}>
                Remove
              </button>
            </div>
          );
          if (isCancel(message)) {
            return (
              <div key={message.clientId ?? message.id}>
                <p className="agents-note">You asked it to stop.</p>
                {unsent}
              </div>
            );
          }
          const mine = message.senderId === meId;
          const first = thread.messages[i - 1]?.senderId !== message.senderId;
          // What a run asks of the board: its card's new status, a decision it waits for, or a change after its work (R-042).
          const draft = message.run?.kind === 'stale' || message.run?.kind === 'decision' || message.run?.kind === 'draft' ? message.run.card : undefined;
          return (
            <div key={message.clientId ?? message.id} className={`bubble-row ${mine ? 'mine' : 'theirs'} ${first ? 'first' : ''}`}>
              <div className="bubble-line">
                <div className={`bubble ${message.prompt?.kind === 'failed' || message.run?.kind === 'failed' ? 'agents-failed' : ''}`}>
                  {/* A review is teammates' text that would run with the owner's login, so nothing of it hides in Markdown. */}
                  {mine || message.run?.kind === 'review' ? (
                    <span className="bubble-text">{message.text}</span>
                  ) : message.prompt?.kind === 'answer' && message.prompt.card ? (
                    <AgentDraft message={message} draft={message.prompt.card} thread={thread} agentId={agentId} />
                  ) : message.board?.kind === 'proposal' ? (
                    <AgentDraft message={message} draft={message.board.card} thread={thread} agentId={agentId} />
                  ) : draft ? (
                    <>
                      {message.run?.kind !== 'draft' && <Markdown text={message.text} />}
                      <AgentDraft message={message} draft={draft} thread={thread} agentId={agentId} />
                    </>
                  ) : (
                    <Markdown text={message.text} />
                  )}
                  {!mine && message.run && 'pull' in message.run && message.run.pull && message.run.kind === 'done' && (
                    <a href={`https://github.com/${message.run.pull.repo}/pull/${message.run.pull.number}`} target="_blank" rel="noopener noreferrer">
                      Open the draft on GitHub
                    </a>
                  )}
                  <span className="bubble-meta">{status === 'sending' ? 'Sending…' : formatTime(message.createdAt)}</span>
                </div>
              </div>
              {message === review && !notNow && (
                <div className="agents-draft-actions">
                  <button className="button-primary" disabled={!!blocked} onClick={() => void askFix(thread.conversationId, request!.id, '', review.id)}>
                    Let the agent fix it
                  </button>
                  <button className="button-secondary" onClick={() => setNotNow(true)}>
                    Not now
                  </button>
                </div>
              )}
              {message === decision && decided && (
                <div className="agents-draft-actions">
                  <button className="button-primary" disabled={!!blocked} onClick={() => void askFix(thread.conversationId, request!.id, `I added the decision as ${decided}. Go on with the work.`)}>
                    Go on with {decided}
                  </button>
                </div>
              )}
              {message === nocopy && (
                <div className="agents-draft-actions">
                  <button className="button-primary" disabled={!!blocked} onClick={() => void askClone(thread.conversationId, thread.repo, request ? { request: request.id } : { to: thread.root })}>
                    Clone it
                  </button>
                </div>
              )}
              {unsent}
            </div>
          );
        })}
        {working && <p className="agents-note">{waiting}</p>}
      </div>
      <footer className="composer">
        {/* A proposal is the repository's: it waits for Add or Update, and takes no reply (R-040). */}
        {thread.kind === 'proposal' ? null : thread.state === 'ended' ? (
          <div className="agents-ended">
            <p className="composer-blocked">This conversation ended after a day with no reply.</p>
            <button
              className="button-secondary"
              onClick={() => {
                saveDraft('agents:ask', thread.messages[0]!.text);
                actions.setAgentsOpen(true);
              }}
            >
              Ask again
            </button>
          </div>
        ) : paused ? (
          // The owner's words resume the run's session; a second stop ends it, and Start again follows (docs/decisions/stop-pauses-run.md).
          <>
            <div className="agents-ended">
              <p className="composer-blocked">Stopped. Tell it what to change, or start over.</p>
              <button className="button-secondary" disabled={stopping} onClick={stop}>
                {stopping ? 'Stopping…' : 'Start over'}
              </button>
            </div>
            <Box name={`agents:${thread.root}`} placeholder="Tell it what to change" canSend={!blocked && !stopping} onSend={(text) => askFix(thread.conversationId, request!.id, text)} />
          </>
        ) : thread.state === 'unfinished' ? (
          <div className="agents-ended">
            <p className="composer-blocked">It stopped before a draft was ready.</p>
            <button className="button-secondary" onClick={again}>
              Start again
            </button>
          </div>
        ) : thread.state === 'done' || thread.state === 'stale' || (request && (thread.state === 'unsent' || nocopy)) ? null : (
          <>
            {!working && blocked && <p className="composer-blocked">{blocked}</p>}
            <Box
              name={`agents:${thread.root}`}
              placeholder={request ? 'Ask for changes to the draft' : 'Reply'}
              canSend={!blocked && !working}
              // While a review waits, a reply is the go for it too, unless the owner said Not now.
              onSend={(text) => (request ? askFix(thread.conversationId, request.id, text, notNow ? undefined : review?.id) : tellAgent(thread.conversationId, thread.root, 'reply', text))}
              stop={working ? { stopping, onStop: stop } : undefined}
            />
          </>
        )}
      </footer>
    </>
  );
}
