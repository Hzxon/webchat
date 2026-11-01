import { useEffect, useMemo, useState } from 'react';
import { LIMITS, type ProjectRepoDTO } from '../../../shared/types';
import { api } from '../api';
import { addGroupMembers, addProjectMembers, createChannel, openConversation } from '../chat';
import { actions, useAppState } from '../store';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { GithubIcon, HashIcon } from './icons';
import type { MembersTarget } from './MembersDialog';

/** Slack-style channel name: lowercase, words joined by single hyphens, letters and digits in any script. */
export const toChannelName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.channelNameLength);

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

/**
 * The GitHub repositories a project links. A member's new pull request in one is shared into the
 * linked channel by that member's own WebChat (D-046). Everyone sees the list; the owner changes it.
 */
export function ProjectReposDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const project = useAppState((s) => s.projects[projectId]);
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const github = useAppState((s) => s.github);
  const [repos, setRepos] = useState<ProjectRepoDTO[] | null>(null);
  const [repo, setRepo] = useState('');
  const [picked, setPicked] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Oldest first, so #general, the project's first channel, is the default.
  const channels = useMemo(
    () => Object.values(conversations).filter((c) => c.projectId === projectId).sort((a, b) => a.id - b.id),
    [conversations, projectId],
  );
  const channelId = picked || channels[0]?.id || 0;

  useEffect(() => {
    api.projectRepos(projectId).then(setRepos, (err: Error) => setError(err.message));
  }, [projectId]);

  async function run(work: () => Promise<ProjectRepoDTO[]>): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      setRepos(await work());
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    if (await run(() => api.linkRepo(projectId, repo, channelId))) setRepo('');
  }

  if (!project) return null;
  const isOwner = project.ownerId === meId;
  const channelName = (id: number) => `#${conversations[id]?.title ?? 'channel'}`;
  return (
    <Dialog title={`Repositories in ${project.name}`} onClose={onClose}>
      <p className="dialog-intro">
        When someone here opens a pull request in a linked repository, their WebChat shares it into the channel as a card
        that names the reviewers. Drafts wait until they are ready for review.
      </p>
      <p className="dialog-intro">
        This works for people who connected GitHub. Everyone in the project sees each shared title, even without access
        to the repository.
      </p>
      {github?.configured && !github.account && (
        <button
          className="button-secondary"
          onClick={() => {
            onClose();
            actions.setGithubOpen(true);
          }}
        >
          Connect GitHub to share yours
        </button>
      )}
      {github?.account && !github.account.autoShare && (
        <p className="dialog-note">You turned off sharing your pull requests in the Pull requests pane.</p>
      )}
      <ul className="people-list">
        {repos?.map((linked) => (
          <li key={linked.repo} className="member">
            <span className="share-mark">
              <GithubIcon width={18} height={18} />
            </span>
            <span className="member-name">
              <strong>{linked.repo}</strong>
              <small>Into {channelName(linked.conversationId)}</small>
            </span>
            {isOwner && (
              <button
                className="member-remove"
                onClick={() => void run(() => api.unlinkRepo(projectId, linked.repo))}
                disabled={busy}
                aria-label={`Unlink ${linked.repo}`}
              >
                Unlink
              </button>
            )}
          </li>
        ))}
        {repos?.length === 0 && <li className="people-empty">No repositories linked yet.</li>}
        {!repos && !error && <li className="people-empty">Loading…</li>}
      </ul>
      {isOwner ? (
        <form
          className="dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (repo.trim() && channelId) void link();
          }}
        >
          <label className="field">
            Repository
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name, or its GitHub link" />
          </label>
          <label className="field">
            Share into
            <select className="field-input" value={channelId} onChange={(e) => setPicked(Number(e.target.value))}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.title}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="button-primary" type="submit" disabled={busy || !repo.trim() || !channelId}>
            Link repository
          </button>
        </form>
      ) : (
        <>
          {error && <p className="form-error">{error}</p>}
          <p className="dialog-intro">
            Only {users[project.ownerId]?.displayName ?? 'its owner'} can link or unlink repositories.
          </p>
        </>
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
      .filter((u) => !members.has(u.id))
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
      await (target.kind === 'project' ? addProjectMembers(target.projectId, ids) : addGroupMembers(target.conversationId, ids));
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
      <p className="dialog-intro">In this {noun}: {names.join(', ')}.</p>
      <p className="dialog-intro">
        {target.kind === 'project'
          ? 'People you add join every channel and can read earlier messages too. Your browser shares the channel keys with them, so this works only while you can open every channel.'
          : 'People you add can read earlier messages too. Your browser shares the group’s key with them.'}
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
        {picked.size > 1 ? `Add ${picked.size} people` : `Add to ${noun}`}
      </button>
    </Dialog>
  );
}
