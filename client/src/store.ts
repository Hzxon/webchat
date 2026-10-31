import { useSyncExternalStore } from 'react';
import type {
  BootstrapDTO,
  ConversationDTO,
  MessageDTO,
  UserDTO,
} from '../../shared/types';
import type { PushState } from './push';

export interface Toast {
  id: number;
  conversationId: number;
  title: string;
  body: string;
}

export type PendingStatus = 'sending' | 'failed';

export interface State {
  me: UserDTO | null;
  users: Record<number, UserDTO>;
  conversations: Record<number, ConversationDTO>;
  /** Per chat, oldest first. Messages still sending have negative ids and sit at the end. */
  messages: Record<number, MessageDTO[]>;
  historyComplete: Record<number, boolean>;
  pending: Record<string, PendingStatus>;
  activeId: number | null;
  /** False while the last check-in with the server failed. */
  connected: boolean;
  /** Urgent messages the user has not acknowledged yet. They keep ringing. */
  urgent: MessageDTO[];
  toasts: Toast[];
  /** Notification setup of this browser; null until checked. */
  push: PushState | null;
}

const initialState: State = {
  me: null,
  users: {},
  conversations: {},
  messages: {},
  historyComplete: {},
  pending: {},
  activeId: null,
  connected: true,
  urgent: [],
  toasts: [],
  push: null,
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

function insertMessage(list: MessageDTO[], message: MessageDTO): MessageDTO[] {
  const settled = list.filter((m) => m.id > 0 && m.id !== message.id);
  const sending = list.filter((m) => m.id < 0 && (message.clientId === null || m.clientId !== message.clientId));
  if (message.id < 0) return [...settled, ...sending, message];
  let index = settled.length;
  while (index > 0 && settled[index - 1]!.id > message.id) index--;
  settled.splice(index, 0, message);
  return [...settled, ...sending];
}

function withConversation(current: State, id: number, change: (c: ConversationDTO) => ConversationDTO): State {
  const conversation = current.conversations[id];
  if (!conversation) return current;
  return { ...current, conversations: { ...current.conversations, [id]: change(conversation) } };
}

let toastId = 0;

export const actions = {
  reset: () => store.set(() => initialState),

  bootstrap: (data: BootstrapDTO) =>
    store.set((s) => ({
      ...s,
      me: data.me,
      users: Object.fromEntries(data.users.map((u) => [u.id, u])),
      conversations: Object.fromEntries(data.conversations.map((c) => [c.id, c])),
    })),

  /** Takes the server's latest people and chats, and adds new messages to chats already loaded. */
  applySync: (users: UserDTO[], conversations: ConversationDTO[], messages: MessageDTO[]) =>
    store.set((s) => {
      const lists = { ...s.messages };
      for (const message of messages) {
        const list = lists[message.conversationId];
        if (list) lists[message.conversationId] = insertMessage(list, message);
      }
      const pending = { ...s.pending };
      for (const message of messages) if (message.clientId) delete pending[message.clientId];
      return {
        ...s,
        users: Object.fromEntries(users.map((u) => [u.id, u])),
        conversations: Object.fromEntries(conversations.map((c) => [c.id, c])),
        messages: lists,
        pending,
      };
    }),

  setConnected: (connected: boolean) => store.set((s) => (s.connected === connected ? s : { ...s, connected })),

  upsertConversation: (conversation: ConversationDTO) =>
    store.set((s) => ({ ...s, conversations: { ...s.conversations, [conversation.id]: conversation } })),

  /** Adds a message and updates the chat preview. The caller decides whether it counts as unread. */
  addMessage: (message: MessageDTO, countsAsUnread: boolean) =>
    store.set((s) => {
      const list = s.messages[message.conversationId];
      const next = list ? { ...s, messages: { ...s.messages, [message.conversationId]: insertMessage(list, message) } } : s;
      return withConversation(next, message.conversationId, (c) => ({
        ...c,
        lastMessage: !c.lastMessage || message.id >= c.lastMessage.id ? message : c.lastMessage,
        updatedAt: Math.max(c.updatedAt, message.createdAt),
        unread: countsAsUnread ? c.unread + 1 : c.unread,
      }));
    }),

  addSending: (message: MessageDTO) =>
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

  setHistory: (conversationId: number, older: MessageDTO[], complete: boolean) =>
    store.set((s) => {
      let list = s.messages[conversationId] ?? [];
      for (const message of older) list = insertMessage(list, message);
      return {
        ...s,
        messages: { ...s.messages, [conversationId]: list },
        historyComplete: { ...s.historyComplete, [conversationId]: complete },
      };
    }),

  clearHistory: () => store.set((s) => ({ ...s, messages: {}, historyComplete: {} })),

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

  setActive: (activeId: number | null) => store.set((s) => ({ ...s, activeId })),

  addUrgent: (message: MessageDTO) =>
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
    store.set((s) => ({ ...s, toasts: [...s.toasts.filter((t) => t.conversationId !== toast.conversationId), { ...toast, id }].slice(-3) }));
    setTimeout(() => actions.dismissToast(id), 5000);
  },

  dismissToast: (id: number) =>
    store.set((s) => (s.toasts.some((t) => t.id === id) ? { ...s, toasts: s.toasts.filter((t) => t.id !== id) } : s)),
};

/** Name shown for a chat: the group name, or the other person's name in a direct chat. */
export function chatTitle(conversation: ConversationDTO, current: State = state): string {
  if (conversation.type === 'group') return conversation.title ?? 'Group';
  const other = conversation.members.find((m) => m.userId !== current.me?.id);
  return (other && current.users[other.userId]?.displayName) ?? 'Unknown';
}

export function otherMemberId(conversation: ConversationDTO, meId: number | undefined): number | undefined {
  return conversation.type === 'direct' ? conversation.members.find((m) => m.userId !== meId)?.userId : undefined;
}
