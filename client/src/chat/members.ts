import { api, ApiError } from '../api';
import { keyring } from '../e2ee/keyring';
import { actions, store } from '../store';
import { adoptConversation, currentLookup, ensureChatKey, firstChatKey, keyRecipient, meId, reloadAll, syncNow, warnedIds } from './core';

/** A project starts with its #general channel. Returns that channel's id. */
export async function createProject(name: string, memberIds: number[]): Promise<number> {
  const state = store.get();
  const members = [
    { id: meId, name: 'You', keys: keyring.myKeys() },
    ...memberIds.map((id) => ({ id, name: state.users[id]?.displayName ?? 'Someone', keys: state.users[id]?.keys ?? null })),
  ];
  const { input, key } = await firstChatKey(members);
  const { project, channel } = await api.createProject({ name, memberIds, key: input });
  actions.upsertProject(project);
  return adoptConversation(channel, { keyId: input.keyId, key });
}

/**
 * Runs a change to a project or group. When the server says it changed meanwhile (someone joined
 * or left, or a channel was added), it reloads and tries once more, so every key is wrapped for
 * exactly the people in it.
 */
export async function retryIfStale<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ApiError && (error.code === 'stale_project' || error.code === 'stale_group'))) throw error;
    await reloadAll();
    return work();
  }
}

/** Adds a channel, with a new key for every member of the project. Returns the channel's id. */
export function createChannel(projectId: number, name: string): Promise<number> {
  return retryIfStale(async () => {
    const project = store.get().projects[projectId];
    if (!project) throw new Error('Project not found.');
    const { input, key } = await firstChatKey(project.memberIds.map(keyRecipient));
    return adoptConversation(await api.createChannel(projectId, { name, key: input }), { keyId: input.keyId, key });
  });
}

/** Adds people to a project, sharing every channel key with them so they can read the history. */
export function addProjectMembers(projectId: number, userIds: number[]): Promise<void> {
  return retryIfStale(async () => {
    // A channel that someone left gets its new key first, so newcomers never get one they hold, and
    // so does one whose key is from before keys named their chat (K-65).
    const keyed = Object.values(store.get().conversations).filter((c) => c.projectId === projectId && c.keyId);
    await Promise.all(keyed.map((c) => ensureChatKey(c.id)));
    const state = store.get();
    const keysOf = currentLookup();
    const recipients = userIds.map((id) => ({
      id,
      name: state.users[id]?.displayName ?? 'Someone',
      keys: state.users[id]?.keys ?? null,
    }));
    const channels = Object.values(state.conversations).filter((c) => c.projectId === projectId);
    const channelKeys = await Promise.all(
      channels.map(async (c) => ({
        conversationId: c.id,
        keyId: c.keyId ?? '',
        wrappedKeys: await keyring.shareChatKey(c, keysOf, recipients, warnedIds()),
      })),
    );
    actions.upsertProject(await api.addProjectMembers(projectId, { userIds, channelKeys }));
    void syncNow();
  });
}

/**
 * Removes someone from a project. This browser gives every channel a new key for the people who
 * stay, so the person removed cannot read what is sent next.
 */
export function removeProjectMember(projectId: number, userId: number): Promise<void> {
  return retryIfStale(async () => {
    const state = store.get();
    const project = state.projects[projectId];
    if (!project) throw new Error('Project not found.');
    // Removed already, for example from another tab.
    if (!project.memberIds.includes(userId)) return;
    const keysOf = currentLookup();
    const staying = project.memberIds.filter((id) => id !== userId).map(keyRecipient);
    const channels = Object.values(state.conversations).filter((c) => c.projectId === projectId);
    const rotated = await Promise.all(
      channels.map(async (c) => ({ conversationId: c.id, ...(await keyring.rotateChatKey(c, keysOf, staying, warnedIds())) })),
    );
    const channelKeys = rotated.map(({ conversationId, input }) => ({ conversationId, ...input }));
    actions.upsertProject(await api.removeProjectMember(projectId, userId, { channelKeys }));
    await Promise.all(rotated.map(({ conversationId, input, key }) => keyring.remember(conversationId, input.keyId, key)));
    void syncNow();
  });
}

