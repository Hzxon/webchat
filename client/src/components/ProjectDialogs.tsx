import { useEffect, useMemo, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { List, ListItem } from '@astryxdesign/core/List';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Selector } from '@astryxdesign/core/Selector';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { LIMITS, toChannelName, type ProjectReposDTO } from '../../../shared/types';
import { api } from '../api';
import { addGroupMembers, addProjectMembers, createChannel, openConversation } from '../chat';
import { DOC_TEMPLATES } from '../docTemplates';
import { createDoc } from '../docs';
import { actions, useAppState } from '../store';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { PickItem } from './PickItem';
import { GithubIcon, HashIcon } from './icons';
import type { MembersTarget } from './MembersDialog';

/** A project or group from the store, with its members' ids in the order they joined. */
function useTarget(target: MembersTarget) {
  const project = useAppState((s) => (target.kind === 'project' ? s.projects[target.projectId] : undefined));
  const group = useAppState((s) => (target.kind === 'group' ? s.conversations[target.conversationId] : undefined));
  return useMemo(() => {
    if (project) return { name: project.name, memberIds: project.memberIds };
    if (group) return { name: group.title ?? 'Group', memberIds: group.members.map((m) => m.userId) };
    return undefined;
  }, [project, group]);
}

/** Names of the people in a project or group, with "You" first. */
function useMemberNames(memberIds: number[]) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  return useMemo(() => {
    const others = memberIds.filter((id) => id !== meId).map((id) => users[id]?.displayName ?? 'Someone');
    return memberIds.includes(meId ?? -1) ? ['You', ...others] : others;
  }, [memberIds, users, meId]);
}

const NO_MEMBERS: number[] = [];

export function NewChannelDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const project = useAppState((s) => s.projects[projectId]);
  const names = useMemberNames(project?.memberIds ?? NO_MEMBERS);
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
      <Stack
        as="form"
        gap={4}
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault();
          if (channel) void create();
        }}
      >
        <TextInput
          label="Channel name"
          startIcon={HashIcon}
          value={name}
          onChange={(v) => setName(v.slice(0, LIMITS.channelNameLength + 10))}
          placeholder="design, slides, research"
          hasAutoFocus
        />
        {name && channel !== name && (
          <Text as="p" color="secondary">
            It will be called <strong>#{channel || '…'}</strong>.
          </Text>
        )}
        <Text as="p" color="secondary">
          Everyone in the project can read it: {names.join(', ')}.
        </Text>
        {error && <Banner status="error" title={error} />}
        <Button variant="primary" type="submit" isLoading={busy} isDisabled={!channel} label="Create channel" />
      </Stack>
    </Dialog>
  );
}

/** A new doc in a project, from a template. Everyone in the project can read and edit it (R-020). */
export function NewDocDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const project = useAppState((s) => s.projects[projectId]);
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError('');
    try {
      const id = await createDoc(projectId, title.trim(), DOC_TEMPLATES[template]!.sections);
      onClose();
      actions.setDocOpen(id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (!project) return null;
  return (
    <Dialog title={`New doc in ${project.name}`} onClose={onClose}>
      <Stack
        as="form"
        gap={4}
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault();
          if (title.trim()) void create();
        }}
      >
        <TextInput
          label="Title"
          value={title}
          onChange={(v) => setTitle(v.slice(0, LIMITS.docTitleLength))}
          placeholder="Capstone PRD"
          hasAutoFocus
        />
        <RadioList label="Start from" value={String(template)} onChange={(v) => setTemplate(Number(v))}>
          {DOC_TEMPLATES.map((t, i) => (
            <RadioListItem key={t.name} value={String(i)} label={t.name} description={t.description} />
          ))}
        </RadioList>
        <Text as="p" color="secondary">
          Everyone in the project can read and edit it. It is end-to-end encrypted.
        </Text>
        {error && <Banner status="error" title={error} />}
        <Button variant="primary" type="submit" isLoading={busy} isDisabled={!title.trim()} label="Create doc" />
      </Stack>
    </Dialog>
  );
}

/** The repositories dialog leaves the app for these, and GitHub sends the browser back to it. */
const installOnGithub = (projectId: number) => location.assign(`/api/github/app/install?project=${projectId}`);
const chooseOnGithub = (projectId: number) => location.assign(`/api/github/app/link?project=${projectId}`);

/**
 * The GitHub repositories a project links. GitHub tells WebChat about the pull requests in them,
 * and the server posts each one into the linked channel as a card (D-050). Everyone sees the list.
 * The owner links a repository by installing the WebChat GitHub App on it, then picking it here.
 */
