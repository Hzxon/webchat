import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import type { QuotedMessage } from '../../../shared/e2ee';
import { githubCardEvent } from '../../../shared/github';
import { LIMITS, RUN_PICKUP_MS, type GithubCardDTO, type PullCardDTO, type PullEvent, type RunReport, type RunRequest } from '../../../shared/types';
import { seatFor } from '../agents';
import { holdReloadWhile } from '../build';
import { cancelRun, discardMessage, loadDraft, loadOlder, quoteOf, react, retryMessage, saveDraft, sendMessage } from '../chat';
import type { ChatConversation, ChatMessage } from '../e2ee/keyring';
import { actions, chatTitle, otherMemberId, senderName, useAppState, type MessageReactions, type State } from '../store';
import { Avatar, nameColor } from './Avatar';
import { dayLabel, formatTime, linkify, presenceText } from './format';
import {
  AlertIcon,
  BackIcon,
  BellRingIcon,
  ClockIcon,
  CloseIcon,
  LockIcon,
  LockOpenIcon,
  PullRequestIcon,
  ReplyIcon,
  SendIcon,
  SmilePlusIcon,
  Ticks,
  UserPlusIcon,
  UsersIcon,
} from './icons';
import type { MembersTarget } from './MembersDialog';
import { PullTags, RUN_TAGS, Tag, type Tone } from './PullTags';
import { receiptState } from './receipts';
import { SecurityCodeDialog } from './SecurityCodeDialog';

const EMPTY: ChatMessage[] = [];
const NO_REACTIONS: Record<number, MessageReactions> = {};
/** The six quick reactions WhatsApp offers. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** Phones and tablets: no hover, so tapping a message opens its reactions and reply. */
const touchOnly = () => window.matchMedia('(hover: none)').matches;

/**
 * Why messages cannot be sent here yet, if so. A chat from before encryption gets its key on the
 * first send, which needs every member's public keys.
 */
function sendBlockedReason(conversation: ChatConversation, state: Pick<State, 'me' | 'users'>): string | null {
  if (conversation.keyId) return null;
  const missing = conversation.members
    .filter((m) => m.userId !== state.me?.id && !state.users[m.userId]?.keys)
    .map((m) => state.users[m.userId]?.displayName ?? 'Someone');
  if (missing.length === 0) return null;
  return `${missing.join(', ')} must sign in again before you can send encrypted messages here.`;
}

interface ChatViewProps {
  conversation: ChatConversation;
  onAddPeople: (target: MembersTarget) => void;
  onMembers: (target: MembersTarget) => void;
}

export function ChatView({ conversation, onAddPeople, onMembers }: ChatViewProps) {
  const me = useAppState((s) => s.me);
  const meId = me?.id;
  const users = useAppState((s) => s.users);
  const warnings = useAppState((s) => s.keyWarnings);
  const project = useAppState((s) => (conversation.projectId === null ? undefined : s.projects[conversation.projectId]));
  const [showCodes, setShowCodes] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);

  const isChannel = conversation.type === 'channel';
  const title = isChannel ? `#${conversation.title ?? 'channel'}` : chatTitle(conversation);
  const otherId = otherMemberId(conversation, meId);
  const people = conversation.members.length;
  const subtitle = isChannel
    ? `${project?.name ?? 'Project'} · ${people} ${people === 1 ? 'member' : 'members'}`
    : otherId !== undefined
      ? presenceText(users[otherId])
      : conversation.members
          .map((m) => (m.userId === meId ? 'You' : (users[m.userId]?.displayName ?? 'Unknown')))
          .join(', ');
  const changed = conversation.members
    .filter((m) => warnings[m.userId])
    .map((m) => users[m.userId]?.displayName ?? 'Someone');
  const membersOf: MembersTarget | null =
    isChannel && project
      ? { kind: 'project', projectId: project.id }
      : conversation.type === 'group'
        ? { kind: 'group', conversationId: conversation.id }
        : null;

  return (
    <section className="chat">
      <header className="chat-header">
        <button className="icon-button back-button" onClick={() => actions.setActive(null)} aria-label="Back to chats">
          <BackIcon />
        </button>
        {isChannel ? (
          <Avatar name={project?.name ?? '#'} seed={(project?.id ?? 0) + 5} size={40} square />
        ) : (
          <Avatar name={title} seed={otherId ?? conversation.id + 3} size={40} online={otherId ? users[otherId]?.online : false} />
        )}
        <div className="chat-header-text">
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="header-end">
          {membersOf && (
            <>
              <button className="icon-button" onClick={() => onMembers(membersOf)} title="Members" aria-label="Members">
                <UsersIcon />
              </button>
              <button className="icon-button" onClick={() => onAddPeople(membersOf)} title="Add people" aria-label="Add people">
                <UserPlusIcon />
              </button>
            </>
          )}
          <button
            className="icon-button"
            onClick={() => setShowCodes(true)}
            title="Encryption and security codes"
            aria-label="Encryption and security codes"
          >
            <LockIcon />
          </button>
        </div>
      </header>
      {changed.length > 0 && (
        <button className="banner banner-warn" onClick={() => setShowCodes(true)}>
          <AlertIcon width={18} height={18} />
          <span>
            {changed.join(', ')}’s security code changed. Check it with them before trusting new messages.
          </span>
        </button>
      )}
      <MessageList conversation={conversation} onShowCodes={() => setShowCodes(true)} onReply={setReplyTo} />
      <Composer
        conversationId={conversation.id}
        blockedReason={sendBlockedReason(conversation, { me, users })}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
      {showCodes && <SecurityCodeDialog conversation={conversation} onClose={() => setShowCodes(false)} />}
    </section>
  );
}