/** Adds people to a group, sharing its key with them so they can read the history. */
export function addGroupMembers(conversationId: number, userIds: number[]): Promise<void> {
  return retryIfStale(async () => {
    // A group that someone left gets its new key first, so newcomers never get one they hold, and so
    // does one whose key is from before keys named their chat (K-65).
    if (store.get().conversations[conversationId]?.keyId) await ensureChatKey(conversationId);
    const conversation = store.get().conversations[conversationId];
    if (!conversation) throw new Error('Group not found.');
    const key = conversation.keyId
      ? {
          keyId: conversation.keyId,
          wrappedKeys: await keyring.shareChatKey(conversation, currentLookup(), userIds.map(keyRecipient), warnedIds()),
        }
      : null;
    await adoptConversation(await api.addGroupMembers(conversationId, { userIds, key }));
    void syncNow();
  });
}

/** Removes someone from a group, with a new key for the people who stay. */
export function removeGroupMember(conversationId: number, userId: number): Promise<void> {
  return retryIfStale(async () => {
    const conversation = store.get().conversations[conversationId];
    if (!conversation) throw new Error('Group not found.');
    if (!conversation.members.some((m) => m.userId === userId)) return;
    const staying = conversation.members.filter((m) => m.userId !== userId).map((m) => keyRecipient(m.userId));
    // A group from before encryption has no key to replace.
    const rotated = conversation.keyId
      ? await keyring.rotateChatKey(conversation, currentLookup(), staying, warnedIds())
      : null;
    await adoptConversation(
      await api.removeGroupMember(conversationId, userId, { key: rotated?.input ?? null }),
      rotated ? { keyId: rotated.input.keyId, key: rotated.key } : undefined,
    );
    void syncNow();
  });
}

/**
 * Leaves a project. This browser cannot make new keys for the others, so a member who stays gives
 * each channel one before anyone sends there again.
 */
export async function leaveProject(projectId: number) {
  await api.leaveProject(projectId);
  actions.dropProject(projectId);
  void syncNow();
}

/** Mutes or unmutes a chat for this user on all their devices; a failure puts the old state back. */
export async function setMuted(conversationId: number, muted: boolean) {
  actions.setMuted(conversationId, muted);
  try {
    await api.setMuted(conversationId, muted);
  } catch (error) {
    actions.setMuted(conversationId, !muted);
    actions.addToast({ conversationId, title: muted ? 'Not muted' : 'Not unmuted', body: (error as Error).message });
  }
}

/** Leaves a group. A member who stays gives it a new key, as for a project. */
export async function leaveGroup(conversationId: number) {
  await api.leaveGroup(conversationId);
  actions.dropConversation(conversationId);
  void syncNow();
}

/** Makes another member the project's owner, so this user can leave it. */
export async function handOverProject(projectId: number, userId: number) {
  actions.upsertProject(await api.handOverProject(projectId, { userId }));
  void syncNow();
}

/** Makes another member the group's owner, so this user can leave it. */
export async function handOverGroup(conversationId: number, userId: number) {
  await adoptConversation(await api.handOverGroup(conversationId, { userId }));
  void syncNow();
}

/** Deletes a project for everyone, with its channels and their messages. */
export async function deleteProject(projectId: number) {
  await api.deleteProject(projectId);
  actions.dropProject(projectId);
  void syncNow();
}

/** Deletes a channel for everyone, with its messages. Only the project's owner can, and never #general. */
export async function deleteChannel(projectId: number, conversationId: number) {
  await api.deleteChannel(projectId, conversationId);
  actions.dropConversation(conversationId);
  void syncNow();
}

/** Deletes a group for everyone, with its messages. */
export async function deleteGroup(conversationId: number) {
  await api.deleteGroup(conversationId);
  actions.dropConversation(conversationId);
  void syncNow();
}
