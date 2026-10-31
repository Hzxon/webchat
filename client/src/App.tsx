import { useCallback, useEffect, useState } from 'react';
import type { UserDTO } from '../../shared/types';
import { ApiError } from './api';
import { signOut, startChat } from './chat';
import { useAppState } from './store';
import { Toasts, UrgentAlert } from './components/Alerts';
import { AuthScreen } from './components/AuthScreen';
import { ChatView } from './components/ChatView';
import { GithubView } from './components/GithubView';
import { NewChatDialog } from './components/NewChatDialog';
import { NotificationDialog } from './components/NotificationDialog';
import { Sidebar } from './components/Sidebar';
import { UnlockScreen } from './components/UnlockScreen';
import { BellRingIcon } from './components/icons';

type Phase = 'loading' | 'signed-out' | 'locked' | 'signed-in' | 'error';

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [lockedUser, setLockedUser] = useState<UserDTO | null>(null);

  const start = useCallback(() => {
    setPhase('loading');
    startChat(() => setPhase('signed-out'))
      .then((result) => {
        if (result.status === 'locked') {
          setLockedUser(result.me);
          setPhase('locked');
        } else if (result.status === 'ready') {
          setPhase('signed-in');
        }
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          setPhase('signed-out');
        } else {
          setError((err as Error).message);
          setPhase('error');
        }
      });
  }, []);

  useEffect(start, [start]);

  if (phase === 'loading') return <div className="splash">Loading…</div>;
  if (phase === 'signed-out') return <AuthScreen onSignedIn={start} />;
  if (phase === 'locked' && lockedUser) {
    return <UnlockScreen me={lockedUser} onUnlocked={start} onSignOut={() => void signOut().then(() => setPhase('signed-out'))} />;
  }
  if (phase === 'error') {
    return (
      <div className="splash">
        <p>{error}</p>
        <button className="button-primary" onClick={start}>
          Try again
        </button>
      </div>
    );
  }
  return <ChatLayout />;
}

function ChatLayout() {
  const activeId = useAppState((s) => s.activeId);
  const active = useAppState((s) => (s.activeId === null ? undefined : s.conversations[s.activeId]));
  const push = useAppState((s) => s.push);
  const githubOpen = useAppState((s) => s.githubOpen);
  const [dialog, setDialog] = useState<'new-chat' | 'notifications' | null>(null);

  return (
    <div className={`layout ${activeId !== null || githubOpen ? 'has-active' : ''}`}>
      <Sidebar onNewChat={() => setDialog('new-chat')} onNotifications={() => setDialog('notifications')} />
      {githubOpen ? (
        <GithubView />
      ) : active ? (
        <ChatView key={active.id} conversation={active} />
      ) : (
        <section className="chat chat-empty">
          <div className="chat-empty-card">
            <BellRingIcon width={36} height={36} />
            <h2>Never miss an urgent message</h2>
            <p>
              Messages arrive here the moment they are sent, end-to-end encrypted. Mark a message as urgent with the bell
              button, and the other person’s browser keeps ringing until they see it.
            </p>
            {push?.permission !== 'granted' && (
              <button className="button-primary" onClick={() => setDialog('notifications')}>
                Set up notifications
              </button>
            )}
          </div>
        </section>
      )}
      {dialog === 'new-chat' && <NewChatDialog onClose={() => setDialog(null)} />}
      {dialog === 'notifications' && <NotificationDialog onClose={() => setDialog(null)} />}
      <UrgentAlert />
      <Toasts />
    </div>
  );
}
