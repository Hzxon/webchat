import { useEffect, useMemo, useState } from 'react';
import { LIMITS, toChannelName, type ProjectReposDTO } from '../../../shared/types';
import { api } from '../api';
import { addGroupMembers, addProjectMembers, createChannel, openConversation } from '../chat';
import { DOC_TEMPLATES } from '../docTemplates';
import { createDoc } from '../docs';
import { actions, useAppState } from '../store';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
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
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void create();
        }}
      >
        <label className="field">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Capstone PRD" maxLength={LIMITS.docTitleLength} />
        </label>
        <fieldset className="template-list">
          <legend>Start from</legend>
          {DOC_TEMPLATES.map((t, i) => (
            <label key={t.name} className="template-option">
              <input type="radio" name="template" checked={template === i} onChange={() => setTemplate(i)} />
              <span>
                <strong>{t.name}</strong>
                <small>{t.description}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="dialog-intro">Everyone in the project can read and edit it. It is end-to-end encrypted.</p>
        {error && <p className="form-error">{error}</p>}
        <button className="button-primary" type="submit" disabled={busy || !title.trim()}>
          Create doc
        </button>
      </form>
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
    () => Object.values(conversations).filter((c) => c.projectId === projectId).sort((a, b) => a.id - b.id),
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
      <p className="dialog-intro">
        When someone opens a pull request in a linked repository, WebChat posts it into the channel as a card. It posts
        again when the pull request is ready for review, merged or closed. GitHub sends these, so nobody has to connect
        GitHub.
      </p>
      <p className="dialog-intro">
        Everyone in the project sees each card, even without access to the repository. The server writes the cards, so
        they are not end-to-end encrypted.
      </p>
      <ul className="people-list">
        {view?.repos.map((linked) => (
          <li key={linked.repoId} className="member">
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
                onClick={() => void run(() => api.unlinkRepo(projectId, linked.repoId))}
                disabled={busy}
                aria-label={`Unlink ${linked.repo}`}
              >
                Unlink
              </button>
            )}
          </li>
        ))}
        {view?.repos.length === 0 && <li className="people-empty">No repositories linked yet.</li>}
        {!view && !error && <li className="people-empty">Loading…</li>}
      </ul>
      {!isOwner ? (
        <>
          {error && <p className="form-error">{error}</p>}
          <p className="dialog-intro">
            Only {users[project.ownerId]?.displayName ?? 'its owner'} can link or unlink repositories.
          </p>
        </>
      ) : view && !view.configured ? (
        <p className="dialog-note">
          The server owner has not set up the WebChat GitHub App yet, so repositories cannot be linked.
        </p>
      ) : choices.length > 0 ? (
        <form
          className="dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (choiceId && channelId) void run(() => api.linkRepo(projectId, { repoId: choiceId, conversationId: channelId }));
          }}
        >
          <label className="field">
            Repository
            <select className="field-input" value={choiceId} onChange={(e) => setRepoId(Number(e.target.value))}>
              {choices.map((c) => (
                <option key={c.repoId} value={c.repoId}>
                  {c.repo}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Post into
            <select className="field-input" value={channelId} onChange={(e) => setPicked(Number(e.target.value))}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.title}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="button-primary" type="submit" disabled={busy || !choiceId || !channelId}>
            Link repository
          </button>
          <button className="button-secondary" type="button" onClick={() => installOnGithub(projectId)}>
            Add another repository on GitHub
          </button>
        </form>
      ) : (
        view && (
          <div className="dialog-form">
            <p className="dialog-intro">
              First install the WebChat app on the repository on GitHub. Only someone who can manage the repository can
              install it.
            </p>
            {error && <p className="form-error">{error}</p>}
            <button className="button-primary" onClick={() => installOnGithub(projectId)}>
              Install on GitHub
            </button>
            <button className="button-secondary" onClick={() => chooseOnGithub(projectId)}>
              Already installed? Choose a repository
            </button>
          </div>
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
