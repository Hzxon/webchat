// The Coding agents pane (R-035, D-103): the user asks their coding agent about a repository and
// reads its answers. It takes the chat's place, with a back button on phones. A conversation is a
// prompt and the messages that name it, in the user's direct chat with the agent (D-102).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AGENT_LEVEL, LIMITS, type RunRequest } from '../../../shared/types';
import { asleep, ownAgents, ready, seatFor, seatKey, short, THREAD_STATE, useAgentThreads, WAKE, type Seat, type Thread } from '../agents';
import { askAgent, askClone, askFix, cancelRun, discardMessage, loadChat, loadOlder, retryMessage, saveDraft, tellAgent } from '../chat';
import type { ChatConversation, ChatMessage } from '../e2ee/keyring';
import { actions, useAppState } from '../store';
import { useAutoGrow, useDraft } from './ChatView';
import { formatListTime, formatTime } from './format';
import { AlertIcon, BackIcon, SendIcon, TerminalIcon } from './icons';
import { AgentBrief } from './AgentBrief';
import { AgentDraft } from './AgentDraft';
import { Markdown } from './Markdown';
import { Tag } from './PullTags';


/** Why a question or reply cannot go to a session now, in plain words, or '' when it can. */
function blockedBy(seat: Seat | undefined) {
  if (!seat) return 'Your agent has no repository on your laptop yet. Start a card from your project’s board, and it offers to clone the repository.';
  // A session on an older plugin checks in, but never answers (D-103).
  if (seat.protocol < AGENT_LEVEL.answers) return `${short(seat.repo)} has an older WebChat plugin, which cannot answer questions. In Claude Code, type /plugin, open Installed, choose webchat, then Update now.`;
  if (!seat.online) return `${asleep(seat)}. ${WAKE}`;
  return '';
}

