import { useCallback, useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Center } from '@astryxdesign/core/Center';
import { Heading } from '@astryxdesign/core/Heading';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import type { UserDTO } from '../../shared/types';
import { ApiError } from './api';
import { sessionExpired, signOut, startChat } from './chat';
import type { ChatDoc } from './e2ee/keyring';
import { actions, useAppState } from './store';
import { Toasts, UrgentAlert } from './components/Alerts';
import { AuthScreen } from './components/AuthScreen';
import { ChatView } from './components/ChatView';
import { BoardView } from './components/BoardView';
import { DocView, RenameDialog } from './components/DocView';
import { AgentsView } from './components/AgentsView';
import { GithubView } from './components/GithubView';
import { MembersDialog, type MembersTarget } from './components/MembersDialog';
import { NewChatDialog, type NewChatMode } from './components/NewChatDialog';
import { NotificationDialog } from './components/NotificationDialog';
import { AddPeopleDialog, NewChannelDialog, NewDocDialog, ProjectReposDialog } from './components/ProjectDialogs';
import { Sidebar, SidebarRail } from './components/Sidebar';
import { UnlockScreen } from './components/UnlockScreen';
import { BellRingIcon } from './components/icons';
import { fitToVisualViewport } from './viewport';
import { runSignature } from './agents';
import { followRuns } from './runStatus';

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
          // Shows the sign-in screen once the keys are gone from this device.
          void sessionExpired();
        } else {
          setError((err as Error).message);
          setPhase('error');
        }
      });
  }, []);

  useEffect(start, [start]);

  if (phase === 'loading')
    return (
      <Center height="100%">
        <Text color="secondary">Loading…</Text>
      </Center>
    );
  if (phase === 'signed-out') return <AuthScreen onSignedIn={start} />;
  if (phase === 'locked' && lockedUser) {
    return <UnlockScreen me={lockedUser} onUnlocked={start} onSignOut={() => void signOut().then(() => setPhase('signed-out'))} />;
  }
  if (phase === 'error') {
    return (
      <Center height="100%">
        <Stack gap={3} hAlign="center">
          <Text as="p" color="secondary">
            {error}
          </Text>
          <Button variant="primary" label="Try again" onClick={start} />
        </Stack>
      </Center>
    );
  }
  return <ChatLayout />;
}

type OpenDialog =
  | { kind: 'new-chat'; mode: NewChatMode }
  | { kind: 'notifications' }
  | { kind: 'new-channel'; projectId: number }
  | { kind: 'new-doc'; projectId: number }
  | { kind: 'rename-doc'; doc: ChatDoc }
  | { kind: 'add-people'; target: MembersTarget }
  | { kind: 'members'; target: MembersTarget };

const COLLAPSED_KEY = 'webchat.sidebarCollapsed';

function rememberedCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function ChatLayout() {
  const activeId = useAppState((s) => s.activeId);
  const active = useAppState((s) => (s.activeId === null ? undefined : s.conversations[s.activeId]));
  const push = useAppState((s) => s.push);
  const githubOpen = useAppState((s) => s.githubOpen);
  const agentsOpen = useAppState((s) => s.agentsOpen);
  const doc = useAppState((s) => (s.docOpen === null ? undefined : s.docs[s.docOpen]));
  const board = useAppState((s) => (s.boardOpen === null ? undefined : s.projects[s.boardOpen]));
  const reposFor = useAppState((s) => s.reposFor);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const addPeople = (target: MembersTarget) => setDialog({ kind: 'add-people', target });
  const showMembers = (target: MembersTarget) => setDialog({ kind: 'members', target });
  const [collapsed, setCollapsed] = useState(rememberedCollapsed);
  const collapse = (value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
    } catch {
      // A private window keeps the sidebar open on the next load.
    }
  };

  useEffect(fitToVisualViewport, []);
  // A card's status line follows its run from any page of its owner's (D-105).
  const runs = useAppState(runSignature);
  useEffect(() => void followRuns().catch(() => undefined), [runs]);

  return (
    <div
      className={`layout ${activeId !== null || githubOpen || agentsOpen || doc || board ? 'has-active' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}
    >
      <SidebarRail onExpand={() => collapse(false)} onNotifications={() => setDialog({ kind: 'notifications' })} />
      <Sidebar
        onCollapse={() => collapse(true)}
        onNewChat={() => setDialog({ kind: 'new-chat', mode: 'person' })}
        onNewProject={() => setDialog({ kind: 'new-chat', mode: 'project' })}
        onNewChannel={(projectId) => setDialog({ kind: 'new-channel', projectId })}
        onAddPeople={(projectId) => addPeople({ kind: 'project', projectId })}
        onMembers={(projectId) => showMembers({ kind: 'project', projectId })}
        onRepos={(projectId) => actions.setReposFor(projectId)}
        onNewDoc={(projectId) => setDialog({ kind: 'new-doc', projectId })}
        onRenameDoc={(doc) => setDialog({ kind: 'rename-doc', doc })}
        onNotifications={() => setDialog({ kind: 'notifications' })}
      />
      {githubOpen ? (
        <GithubView />
      ) : agentsOpen ? (
        <AgentsView />
      ) : doc ? (
        <DocView key={doc.id} doc={doc} />
      ) : board ? (
        <BoardView key={board.id} project={board} />
      ) : active ? (
        <ChatView key={active.id} conversation={active} onAddPeople={addPeople} onMembers={showMembers} />
      ) : (
        <section className="chat chat-empty">
          <Stack gap={3} hAlign="center" maxWidth={420} className="chat-empty-card">
            <BellRingIcon width={36} height={36} />
            <Heading level={2}>Never miss an urgent message</Heading>
            <Text as="p" color="secondary" justify="center">
              Messages arrive here the moment they are sent, end-to-end encrypted. Mark a message as urgent with the bell
              button, and the other person’s browser keeps ringing until they see it.
            </Text>
            {push?.permission !== 'granted' && (
              <Button variant="primary" label="Set up notifications" onClick={() => setDialog({ kind: 'notifications' })} />
            )}
          </Stack>
        </section>
      )}
      {dialog?.kind === 'new-chat' && <NewChatDialog initialMode={dialog.mode} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'notifications' && <NotificationDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'new-channel' && <NewChannelDialog projectId={dialog.projectId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'new-doc' && <NewDocDialog projectId={dialog.projectId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rename-doc' && <RenameDialog doc={dialog.doc} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'add-people' && <AddPeopleDialog target={dialog.target} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'members' && <MembersDialog target={dialog.target} onClose={() => setDialog(null)} />}
      {reposFor !== null && <ProjectReposDialog projectId={reposFor} onClose={() => actions.setReposFor(null)} />}
      <UrgentAlert />
      <Toasts />
    </div>
  );
}
