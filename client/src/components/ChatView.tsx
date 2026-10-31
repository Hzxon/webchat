import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { LIMITS, type ConversationDTO, type MessageDTO } from '../../../shared/types';
import { loadOlder, retryMessage, sendMessage } from '../chat';
import { actions, chatTitle, otherMemberId, useAppState } from '../store';
import { Avatar, nameColor } from './Avatar';
import { dayLabel, formatTime, linkify, presenceText } from './format';
import { AlertIcon, BackIcon, BellRingIcon, ClockIcon, SendIcon, Ticks } from './icons';
import { receiptState } from './receipts';

const EMPTY: MessageDTO[] = [];

export function ChatView({ conversation }: { conversation: ConversationDTO }) {
  const meId = useAppState((s) => s.me?.id);
  const users = useAppState((s) => s.users);

  const title = chatTitle(conversation);
  const otherId = otherMemberId(conversation, meId);
  const subtitle =
    otherId !== undefined
      ? presenceText(users[otherId])
      : conversation.members
          .map((m) => (m.userId === meId ? 'You' : (users[m.userId]?.displayName ?? 'Unknown')))
          .join(', ');

  return (
    <section className="chat">
      <header className="chat-header">
        <button className="icon-button back-button" onClick={() => actions.setActive(null)} aria-label="Back to chats">
          <BackIcon />
        </button>
        <Avatar name={title} seed={otherId ?? conversation.id + 3} size={40} online={otherId ? users[otherId]?.online : false} />
        <div className="chat-header-text">
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
      </header>
      <MessageList conversation={conversation} />
      <Composer conversationId={conversation.id} />
    </section>
  );
}

function MessageList({ conversation }: { conversation: ConversationDTO }) {
  const meId = useAppState((s) => s.me?.id);
  const users = useAppState((s) => s.users);
  const messages = useAppState((s) => s.messages[conversation.id] ?? EMPTY);
  const complete = useAppState((s) => s.historyComplete[conversation.id] ?? false);
  const pending = useAppState((s) => s.pending);
  const scroller = useRef<HTMLDivElement>(null);
  const restoreFrom = useRef<number | null>(null);
  const stickToBottom = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

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
  }, [messages, meId]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [conversation.id]);

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
    >
      {!complete && messages.length > 0 && (
        <button className="load-older" onClick={() => void showOlder()} disabled={loadingOlder}>
          {loadingOlder ? 'Loading…' : 'Show earlier messages'}
        </button>
      )}
      {messages.length === 0 && complete && <p className="messages-empty">No messages yet. Say hello.</p>}
      {messages.map((message, i) => {
        const previous = messages[i - 1];
        const newDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
        const mine = message.senderId === meId;
        const firstOfRun = newDay || previous?.senderId !== message.senderId;
        const status = message.clientId ? pending[message.clientId] : undefined;
        const sender = users[message.senderId];
        return (
          <Fragment key={message.clientId ?? message.id}>
            {newDay && <div className="day-separator">{dayLabel(message.createdAt)}</div>}
            <div className={`bubble-row ${mine ? 'mine' : 'theirs'} ${firstOfRun ? 'first' : ''}`}>
              <div className={`bubble ${message.urgent ? 'bubble-urgent' : ''}`}>
                {conversation.type === 'group' && !mine && firstOfRun && (
                  <span className="bubble-sender" style={{ color: nameColor(message.senderId) }}>
                    {sender?.displayName ?? 'Unknown'}
                  </span>
                )}
                {message.urgent && (
                  <span className="bubble-urgent-label">
                    <BellRingIcon width={13} height={13} /> URGENT
                  </span>
                )}
                <span className="bubble-text">{linkify(message.body)}</span>
                <span className="bubble-meta">
                  {formatTime(message.createdAt)}
                  {mine && status === 'sending' && <ClockIcon width={13} height={13} aria-label="sending" />}
                  {mine && !status && message.id > 0 && <Ticks state={receiptState(conversation, message.id, meId)} />}
                </span>
              </div>
              {status === 'failed' && (
                <button className="send-failed" onClick={() => retryMessage(message)}>
                  <AlertIcon width={14} height={14} /> Not sent. Tap to retry.
                </button>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function Composer({ conversationId }: { conversationId: number }) {
  const [text, setText] = useState('');
  const [urgent, setUrgent] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText('');
    setUrgent(false);
    input.current?.focus();
  }, [conversationId]);

  // Grow with the text up to about six lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border, and box-sizing is border-box, so add it back.
    const height = el.scrollHeight + el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(height, 150)}px`;
    el.style.overflowY = height > 150 ? 'auto' : 'hidden';
  }, [text]);

  function submit() {
    if (!text.trim()) return;
    void sendMessage(conversationId, text, urgent);
    setText('');
    setUrgent(false);
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <footer className={`composer ${urgent ? 'is-urgent' : ''}`}>
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
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="send-button" onClick={submit} disabled={!text.trim()} aria-label="Send">
          <SendIcon />
        </button>
      </div>
    </footer>
  );
}
