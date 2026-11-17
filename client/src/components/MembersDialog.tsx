import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { List, ListItem } from '@astryxdesign/core/List';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
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
import { Dialog } from './Dialog';

/** Whose members to show or add to: a project's or a group's. */
export type MembersTarget = { kind: 'project'; projectId: number } | { kind: 'group'; conversationId: number };

/**
 * The people in a project or group. Its owner can remove people, hand it to someone else, and
 * delete it for everyone. Everyone else can leave, and sees who owns it.
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
  const ownerId = project?.ownerId ?? group?.ownerId ?? null;
  const canManage = ownerId === null || ownerId === me.id;
  const rank = (id: number) => (id === ownerId ? 0 : id === me.id ? 1 : 2);
  const people = memberIds
    .map((id) => ({ id, user: id === me.id ? me : users[id] }))
    .map(({ id, user }) => ({
      id,
      name: user?.displayName ?? 'Someone',
      username: user?.username ?? '',
      online: user?.online,
      agent: user?.agentOwner != null,
    }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  const owner = people.find((p) => p.id === ownerId);
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

  function remove(person: { id: number; name: string }) {
    const after =
      target.kind === 'project'
        ? 'They leave every channel and cannot read anything sent after this. You can add them again later.'
        : 'They cannot read anything sent after this. You can add them again later.';
    if (!confirm(`Remove ${person.name} from ${name}? ${after}`)) return;
    void run(() =>
      target.kind === 'project'
        ? removeProjectMember(target.projectId, person.id)
        : removeGroupMember(target.conversationId, person.id),
    );
  }

  function handOver(person: { id: number; name: string }) {
    if (
      !confirm(
        `Make ${person.name} the owner of ${name}? Only they can then remove people or delete it, and you can leave.`,
      )
    )
      return;
    void run(() =>
      target.kind === 'project'
        ? handOverProject(target.projectId, person.id)
        : handOverGroup(target.conversationId, person.id),
    );
  }

  async function leave() {
    const warning = 'You stop getting its messages and cannot read anything sent after you leave.';
    if (!confirm(`Leave ${name}? ${warning} Someone in it can add you again later.`)) return;
    const left = await run(() =>
      target.kind === 'project' ? leaveProject(target.projectId) : leaveGroup(target.conversationId),
    );
    if (left) onClose();
  }

  async function deleteForEveryone() {
    const what = target.kind === 'project' ? 'Every channel and message in it' : 'Every message in it';
    if (!confirm(`Delete ${name} for everyone? ${what} will be deleted for all members. This cannot be undone.`))
      return;
    const deleted = await run(() =>
      target.kind === 'project' ? deleteProject(target.projectId) : deleteGroup(target.conversationId),
    );
    if (deleted) onClose();
  }

  return (
    <Dialog title={name} onClose={onClose}>
      <Text as="p" color="secondary">
        {people.length} {people.length === 1 ? 'member' : 'members'}
        {owner && `. ${owner.id === me.id ? 'You own' : `${owner.name} owns`} this ${noun}.`}
      </Text>
      <List edge="flush">
        {people.map((person) => (
          <ListItem
            key={person.id}
            startContent={
              <Avatar name={person.name} seed={person.id} size={38} online={person.id !== me.id && person.online} />
            }
            label={person.id === me.id ? 'You' : person.name}
            description={person.id === ownerId ? 'Owner' : `@${person.username}`}
            endContent={
              canManage &&
              person.id !== me.id &&
              person.id !== ownerId && (
                <Stack direction="horizontal" gap={1}>
                  {/* An agent can neither remove people nor hand it back, so it never owns one (D-114). */}
                  {!person.agent && (
                    <Button
                      variant="ghost"
                      size="sm"
                      label="Make owner"
                      aria-label={`Make ${person.name} the owner of ${name}`}
                      onClick={() => handOver(person)}
                      isDisabled={busy}
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    label="Remove"
                    aria-label={`Remove ${person.name} from ${name}`}
                    onClick={() => remove(person)}
                    isDisabled={busy}
                  />
                </Stack>
              )
            }
          />
        ))}
      </List>
      {error && <Banner status="error" title={error} />}
      {(canLeave || canManage) && (
        <Stack direction="horizontal" gap={2} wrap="wrap">
          {canLeave && <Button label={`Leave ${noun}`} onClick={() => void leave()} isDisabled={busy} />}
          {canManage && (
            <Button
              variant="destructive"
              label={`Delete ${noun}`}
              onClick={() => void deleteForEveryone()}
              isDisabled={busy}
            />
          )}
        </Stack>
      )}
      {ownerId === me.id
        ? people.length > 1 && (
            <Text as="p" color="secondary">
              To leave, make someone else the owner first.
            </Text>
          )
        : owner && (
            <Text as="p" color="secondary">
              Only {owner.name} can remove people or delete this {noun}.
            </Text>
          )}
    </Dialog>
  );
}
