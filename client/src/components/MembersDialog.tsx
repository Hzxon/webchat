import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Dialog as AstryxDialog, DialogHeader } from '@astryxdesign/core/Dialog';
import {
  deleteGroup,
  deleteProject,
  handOverGroup,
  handOverProject,
  leaveGroup,
  leaveProject,
  removeGroupMember,
  removeProjectMember,
} from '../chat';
import { useAppState } from '../store';
import { Avatar } from './Avatar';
import { PlusIcon } from './icons';
import { confirmAction } from './ConfirmHost';

/** Whose members to show or add to: a project's or a group's. */
export type MembersTarget = { kind: 'project'; projectId: number } | { kind: 'group'; conversationId: number };

/**
 * The people in a project or group and their roles. Its owner can remove people, hand it to someone
 * else from a member's role, and delete it for everyone. Everyone else can leave.
 */
export function MembersDialog({
  target,
  onAdd,
  onClose,
}: {
  target: MembersTarget;
  onAdd: () => void;
  onClose: () => void;
}) {
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
  const ownerId = project?.ownerId ?? group?.ownerId ?? null;
  const canManage = ownerId === null || ownerId === me.id;
  const rank = (id: number) => (id === ownerId ? 0 : id === me.id ? 1 : 2);
  const people = memberIds
    .map((id) => ({ id, user: id === me.id ? me : users[id] }))
    .map(({ id, user }) => ({
      id,
      name: user?.displayName ?? 'Someone',
      agent: user?.agentOwner != null,
    }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  // The owner hands it over first, so it always has one. The last person in it deletes it instead.
  const canLeave = ownerId !== me.id && people.length > 1;

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

  async function remove(person: { id: number; name: string }) {
    const after =
      target.kind === 'project'
        ? 'They leave every channel and cannot read anything sent after this. You can add them again later.'
        : 'They cannot read anything sent after this. You can add them again later.';
    if (
      !(await confirmAction({
        title: `Remove ${person.name} from ${name}?`,
        body: after,
        confirmLabel: 'Remove',
      }))
    )
      return;
    void run(() =>
      target.kind === 'project'
        ? removeProjectMember(target.projectId, person.id)
        : removeGroupMember(target.conversationId, person.id),
    );
  }

  async function handOver(person: { id: number; name: string }) {
    const yes = await confirmAction({
      title: `Make ${person.name} the owner of ${name}?`,
      body: 'Only they can then remove people or delete it, and you can leave.',
      confirmLabel: 'Make owner',
      destructive: false,
    });
    if (!yes) return;
    void run(() =>
      target.kind === 'project'
        ? handOverProject(target.projectId, person.id)
        : handOverGroup(target.conversationId, person.id),
    );
  }

  async function leave() {
    const warning = 'You stop getting its messages and cannot read anything sent after you leave.';
    if (
      !(await confirmAction({
        title: `Leave ${name}?`,
        body: `${warning} Someone in it can add you again later.`,
        confirmLabel: `Leave ${target.kind}`,
      }))
    )
      return;
    const left = await run(() =>
      target.kind === 'project' ? leaveProject(target.projectId) : leaveGroup(target.conversationId),
    );
    if (left) onClose();
  }

  async function deleteForEveryone() {
    const what = target.kind === 'project' ? 'Every channel and message in it' : 'Every message in it';
    const yes = await confirmAction({
      title: `Delete ${name} for everyone?`,
      body: `${what} will be deleted for all members. This cannot be undone.`,
      confirmLabel: `Delete ${target.kind}`,
    });
    if (!yes) return;
    const deleted = await run(() =>
      target.kind === 'project' ? deleteProject(target.projectId) : deleteGroup(target.conversationId),
    );
    if (deleted) onClose();
  }

  return (
    <AstryxDialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      width={600}
      maxHeight="min(720px, 90dvh)"
      padding={0}
    >
      <div className="mhead">
        <DialogHeader title={`Members of ${name}`} onOpenChange={(open) => !open && onClose()} />
      </div>
      <div className="mbody">
        <section className="mlbl-row">
          <h3 className="mlbl">Invite people</h3>
          <button type="button" className="btn btn-secondary sm" onClick={onAdd}>
            <PlusIcon width={16} height={16} />
            Add member
          </button>
        </section>
        <section>
          <h3 className="mlbl">
            {people.length} {people.length === 1 ? 'member' : 'members'}
          </h3>
          <div className="mlist">
            {people.map((person) => {
              // An agent can neither remove people nor hand it back, so it never owns one (D-114).
              const role = person.id === ownerId ? 'Owner' : person.agent ? 'Agent' : 'Member';
              const manageable = canManage && person.id !== me.id && person.id !== ownerId;
              return (
                <div key={person.id} className="mrow">
                  <Avatar name={person.name} seed={person.id} size={32} />
                  <span className="mrow-who">{person.name}</span>
                  {manageable && !person.agent ? (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      title="Make owner"
                      aria-label={`${role}. Make ${person.name} the owner of ${name}`}
                      onClick={() => handOver(person)}
                      disabled={busy}
                    >
                      {role}
                    </button>
                  ) : (
                    <span className="mrow-role">{role}</span>
                  )}
                  {manageable && (
                    <button
                      type="button"
                      className="btn btn-danger-quiet"
                      aria-label={`Remove ${person.name} from ${name}`}
                      onClick={() => remove(person)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        {error && <Banner status="error" title={error} />}
      </div>
      <footer className="mfoot">
        {canLeave && (
          <button type="button" className="btn btn-secondary" onClick={() => void leave()} disabled={busy}>
            Leave {noun}
          </button>
        )}
        {canManage && (
          <button
            type="button"
            className="btn btn-danger-quiet"
            onClick={() => void deleteForEveryone()}
            disabled={busy}
          >
            Delete {noun}
          </button>
        )}
        <button type="button" className="btn btn-primary mfoot-done" onClick={onClose}>
          Done
        </button>
      </footer>
    </AstryxDialog>
  );
}
