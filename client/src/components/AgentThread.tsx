// One conversation with the user's coding agent, as the Coding agents pane shows it and, for a card's
// run, the card's peek beside the card (the card-run-in-peek decision, proposed in #259).
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { LIMITS, takesControls, type RunRequest, type SessionEventDTO } from '../../../shared/types';
import { blockedBy, THREAD_STATE, threadProject, WAKE, type Seat, type Thread } from '../agents';
import { answerPermit, askClone, askFix, cancelRun, discardMessage, loadSteps, retryMessage, saveDraft, tellAgent } from '../chat';
import type { ChatMessage } from '../e2ee/keyring';
import { actions, useAppState } from '../store';
import { FileBubble, useAutoGrow, useDraft } from './ChatView';
import { formatAgo, formatTime } from './format';
import { AlertIcon, SendIcon, StopIcon } from './icons';
import { AgentDraft } from './AgentDraft';
import { Markdown } from './Markdown';
import { QuestionCard } from './AgentAsks';
import { RunAsk, RunPanel, RunStep } from './RunPanel';
import { Controls, Summary, type Choice } from './SessionControls';
import { SessionDetails } from './SessionDetails';
import { SessionSteps } from './SessionSteps';

/**
 * A message box that sends on Enter, as the chat's does, and grows with its text. While the agent
 * works, Send turns into Stop, and the text waits.
 */
export function Box(props: {
  name: string;
  placeholder: string;
  canSend: boolean;
  onSend: (text: string) => Promise<unknown>;
  stop?: { stopping: boolean; onStop: () => void };
  /** The harness's own commands and skills, offered after a slash (R-072). */
  commands?: string[];
  /** The model button, between the text and the round button, in the pane's pill box. */
  model?: ReactNode;
  pill?: boolean;
}) {
  const { name, placeholder, canSend, onSend, stop, commands, model, pill } = props;
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
  // A slash and a word offer the commands that start with it; a space ends the offer.
  const typed = /^\/([\w:.-]*)$/.exec(text)?.[1];
  const offered = typed === undefined ? [] : (commands ?? []).filter((c) => c.startsWith(typed)).slice(0, 6);
  return (
    <>
    {offered.length > 0 && (
      <List edge="flush">
        {offered.map((c) => (
          <ListItem key={c} label={`/${c}`} onClick={() => edit(`/${c} `)} />
        ))}
      </List>
    )}
    <div className={pill ? 'composer-row agents-pill' : 'composer-row'}>
      <textarea
        ref={input}
        rows={1}
        value={text}
        maxLength={LIMITS.messageLength}
        placeholder={placeholder}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {model}
      {/* One round button: it stops a running turn while the box is empty, and sends otherwise (R-072). */}
      {pill ? (
        // The pill box's round button, in the text color, as the design draws it.
        stop && !text.trim() ? (
          <button type="button" className="agents-send" aria-label="Stop" title="Stop" disabled={stop.stopping} onClick={stop.onStop}>
            <StopIcon width={14} height={14} />
          </button>
        ) : (
          <button type="button" className="agents-send" aria-label="Send" disabled={!text.trim() || !canSend} onClick={send}>
            <ArrowUpIcon />
          </button>
        )
      ) : stop && !text.trim() ? (
        <IconButton variant="primary" label="Stop" icon={<StopIcon />} isDisabled={stop.stopping} onClick={stop.onStop} />
      ) : (
        <IconButton
          variant="primary"
          label="Send"
          icon={<SendIcon />}
          onClick={send}
          isDisabled={!text.trim() || !canSend}
        />
      )}
    </div>
    </>
  );
}

const isCancel = (m: ChatMessage) => m.prompt?.kind === 'cancel' || m.run?.kind === 'cancel';