export function AgentsView() {
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const open = useAppState((s) => s.agentThread);
  const brief = useAppState((s) => s.agentBrief);
  const { chats, threads } = useAgentThreads();
  const agents = useMemo(() => ownAgents(users, meId), [users, meId]);
  const seats = useMemo(() => agents.flatMap((agent) => agent.agentRepos.flatMap((s) => seatFor(agent, s.repo) ?? [])), [agents]);
  const thread = threads.find((t) => t.root === open);
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

  let subtitle = 'Not connected to a repository yet';
  if (thread) subtitle = `${thread.kind === 'card' ? 'Runs' : 'Asked'} in ${short(thread.repo)} · ${THREAD_STATE[thread.state].label}`;
  else if (brief) subtitle = 'Before it starts';
  else if (seats.length === 1) subtitle = seats[0]!.online ? `${short(seats[0]!.repo)} is online` : asleep(seats[0]!);
  else if (seats.length > 1) subtitle = `${seats.filter((s) => s.online).length} of ${seats.length} repositories online`;
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
      </header>
      {thread ? (
        <ThreadView key={thread.root} thread={thread} seat={seatOf(thread)} agentId={conversations[thread.conversationId]?.members.find((m) => m.userId !== meId)?.userId ?? 0} />
      ) : brief ? (
        <AgentBrief brief={brief} />
      ) : (
        <ThreadList threads={threads} seats={seats} chats={chats} />
      )}
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

function ThreadList({ threads, seats, chats }: { threads: Thread[]; seats: Seat[]; chats: ChatConversation[] }) {
  const [picked, setPicked] = useState('');
  const messages = useAppState((s) => s.messages);
  const complete = useAppState((s) => s.historyComplete);
  // A chat loads its newest page first, so older conversations wait for a tap.
  const older = chats.filter((c) => messages[c.id] && !complete[c.id]);
  // The repository picked, else the newest conversation's while it can answer, else the first that can.
  const seat = seats.find((s) => seatKey(s) === picked) ?? seats.find((s) => ready(s) && s.repo === threads[0]?.repo) ?? seats.find(ready) ?? seats[0];
  const several = new Set(seats.map((s) => s.agent.id)).size > 1;
  const blocked = blockedBy(seat);

  async function ask(text: string) {
    try {
      actions.setAgentsOpen(true, await askAgent(seat!.agent.id, seat!.repo, text));
    } catch (err) {
      actions.addToast({ conversationId: null, title: 'Question not sent', body: (err as Error).message });
      throw err;
    }
  }

  return (
    <div className="messages agents-list-view">
      <div className="composer agents-ask">
        {seats.length > 1 ? (
          <label className="agents-repo">
            Asks in
            <select value={seat ? seatKey(seat) : ''} onChange={(e) => setPicked(e.target.value)}>
              {seats.map((s) => (
                <option key={seatKey(s)} value={seatKey(s)}>
                  {short(s.repo)}
                  {several ? ` on ${s.agent.displayName}` : ''}
                  {s.online ? '' : ' (asleep)'}
                </option>
              ))}
            </select>
          </label>
        ) : (
          seat && <p className="agents-repo">Asks in {short(seat.repo)}</p>
        )}
        {blocked && <p className="composer-blocked">{blocked}</p>}
        <Box name="agents:ask" placeholder="Ask about your code" canSend={!blocked} onSend={ask} />
        <p className="agents-hint">It reads your team’s code as it is on GitHub. After a push, ask a new question to see it.</p>
      </div>
      {threads.length > 0 ? (
        <ul className="agents-list">
          {threads.map((t) => (
            <li key={t.root}>
              <button className="agents-item" onClick={() => actions.setAgentsOpen(true, t.root)}>
                <span className="agents-item-text">{t.messages[0]!.text}</span>
                <span className="agents-item-meta">
                  <Tag tone={THREAD_STATE[t.state].tone}>{THREAD_STATE[t.state].label}</Tag>
                  {seats.length > 1 && <span>{short(t.repo)}</span>}
                  <time>{formatListTime(t.last)}</time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="agents-empty">
          Ask how something in your team’s code works, where a bug comes from, or what a change would take. Your agent
          reads the code on your laptop and answers here. To change the code, hand it a card on the board.
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
  const last = thread.messages.at(-1)!;
  const stopping = working && isCancel(last) && pending[last.clientId ?? ''] !== 'failed';
  // A card's conversation: its request, which a stop and the owner's go name (D-105).
  const request = thread.kind === 'card' ? (thread.messages[0] as ChatMessage & { run: RunRequest }) : undefined;
  const review = thread.state === 'waiting' ? thread.messages.findLast((m) => m.run?.kind === 'review') : undefined;
  // The laptop has no copy of the repository, and the run or turn waits for the owner's word (R-036).
  const nocopy = thread.state === 'waiting' ? thread.messages.findLast((m) => m.run?.kind === 'nocopy' || m.prompt?.kind === 'nocopy') : undefined;
  const stop = () => void (request ? cancelRun(request) : tellAgent(thread.conversationId, thread.root, 'cancel', 'Stop'));
  const again = () => {
    const projectId = conversations[docs[request!.run.docId]?.conversationId ?? 0]?.projectId;
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
    const minutes = Math.floor((now - thread.messages.findLast((m) => m.senderId === meId && !isCancel(m))!.createdAt) / 60_000);
    waiting = minutes > 0 ? `Working… ${minutes} min` : 'Working…';
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
          return (
            <div key={message.clientId ?? message.id} className={`bubble-row ${mine ? 'mine' : 'theirs'} ${first ? 'first' : ''}`}>
              <div className="bubble-line">
                <div className={`bubble ${message.prompt?.kind === 'failed' || message.run?.kind === 'failed' ? 'agents-failed' : ''}`}>
                  {/* A review is teammates' text that would run with the owner's login, so nothing of it hides in Markdown. */}
                  {mine || message.run?.kind === 'review' ? (
                    <span className="bubble-text">{message.text}</span>
                  ) : message.prompt?.kind === 'answer' && message.prompt.card ? (
                    <AgentDraft message={message} draft={message.prompt.card} thread={thread} agentId={agentId} />
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
        {thread.state === 'ended' ? (
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
        ) : thread.state === 'unfinished' ? (
          <div className="agents-ended">
            <p className="composer-blocked">It stopped before a draft was ready.</p>
            <button className="button-secondary" onClick={again}>
              Start again
            </button>
          </div>
        ) : thread.state === 'done' || (request && (thread.state === 'unsent' || nocopy)) ? null : (
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
