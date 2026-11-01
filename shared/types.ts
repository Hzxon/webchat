// Types shared by the server, the web client, and the service worker.
// Only type declarations live here, so importing them never adds runtime code.

/** A user's public keys, base64url of the raw P-256 points. Null until the user sets up encryption. */
export interface PublicKeysDTO {
  /** ECDH key: other members wrap chat keys for it. */
  dh: string;
  /** ECDSA key: verifies the messages this user signs. */
  sign: string;
}

export interface UserDTO {
  id: number;
  username: string;
  displayName: string;
  online: boolean;
  lastSeen: number | null;
  keys: PublicKeysDTO | null;
}

/** An encrypted, signed message. The server stores and relays it without being able to read it. */
export interface EnvelopeDTO {
  v: 1;
  /** Id of the chat key it was encrypted with. */
  kid: string;
  iv: string;
  ct: string;
  sig: string;
}

/**
 * "message" is a chat message. "reaction" puts an emoji on an earlier message, or takes it back;
 * which message and which emoji are inside the envelope, so only members can see them.
 */
export type MessageKind = 'message' | 'reaction';

export interface MessageDTO {
  id: number;
  conversationId: number;
  senderId: number;
  kind: MessageKind;
  /** Plain text only for messages sent before encryption existed; empty when envelope is set. */
  body: string;
  envelope: EnvelopeDTO | null;
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

/** A channel is a chat inside a project. */
export type ConversationType = 'direct' | 'group' | 'channel';

/** A chat key encrypted for one member, by the member who created it. */
export interface WrappedKeyDTO {
  wrappedBy: number;
  iv: string;
  data: string;
}

export interface ConversationDTO {
  id: number;
  type: ConversationType;
  /** Group name, or channel name without the "#"; null for direct chats (the client shows the other person's name). */
  title: string | null;
  /** The project a channel belongs to; null for other chats. */
  projectId: number | null;
  /**
   * The person who made a group, the only one who can remove people from it or delete it. Null for
   * other chats, and for a group from before encryption that has no key yet, which any member can manage.
   */
  createdBy: number | null;
  members: MemberState[];
  /** Newest message of kind "message". Reactions never replace it. */
  lastMessage: MessageDTO | null;
  /** Unread count for the user this DTO was built for. */
  unread: number;
  updatedAt: number;
  /** Null for chats created before encryption, until a member sets a key. */
  keyId: string | null;
  /** The chat key wrapped for the user this DTO was built for. */
  myKey: WrappedKeyDTO | null;
}

/** A project: a team with its own channels. Every project member is a member of every channel in it. */
export interface ProjectDTO {
  id: number;
  name: string;
  createdBy: number;
  createdAt: number;
  /** In the order they joined. */
  memberIds: number[];
}

export interface BootstrapDTO {
  me: UserDTO;
  users: UserDTO[];
  projects: ProjectDTO[];
  conversations: ConversationDTO[];
  /** Newest message id the client has now seen. Sync returns messages after it. */
  cursor: number;
  /** Fingerprint of everything this user can see. Sync answers "unchanged" while it matches. */
  stamp: string;
}

export interface ConfigDTO {
  vapidPublicKey: string;
  /** Random per deployment; mixed into the password key derivation. */
  kdfSalt: string;
}

/** Private keys encrypted with a key only the user's password can derive. */
export interface SealedBackupDTO {
  iv: string;
  data: string;
}

export interface AccountKeysInput {
  dh: string;
  sign: string;
  backup: SealedBackupDTO;
}

export interface RegisterInput {
  username: string;
  displayName: string;
  /** Derived from the password in the browser. The password itself never leaves the browser. */
  authKey: string;
  inviteCode: string;
  keys: AccountKeysInput;
}

export interface LoginResponse {
  user: UserDTO;
  /** Null when the account has no keys yet; the client then creates them. */
  backup: SealedBackupDTO | null;
}

export interface WrappedKeyInput {
  userId: number;
  iv: string;
  data: string;
}

/** A new chat key, wrapped once for every member, including the creator. */
export interface ChatKeyInput {
  keyId: string;
  wrappedKeys: WrappedKeyInput[];
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
      projects: ProjectDTO[];
      conversations: ConversationDTO[];
      /** Messages after the request cursor, plus a short overlap the client de-duplicates. */
      messages: MessageDTO[];
    };

export interface SendMessageInput {
  envelope: EnvelopeDTO;
  urgent: boolean;
  clientId: string;
  /** Defaults to "message". */
  kind?: MessageKind;
}

/** A new project, with the key of its first channel, #general, wrapped for every member. */
export interface CreateProjectInput {
  name: string;
  /** The other people in the project; the creator is always in it. */
  memberIds: number[];
  key: ChatKeyInput;
}

export interface CreateProjectResponse {
  project: ProjectDTO;
  /** The project's #general channel. */
  channel: ConversationDTO;
}

/** A new channel, with its key wrapped for exactly the project's current members. */
export interface CreateChannelInput {
  name: string;
  key: ChatKeyInput;
}

/** One channel's existing key, wrapped for the people being added, or again for everyone who stays. */
export interface SharedChannelKeyInput {
  conversationId: number;
  keyId: string;
  wrappedKeys: WrappedKeyInput[];
}

/** People to add to a project, with every one of its channel keys wrapped for each of them. */
export interface AddProjectMembersInput {
  userIds: number[];
  channelKeys: SharedChannelKeyInput[];
}

/**
 * Every channel key of a project, wrapped again for exactly the people who stay, so no copy left
 * was made by the person being removed.
 */
export interface RemoveProjectMemberInput {
  channelKeys: SharedChannelKeyInput[];
}

/** The group's key wrapped again for exactly the people who stay. Null for a group without a key. */
export interface RemoveGroupMemberInput {
  key: ChatKeyInput | null;
}

/** JSON body of every Web Push message. The service worker turns it into a notification. */
export interface PushPayload {
  /** "reaction" only wakes a tab the user is looking at; "project" says someone added them to one. */
  kind: 'message' | 'reaction' | 'project' | 'github' | 'test';
  title: string;
  /** Text for messages the server can read (tests, old plain messages). Empty for encrypted ones. */
  body: string;
  /** Shown before the decrypted text, such as "Bob: " in a group. */
  bodyPrefix: string;
  urgent: boolean;
  tag: string;
  conversationId: number | null;
  messageId: number | null;
  senderId: number | null;
  clientId: string | null;
  /** The encrypted message, when it fits in a push. The service worker decrypts it on the device. */
  envelope: EnvelopeDTO | null;
  unreadTotal: number | null;
  sentAt: number;
  /** Page a click on the notification opens instead of a chat, such as a pull request on GitHub. */
  url: string | null;
}

/** Combined result of a pull request's checks on its newest commit. Null when it has none. */
export type PullChecks = 'success' | 'failure' | 'pending' | null;

/** GitHub's review decision. Null when the repository does not require reviews. */
export type PullReview = 'approved' | 'changes_requested' | 'review_required' | null;

export interface PullRequestDTO {
  /** GitHub's node id. */
  id: string;
  /** "owner/name". */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  draft: boolean;
  review: PullReview;
  checks: PullChecks;
  /** The branch cannot merge without resolving conflicts. */
  conflicts: boolean;
  comments: number;
  /** Who wrote the newest comment, to skip alerts about one's own comments. */
  lastCommenter: string | null;
  additions: number;
  deletions: number;
  updatedAt: number;
}

/**
 * A pull request shared into a chat: a snapshot of how it stood when it was shared. It travels
 * inside the message's envelope, so the server never sees which pull request was shared.
 */
export interface PullCardDTO {
  /** "owner/name". */
  repo: string;
  number: number;
  title: string;
  /** Always the pull request's page on github.com; the page checks that before it shows a card. */
  url: string;
  draft: boolean;
  review: PullReview;
  checks: PullChecks;
  conflicts: boolean;
}

export interface PullListsDTO {
  /** Open pull requests that ask this user, or one of their teams, for a review. */
  reviewRequested: PullRequestDTO[];
  /** Open pull requests this user opened. */
  authored: PullRequestDTO[];
}

export type GithubEventKind =
  | 'review_requested'
  | 'approved'
  | 'changes_requested'
  | 'commented'
  | 'checks_failed'
  | 'checks_passed'
  | 'conflicts'
  | 'merged'
  | 'closed';

/** A change to a watched pull request, found by comparing two polls. */
export interface GithubEventDTO {
  id: number;
  kind: GithubEventKind;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The person behind the change, when GitHub says who it was. */
  actor: string | null;
  createdAt: number;
}

export interface GithubAccountDTO {
  login: string;
  name: string | null;
  /** Push alerts for pull request changes. */
  notify: boolean;
}

export interface GithubDTO {
  /** False until the server owner sets GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET. */
  configured: boolean;
  /** Null while no GitHub account is connected. */
  account: GithubAccountDTO | null;
  pulls: PullListsDTO | null;
  /** Newest first. */
  events: GithubEventDTO[];
  /** When the pull requests were last fetched from GitHub. */
  fetchedAt: number | null;
  /** Why the last fetch failed, if it did. */
  error: string | null;
  /** True when GitHub refused the token: the user must connect again. */
  reconnect: boolean;
}

/** Messages the service worker posts to open pages. */
export type WorkerToPageMessage =
  | { type: 'push'; payload: PushPayload }
  | { type: 'open-conversation'; conversationId: number };

/** Response header that names the server's build. A tab reloads when the value changes. */
export const BUILD_HEADER = 'x-webchat-build';

export const LIMITS = {
  messageLength: 4000,
  /** Characters of the quoted message a reply carries. */
  quoteLength: 160,
  /** Base64url ciphertext of the longest message with its quote, each character up to 4 UTF-8 bytes. */
  ciphertextLength: 24_000,
  groupTitleLength: 60,
  projectNameLength: 60,
  channelNameLength: 40,
  /** People added to a project at once. Each needs every channel key, and requests stop at 64 KB. */
  addMembersAtOnce: 20,
  displayNameLength: 40,
  /** GitHub's own limit for a pull request title. */
  pullTitleLength: 256,
  pageSize: 50,
} as const;
