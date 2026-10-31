// Types shared by the server, the web client, and the service worker.
// Only type declarations live here, so importing them never adds runtime code.

export interface UserDTO {
  id: number;
  username: string;
  displayName: string;
  online: boolean;
  lastSeen: number | null;
}

export interface MessageDTO {
  id: number;
  conversationId: number;
  senderId: number;
  body: string;
  urgent: boolean;
  createdAt: number;
  /** Echoed back to the sender so its tabs can replace the optimistic copy. */
  clientId: string | null;
}

/** Per-member read pointers. Message ids at or below a pointer count as delivered or read. */
export interface MemberState {
  userId: number;
  lastDeliveredId: number;
  lastReadId: number;
}

export type ConversationType = 'direct' | 'group';

export interface ConversationDTO {
  id: number;
  type: ConversationType;
  /** Group name; null for direct chats (the client shows the other person's name). */
  title: string | null;
  members: MemberState[];
  lastMessage: MessageDTO | null;
  /** Unread count for the user this DTO was built for. */
  unread: number;
  updatedAt: number;
}

export interface BootstrapDTO {
  me: UserDTO;
  users: UserDTO[];
  conversations: ConversationDTO[];
  /** Newest message id the client has now seen. Sync returns messages after it. */
  cursor: number;
  /** Fingerprint of everything this user can see. Sync answers "unchanged" while it matches. */
  stamp: string;
}

export interface ConfigDTO {
  vapidPublicKey: string;
}

export interface SyncRequest {
  cursor: number;
  stamp: string;
  /** True while the user is looking at this tab: visible, focused, and recently active. */
  attentive: boolean;
  /** Random id per page load, so one tab going idle does not clear another tab's attention. */
  tabId: string;
  /** This browser's push endpoint, if push is on here. Lets the server push only to the tab in use. */
  endpoint: string | null;
}

export type SyncResponse =
  | { changed: false; stamp: string; cursor: number }
  | {
      changed: true;
      stamp: string;
      cursor: number;
      users: UserDTO[];
      conversations: ConversationDTO[];
      /** Messages after the request cursor, plus a short overlap the client de-duplicates. */
      messages: MessageDTO[];
    };

export interface SendMessageInput {
  body: string;
  urgent: boolean;
  clientId: string;
}

/** JSON body of every Web Push message. The service worker turns it into a notification. */
export interface PushPayload {
  kind: 'message' | 'test';
  title: string;
  body: string;
  urgent: boolean;
  tag: string;
  conversationId: number | null;
  messageId: number | null;
  unreadTotal: number | null;
  sentAt: number;
}

/** Messages the service worker posts to open pages. */
export type WorkerToPageMessage =
  | { type: 'push'; payload: PushPayload }
  | { type: 'open-conversation'; conversationId: number };

export const LIMITS = {
  messageLength: 4000,
  groupTitleLength: 60,
  displayNameLength: 40,
  pageSize: 50,
} as const;
