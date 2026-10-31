import { useMemo, useState } from 'react';
import { LIMITS } from '../../../shared/types';
import { addProjectMembers, createChannel, openConversation } from '../chat';
import { useAppState } from '../store';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { HashIcon } from './icons';

/** Slack-style channel name: lowercase, words joined by single hyphens, letters and digits in any script. */
export const toChannelName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.channelNameLength);

/** Names of a project's members, with "You" first. */
function useMemberNames(projectId: number) {
  const project = useAppState((s) => s.projects[projectId]);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  return useMemo(() => {
    const ids = project?.memberIds ?? [];
    const others = ids.filter((id) => id !== meId).map((id) => users[id]?.displayName ?? 'Someone');
    return ids.includes(meId ?? -1) ? ['You', ...others] : others;
  }, [project, users, meId]);
}

export function NewChannelDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const project = useAppState((s) => s.projects[projectId]);
  const names = useMemberNames(projectId);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const channel = toChannelName(name);

  async function create() {
    setBusy(true);
    setError('');
    try {
      const id = await createChannel(projectId, channel);
      onClose();
      await openConversation(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!project) return null;
  return (
    <Dialog title={`New channel in ${project.name}`} onClose={onClose}>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (channel) void create();
        }}
      >
        <label className="field">
          Channel name
          <span className="channel-input">
            <HashIcon width={16} height={16} />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="design, slides, research"
              maxLength={LIMITS.channelNameLength + 10}
              autoFocus
            />
          </span>
        </label>
        {name && channel !== name && (
          <p className="dialog-intro">
            It will be called <strong>#{channel || '…'}</strong>.
          </p>
        )}
        <p className="dialog-intro">Everyone in the project can read it: {names.join(', ')}.</p>
        {error && <p className="form-error">{error}</p>}
        <button className="button-primary" type="submit" disabled={busy || !channel}>
          Create channel
        </button>
      </form>
    </Dialog>
  );
}

const NO_KEYS = 'Must sign in again to turn on encryption';

export function AddPeopleDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const project = useAppState((s) => s.projects[projectId]);
  const users = useAppState((s) => s.users);
  const names = useMemberNames(projectId);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    const members = new Set(project?.memberIds ?? []);
    return Object.values(users)
      .filter((u) => !members.has(u.id))
      .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [users, project, query]);

  function toggle(id: number) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function add() {
    setBusy(true);
    setError('');
    try {
      await addProjectMembers(projectId, [...picked]);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!project) return null;
  const tooMany = picked.size > LIMITS.addMembersAtOnce;
  return (
    <Dialog title={`Add people to ${project.name}`} onClose={onClose}>
      <p className="dialog-intro">In this project: {names.join(', ')}.</p>
      <p className="dialog-intro">
        People you add join every channel and can read earlier messages too. Your browser shares the channel keys with
        them, so this works only while you can open every channel.
      </p>
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
            <label className="person">
              <input type="checkbox" checked={picked.has(user.id)} onChange={() => toggle(user.id)} disabled={!user.keys} />
              <Avatar name={user.displayName} seed={user.id} size={38} online={user.online} />
              <span>
                <strong>{user.displayName}</strong>
                <small>{user.keys ? `@${user.username}` : NO_KEYS}</small>
              </span>
            </label>
          </li>
        ))}
        {people.length === 0 && (
          <li className="people-empty">{query ? 'Nobody matches.' : 'Everyone who has joined the site is already here.'}</li>
        )}
      </ul>
      {tooMany && <p className="form-error">Add up to {LIMITS.addMembersAtOnce} people at a time.</p>}
      {error && <p className="form-error">{error}</p>}
      <button className="button-primary" onClick={() => void add()} disabled={busy || picked.size === 0 || tooMany}>
        {picked.size > 1 ? `Add ${picked.size} people` : 'Add to project'}
      </button>
    </Dialog>
  );
}
