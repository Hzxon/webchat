import { useMemo, useState } from 'react';
import { LIMITS } from '../../../shared/types';
import { createProject, openConversation, startDirectChat, startGroupChat } from '../chat';
import { useAppState } from '../store';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { presenceText } from './format';

const NO_KEYS = 'Must sign in again to turn on encryption';

export type NewChatMode = 'person' | 'group' | 'project';

export function NewChatDialog({ initialMode = 'person', onClose }: { initialMode?: NewChatMode; onClose: () => void }) {
  const users = useAppState((s) => s.users);
  const [mode, setMode] = useState<NewChatMode>(initialMode);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName));
  }, [users, query]);

  async function run(work: () => Promise<number>) {
    setBusy(true);
    setError('');
    try {
      const id = await work();
      onClose();
      await openConversation(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const openDirect = (userId: number) => run(() => startDirectChat(userId));
  const createGroup = () => run(() => startGroupChat(groupName.trim(), [...picked]));
  const startProject = () => run(() => createProject(groupName.trim(), [...picked]));

  function toggle(id: number) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog title={mode === 'project' ? 'New project' : 'New chat'} onClose={onClose}>
      <div className="segmented">
        <button aria-selected={mode === 'person'} onClick={() => setMode('person')}>
          Person
        </button>
        <button aria-selected={mode === 'group'} onClick={() => setMode('group')}>
          Group
        </button>
        <button aria-selected={mode === 'project'} onClick={() => setMode('project')}>
          Project
        </button>
      </div>

      {mode !== 'person' && (
        <label className="field">
          {mode === 'project' ? 'Project name' : 'Group name'}
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            maxLength={mode === 'project' ? LIMITS.projectNameLength : LIMITS.groupTitleLength}
            placeholder={mode === 'project' ? 'Capstone, Thesis, Robotics club' : undefined}
          />
        </label>
      )}
      {mode === 'project' && (
        <p className="dialog-intro">
          The project starts with a #general channel. Everyone in it can read every channel, including earlier messages,
          and can add more people later.
        </p>
      )}

      <input
        className="field-input"
        placeholder="Search people"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      <ul className="people-list">
        {people.map((user) => (
          <li key={user.id}>
            {mode === 'person' ? (
              <button className="person" onClick={() => void openDirect(user.id)} disabled={busy || !user.keys}>
                <Avatar name={user.displayName} seed={user.id} size={38} online={user.online} />
                <span>
                  <strong>{user.displayName}</strong>
                  <small>{user.keys ? presenceText(user) : NO_KEYS}</small>
                </span>
              </button>
            ) : (
              <label className="person">
                <input
                  type="checkbox"
                  checked={picked.has(user.id)}
                  onChange={() => toggle(user.id)}
                  disabled={!user.keys}
                />
                <Avatar name={user.displayName} seed={user.id} size={38} online={user.online} />
                <span>
                  <strong>{user.displayName}</strong>
                  <small>{user.keys ? `@${user.username}` : NO_KEYS}</small>
                </span>
              </label>
            )}
          </li>
        ))}
        {people.length === 0 && (
          <li className="people-empty">
            {query ? 'Nobody matches.' : 'No one else has joined yet. Share the site address and the invite code.'}
          </li>
        )}
      </ul>

      {error && <p className="form-error">{error}</p>}
      {mode === 'project' && (
        <button className="button-primary" onClick={() => void startProject()} disabled={busy || !groupName.trim()}>
          {picked.size > 0 ? `Create project with ${picked.size}` : 'Create project'}
        </button>
      )}
      {mode === 'group' && (
        <button
          className="button-primary"
          onClick={() => void createGroup()}
          disabled={busy || picked.size === 0 || !groupName.trim()}
        >
          Create group{picked.size > 0 ? ` with ${picked.size}` : ''}
        </button>
      )}
    </Dialog>
  );
}
