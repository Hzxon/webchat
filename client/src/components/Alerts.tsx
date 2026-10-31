import { openConversation, previewText } from '../chat';
import { actions, chatTitle, useAppState } from '../store';
import { formatTime } from './format';
import { BellRingIcon, CloseIcon } from './icons';

/** Full-screen alert for urgent messages. It stays, and the page keeps ringing, until acknowledged. */
export function UrgentAlert() {
  const urgent = useAppState((s) => s.urgent);
  const users = useAppState((s) => s.users);
  const conversations = useAppState((s) => s.conversations);
  const first = urgent[0];
  if (!first) return null;

  const sender = users[first.senderId]?.displayName ?? 'Someone';
  const conversation = conversations[first.conversationId];
  const inGroup = conversation && conversation.type !== 'direct' ? ` in ${chatTitle(conversation)}` : '';

  return (
    <div className="urgent-overlay" role="alertdialog" aria-labelledby="urgent-title" aria-describedby="urgent-body">
      <div className="urgent-card">
        <div className="urgent-pulse">
          <BellRingIcon width={30} height={30} />
        </div>
        <p className="urgent-kicker">Urgent message</p>
        <h2 id="urgent-title">
          {sender}
          {inGroup}
        </h2>
        <p id="urgent-body" className="urgent-text">
          {previewText(first)}
        </p>
        <p className="urgent-time">
          {formatTime(first.createdAt)}
          {urgent.length > 1 ? ` · ${urgent.length - 1} more urgent` : ''}
        </p>
        <div className="urgent-actions">
          <button className="button-primary" autoFocus onClick={() => void openConversation(first.conversationId)}>
            Open chat
          </button>
          <button className="button-secondary" onClick={() => actions.clearUrgent(first.conversationId, first.id)}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/** Small pop-ups for messages in other chats while the user is looking at the app. */
export function Toasts() {
  const toasts = useAppState((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <button
            className="toast-main"
            onClick={() => {
              actions.dismissToast(toast.id);
              if (toast.url) window.open(toast.url, '_blank', 'noopener,noreferrer');
              else if (toast.conversationId !== null) void openConversation(toast.conversationId);
            }}
          >
            <strong>{toast.title}</strong>
            <span>{toast.body}</span>
          </button>
          <button className="icon-button" onClick={() => actions.dismissToast(toast.id)} aria-label="Dismiss">
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
