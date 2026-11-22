import { useEffect, useMemo, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog as AstryxDialog, DialogHeader } from '@astryxdesign/core/Dialog';
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
import { GithubIcon, HashIcon, SearchIcon } from './icons';
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

/**
 * Adds people to a project or a group, one Add at a time. Any member can, and the people added read
 * the history. With no search it offers the people from the user's chats.
 */
export function AddPeopleDialog({ target, onClose }: { target: MembersTarget; onClose: () => void }) {
  const chat = useTarget(target);
  const users = useAppState((s) => s.users);
  const conversations = useAppState((s) => s.conversations);
  const meId = useAppState((s) => s.me?.id);
  const [query, setQuery] = useState('');
  // Those added here stay listed, marked Added, rather than vanish as they become members.
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /** Where the user and each person share a chat: a group's name, or their direct chat. */
  const sharedChat = useMemo(() => {
    const where = new Map<number, string>();
    for (const c of Object.values(conversations)) {
      if (c.type === 'channel') continue;
      for (const m of c.members) {
        if (m.userId !== meId && !where.has(m.userId))
          where.set(m.userId, c.type === 'direct' ? 'Direct chat' : `In ${c.title ?? 'a group'}`);
      }
    }
    return where;
  }, [conversations, meId]);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    const members = new Set(chat?.memberIds ?? []);
    return Object.values(users)
      .filter((u) => u.id !== meId && !u.deleted && (added.has(u.id) || !members.has(u.id)))
      .filter((u) =>
        q ? u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) : sharedChat.has(u.id),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [users, chat, query, added, sharedChat, meId]);

  async function add(id: number) {
    setBusy(true);
    setError('');
    try {
      await (target.kind === 'project'
        ? addProjectMembers(target.projectId, [id])
        : addGroupMembers(target.conversationId, [id]));
      setAdded((current) => new Set(current).add(id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!chat) return null;
  return (
    <AstryxDialog isOpen onOpenChange={(open) => !open && onClose()} width={460} maxHeight="min(680px, 90dvh)">
      <div className="mhead">
        <DialogHeader title="Add Member" onOpenChange={(open) => !open && onClose()} />
      </div>
      <div className="mbody">
        <label className="side-search">
          <SearchIcon width={16} height={16} />
          <input
            type="search"
            placeholder="Search by name or username"
            aria-label="Search by name or username"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </label>
        <section>
          <h3 className="mlbl">{query.trim() ? 'People' : 'From your chats'}</h3>
          {people.length > 0 ? (
            <div className="mlist">
              {people.map((user) => (
                <div key={user.id} className="mrow">
                  <Avatar name={user.displayName} seed={user.id} size={32} />
                  <span className="mrow-who">
                    {user.displayName}
                    <small>{user.keys ? (sharedChat.get(user.id) ?? `@${user.username}`) : NO_KEYS}</small>
                  </span>
                  {added.has(user.id) ? (
                    <span className="mrow-role">Added</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary sm"
                      aria-label={`Add ${user.displayName}`}
                      onClick={() => void add(user.id)}
                      disabled={!user.keys || busy}
                    >
                      Add
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="mnote">{query.trim() ? 'Nobody matches.' : 'Search for anyone who has joined the site.'}</p>
          )}
        </section>
        {error && <Banner status="error" title={error} />}
      </div>
      <footer className="mfoot">
        <button type="button" className="btn btn-primary mfoot-done" onClick={onClose}>
          Done
        </button>
      </footer>
    </AstryxDialog>
  );
}