interface MessageListProps {
  conversation: ChatConversation;
  onShowCodes: () => void;
  onReply: (message: ChatMessage) => void;
}

function MessageList({ conversation, onShowCodes, onReply }: MessageListProps) {
  const meId = useAppState((s) => s.me?.id);
  const users = useAppState((s) => s.users);
  const messages = useAppState((s) => s.messages[conversation.id] ?? EMPTY);
  const reactions = useAppState((s) => s.reactions[conversation.id] ?? NO_REACTIONS);
  const complete = useAppState((s) => s.historyComplete[conversation.id] ?? false);
  // No list yet means the first page is still loading.
  const loaded = useAppState((s) => s.messages[conversation.id] !== undefined);
  const pending = useAppState((s) => s.pending);
  const scroller = useRef<HTMLDivElement>(null);
  const restoreFrom = useRef<number | null>(null);
  const stickToBottom = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** The message whose reaction tray is open. */
  const [trayFor, setTrayFor] = useState<number | null>(null);
  /** The message just jumped to from a quote, highlighted for a moment. */
  const [flashId, setFlashId] = useState<number | null>(null);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // An agent's reports fold into the card of the request they name, when that request is here.
  // Only the agent the request names reports on it, so nobody else can mark it done.
  const { reports, shown } = useMemo(() => {
    const reports = new Map<number, RunReport>();
    const shown: ChatMessage[] = [];
    for (const m of messages) {
      const report = m.run?.kind === 'request' || m.run?.kind === 'cancel' || m.run?.kind === 'fix' || m.run?.kind === 'clone' ? null : m.run;
      const request = report ? byId.get(report.request)?.run : null;
      if (report && request?.kind === 'request' && request.runtime === m.senderId) reports.set(report.request, report);
      else shown.push(m);
    }
    return { reports, shown };
  }, [messages, byId]);

  useEffect(() => {
    if (trayFor === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setTrayFor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trayFor]);

  function jumpTo(id: number) {
    const el = document.getElementById(`message-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashId(id);
    setTimeout(() => setFlashId((current) => (current === id ? null : current)), 1600);
  }

  function onBubbleClick(event: MouseEvent, id: number) {
    // Leave links, quotes and text selection alone.
    if ((event.target as Element).closest('a, button') || !window.getSelection()?.isCollapsed) return;
    setTrayFor((current) => (touchOnly() && current !== id ? id : null));
  }

  // Keep the view pinned to the newest message unless the user scrolled up to read history.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restoreFrom.current !== null) {
      el.scrollTop = el.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
    } else if (stickToBottom.current || messages.at(-1)?.senderId === meId) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, reactions, meId]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [conversation.id]);

  // The list gets shorter when the keyboard opens or the composer grows. Keep the newest message in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  async function showOlder() {
    const el = scroller.current;
    if (!el) return;
    restoreFrom.current = el.scrollHeight - el.scrollTop;
    setLoadingOlder(true);
    try {
      await loadOlder(conversation.id);
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      onClick={(e) => {
        if (trayFor !== null && !(e.target as Element).closest('.reaction-tray, .message-tools, .bubble')) setTrayFor(null);
      }}
    >
      <button className="encryption-notice" onClick={onShowCodes}>
        <LockIcon width={14} height={14} />
        {conversation.keyId
          ? 'Messages are end-to-end encrypted. No one outside this chat, not even the server, can read them.'
          : 'Messages you send here will be end-to-end encrypted. Earlier ones were sent before encryption.'}
      </button>
      {loaded && !complete && (
        <button className="load-older" onClick={() => void showOlder()} disabled={loadingOlder}>
          {loadingOlder ? 'Loading…' : 'Show earlier messages'}
        </button>
      )}
      {messages.length === 0 && complete && <p className="messages-empty">No messages yet. Say hello.</p>}
      {shown.map((message, i) => {
        const previous = shown[i - 1];
        const newDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
        const mine = message.senderId === meId;
        const firstOfRun = newDay || previous?.senderId !== message.senderId;
        const status = message.clientId ? pending[message.clientId] : undefined;
        const canAct = message.id > 0 && message.security !== 'failed';
        const marks = reactions[message.id];
        const rowClass = [
          'bubble-row',
          mine ? 'mine' : 'theirs',
          firstOfRun ? 'first' : '',
          trayFor === message.id ? 'is-selected' : '',
          flashId === message.id ? 'is-flash' : '',
        ].join(' ');
        return (
          <Fragment key={message.clientId ?? message.id}>
            {newDay && <div className="day-separator">{dayLabel(message.createdAt)}</div>}
            <div className={rowClass} id={message.id > 0 ? `message-${message.id}` : undefined}>
              <div className="bubble-line">
                <div
                  className={`bubble ${message.urgent ? 'bubble-urgent' : ''}`}
                  onClick={canAct ? (e) => onBubbleClick(e, message.id) : undefined}
                >
                  {conversation.type !== 'direct' && !mine && firstOfRun && (
                    <span className="bubble-sender" style={{ color: nameColor(message.senderId ?? 0) }}>
                      {senderName(users, message.senderId, 'Unknown')}
                    </span>
                  )}
                  {message.urgent && (
                    <span className="bubble-urgent-label">
                      <BellRingIcon width={13} height={13} /> URGENT
                    </span>
                  )}
                  {message.replyTo && (
                    <Quote quote={message.replyTo} original={byId.get(message.replyTo.id)} onJump={() => jumpTo(message.replyTo!.id)} />
                  )}
                  {message.security === 'failed' ? (
                    <span className="bubble-text bubble-failed">
                      <LockIcon width={13} height={13} /> This message could not be decrypted. It may have been altered.
                    </span>
                  ) : message.github ? (
                    <GithubCard card={message.github} />
                  ) : message.run?.kind === 'request' ? (
                    <RunCard
                      run={message.run}
                      state={reports.get(message.id) ?? null}
                      users={users}
                      onCancel={mine ? () => void cancelRun({ ...message, run: message.run as RunRequest }).catch(() => undefined) : undefined}
                    />
                  ) : message.pull ? (
                    <PullCard pull={message.pull} />
                  ) : (
                    <span className="bubble-text">{linkify(message.text)}</span>
                  )}
                  <span className="bubble-meta">
                    {message.security === 'plain' && (
                      <span className="not-encrypted" title="Sent before end-to-end encryption was turned on">
                        <LockOpenIcon width={11} height={11} /> Not encrypted
                      </span>
                    )}
                    {message.security === 'github' && (
                      <span className="not-encrypted" title="WebChat wrote this from what GitHub sent, so it is not end-to-end encrypted">
                        <LockOpenIcon width={11} height={11} /> Not encrypted
                      </span>
                    )}
                    {formatTime(message.createdAt)}
                    {mine && status === 'sending' && <ClockIcon width={13} height={13} aria-label="sending" />}
                    {mine && !status && message.id > 0 && <Ticks state={receiptState(conversation, message.id, meId)} />}
                  </span>
                </div>
                {canAct && (
                  <span className="message-tools">
                    <button
                      className="tool-button"
                      onClick={() => setTrayFor((current) => (current === message.id ? null : message.id))}
                      title="React"
                      aria-label="React"
                    >
                      <SmilePlusIcon width={17} height={17} />
                    </button>
                    <button className="tool-button" onClick={() => onReply(message)} title="Reply" aria-label="Reply">
                      <ReplyIcon width={17} height={17} />
                    </button>
                  </span>
                )}
                {trayFor === message.id && (
                  <div className="reaction-tray" role="menu" aria-label="React or reply">
                    {QUICK_REACTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        role="menuitem"
                        className={`tray-emoji ${meId !== undefined && marks?.[meId]?.emoji === emoji ? 'is-mine' : ''}`}
                        onClick={() => {
                          setTrayFor(null);
                          void react(message, emoji);
                        }}
                        aria-label={`React with ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                    <button
                      role="menuitem"
                      className="tray-reply"
                      onClick={() => {
                        setTrayFor(null);
                        onReply(message);
                      }}
                    >
                      <ReplyIcon width={16} height={16} /> Reply
                    </button>
                  </div>
                )}
              </div>
              {marks && <ReactionChips marks={marks} target={message} onToggle={(emoji) => void react(message, emoji)} />}
              {status === 'failed' && (
                <div className="send-failed-row">
                  <button className="send-failed" onClick={() => retryMessage(message)}>
                    <AlertIcon width={14} height={14} /> Not sent. Tap to retry.
                  </button>
                  <button className="send-discard" onClick={() => discardMessage(message)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * The message a reply answers. A loaded original passed its sender's signature check, so it wins
 * over the copy inside the reply, which only the person replying wrote.
 */
/**
 * A shared pull request, as it stood when it was shared. A click opens it on GitHub. A card that
 * reports a later event names only the pull request, with a tag for what happened.
 */
function PullCard({ pull, event }: { pull: PullCardDTO; event?: [Tone, string] }) {
  const login = useAppState((s) => s.github?.account?.login);
  return (
    <a className="pull-card" href={pull.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      <span className="pull-card-head">
        <PullRequestIcon width={14} height={14} />
        {pull.repo}#{pull.number}
      </span>
      <span className="pull-title">{pull.title}</span>
      <span className="pull-tags">{event ? <Tag tone={event[0]}>{event[1]}</Tag> : <PullTags pull={pull} />}</span>
      {!event && pull.reviewers && <PullPeople label="Reviewers" names={pull.reviewers} login={login} />}
      {!event && pull.assignees && pull.assignees.length > 0 && (
        <PullPeople label="Assignees" names={pull.assignees} login={login} />
      )}
    </a>
  );
}

/** The same tones as the pane's activity list. */
const EVENT_TAGS: Record<Exclude<PullEvent, 'opened'>, [Tone, string]> = {
  ready: ['ok', 'Ready for review'],
  reopened: ['muted', 'Reopened'],
  merged: ['ok', 'Merged'],
  closed: ['muted', 'Closed'],
};

/**
 * A card handed to a coding agent (R-027), with the agent's latest report on it folded in. Its
 * sender can cancel it while it runs (R-030); the agent's report then says so.
 */
function RunCard({ run, state, users, onCancel }: { run: RunRequest; state: RunReport | null; users: State['users']; onCancel?: () => void }) {
  // A request nobody took in time waits no more, as on the board (D-100).
  const unanswered = !state && Date.now() - (run.sentAt ?? 0) > RUN_PICKUP_MS;
  const [tone, label] = state ? RUN_TAGS[state.kind] : ((['muted', unanswered ? 'No answer' : 'Waiting for the agent']) as [Tone, string]);
  const going = (!state && !unanswered) || state?.kind === 'claimed' || state?.kind === 'fixing';
  // Nothing runs while the agent, or its session in the request's repository, checks in nowhere.
  // A daemon that starts again reports the run (K-46).
  const agent = users[run.runtime];
  const seat = run.repo && agent ? seatFor(agent, run.repo) : agent;
  const offline = going && !seat?.online;
  return (
    <span className="pull-card">
      <span className="pull-card-head">
        {run.card} · {senderName(users, run.runtime)}
        {run.repo && ` in ${run.repo}`}
      </span>
      <span className="pull-title">{run.title}</span>
      <span className="pull-tags">
        <Tag tone={tone}>{label}</Tag>
        {offline && <Tag tone="warn">Agent offline</Tag>}
        {state?.branch && <code>{state.branch}</code>}
        {state?.pull && (
          <a href={`https://github.com/${state.pull.repo}/pull/${state.pull.number}`} target="_blank" rel="noopener noreferrer">
            {state.pull.repo}#{state.pull.number}
          </a>
        )}
      </span>
      {state?.note && <span className="pull-people">{state.note}</span>}
      {going && onCancel && (
        <button
          className="button-secondary run-cancel"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
        >
          Cancel
        </button>
      )}
    </span>
  );
}

/**
 * A pull request event in a linked repository. The server wrote it from GitHub's webhook (D-050),
 * so nobody signed it; its link still leads only to the pull request on github.com.
 */
function GithubCard({ card }: { card: GithubCardDTO }) {
  return (
    <>
      <span className="bubble-text">{githubCardEvent(card)}</span>
      <PullCard pull={card.pull} event={card.event === 'opened' ? undefined : EVENT_TAGS[card.event]} />
    </>
  );
}

/** Who a card names. The viewer's own GitHub login reads "you", so a reviewer spots their turn. */
function PullPeople({ label, names, login }: { label: string; names: string[]; login?: string }) {
  const mine = login?.toLowerCase();
  return (
    <span className="pull-people">
      <span className="pull-people-label">{label}:</span>{' '}
      {names.length === 0 ? (
        'none asked yet'
      ) : (
        names.map((name, i) => (
          <Fragment key={name}>
            {i > 0 && ', '}
            {name.toLowerCase() === mine ? <strong className="pull-you">you</strong> : `@${name}`}
          </Fragment>
        ))
      )}
    </span>
  );
}

function Quote({ quote, original, onJump }: { quote: QuotedMessage; original?: ChatMessage; onJump?: () => void }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  // The server picks message ids and no signature covers them, so the message that now has the
  // quoted id stands in for the quote only when its sender and text match what the reply signed (K-44).
  const readable = original && original.security !== 'failed' ? original : undefined;
  const trusted =
    readable && (readable.senderId ?? 0) === quote.senderId && readable.text.slice(0, LIMITS.quoteLength) === quote.text ? readable : undefined;
  // A reply to a card from GitHub quotes sender 0.
  const senderId = quote.senderId || null;
  const text = trusted?.text ?? quote.text;
  const name = senderId === meId ? 'You' : senderName(users, senderId);
  const color = nameColor(senderId ?? 0);
  const body = (
    <>
      <span className="quote-sender" style={{ color }}>
        {name}
      </span>
      <span className="quote-text">{text}</span>
    </>
  );
  return onJump && trusted === readable ? (
    <button type="button" className="quote" style={{ borderColor: color }} onClick={onJump} title="Show the original message">
      {body}
    </button>
  ) : (
    <span className="quote" style={{ borderColor: color }}>
      {body}
    </span>
  );
}

/** One chip per emoji, with how many people chose it. Tapping a chip adds or takes back yours. */
function ReactionChips({ marks, target, onToggle }: { marks: MessageReactions; target: ChatMessage; onToggle: (emoji: string) => void }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const groups = useMemo(() => {
    const byEmoji = new Map<string, { emoji: string; userIds: number[]; first: number }>();
    for (const [id, mark] of Object.entries(marks)) {
      if (!mark.emoji) continue;
      // Reactions are filed under the message id, which the server picks and no signature covers.
      // Skip one signed for another message than the one that now has the id (K-44).
      if (mark.senderId !== undefined && (mark.senderId !== (target.senderId ?? 0) || mark.clientId !== (target.clientId ?? undefined))) continue;
      const group = byEmoji.get(mark.emoji) ?? { emoji: mark.emoji, userIds: [], first: mark.eventId };
      group.userIds.push(Number(id));
      group.first = Math.min(group.first, mark.eventId);
      byEmoji.set(mark.emoji, group);
    }
    return [...byEmoji.values()].sort((a, b) => b.userIds.length - a.userIds.length || a.first - b.first);
  }, [marks, target.senderId, target.clientId]);

  if (groups.length === 0) return null;
  return (
    <div className="reactions">
      {groups.map(({ emoji, userIds }) => {
        const names = userIds.map((id) => (id === meId ? 'You' : (users[id]?.displayName ?? 'Someone')));
        const mine = meId !== undefined && userIds.includes(meId);
        return (
          <button
            key={emoji}
            className={`reaction ${mine ? 'is-mine' : ''}`}
            onClick={() => onToggle(emoji)}
            title={names.join(', ')}
            aria-label={`${emoji} from ${names.join(', ')}${mine ? '. Tap to take yours back.' : ''}`}
          >
            <span className="reaction-emoji">{emoji}</span>
            {userIds.length > 1 && <span className="reaction-count">{userIds.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

interface ComposerProps {
  conversationId: number;
  blockedReason: string | null;
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
}

/** Grows a message box with its text up to about six lines. */
export function useAutoGrow(input: RefObject<HTMLTextAreaElement | null>, text: string) {
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border, and box-sizing is border-box, so add it back.
    const height = el.scrollHeight + el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(height, 150)}px`;
    el.style.overflowY = height > 150 ? 'auto' : 'hidden';
  }, [input, text]);
}

/**
 * A message box's text. The draft stays on this device, so it comes back after a close, a reload or
 * another chat (D-051), and a reload after a deploy waits until it is sent or cleared (D-040).
 */
export function useDraft(name: number | string) {
  const [text, setText] = useState('');
  const draft = useRef('');
  useEffect(() => {
    draft.current = text;
  }, [text]);
  useEffect(() => holdReloadWhile(() => draft.current.trim() !== ''), []);
  useEffect(() => {
    let current = true;
    setText('');
    void loadDraft(name).then((saved) => {
      if (current && saved) setText((typed) => typed || saved);
    });
    return () => {
      current = false;
    };
  }, [name]);
  const edit = (value: string) => {
    setText(value);
    saveDraft(name, value);
  };
  return [text, edit] as const;
}

function Composer({ conversationId, blockedReason, replyTo, onCancelReply }: ComposerProps) {
  const [text, edit] = useDraft(conversationId);
  const [urgent, setUrgent] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setUrgent(false);
    // On a phone the keyboard would cover half of a chat just opened, so it waits for a tap.
    if (!touchOnly()) input.current?.focus();
  }, [conversationId]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  useAutoGrow(input, text);

  function submit() {
    if (!text.trim() || blockedReason) return;
    void sendMessage(conversationId, text, urgent, replyTo ? quoteOf(replyTo) : null);
    edit('');
    setUrgent(false);
    onCancelReply();
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && replyTo) {
      event.preventDefault();
      onCancelReply();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <footer className={`composer ${urgent ? 'is-urgent' : ''}`}>
      {blockedReason && <p className="composer-blocked">{blockedReason}</p>}
      {replyTo && (
        <div className="composer-reply">
          <Quote quote={quoteOf(replyTo)} original={replyTo} />
          <button className="icon-button" onClick={onCancelReply} title="Cancel reply" aria-label="Cancel reply">
            <CloseIcon width={18} height={18} />
          </button>
        </div>
      )}
      {urgent && <p className="composer-hint">Urgent: their device keeps ringing until they see it.</p>}
      <div className="composer-row">
        <button
          className={`icon-button urgent-toggle ${urgent ? 'is-on' : ''}`}
          onClick={() => setUrgent((u) => !u)}
          aria-pressed={urgent}
          title="Mark as urgent"
          aria-label="Mark as urgent"
        >
          <BellRingIcon />
        </button>
        <textarea
          ref={input}
          rows={1}
          value={text}
          maxLength={LIMITS.messageLength}
          placeholder={urgent ? 'Urgent message' : 'Type a message'}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="send-button" onClick={submit} disabled={!text.trim() || blockedReason !== null} aria-label="Send">
          <SendIcon />
        </button>
      </div>
    </footer>
  );
}