export function ProjectReposDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const project = useAppState((s) => s.projects[projectId]);
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const [view, setView] = useState<ProjectReposDTO | null>(null);
  const [repoId, setRepoId] = useState(0);
  const [picked, setPicked] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Oldest first, so #general, the project's first channel, is the default.
  const channels = useMemo(
    () =>
      Object.values(conversations)
        .filter((c) => c.projectId === projectId)
        .sort((a, b) => a.id - b.id),
    [conversations, projectId],
  );
  const channelId = picked || channels[0]?.id || 0;
  const choices = view?.choices ?? [];
  const choiceId = choices.some((c) => c.repoId === repoId) ? repoId : (choices[0]?.repoId ?? 0);

  useEffect(() => {
    api.projectRepos(projectId).then(setView, (err: Error) => setError(err.message));
  }, [projectId]);

  async function run(work: () => Promise<ProjectReposDTO>) {
    setBusy(true);
    setError('');
    try {
      setView(await work());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!project) return null;
  const isOwner = project.ownerId === meId;
  const channelName = (id: number) => `#${conversations[id]?.title ?? 'channel'}`;
  return (
    <Dialog title={`Repositories in ${project.name}`} onClose={onClose}>
      <Text as="p" color="secondary">
        When someone opens a pull request in a linked repository, WebChat posts it into the channel as a card. It posts
        again when the pull request is ready for review, merged or closed. GitHub sends these, so nobody has to connect
        GitHub.
      </Text>
      <Text as="p" color="secondary">
        Everyone in the project sees each card, even without access to the repository. The server writes the cards, so
        they are not end-to-end encrypted.
      </Text>
      <List edge="flush">
        {view?.repos.map((linked) => (
          <ListItem
            key={linked.repoId}
            startContent={
              <span className="share-mark">
                <GithubIcon width={18} height={18} />
              </span>
            }
            label={linked.repo}
            description={`Into ${channelName(linked.conversationId)}`}
            endContent={
              isOwner && (
                <Button
                  variant="ghost"
                  size="sm"
                  label="Unlink"
                  aria-label={`Unlink ${linked.repo}`}
                  onClick={() => void run(() => api.unlinkRepo(projectId, linked.repoId))}
                  isDisabled={busy}
                />
              )
            }
          />
        ))}
      </List>
      {view?.repos.length === 0 && (
        <Text as="p" color="secondary">
          No repositories linked yet.
        </Text>
      )}
      {!view && !error && (
        <Text as="p" color="secondary">
          Loading…
        </Text>
      )}
      {!isOwner ? (
        <>
          {error && <Banner status="error" title={error} />}
          <Text as="p" color="secondary">
            Only {users[project.ownerId]?.displayName ?? 'its owner'} can link or unlink repositories.
          </Text>
        </>
      ) : view && !view.configured ? (
        <Text as="p" weight="semibold">
          The server owner has not set up the WebChat GitHub App yet, so repositories cannot be linked.
        </Text>
      ) : choices.length > 0 ? (
        <Stack
          as="form"
          gap={4}
          onSubmit={(e: React.FormEvent) => {
            e.preventDefault();
            if (choiceId && channelId)
              void run(() => api.linkRepo(projectId, { repoId: choiceId, conversationId: channelId }));
          }}
        >
          <Selector
            label="Repository"
            value={String(choiceId)}
            onChange={(v) => setRepoId(Number(v))}
            options={choices.map((c) => ({ value: String(c.repoId), label: c.repo }))}
          />
          <Selector
            label="Post into"
            value={String(channelId)}
            onChange={(v) => setPicked(Number(v))}
            options={channels.map((c) => ({ value: String(c.id), label: `#${c.title}` }))}
          />
          {error && <Banner status="error" title={error} />}
          <Button
            variant="primary"
            type="submit"
            isLoading={busy}
            isDisabled={!choiceId || !channelId}
            label="Link repository"
          />
          <Button label="Add another repository on GitHub" onClick={() => installOnGithub(projectId)} />
        </Stack>
      ) : (
        view && (
          <Stack gap={4}>
            <Text as="p" color="secondary">
              First install the WebChat app on the repository on GitHub. Only someone who can manage the repository can
              install it.
            </Text>
            {error && <Banner status="error" title={error} />}
            <Button variant="primary" label="Install on GitHub" onClick={() => installOnGithub(projectId)} />
            <Button label="Already installed? Choose a repository" onClick={() => chooseOnGithub(projectId)} />
          </Stack>
        )
      )}
    </Dialog>
  );
}

const NO_KEYS = 'Must sign in again to turn on encryption';

/** Adds people to a project or a group. Any member can, and the people added read the history. */
export function AddPeopleDialog({ target, onClose }: { target: MembersTarget; onClose: () => void }) {
  const chat = useTarget(target);
  const users = useAppState((s) => s.users);
  const names = useMemberNames(chat?.memberIds ?? NO_MEMBERS);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    const members = new Set(chat?.memberIds ?? []);
    return Object.values(users)
      .filter((u) => !members.has(u.id) && !u.deleted)
      .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [users, chat, query]);

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
      const ids = [...picked];
      await (target.kind === 'project'
        ? addProjectMembers(target.projectId, ids)
        : addGroupMembers(target.conversationId, ids));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!chat) return null;
  const noun = target.kind;
  const tooMany = picked.size > LIMITS.addMembersAtOnce;
  return (
    <Dialog title={`Add people to ${chat.name}`} onClose={onClose}>
      <Text as="p" color="secondary">
        In this {noun}: {names.join(', ')}.
      </Text>
      <Text as="p" color="secondary">
        {target.kind === 'project'
          ? 'People you add join every channel and can read earlier messages too. You can add people only while you can open every channel yourself.'
          : 'People you add can read earlier messages too. Your browser shares the group’s key with them.'}
      </Text>
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
        {people.map((user) => (
          <PickItem
            key={user.id}
            label={user.displayName}
            description={user.keys ? `@${user.username}` : NO_KEYS}
            start={<Avatar name={user.displayName} seed={user.id} size={38} online={user.online} />}
            checked={picked.has(user.id)}
            onChange={() => toggle(user.id)}
            isDisabled={!user.keys}
          />
        ))}
      </List>
      {people.length === 0 && (
        <Text as="p" color="secondary">
          {query ? 'Nobody matches.' : 'Everyone who has joined the site is already here.'}
        </Text>
      )}
      {tooMany && <Banner status="error" title={`Add up to ${LIMITS.addMembersAtOnce} people at a time.`} />}
      {error && <Banner status="error" title={error} />}
      <Button
        variant="primary"
        onClick={() => void add()}
        isLoading={busy}
        isDisabled={picked.size === 0 || tooMany}
        label={picked.size > 1 ? `Add ${picked.size} people` : `Add to ${noun}`}
      />
    </Dialog>
  );
}
