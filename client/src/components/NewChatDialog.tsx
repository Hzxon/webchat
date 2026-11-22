import { useMemo, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { List } from '@astryxdesign/core/List';
import { Stack } from '@astryxdesign/core/Stack';
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

/** People and groups start from one list: pick one person or several. A project starts from the same list with a name. */
export function NewChatDialog({ initialMode = 'person', onClose }: { initialMode?: NewChatMode; onClose: () => void }) {
  const users = useAppState((s) => s.users);
  const project = initialMode === 'project';
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

  // One person picked opens the chat with them; more make a group, named by its people unless named.
  function startChat() {
    const ids = [...picked];
    if (ids.length === 1) return run(() => startDirectChat(ids[0]));
    const named = groupName.trim() || ['You', ...ids.map((id) => users[id]?.displayName.split(' ')[0] ?? 'Someone')].join(', ');
    return run(() => startGroupChat(named.slice(0, LIMITS.groupTitleLength), ids));
  }
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
    <Dialog title={project ? 'New project' : 'New chat'} onClose={onClose}>
      {(project || picked.size > 1) && (
        <TextInput
          label={project ? 'Project name' : 'Group name'}
          value={groupName}
          onChange={(v) => setGroupName(v.slice(0, project ? LIMITS.projectNameLength : LIMITS.groupTitleLength))}
          placeholder={project ? 'Capstone, Thesis, Robotics club' : 'Optional'}
          hasAutoFocus={project}
        />
      )}

      <TextInput
        label="Search people"
        isLabelHidden
        placeholder="Search people"
        type="search"
        value={query}
        onChange={setQuery}
        hasAutoFocus={!project}
      />

      <List edge="flush">
        {people.map((user) => (
          <PickItem
            key={user.id}
            label={user.displayName}
            description={user.keys ? presenceText(user) : NO_KEYS}
            start={<Avatar name={user.displayName} seed={user.id} size={32} online={user.online} />}
            checked={picked.has(user.id)}
            onChange={() => toggle(user.id)}
            isDisabled={busy || !user.keys}
          />
        ))}
      </List>
      {people.length === 0 && (
        <Text as="p" color="secondary">
          {query ? 'Nobody matches.' : 'No one else has joined yet. Share the site address and the invite code.'}
        </Text>
      )}

      {error && <Banner status="error" title={error} />}
      <Stack direction="horizontal" hAlign="end">
        {project ? (
          <Button
            variant="primary"
            onClick={() => void startProject()}
            isLoading={busy}
            isDisabled={!groupName.trim()}
            label="Create project"
          />
        ) : (
          <Button variant="primary" onClick={() => void startChat()} isLoading={busy} isDisabled={picked.size === 0} label="Start chat" />
        )}
      </Stack>
    </Dialog>
  );
}
