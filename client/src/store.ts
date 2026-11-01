import { useSyncExternalStore } from 'react';
import type { GithubDTO, ProjectDTO, UserDTO } from '../../shared/types';
import type { ChatConversation, ChatMessage } from './e2ee/keyring';
import type { PushState } from './push';

export interface Toast {
  id: number;
  /** The chat a click opens. Null for toasts that open a page instead. */
  conversationId: number | null;
  /** Page a click opens in a new tab, such as a pull request on GitHub. */
  url?: string;
  title: string;
  body: string;
}

export type PendingStatus = 'sending' | 'failed';

/** One person's reaction to a message: the newest reaction event they sent for it wins. */
export interface ReactionMark {
  /** Id of that event. A reaction still sending uses Number.MAX_SAFE_INTEGER, so no older event replaces it. */
  eventId: number;
  /** Empty once they took the reaction back. */
  emoji: string;
}

/** By person id. */
export type MessageReactions = Record<number, ReactionMark>;

export type SidebarTab = 'chats' | 'projects';

export interface State {
  me: UserDTO | null;
  users: Record<number, UserDTO>;
  projects: Record<number, ProjectDTO>;
  conversations: Record<number, ChatConversation>;
  /** Per chat, oldest first, decrypted. Messages still sending have negative ids and sit at the end. Never reactions. */
  messages: Record<number, ChatMessage[]>;
  /** Per chat, per message id. */
  reactions: Record<number, Record<number, MessageReactions>>;
  historyComplete: Record<number, boolean>;
  pending: Record<string, PendingStatus>;
  activeId: number | null;
  tab: SidebarTab;
  /** False while the last check-in with the server failed. */
  connected: boolean;
  /** Urgent messages the user has not acknowledged yet. They keep ringing. */
  urgent: ChatMessage[];
  toasts: Toast[];
  /** Notification setup of this browser; null until checked. */
  push: PushState | null;
  /** People whose encryption keys differ from the ones this device saw first. */
  keyWarnings: Record<number, true>;
  /** The GitHub connector's state; null until loaded. */
  github: GithubDTO | null;
  /** The pull requests pane is showing instead of a chat. */
  githubOpen: boolean;
}

const initialState: State = {
  me: null,
  users: {},
  projects: {},
  conversations: {},
  messages: {},
  reactions: {},
  historyComplete: {},
  pending: {},
  activeId: null,
  tab: 'chats',
  connected: true,
  urgent: [],
  toasts: [],
  push: null,
  keyWarnings: {},
  github: null,
  githubOpen: false,
};

let state = initialState;
const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(update: (current: State) => State) {
    state = update(state);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The selector must return existing objects from the state, not build new ones, or React re-renders forever. */
export function useAppState<T>(selector: (current: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state));
}

function insertMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const settled = list.filter((m) => m.id > 0 && m.id !== message.id);
  const sending = list.filter((m) => m.id < 0 && (message.clientId === null || m.clientId !== message.clientId));
  if (message.id < 0) return [...settled, ...sending, message];
  let index = settled.length;
  while (index > 0 && settled[index - 1]!.id > message.id) index--;
  settled.splice(index, 0, message);
  return [...settled, ...sending];
}

/** Sets one person's reaction to a message, unless a newer one is already there or force is set. */
function withReaction(
  reactions: State['reactions'],
  conversationId: number,
  messageId: number,
  userId: number,
  mark: ReactionMark,
  force = false,
): State['reactions'] {
  const chat = reactions[conversationId] ?? {};
  const people = chat[messageId] ?? {};
  const current = people[userId];
  if (current && !force && current.eventId >= mark.eventId) return reactions;
  if (current && current.eventId === mark.eventId && current.emoji === mark.emoji) return reactions;
  return { ...reactions, [conversationId]: { ...chat, [messageId]: { ...people, [userId]: mark } } };
}

/** Sorts events into message lists and reactions. Message lists exist only for chats already loaded. */
function withEvents(current: State, events: ChatMessage[]): Pick<State, 'messages' | 'reactions'> {
  const messages = { ...current.messages };
  let reactions = current.reactions;
  for (const event of events) {
    if (event.kind === 'reaction') {
      if (event.reaction && event.security !== 'failed') {
        const { messageId, emoji } = event.reaction;
        reactions = withReaction(reactions, event.conversationId, messageId, event.senderId, { eventId: event.id, emoji });
      }
      continue;
    }
    const list = messages[event.conversationId];
    if (list) messages[event.conversationId] = insertMessage(list, event);
  }
  return { messages, reactions };
}

function withConversation(current: State, id: number, change: (c: ChatConversation) => ChatConversation): State {
  const conversation = current.conversations[id];
  if (!conversation) return current;
  return { ...current, conversations: { ...current.conversations, [id]: change(conversation) } };
}

