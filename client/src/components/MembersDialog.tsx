import { useState } from 'react';
import { deleteGroup, deleteProject, removeGroupMember, removeProjectMember } from '../chat';
import { useAppState } from '../store';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';

/** Whose members to show: a project's or a group's. */
export type MembersTarget = { kind: 'project'; projectId: number } | { kind: 'group'; conversationId: number };

/**
 * The people in a project or group. The person who made it can remove people and delete it for
 * everyone; everyone else sees who can.
 */
export function MembersDialog({ target, onClose }: { target: MembersTarget; onClose: () => void }) {
  const me = useAppState((s) => s.me);
  const users = useAppState((s) => s.users);
  const project = useAppState((s) => (target.kind === 'project' ? s.projects[target.projectId] : undefined));
  const group = useAppState((s) => (target.kind === 'group' ? s.conversations[target.conversationId] : undefined));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!me || (!project && !group)) return null;
  const noun = target.kind;
  const name = project?.name ?? group?.title ?? 'Group';
  const memberIds = project?.memberIds ?? group?.members.map((m) => m.userId) ?? [];
  // A group from before encryption may have no owner; then any member can manage it.
  const ownerId = project?.createdBy ?? group?.createdBy ?? null;
  const canManage = ownerId === null || ownerId === me.id;
  const rank = (id: number) => (id === ownerId ? 0 : id === me.id ? 1 : 2);
  const people = memberIds
    .map((id) => ({ id, user: id === me.id ? me : users[id] }))
    .map(({ id, user }) => ({ id, name: user?.displayName ?? 'Someone', username: user?.username ?? '', online: user?.online }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  const owner = people.find((p) => p.id === ownerId);

  async function run(work: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      await work();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function remove(person: { id: number; name: string }) {
    const after =
      target.kind === 'project'
        ? 'They leave every channel and stop getting its messages. You can add them again later.'
        : 'They stop getting its messages. People cannot be added to a group, so they cannot come back.';
    if (!confirm(`Remove ${person.name} from ${name}? ${after}`)) return;
    void run(() =>
      target.kind === 'project' ? removeProjectMember(target.projectId, person.id) : removeGroupMember(target.conversationId, person.id),
    );
  }

  async function deleteForEveryone() {
    const what = target.kind === 'project' ? 'Every channel and message in it' : 'Every message in it';
    if (!confirm(`Delete ${name} for everyone? ${what} will be deleted for all members. This cannot be undone.`)) return;
    const deleted = await run(() =>
      target.kind === 'project' ? deleteProject(target.projectId) : deleteGroup(target.conversationId),
    );
    if (deleted) onClose();
  }

  return (
    <Dialog title={name} onClose={onClose}>
      <p className="dialog-intro">
        {people.length} {people.length === 1 ? 'member' : 'members'}
        {owner && `. ${owner.id === me.id ? 'You' : owner.name} made this ${noun}.`}
      </p>
      <ul className="people-list">
        {people.map((person) => (
          <li key={person.id} className="member">
            <Avatar name={person.name} seed={person.id} size={38} online={person.id !== me.id && person.online} />
            <span className="member-name">
              <strong>{person.id === me.id ? 'You' : person.name}</strong>
              <small>{person.id === ownerId ? 'Owner' : `@${person.username}`}</small>
            </span>
            {canManage && person.id !== me.id && person.id !== ownerId && (
              <button
                className="member-remove"
                onClick={() => remove(person)}
                disabled={busy}
                aria-label={`Remove ${person.name} from ${name}`}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
      {canManage ? (
        <button className="button-danger" onClick={() => void deleteForEveryone()} disabled={busy}>
          Delete {noun}
        </button>
      ) : (
        <p className="dialog-intro">
          Only {owner?.name ?? 'its owner'} can remove people or delete this {noun}.
        </p>
      )}
    </Dialog>
  );
}
