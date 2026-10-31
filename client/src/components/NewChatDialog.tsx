import { useMemo, useState } from 'react';
import { LIMITS } from '../../../shared/types';
import { openConversation, startDirectChat, startGroupChat } from '../chat';
import { useAppState } from '../store';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { presenceText } from './format';

const NO_KEYS = 'Must sign in again to turn on encryption';

export function NewChatDialog({ onClose }: { onClose: () => void }) {
  const users = useAppState((s) => s.users);
  const [mode, setMode] = useState<'person' | 'group'>('person');
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

  function toggle(id: number) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog title="New chat" onClose={onClose}>
      <div className="segmented">
        <button aria-selected={mode === 'person'} onClick={() => setMode('person')}>
          Message a person
        </button>
        <button aria-selected={mode === 'group'} onClick={() => setMode('group')}>
          New group
        </button>
      </div>

      {mode === 'group' && (
        <label className="field">
          Group name
          <input value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={LIMITS.groupTitleLength} />
        </label>
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