/**
 * Forgets chats the user is no longer in, with everything kept for them: loaded messages (so the
 * history loads again if they come back), urgent alerts, toasts, and the open chat.
 */
function withoutChats(current: State, gone: Set<number>): State {
  if (gone.size === 0) return current;
  const keep = <T>(record: Record<number, T>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !gone.has(Number(id)))) as Record<number, T>;
  return {
    ...current,
    conversations: keep(current.conversations),
    messages: keep(current.messages),
    reactions: keep(current.reactions),
    historyComplete: keep(current.historyComplete),
    activeId: current.activeId !== null && gone.has(current.activeId) ? null : current.activeId,
    urgent: current.urgent.filter((m) => !gone.has(m.conversationId)),
    toasts: current.toasts.filter((t) => t.conversationId === null || !gone.has(t.conversationId)),
  };
}

let toastId = 0;

export const actions = {
  reset: () => store.set(() => initialState),

  bootstrap: (data: { me: UserDTO; users: UserDTO[]; projects: ProjectDTO[]; conversations: ChatConversation[] }) =>
    store.set((s) => ({
      ...s,
      me: data.me,
      users: Object.fromEntries(data.users.map((u) => [u.id, u])),
      projects: Object.fromEntries(data.projects.map((p) => [p.id, p])),
      conversations: Object.fromEntries(data.conversations.map((c) => [c.id, c])),
    })),

  /**
   * Takes the server's latest people, projects and chats, adds new messages to chats already
   * loaded, and applies new reactions. Chats the server no longer lists were deleted, or the user
   * was removed from them.
   */
  applySync: (users: UserDTO[], projects: ProjectDTO[], conversations: ChatConversation[], messages: ChatMessage[]) =>
    store.set((s) => {
      const pending = { ...s.pending };
      for (const message of messages) if (message.clientId) delete pending[message.clientId];
      const listed = new Set(conversations.map((c) => c.id));
      const current = withoutChats(s, new Set(Object.keys(s.conversations).map(Number).filter((id) => !listed.has(id))));
      return {
        ...current,
        ...withEvents(current, messages),
        users: Object.fromEntries(users.map((u) => [u.id, u])),
        projects: Object.fromEntries(projects.map((p) => [p.id, p])),
        conversations: Object.fromEntries(conversations.map((c) => [c.id, c])),
        pending,
      };
    }),

  upsertProject: (project: ProjectDTO) => store.set((s) => ({ ...s, projects: { ...s.projects, [project.id]: project } })),

  /** Forgets a project and its channels at once, after deleting it, ahead of the next check-in. */
  dropProject: (projectId: number) =>
    store.set((s) => {
      const projects = { ...s.projects };
      delete projects[projectId];
      const channels = Object.values(s.conversations).filter((c) => c.projectId === projectId);
      return { ...withoutChats(s, new Set(channels.map((c) => c.id))), projects };
    }),

  /** Forgets a chat at once, after deleting it. */
  dropConversation: (conversationId: number) => store.set((s) => withoutChats(s, new Set([conversationId]))),

  /** Sets this user's own reaction at once, ahead of the server. Force lets a failed send put back the old one. */
  setMyReaction: (conversationId: number, messageId: number, userId: number, mark: ReactionMark) =>
    store.set((s) => {
      const reactions = withReaction(s.reactions, conversationId, messageId, userId, mark, true);
      return reactions === s.reactions ? s : { ...s, reactions };
    }),

  setConnected: (connected: boolean) => store.set((s) => (s.connected === connected ? s : { ...s, connected })),

  upsertConversation: (conversation: ChatConversation) =>
    store.set((s) => ({ ...s, conversations: { ...s.conversations, [conversation.id]: conversation } })),

  /** Adds a message and updates the chat preview. The caller decides whether it counts as unread. */
  addMessage: (message: ChatMessage, countsAsUnread: boolean) =>
    store.set((s) => {
      if (message.kind === 'reaction') return { ...s, ...withEvents(s, [message]) };
      const list = s.messages[message.conversationId];
      const next = list ? { ...s, messages: { ...s.messages, [message.conversationId]: insertMessage(list, message) } } : s;
      return withConversation(next, message.conversationId, (c) => ({
        ...c,
        lastMessage: !c.lastMessage || message.id >= c.lastMessage.id ? message : c.lastMessage,
        updatedAt: Math.max(c.updatedAt, message.createdAt),
        unread: countsAsUnread ? c.unread + 1 : c.unread,
      }));
    }),

  addSending: (message: ChatMessage) =>
    store.set((s) => ({
      ...s,
      pending: { ...s.pending, [message.clientId!]: 'sending' },
      messages: { ...s.messages, [message.conversationId]: insertMessage(s.messages[message.conversationId] ?? [], message) },
    })),

  setPending: (clientId: string, status: PendingStatus | null) =>
    store.set((s) => {
      const pending = { ...s.pending };
      if (status) pending[clientId] = status;
      else delete pending[clientId];
      return { ...s, pending };
    }),

  dropSending: (conversationId: number, clientId: string) =>
    store.set((s) => ({
      ...s,
      messages: {
        ...s.messages,
        [conversationId]: (s.messages[conversationId] ?? []).filter((m) => !(m.id < 0 && m.clientId === clientId)),
      },
    })),

  setHistory: (conversationId: number, older: ChatMessage[], complete: boolean) =>
    store.set((s) => {
      const withList = { ...s, messages: { ...s.messages, [conversationId]: s.messages[conversationId] ?? [] } };
      return {
        ...s,
        ...withEvents(withList, older),
        historyComplete: { ...s.historyComplete, [conversationId]: complete },
      };
    }),

  clearHistory: () => store.set((s) => ({ ...s, messages: {}, reactions: {}, historyComplete: {} })),

  /** Moves one member's delivered and read pointers in a chat. */
  applyReceipt: (receipt: { conversationId: number; userId: number; lastDeliveredId: number; lastReadId: number }) =>
    store.set((s) => {
      const next = withConversation(s, receipt.conversationId, (c) => ({
        ...c,
        members: c.members.map((m) =>
          m.userId === receipt.userId
            ? { ...m, lastDeliveredId: receipt.lastDeliveredId, lastReadId: receipt.lastReadId }
            : m,
        ),
      }));
      return next;
    }),

  setUnread: (conversationId: number, unread: number) =>
    store.set((s) => withConversation(s, conversationId, (c) => (c.unread === unread ? c : { ...c, unread }))),

  setPush: (push: PushState) => store.set((s) => ({ ...s, push })),

  setKeyWarnings: (ids: Set<number>) =>
    store.set((s) => {
      const same = ids.size === Object.keys(s.keyWarnings).length && [...ids].every((id) => s.keyWarnings[id]);
      return same ? s : { ...s, keyWarnings: Object.fromEntries([...ids].map((id) => [id, true as const])) };
    }),

  setActive: (activeId: number | null) =>
    store.set((s) => ({ ...s, activeId, githubOpen: activeId === null ? s.githubOpen : false })),

  setGithub: (github: GithubDTO) => store.set((s) => ({ ...s, github })),

  /** Shows the pull requests pane in place of the open chat, or closes it. */
  setGithubOpen: (githubOpen: boolean) =>
    store.set((s) => ({ ...s, githubOpen, activeId: githubOpen ? null : s.activeId })),

  setTab: (tab: SidebarTab) => store.set((s) => (s.tab === tab ? s : { ...s, tab })),

  addUrgent: (message: ChatMessage) =>
    store.set((s) => (s.urgent.some((m) => m.id === message.id) ? s : { ...s, urgent: [...s.urgent, message] })),

  /** Clears urgent alerts for a chat, up to a message id (all of them when no id is given). */
  clearUrgent: (conversationId: number, upToId = Number.MAX_SAFE_INTEGER) =>
    store.set((s) => {
      const urgent = s.urgent.filter((m) => !(m.conversationId === conversationId && m.id <= upToId));
      return urgent.length === s.urgent.length ? s : { ...s, urgent };
    }),

  dismissAllUrgent: () => store.set((s) => ({ ...s, urgent: [] })),

  addToast: (toast: Omit<Toast, 'id'>) => {
    const id = ++toastId;
    const replaces = (t: Toast) => toast.conversationId !== null && t.conversationId === toast.conversationId;
    store.set((s) => ({ ...s, toasts: [...s.toasts.filter((t) => !replaces(t)), { ...toast, id }].slice(-3) }));
    setTimeout(() => actions.dismissToast(id), 5000);
  },

  dismissToast: (id: number) =>
    store.set((s) => (s.toasts.some((t) => t.id === id) ? { ...s, toasts: s.toasts.filter((t) => t.id !== id) } : s)),
};

/**
 * Name shown for a chat: the group name, "#channel · Project" for a channel, or the other person's
 * name in a direct chat.
 */
export function chatTitle(
  conversation: Pick<ChatConversation, 'type' | 'title' | 'members' | 'projectId'>,
  current: State = state,
): string {
  if (conversation.type === 'group') return conversation.title ?? 'Group';
  if (conversation.type === 'channel') {
    const project = conversation.projectId === null ? undefined : current.projects[conversation.projectId];
    return `#${conversation.title ?? 'channel'}${project ? ` · ${project.name}` : ''}`;
  }
  const other = conversation.members.find((m) => m.userId !== current.me?.id);
  return (other && current.users[other.userId]?.displayName) ?? 'Unknown';
}

export function otherMemberId(conversation: Pick<ChatConversation, 'type' | 'members'>, meId: number | undefined): number | undefined {
  return conversation.type === 'direct' ? conversation.members.find((m) => m.userId !== meId)?.userId : undefined;
}
