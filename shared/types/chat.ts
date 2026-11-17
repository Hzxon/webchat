import { type UserDTO } from './account.js';
import { type DocDTO } from './docs.js';
import { type PermitDTO, type PromptDTO } from './runs.js';
import { LIMITS } from './limits.js';

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
 * which message and which emoji are inside the envelope, so only members can see them. "github" is
 * a card the server writes from GitHub's webhook, in plain text, with no sender (D-050). "sync" is an
 * agent's board traffic with its owner's page: it is pushed and counted like a reaction (K-69).
 */
export type MessageKind = 'message' | 'reaction' | 'github' | 'sync';

export interface MessageDTO {
  id: number;
  conversationId: number;
  /** Null for a card the server wrote from GitHub. */
  senderId: number | null;
  kind: MessageKind;
  /**
   * Plain text only for messages sent before encryption existed, and a GithubCardDTO as JSON for
   * kind "github"; empty when envelope is set.
   */
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

/**
 * A chat's earlier key, encrypted with the key that replaced it. Whoever holds the current key opens
 * the earlier ones in turn, so the whole history stays readable after a rotation.
 */
export interface KeyLinkDTO {
  /** The key that replaced it, and encrypts it. */
  keyId: string;
  previousKeyId: string;
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
   * The owner of a group: the person who made it, or the member they handed it to. Only the owner
   * can remove people from it or delete it. Null for other chats, and for a group from before
   * encryption that has no key yet, which any member can manage.
   */
  ownerId: number | null;
  members: MemberState[];
  /** Newest message or GitHub card. Reactions never replace it. */
  lastMessage: MessageDTO | null;
  /** Unread count for the user this DTO was built for. */
  unread: number;
  updatedAt: number;
  /** Null for chats created before encryption, until a member sets a key. */
  keyId: string | null;
  /** The chat key wrapped for the user this DTO was built for. */
  myKey: WrappedKeyDTO | null;
  /** Every key the chat used before keyId, oldest first. */
  keyLinks: KeyLinkDTO[];
  /**
   * Someone who holds the current key left. The server takes no messages until a member who stays
   * replaces the key, which their browser does on its next check-in or before it sends.
   */
  needsNewKey: boolean;
}

/** A project: a team with its own channels. Every project member is a member of every channel in it. */
export interface ProjectDTO {
  id: number;
  name: string;
  /** The person who made it, or the member they handed it to. Only they can remove people or delete it. */
  ownerId: number;
  createdAt: number;
  /** In the order they joined. */
  memberIds: number[];
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

/**
 * A new chat's first key. Its copies name the chat, so they are made for the id that
 * `POST /conversations/ids` reserved for this user, and the chat gets that id (D-111).
 */
export interface FirstChatKeyInput extends ChatKeyInput {
  conversationId: number;
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
  /** The doc section this tab is editing. Each check-in keeps its lock (R-020). */
  editing?: { docId: string; section: string } | null;
  /** From an older plugin's session: the repository it is open in (R-030). */
  repo?: string | null;
  /** From an agent's laptop: every repository it has a folder for, which one window serves (R-036). */
  repos?: string[];
  /** From the plugin's session: what it can do, as a level of AGENT_LEVEL (D-103). Older plugins leave it out. */
  protocol?: number;
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
      /** True when newer messages exist than this answer carries. The client checks in again at once. */
      more: boolean;
      docs: DocDTO[];
    };

export interface SendMessageInput {
  envelope: EnvelopeDTO;
  urgent: boolean;
  clientId: string;
  /** Defaults to "message". Only the server writes kind "github". */
  kind?: Exclude<MessageKind, 'github'>;
  /** The upload a photo or file message names, which the server then keeps (R-005). */
  fileId?: string;
}

/** A new project, with the key of its first channel, #general, wrapped for every member. */
export interface CreateProjectInput {
  name: string;
  /** The other people in the project; the creator is always in it. */
  memberIds: number[];
  /** The key of its #general channel. */
  key: FirstChatKeyInput;
}

export interface CreateProjectResponse {
  project: ProjectDTO;
  /** The project's #general channel. */
  channel: ConversationDTO;
}

/** A new channel, with its key wrapped for exactly the project's current members. */
export interface CreateChannelInput {
  name: string;
  key: FirstChatKeyInput;
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

/** A chat's current key, encrypted with the key that replaces it. */
export interface KeyLinkInput {
  previousKeyId: string;
  iv: string;
  data: string;
}

/** A new key that replaces a chat's current one, wrapped for every member, with the current key inside. */
export interface RotatedKeyInput extends ChatKeyInput {
  link: KeyLinkInput;
}

export interface RotatedChannelKeyInput extends RotatedKeyInput {
  conversationId: number;
}

/**
 * A new key for every channel of a project, wrapped for exactly the people who stay, so the person
 * being removed cannot read what is sent next.
 */
export interface RemoveProjectMemberInput {
  channelKeys: RotatedChannelKeyInput[];
}

/** People to add to a group, with its existing key wrapped for each of them. Null for a group without a key. */
export interface AddGroupMembersInput {
  userIds: number[];
  key: ChatKeyInput | null;
}

/** The group's new key, wrapped for exactly the people who stay. Null for a group without a key. */
export interface RemoveGroupMemberInput {
  key: RotatedKeyInput | null;
}

/** The member who becomes the owner of a project or group. */
export interface NewOwnerInput {
  userId: number;
}

/** What a message's content says in a chat list, a toast or a notification. An agent's answer is Markdown, shown as plain words (D-103). */
export function previewOf(content: { text: string; pull?: { title: string } | null; prompt?: PromptDTO | null; permit?: PermitDTO | null }) {
  // Never the command: a lock screen shows it to whoever looks.
  if (content.permit?.kind === 'question') return 'Your agent asks your permission';
  if (content.pull) return `Pull request: ${content.pull.title}`;
  if (content.prompt?.kind === 'answer') return content.text.replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/```\w*|\*\*|__|`/g, '');
  return content.text;
}

/** Slack-style channel names (D-027): lowercase letters and digits in any script, joined by single hyphens. */
export const CHANNEL_NAME = /^[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+(-[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+)*$/u;

export const isChannelName = (name: string) => name.length <= LIMITS.channelNameLength && CHANNEL_NAME.test(name);

/** Turns what someone types into a channel name, such as "Slides & Design" into "slides-design". */
export const toChannelName = (value: string) =>
  value
    // NFKC turns capitals with no lowercase form, such as ℂ, into plain ones that have it.
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+/gu, '-')
    // The limit counts UTF-16 units, as the server does, so the cut can leave a hyphen or half a
    // character at the end. Trimming after the cut drops both.
    .slice(0, LIMITS.channelNameLength)
    .replace(/^[^\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+|[^\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+$/gu, '');
