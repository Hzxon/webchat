import { useCallback, useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Center } from '@astryxdesign/core/Center';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import type { UserDTO } from '../../shared/types';
import { ApiError } from './api';
import { openConversation, sessionExpired, signOut, startChat } from './chat';
import type { ChatDoc } from './e2ee/keyring';
import { formatRoute, parseRoute, routeOf } from './route';
import { actions, store, useAppState } from './store';
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
import { clampSide, Rail, Sidebar, SidebarResizer } from './components/Sidebar';
import { UnlockScreen } from './components/UnlockScreen';
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
          // A proxy's 502 or a dropped connection says nothing useful in its own words.
          const unreachable = err instanceof ApiError && (err.status === 0 || err.status >= 500);
          setError(unreachable ? 'WebChat cannot reach the server. Check your connection and try again.' : (err as Error).message);
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

const WIDTH_KEY = 'webchat.sidebarWidth';

function rememberedWidth() {
  try {
    return clampSide(Number(localStorage.getItem(WIDTH_KEY)) || 300);
  } catch {
    return 300;
  }
}

/**
 * Keeps the address hash and the open view in step: opening a view adds a history entry, and a
 * reload, a pasted link, Back or Forward opens the view the hash names. Only mounted once the data
 * has loaded, so the hash can be checked against what this user can see.
 */
function followHash() {
  let opening = false;
  const write = (change: typeof history.pushState) => {
    const hash = formatRoute(routeOf(store.get()));
    if (hash !== location.hash) change.call(history, null, '', location.pathname + location.search + hash);
  };
  const open = () => {
    // The store changes several times on the way; none of them is a new history entry.
    opening = true;
    const route = parseRoute(location.hash);
    const s = store.get();
    if (route?.kind === 'chat' && s.conversations[route.id]) void openConversation(route.id);
    else if (route?.kind === 'doc' && s.docs[route.id]) actions.setDocOpen(route.id);
    else if (route?.kind === 'board' && s.projects[route.id]) actions.setBoardOpen(route.id);
    else if (route?.kind === 'agents' || route?.kind === 'github') {
      actions.setTab('chats');
      if (route.kind === 'agents') actions.setAgentsOpen(true, route.thread);
      else actions.setGithubOpen(true);
    } else actions.closePanes();
    opening = false;
    // A hash naming something this user cannot see gives way to the landing pane's.
    write(history.replaceState);
  };
  if (location.hash) open();
  // A notification's /?chat= link may have opened a chat already.
  else write(history.replaceState);
  window.addEventListener('popstate', open);
  const unsubscribe = store.subscribe(() => {
    if (!opening) write(history.pushState);
  });
  return () => {
    window.removeEventListener('popstate', open);
    unsubscribe();
  };
}

function ChatLayout() {
  const activeId = useAppState((s) => s.activeId);
  const active = useAppState((s) => (s.activeId === null ? undefined : s.conversations[s.activeId]));
  const githubOpen = useAppState((s) => s.githubOpen);
  const agentsOpen = useAppState((s) => s.agentsOpen);
  const doc = useAppState((s) => (s.docOpen === null ? undefined : s.docs[s.docOpen]));
  const board = useAppState((s) => (s.boardOpen === null ? undefined : s.projects[s.boardOpen]));
  const reposFor = useAppState((s) => s.reposFor);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const addPeople = (target: MembersTarget) => setDialog({ kind: 'add-people', target });
  const showMembers = (target: MembersTarget) => setDialog({ kind: 'members', target });
  const [sideWidth, setSideWidth] = useState(rememberedWidth);
  const resize = (width: number) => {
    setSideWidth(width);
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // A private window starts at the default width on the next load.
    }
  };

  useEffect(fitToVisualViewport, []);
  useEffect(followHash, []);
  // A card's status line follows its run from any page of its owner's (D-105).
  const runs = useAppState(runSignature);
  useEffect(() => void followRuns().catch(() => undefined), [runs]);

  return (
    <div
      className={`layout ${activeId !== null || githubOpen || agentsOpen || doc || board ? 'has-active' : ''} ${agentsOpen ? 'agents-open' : ''}`}
      style={{ '--side-width': `${sideWidth}px` } as React.CSSProperties}
    >
      <Rail onNotifications={() => setDialog({ kind: 'notifications' })} />
      <div className="frame">
        {/* Coding agents brings its own sidebar (D-103). */}
        {!agentsOpen && (
          <>
            <Sidebar
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
            <SidebarResizer width={sideWidth} onChange={resize} />
          </>
        )}
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
              <Text as="p" color="secondary" justify="center">
                End-to-end encrypted chats, project channels and boards. Pick one from the sidebar to start.
              </Text>
            </Stack>
          </section>
        )}
      </div>
      {dialog?.kind === 'new-chat' && <NewChatDialog initialMode={dialog.mode} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'notifications' && <NotificationDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'new-channel' && <NewChannelDialog projectId={dialog.projectId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'new-doc' && <NewDocDialog projectId={dialog.projectId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rename-doc' && <RenameDialog doc={dialog.doc} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'add-people' && <AddPeopleDialog target={dialog.target} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'members' && (
        <MembersDialog target={dialog.target} onAdd={() => addPeople(dialog.target)} onClose={() => setDialog(null)} />
      )}
      {reposFor !== null && <ProjectReposDialog projectId={reposFor} onClose={() => actions.setReposFor(null)} />}
      <UrgentAlert />
      <Toasts />
    </div>
  );
}
