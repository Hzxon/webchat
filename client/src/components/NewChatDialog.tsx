import { useMemo, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { List, ListItem } from '@astryxdesign/core/List';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { LIMITS } from '../../../shared/types';
import { createProject, openConversation, startDirectChat, startGroupChat } from '../chat';
import { useAppState } from '../store';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { PickItem } from './PickItem';
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
      .filter((u) => !u.deleted)
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

  const nameLimit = mode === 'project' ? LIMITS.projectNameLength : LIMITS.groupTitleLength;

  return (
    <Dialog title={mode === 'project' ? 'New project' : 'New chat'} onClose={onClose}>
      <SegmentedControl label="Kind of chat" value={mode} onChange={(v) => setMode(v as NewChatMode)} layout="fill">
        <SegmentedControlItem value="person" label="Person" />
        <SegmentedControlItem value="group" label="Group" />
        <SegmentedControlItem value="project" label="Project" />
      </SegmentedControl>

      {mode !== 'person' && (
        <TextInput
          label={mode === 'project' ? 'Project name' : 'Group name'}
          value={groupName}
          onChange={(v) => setGroupName(v.slice(0, nameLimit))}
          placeholder={mode === 'project' ? 'Capstone, Thesis, Robotics club' : undefined}
        />
      )}
      {mode === 'project' && (
        <Text as="p" color="secondary">
          The project starts with a #general channel. Everyone in it can read every channel, including earlier messages,
          and can add more people later.
        </Text>
      )}

      <TextInput
        label="Search people"
        isLabelHidden
        placeholder="Search people"
        type="search"
        value={query}
        onChange={setQuery}
        hasAutoFocus
      />

      <List edge="flush">
        {people.map((user) =>
          mode === 'person' ? (
            <ListItem
              key={user.id}
              label={user.displayName}
              description={user.keys ? presenceText(user) : NO_KEYS}
              startContent={<Avatar name={user.displayName} seed={user.id} size={38} online={user.online} />}
              onClick={() => void openDirect(user.id)}
              isDisabled={busy || !user.keys}
            />
          ) : (
            <PickItem
              key={user.id}
              label={user.displayName}
              description={user.keys ? `@${user.username}` : NO_KEYS}
              start={<Avatar name={user.displayName} seed={user.id} size={38} online={user.online} />}
              checked={picked.has(user.id)}
              onChange={() => toggle(user.id)}
              isDisabled={!user.keys}
            />
          ),
        )}
      </List>
      {people.length === 0 && (
        <Text as="p" color="secondary">
          {query ? 'Nobody matches.' : 'No one else has joined yet. Share the site address and the invite code.'}
        </Text>
      )}

      {error && <Banner status="error" title={error} />}
      {mode === 'project' && (
        <Button
          variant="primary"
          onClick={() => void startProject()}
          isLoading={busy}
          isDisabled={!groupName.trim()}
          label={picked.size > 0 ? `Create project with ${picked.size}` : 'Create project'}
        />
      )}
      {mode === 'group' && (
        <Button
          variant="primary"
          onClick={() => void createGroup()}
          isLoading={busy}
          isDisabled={picked.size === 0 || !groupName.trim()}
          label={`Create group${picked.size > 0 ? ` with ${picked.size}` : ''}`}
        />
      )}
    </Dialog>
  );
}
