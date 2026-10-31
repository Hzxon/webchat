import { useCallback, useEffect, useState } from 'react';
import type { UserDTO } from '../../shared/types';
import { ApiError } from './api';
import { signOut, startChat } from './chat';
import { useAppState } from './store';
import { Toasts, UrgentAlert } from './components/Alerts';
import { AuthScreen } from './components/AuthScreen';
import { ChatView } from './components/ChatView';
import { GithubView } from './components/GithubView';
import { NewChatDialog, type NewChatMode } from './components/NewChatDialog';
import { NotificationDialog } from './components/NotificationDialog';
import { AddPeopleDialog, NewChannelDialog } from './components/ProjectDialogs';
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

type OpenDialog =
  | { kind: 'new-chat'; mode: NewChatMode }
  | { kind: 'notifications' }
  | { kind: 'new-channel'; projectId: number }
  | { kind: 'add-people'; projectId: number };

function ChatLayout() {
  const activeId = useAppState((s) => s.activeId);
  const active = useAppState((s) => (s.activeId === null ? undefined : s.conversations[s.activeId]));
  const push = useAppState((s) => s.push);
  const githubOpen = useAppState((s) => s.githubOpen);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const addPeople = (projectId: number) => setDialog({ kind: 'add-people', projectId });

  return (
    <div className={`layout ${activeId !== null || githubOpen ? 'has-active' : ''}`}>
      <Sidebar
        onNewChat={() => setDialog({ kind: 'new-chat', mode: 'person' })}
        onNewProject={() => setDialog({ kind: 'new-chat', mode: 'project' })}
        onNewChannel={(projectId) => setDialog({ kind: 'new-channel', projectId })}
        onAddPeople={addPeople}
        onNotifications={() => setDialog({ kind: 'notifications' })}
      />
      {githubOpen ? (
        <GithubView />
      ) : active ? (
        <ChatView key={active.id} conversation={active} onAddPeople={addPeople} />
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
              <button className="button-primary" onClick={() => setDialog({ kind: 'notifications' })}>
                Set up notifications
              </button>
            )}
          </div>
        </section>
      )}
      {dialog?.kind === 'new-chat' && <NewChatDialog initialMode={dialog.mode} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'notifications' && <NotificationDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'new-channel' && <NewChannelDialog projectId={dialog.projectId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'add-people' && <AddPeopleDialog projectId={dialog.projectId} onClose={() => setDialog(null)} />}
      <UrgentAlert />
      <Toasts />
    </div>
  );
}