export function AgentThread({
  thread,
  seat,
  agentId,
  inForm,
  details,
  panel,
}: {
  thread: Thread;
  seat: Seat | undefined;
  agentId: number;
  /** In the new card form, its box asks for the draft with the form's fields as they stand (R-071). */
  inForm?: (text: string) => Promise<unknown>;
  /** Shows what the session runs with beside it, as the pane does (R-072). */
  details?: boolean;
  /** Reads as a run's panel beside its card: a heading with where it stands, and each message as a step, not a bubble (R-047). */
  panel?: boolean;
}) {
  const pending = useAppState((s) => s.pending);
  const meId = useAppState((s) => s.me?.id);
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const list = useRef<HTMLDivElement>(null);
  const [notNow, setNotNow] = useState(false);
  const working = thread.state === 'working';
  const asking = thread.state === 'asking';
  const paused = thread.state === 'paused';
  const planned = thread.state === 'planned';
  const last = thread.messages.at(-1)!;
  const stopping =
    (working || asking || paused || planned) && isCancel(last) && pending[last.clientId ?? ''] !== 'failed';
  // A card's conversation: its request, which a stop and the owner's go name (D-105).
  const request = thread.kind === 'card' ? (thread.messages[0] as ChatMessage & { run: RunRequest }) : undefined;
  const review = thread.state === 'waiting' ? thread.messages.findLast((m) => m.run?.kind === 'review') : undefined;
  // The laptop has no copy of the repository, and the run or turn waits for the owner's word (R-036).
  const nocopy =
    thread.state === 'waiting'
      ? thread.messages.findLast((m) => m.run?.kind === 'nocopy' || m.prompt?.kind === 'nocopy')
      : undefined;
  // A run that waits for a decision goes on once its owner added the decision and gave the go (R-042).
  const decision =
    thread.state === 'waiting' ? thread.messages.findLast((m) => m.run?.kind === 'decision' && m.run.card) : undefined;
  const decided = decision && thread.added[decision.clientId ?? ''];
  // The session's controls, for an agent that takes them: the model, effort and mode the next reply carries (R-072).
  const controls = thread.kind === 'question' && !inForm && !!seat && takesControls(seat.protocol);
  const [choice, setChoice] = useState<Choice>({});
  // Make a card: the session drafts one of the kind picked, into the board's new card form (R-071).
  const [kinds, setKinds] = useState(false);
  const makeCard = (cardKind: 'R' | 'K' | 'D') => {
    setKinds(false);
    const projectId = thread.project;
    if (projectId === undefined) return;
    actions.openNewCard({ projectId, kind: cardKind, session: thread.root });
    void tellAgent(thread.conversationId, thread.root, 'reply', 'Make a card of this.', { card: { kind: cardKind, title: '', body: '' } });
  };
  const stop = () =>
    void (request ? cancelRun(request) : tellAgent(thread.conversationId, thread.root, 'cancel', 'Stop'));
  const again = () => {
    const projectId = threadProject(thread, docs, conversations);
    if (projectId) actions.openBrief({ projectId, docId: request!.run.docId, section: request!.run.section });
  };
  // A turn can take long, so the time it has taken shows, a minute at a time.
  const [now, setNow] = useState(Date.now);
  const askDays = thread.ask ? Math.max(1, Math.round((thread.ask.message.permit.expires - now) / 86_400_000)) : 0;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The newest message stays in view as answers and steps come in.
  const steps = thread.steps ?? [];
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.messages.length, steps.length]);
  // A question's steps page apart from the chat's history, back to its prompt (R-072).
  const since = thread.kind === 'question' ? thread.messages[0]!.id : 0;
  useEffect(() => {
    if (since > 0) void loadSteps(thread.conversationId, since).catch(() => undefined);
  }, [thread.conversationId, since]);
  // Each message's steps, those after the message before it, in one pass, as both lists go by id; a message still sending has no id yet.
  const buckets = useMemo(() => {
    const out: SessionEventDTO[][] = thread.messages.map(() => []).concat([[]]);
    let i = 0;
    for (const s of steps) {
      while (i < thread.messages.length && (thread.messages[i]!.id <= 0 ? Infinity : thread.messages[i]!.id) < s.id) i++;
      out[i]!.push(...s.events);
    }
    return out;
  }, [thread.messages, steps]);
  const stepsBefore = (i: number) => buckets[i]!.length > 0 && <SessionSteps events={buckets[i]!} />;
  const newest = steps.at(-1);
  // What the session runs with, once it said anything, beside the timeline (R-072).
  const rail = !!details && (steps.length > 0 || !!thread.about);
  const [showDetails, setShowDetails] = useState(false);

  const blocked = blockedBy(seat);
  let waiting: string;
  if (stopping) waiting = 'Stopping…';
  else if (!seat?.online) {
    waiting = `Your laptop isn’t answering, so no answer can come yet. ${WAKE} If this waits more than 10 minutes, your agent will ask you to send it again.`;
  } else {
    const minutes = Math.floor(
      (now - (thread.messages.findLast((m) => m.senderId === meId && !isCancel(m))?.createdAt ?? thread.last)) / 60_000,
    );
    // What it does now, from its newest step, and how old that is: steps come only with a check-in (R-072).
    const step = newest?.events.at(-1);
    const doing = step ? `${step.title} · ${formatAgo(newest!.at)}` : thread.progress;
    waiting = `${minutes > 0 ? `Working… ${minutes} min` : 'Working…'}${doing ? ` · ${doing}` : ''}`;
  }

  const rows = (
    <>
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
                {stepsBefore(i)}
                <Text as="p" color="secondary">
                  You asked it to stop.
                </Text>
                {unsent}
              </div>
            );
          }
          const mine = message.senderId === meId;
          const first = thread.messages[i - 1]?.senderId !== message.senderId;
          // What a run asks of the board: its card's new status, a decision it waits for, or a change after its work (R-042).
          const draft =
            message.run?.kind === 'stale' || message.run?.kind === 'decision' || message.run?.kind === 'draft'
              ? message.run.card
              : undefined;
          const body = (
            <>
                  {/* A review is teammates' text that would run with the owner's login, so nothing of it hides in Markdown. */}
                  {mine || message.run?.kind === 'review' || message.permit?.kind === 'question' ? (
                    <span className="bubble-text">{message.text}</span>
                  ) : message.prompt?.kind === 'summary' ? (
                    <Summary thread={thread} message={message} />
                  ) : message.prompt?.kind === 'answer' && message.prompt.card ? (
                    <AgentDraft message={message} draft={message.prompt.card} thread={thread} agentId={agentId} />
                  ) : message.board?.kind === 'proposal' ? (
                    <AgentDraft message={message} draft={message.board.card} thread={thread} agentId={agentId} />
                  ) : draft ? (
                    <>
                      {message.run?.kind !== 'draft' && <Markdown text={message.text} />}
                      <AgentDraft message={message} draft={draft} thread={thread} agentId={agentId} />
                    </>
                  ) : message.file ? (
                    // A run's screenshot (R-046): its caption is the model's, so it shows as plain text.
                    <>
                      <FileBubble file={message.file} sentAt={message.createdAt} />
                      <span className="bubble-text">{message.text}</span>
                    </>
                  ) : (
                    <Markdown text={message.text} />
                  )}
                  {!mine && message.run && 'pull' in message.run && message.run.pull && message.run.kind === 'done' && (
                    <a
                      href={`https://github.com/${message.run.pull.repo}/pull/${message.run.pull.number}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open the draft on GitHub
                    </a>
                  )}
            </>
          );
          const time = status === 'sending' ? 'Sending…' : formatTime(message.createdAt);
          const failed = message.prompt?.kind === 'failed' || message.run?.kind === 'failed';
          const after = (
            <>
              {message === review && !notNow && (
                <div className="agents-draft-actions">
                  <Button
                    variant="primary"
                    label="Let the agent fix it"
                    isDisabled={!!blocked}
                    onClick={() => void askFix(thread.conversationId, request!.id, '', review.id)}
                  />
                  <Button label="Not now" onClick={() => setNotNow(true)} />
                </div>
              )}
              {message === decision && decided && (
                <div className="agents-draft-actions">
                  <Button
                    variant="primary"
                    label={`Go on with ${decided}`}
                    isDisabled={!!blocked}
                    onClick={() =>
                      void askFix(
                        thread.conversationId,
                        request!.id,
                        `I added the decision as ${decided}. Go on with the work.`,
                      )
                    }
                  />
                </div>
              )}
              {message === nocopy && (
                <div className="agents-draft-actions">
                  <Button
                    variant="primary"
                    label="Clone it"
                    isDisabled={!!blocked}
                    onClick={() =>
                      void askClone(
                        thread.conversationId,
                        thread.repo,
                        request ? { request: request.id } : { to: thread.root },
                      )
                    }
                  />
                </div>
              )}
              {unsent}
            </>
          );
          return (
            <Fragment key={message.clientId ?? message.id}>
              {stepsBefore(i)}
              {panel ? (
                <>
                  <RunStep time={time} isMine={mine} isFailed={failed}>
                    {body}
                  </RunStep>
                  {after}
                </>
              ) : (
                <div className={`bubble-row ${mine ? 'mine' : 'theirs'} ${first ? 'first' : ''}`}>
                  <div className="bubble-line">
                    <div className={`bubble ${failed ? 'agents-failed' : ''}`}>
                      {body}
                      <span className="bubble-meta">{time}</span>
                    </div>
                  </div>
                  {after}
                </div>
              )}
            </Fragment>
          );
        })}
        {stepsBefore(thread.messages.length)}
        {working && (
          <Text as="p" color="secondary">
            {waiting}
          </Text>
        )}
    </>
  );
  const foot = (
    <>
        {/* A proposal is the repository's: it waits for Add or Update, and takes no reply (R-040). */}
        {thread.kind === 'proposal' ? null : thread.state === 'ended' ? (
          <div className="agents-ended">
            <Banner status="info" title="This conversation ended after a day with no reply." />
            <Button
              label="Ask again"
              onClick={() => {
                saveDraft('agents:ask', thread.messages[0]!.text);
                actions.setAgentsOpen(true);
              }}
            />
          </div>
        ) : paused || planned ? (
          // The owner's words resume the run's session; a second stop ends it, and Start again follows (docs/decisions/stop-pauses-run.md).
          // A plan goes on with their go too, and a stop ends it (docs/decisions/redirect-plan-gate.md).
          <>
            <div className="agents-ended">
              <Banner
                status="info"
                title={
                  planned
                    ? 'Go on with this plan, or tell it what to change.'
                    : 'Stopped. Tell it what to change, or start over.'
                }
              />
              {planned && (
                <Button
                  variant="primary"
                  label="Go"
                  isDisabled={!!blocked || stopping}
                  onClick={() => void askFix(thread.conversationId, request!.id, '')}
                />
              )}
              <Button
                label={stopping ? 'Stopping…' : planned ? 'Stop' : 'Start over'}
                isDisabled={stopping}
                onClick={stop}
              />
            </div>
            <Box
              name={`agents:${thread.root}`}
              placeholder="Tell it what to change"
              canSend={!blocked && !stopping}
              onSend={(text) => askFix(thread.conversationId, request!.id, text)}
            />
          </>
        ) : thread.state === 'unfinished' ? (
          <div className="agents-ended">
            <Banner status="info" title="It stopped before a draft was ready." />
            <Button label="Start again" onClick={again} />
          </div>
        ) : thread.state === 'done' ||
          thread.state === 'stale' ||
          (request && (thread.state === 'unsent' || nocopy)) ? null : (
          <>
            {!working && blocked && <Banner status="warning" title={blocked} />}
            {/* The question docks above the box until it is answered; it stays in the timeline as plain text (R-072). */}
            {thread.ask &&
              (panel ? (
                <RunAsk
                  text={thread.ask.message.text}
                  days={askDays}
                  isDisabled={!!blocked || thread.ask.answered}
                  onAnswer={(decision) => void answerPermit(thread.conversationId, thread.ask!.message, decision)}
                />
              ) : (
                <QuestionCard
                  key={thread.ask.message.clientId}
                  text={thread.ask.message.text}
                  days={askDays}
                  answered={thread.ask.answered}
                  isDisabled={!!blocked}
                  onAnswer={(decision) => void answerPermit(thread.conversationId, thread.ask!.message, decision)}
                />
              ))}
            {/* A session with no card yet can become one, of the kind picked (R-071); in the new card form it already drafts one. */}
            {thread.kind === 'question' && thread.project !== undefined && !inForm && !working && !asking && !blocked && (
              <div className="agents-chip-row">
                <button type="button" className="agents-chip" aria-expanded={kinds} onClick={() => setKinds(!kinds)}>
                  <CardPlusIcon />
                  Make a card
                </button>
                {kinds &&
                  CARD_KINDS.map(([kind, label]) => (
                    <button key={kind} type="button" className="agents-chip" onClick={() => makeCard(kind)}>
                      {label}
                    </button>
                  ))}
              </div>
            )}
            <Box
              name={`agents:${thread.root}`}
              placeholder={
                panel
                  ? request
                    ? 'Ask for changes to the draft'
                    : 'Reply'
                  : // In the window, the box says what a reply does now, as the design words it.
                    asking
                    ? 'Answer your agent'
                    : working
                      ? 'Tell your agent something'
                      : request
                        ? 'Ask for a change'
                        : 'Ask a follow-up'
              }
              canSend={!blocked && !working && !asking}
              // While a review waits, a reply is the go for it too, unless the owner said Not now.
              onSend={(text) =>
                request
                  ? askFix(thread.conversationId, request.id, text, notNow ? undefined : review?.id)
                  : inForm
                    ? inForm(text)
                    : tellAgent(thread.conversationId, thread.root, 'reply', text, choice)
              }
              stop={working || asking ? { stopping, onStop: stop } : undefined}
              commands={thread.about?.commands}
              pill={!panel}
              model={
                controls && (
                  <Controls
                    thread={thread}
                    agent={seat!.agent}
                    choice={choice}
                    onChoice={setChoice}
                    isDisabled={!!blocked || working || asking}
                  />
                )
              }
            />
            {!panel && <WhereItRuns thread={thread} seat={seat} />}
          </>
        )}
    </>
  );
  if (panel)
    return (
      <RunPanel started={formatAgo(thread.messages[0]!.createdAt)} state={THREAD_STATE[thread.state]} listRef={list} footer={foot}>
        {rows}
      </RunPanel>
    );
  return (
    <>
      <div className="agents-session">
      {/* On a phone the details hide behind a button, which shows only there. */}
      {rail && (
        <Button
          className="agents-details-toggle"
          size="sm"
          variant="ghost"
          label={showDetails ? 'Hide details' : 'Details'}
          onClick={() => setShowDetails(!showDetails)}
        />
      )}
      <div className="messages" ref={list}>
        {rows}
      </div>
      {rail && (
        <aside className={`agents-rail${showDetails ? ' is-open' : ''}`}>
          <SessionDetails thread={thread} />
        </aside>
      )}
      </div>
      <footer className="composer">
        {foot}
      </footer>
    </>
  );
}

const CARD_KINDS = [
  ['R', 'Idea'],
  ['K', 'Issue'],
  ['D', 'Decision'],
] as const;

const ArrowUpIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

const CardPlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="12" y1="9" x2="12" y2="15" />
    <line x1="9" y1="12" x2="15" y2="12" />
  </svg>
);

/** About 200k tokens, the context most of these models start from; the ring is a guide, not a limit. */
const CONTEXT_GUIDE = 200_000;

/**
 * Where a session runs, under its box: its branch, its laptop, whether it runs in the user's own
 * setup or restricted by WebChat, and how much context its newest turn sent (R-072). A session's
 * setup is fixed when it starts (D-157), so the mode reads, it does not switch.
 */
function WhereItRuns({ thread, seat }: { thread: Thread; seat: Seat | undefined }) {
  const about = thread.about ?? {};
  // A card's branch is the one its run left, which its done report names.
  const done = thread.messages.findLast((m) => m.run && 'branch' in m.run && m.run.branch)?.run;
  const name = about.branch ?? (done && 'branch' in done ? done.branch : undefined);
  const own = about.own ?? false;
  const k = about.context === undefined ? undefined : Math.round(about.context / 1000);
  const used = about.context === undefined ? undefined : Math.min(100, Math.round((about.context / CONTEXT_GUIDE) * 100));
  return (
    <div className="agents-where">
      {name && (
        <span title="Its branch">
          <BranchIcon />
          {name}
        </span>
      )}
      {seat && (
        <span title="Its laptop">
          <LaptopIcon />
          {seat.agent.displayName}
        </span>
      )}
      {(thread.kind === 'card' || about.own !== undefined) && (
        <span
          className={own ? 'is-own' : undefined}
          title={
            own
              ? 'Runs in your folder with your own settings, hooks, plugins, MCP servers and permission rules, and no sandbox of WebChat’s.'
              : 'Runs in WebChat’s sandbox: it changes only its own branch, and never reads your settings or secrets.'
          }
        >
          <ShieldIcon own={own} />
          {own ? 'Your own setup' : 'Restricted by WebChat'}
        </span>
      )}
      <span className="agents-where-gap" />
      {used !== undefined && (
        <span className="agents-ring" role="img" aria-label={`${k}k tokens sent in the newest turn, about ${used}% of a 200k context`} title={`${k}k tokens in the newest turn`}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8" stroke="var(--line)" strokeWidth="3" />
            <circle cx="12" cy="12" r="8" stroke={used > 80 ? 'var(--warn)' : 'var(--muted)'} strokeWidth="3" strokeLinecap="round" pathLength={100} strokeDasharray={`${used} 100`} transform="rotate(-90 12 12)" />
          </svg>
        </span>
      )}
    </div>
  );
}

export const BranchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="7" r="2" />
    <path d="M6 7v10" />
    <path d="M18 9c0 5-6 4-11 8" />
  </svg>
);

export const LaptopIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="5" width="16" height="11" rx="1" />
    <line x1="2" y1="19" x2="22" y2="19" />
  </svg>
);

export const ShieldIcon = ({ own }: { own: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
    {own ? (
      <>
        <line x1="12" y1="8" x2="12" y2="12.5" />
        <circle cx="12" cy="15.5" r=".6" fill="currentColor" />
      </>
    ) : (
      <polyline points="9 12 11 14 15 10" />
    )}
  </svg>
);
