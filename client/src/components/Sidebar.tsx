import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { sound } from '../alerts';
import { openConversation, previewText, signOut } from '../chat';
import type { ChatConversation } from '../e2ee/keyring';
import { chatTitle, otherMemberId, useAppState } from '../store';
import { Avatar } from './Avatar';
import { formatListTime } from './format';
import { BellIcon, BellRingIcon, LogoutIcon, PlusIcon, SearchIcon, Ticks } from './icons';
import { receiptState } from './receipts';

interface SidebarProps {
  onNewChat: () => void;
  onNotifications: () => void;
}

export function Sidebar({ onNewChat, onNotifications }: SidebarProps) {
  const me = useAppState((s) => s.me);
  const conversations = useAppState((s) => s.conversations);
  const connected = useAppState((s) => s.connected);
  const push = useAppState((s) => s.push);
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => {
    const list = Object.values(conversations).sort(
      (a, b) => (b.lastMessage?.createdAt ?? b.updatedAt) - (a.lastMessage?.createdAt ?? a.updatedAt),
    );
    const q = query.trim().toLowerCase();
    return q ? list.filter((c) => chatTitle(c).toLowerCase().includes(q)) : list;
  }, [conversations, query]);

  if (!me) return null;
  const notificationsReady = push?.permission === 'granted';

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
        <button className="icon-button" onClick={onNewChat} title="New chat" aria-label="New chat">
          <PlusIcon />
        </button>
        <button className="icon-button" onClick={() => void signOut()} title="Sign out" aria-label="Sign out">
          <LogoutIcon />
        </button>
      </header>

      {!connected && <div className="connection-bar">Connecting…</div>}
      <AlertSetupBanner onOpen={onNotifications} />

      <label className="search">
        <SearchIcon width={18} height={18} />
        <input placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>

      <ul className="chat-list">
        {sorted.map((c) => (
          <ChatListItem key={c.id} conversation={c} />
        ))}
        {sorted.length === 0 && (
          <li className="chat-list-empty">
            {query ? 'No chats match.' : 'No chats yet. Press + to message a friend.'}
          </li>
        )}
      </ul>
    </aside>
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
      conversation.type === 'group' && !mine ? `${users[last.senderId]?.displayName.split(' ')[0] ?? 'Someone'}: ` : '';
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
