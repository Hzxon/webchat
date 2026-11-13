// Types shared by the server, the web client, and the service worker.
// The file also holds the few values and checks that more than one of them must agree on: LIMITS,
// the channel name rules, the build header and the test for Apple's push service.
// They live with the types so that each side imports one file and none can drift from the others.
// They are small and import nothing, so they add little code to the page and the service worker.

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
  /** For a coding agent's account (R-027, D-085), the person it runs cards for (D-089). */
  agentOwner: number | null;
  /** What the agent's laptop can do, as a level of AGENT_LEVEL; 0 until a plugin that serves every folder checked in (R-036). */
  protocol: number;
  /** For an agent in Claude Code: a session per repository, each taking that repository's runs (R-032). */
  agentRepos: AgentRepoDTO[];
  /** The account was deleted (R-028). It stays listed so its old messages keep their sender's name. */
  deleted: boolean;
}

/** An agent's Claude Code session, by the repository it is open in, as "owner/name" (R-032, D-094). */
export interface AgentRepoDTO {
  repo: string;
  online: boolean;
  lastSeen: number;
  /** What it can do, as a level of AGENT_LEVEL; 0 for a session on an older plugin (D-103). */
  protocol: number;
}

/**
 * What a plugin session can do, by the level its check-ins name (D-103): 1 answers the owner's
 * questions; 2 also runs cards from the pane, which it names only while `gh` is signed in (D-105).
 * Since R-039 the level is a set of these bits, with 4 for a plugin that heeds its owner's `setup`:
 * 5, or 7 with cards (D-115). Every level from 1 up answers, older ones included.
 */
export const AGENT_LEVEL = { answers: 1, cards: 2, setup: 4 } as const;

/** Whether a session at this level runs cards, or heeds `setup` (D-105, D-115). */
export const runsCards = (level: number) => (level & AGENT_LEVEL.cards) !== 0;
export const takesSetup = (level: number) => (level & AGENT_LEVEL.setup) !== 0;

/** What a choice loads, in words, for the agent's answer and the pane alike (R-039). */
export const setupWords = (c: SetupChoice) => [c.claudeMd && 'your CLAUDE.md', ...c.skills, c.noAttribution && 'no AI attribution', c.noPlan && 'no plan first'].filter(Boolean).join(', ') || 'nothing of your Claude setup';

/**
 * What the owner's agent loads from their setup on its laptop into every run and turn (R-039,
 * D-115): the instructions file its harness reads, skills of its skills folder by folder name, and
 * no AI attribution lines in commits and pull requests. One choice serves every harness, each
 * through the knobs it declares.
 */
export interface SetupChoice {
  /** The instructions file, under its first name, which old pages and plugins still use. */
  claudeMd: boolean;
  skills: string[];
  noAttribution: boolean;
  /**
   * The harnesses the owner linked, by name, in the order that picks one for a request that names
   * none (docs/decisions/harness-linking.md). An agent from before it has none until it first
   * starts; a page from before it sends none, and the agent keeps what it had.
   */
  linked?: string[];
  /** The harnesses an older page turned off, by name: still read, and they mute a linked one. A page that sends `linked` sends none. */
  off?: string[];
  /** Whether a card run goes on without showing its plan first; a page from before the gate sends none, which keeps it on (docs/decisions/redirect-plan-gate.md). */
  noPlan?: boolean;
}

/** A harness the owner's agent found on its laptop, as Settings shows it (D-115). */
export interface HarnessState {
  /** Its name for the owner, such as "Claude Code", which `SetupChoice.off` names. */
  name: string;
  version?: string;
  /** Whether it is signed in, when its adapter can tell. */
  signedIn?: boolean;
  /** Where the agent found it, with `~` for the home folder; none when it found none. */
  path?: string;
  /** Whether the owner linked it and it is not turned off. Undefined from a plugin that has no linking. */
  linked?: boolean;
  /** Why a linked harness needs attention: it cannot run turns, is too old, or is signed out. */
  attention?: string;
  /** Why it answers no questions: not linked, turned off, missing or too old. Undefined from an agent before linking, whose `refusal` stands for both. */
  answers?: string;
  /** Why it takes no cards on this laptop, or nothing when it does. */
  refusal?: string;
  /** The instructions file and the skills folder it reads, such as `~/.claude/CLAUDE.md`. */
  instructions?: string;
  skills?: string;
  /** The knobs its adapter honors, named as in `SetupChoice`, such as `noAttribution`. */
  knobs: string[];
}

export type HarnessRow = 'linked' | 'attention' | 'found' | 'missing';

/** What each row says, for Settings and `doctor` alike. */
export const HARNESS_ROW_WORDS: Record<HarnessRow, string> = { linked: 'Linked', attention: 'Linked, needs attention', found: 'Found, not linked', missing: 'Not found' };

/** Which of the four rows Settings shows for a harness, and `doctor` too. */
export const harnessRow = (h: HarnessState): HarnessRow => (h.linked ? (h.attention ? 'attention' : 'linked') : h.path ? 'found' : 'missing');

/** A harness the owner picked at pairing, as its pairing code seals it for the approval dialog. */
export interface PairingPick {
  name: string;
  version?: string;
  signedIn?: boolean;
}

/** The agent's answer to its owner's `setup`: what the laptop offers, the choice it keeps, and what its last run or turn loaded (R-039). */
export interface SetupState {
  /** The client id of the `setup` it answers, which the owner's page waits for. */
  to: string;
  claudeMd: boolean;
  /** Each skill in `~/.claude/skills`, by folder name, with the description its SKILL.md gives. */
  skills: Array<{ name: string; description: string }>;
  choice: SetupChoice;
  applied?: SetupChoice & { at: number };
  /** Each harness the laptop has. A plugin from before D-115's rewrite sends none: it runs Claude Code alone. */
  harnesses?: HarnessState[];
}

/** A skill's folder name, which cannot lead out of `~/.claude/skills` (R-039). */
export const SKILL_NAME = /^[\w-][\w.-]{0,63}$/;

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
 * a card the server writes from GitHub's webhook, in plain text, with no sender (D-050).
 */
export type MessageKind = 'message' | 'reaction' | 'github';

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

export interface BootstrapDTO {
  me: UserDTO;
  users: UserDTO[];
  projects: ProjectDTO[];
  conversations: ConversationDTO[];
  /** Newest message id the client has now seen. Sync returns messages after it. */
  cursor: number;
  /** Fingerprint of everything this user can see. Sync answers "unchanged" while it matches. */
  stamp: string;
  /**
   * Each chat's newest urgent message from someone else that this user has not read, sent in the
   * last 3 days. The page alerts for them as it opens (D-078).
   */
  urgent: MessageDTO[];
  docs: DocDTO[];
}

export interface ConfigDTO {
  vapidPublicKey: string;
  /** Random per deployment; mixed into the password key derivation. */
  kdfSalt: string;
  /** The release this server runs, such as 0.10.0, whose agent files the Connect dialog names. */
  release: string;
}

/** A phone's Bark app that registered through the user's link. The key is what Bark shows for the device. */
export interface BarkDeviceDTO {
  key: string;
  registeredAt: number;
  seenAt: number;
}

/**
 * The user's Bark setup (R-018): the server URL to type into the app, the encryption key, and the
 * phones that registered. Alerts to Bark carry chat and sender names, never the message text.
 */
export interface BarkDTO {
  /** False until the server holds Bark's APNs key, BARK_APNS_KEY. */
  configured: boolean;
  link: {
    serverUrl: string;
    /** 32 characters for AES-256-GCM, typed into Bark's Push Encryption settings. Null while alerts go plain. */
    cipherKey: string | null;
    devices: BarkDeviceDTO[];
  } | null;
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

export interface LoginInput {
  username: string;
  /** Derived from the password in the browser, or for an agent, the random key it paired with. */
  authKey: string;
}

/**
 * A coding agent's half of a pairing (R-030, D-093): the keys and login key of the account its
 * owner is about to approve. The id and the proof come from the code the owner's page showed, so
 * the server can match the two halves without learning the code.
 */
export interface PairingInput {
  id: string;
  keys: PublicKeysDTO;
  /** HMAC of the agent's keys under the code. The owner's page checks it before approving. */
  proof: string;
  /** The agent's login key, random, since an agent has no password. */
  authKey: string;
  /** The harnesses it asks to link, sealed under the code (`sealPicks`); the server cannot read them. */
  picks?: string;
}

export interface PairingDTO {
  keys: PublicKeysDTO;
  proof: string;
  /** Once the owner approved: the agent's new account, and the owner's keys bound to the code. */
  approved: { user: UserDTO; owner: { id: number; keys: PublicKeysDTO }; proof: string } | null;
  picks?: string;
}

/** How long a pairing code works, from the page showing it to the owner's approval (R-030). */
export const PAIRING_TTL_MS = 10 * 60_000;

/** The board stops waiting on a request that no agent answers in this long (D-100). */
export const RUN_PICKUP_MS = 30 * 60_000;

export interface ApprovePairingInput {
  displayName: string;
  /** HMAC of the owner's id and keys and the agent's keys under the code. The agent checks it. */
  proof: string;
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

/**
 * One section of a doc, or its title, as one person wrote it in one editing session. Encrypted with
 * the chat key and signed like a message, so the server sees only who wrote which section and when.
 */
export interface DocRevisionDTO {
  id: number;
  docId: string;
  /** "title", or the random id the browser gave the section. */
  section: string;
  authorId: number;
  envelope: EnvelopeDTO;
  createdAt: number;
  /** The session's last save. Saves replace the revision until its author stops editing. */
  updatedAt: number;
}

/** A shared Markdown doc in a project (R-020). GET /docs/:id brings its sections. */
export interface DocDTO {
  /** Made by the browser, so every revision is signed with it before the server sees the doc. */
  id: string;
  /** The project's #general channel. Its key encrypts the doc, and its members read and edit it. */
  conversationId: number;
  createdBy: number;
  createdAt: number;
  /** Grows with every save, so an open doc knows to load its sections again. */
  version: number;
  updatedBy: number;
  updatedAt: number;
  /** The newest revision of the title. */
  title: DocRevisionDTO | null;
  /** Who is editing which section now. One person at a time edits a section. */
  locks: Array<{ section: string; userId: number }>;
}

export interface CreateDocInput {
  id: string;
  conversationId: number;
  /** The title and the first sections, each sealed for the chat. */
  revisions: Array<{ section: string; envelope: EnvelopeDTO }>;
}

export interface SendMessageInput {
  envelope: EnvelopeDTO;
  urgent: boolean;
  clientId: string;
  /** Defaults to "message". Only the server writes kind "github". */
  kind?: Exclude<MessageKind, 'github'>;
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

/** JSON body of every Web Push message. The service worker turns it into a notification. */
export interface PushPayload {
  /** "reaction" only wakes a tab the user is looking at; "project" and "group" say someone added them to one. */
  kind: 'message' | 'reaction' | 'project' | 'group' | 'github' | 'test';
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
  /**
   * Who still has to review, as GitHub logins. GitHub drops a person from the list once they
   * review. Teams are left out: reading them needs the read:org scope. Absent in lists stored
   * before WebChat read it.
   */
  reviewers?: string[];
  /** GitHub logins of the people assigned. Absent in lists stored before WebChat read it. */
  assignees?: string[];
}

/**
 * A board card handed to a coding agent (R-027, D-086), the agent's report on the run, or the
 * owner's cancel. All travel inside a message's envelope, like a shared pull request, so the
 * server sees messages and nothing more. A report or a cancel names the request's message.
 */
export type RunDTO = RunRequest | RunReport | RunCancel | RunFix | RunClone;

export interface RunRequest {
  kind: 'request';
  /** The card's id, such as K-12. */
  card: string;
  title: string;
  docId: string;
  section: string;
  /** The agent account asked to run it. */
  runtime: number;
  /**
   * When the owner's page sent it. Signed, unlike the server's time, so an old request cannot be
   * played again as new (K-42). The agent refuses a request without it, from before D-089.
   */
  sentAt?: number;
  /**
   * The repository the menu showed for the agent, as "owner/name". An agent in a Claude Code
   * session runs the card only in a session open in it (R-030). Older pages send none.
   */
  repo?: string;
  /**
   * The hash of the brief the owner saw before pressing Start: the card and the decisions, as
   * briefText makes it (D-105). The agent refuses a request without it, or whose brief changed.
   */
  hash?: string;
  /** The card's status when the owner pressed Start, which their page puts back if the run fails. */
  was?: string;
  /**
   * The harness the owner picked, by its `HarnessState.name`. A page from before the pick names
   * none, and the run goes to the laptop's host harness; one the laptop has not enabled fails.
   */
  harness?: string;
}

export interface RunReport {
  /**
   * "fixing" starts another round on the run's pull request, after CI failed, a conflict or a review
   * (R-030). "review" says someone other than the owner reviewed it, and the round waits for the
   * owner's go; its text holds their comments. "ended" says the watching stopped (D-105). "nocopy"
   * says the laptop has no folder of the request's repository, and the run waits for the owner to
   * have it cloned (R-036). Since R-042: "stale" says the card no longer holds, why in the note,
   * nothing was pushed, and the card is the change of its status the owner can add; "decision" says
   * the run waits for a decision nobody foresaw, whose draft is the card; "draft" hands the owner a
   * change the run asks of the board; "merged" says the draft was merged, so the owner's page
   * finishes the card and accepts its decisions (D-118); "closed" says it was closed unmerged, so the
   * owner's page gives the card back the status it had before the run. "progress" says in the note
   * what the run does now, at most every 30 seconds; "paused" says the owner stopped a run whose
   * work was unfinished, which keeps its worktree, branch, draft and session for their next words
   * (docs/decisions/stop-pauses-run.md). "planned" holds in the note the plan of a card that holds,
   * which waits for the owner's go or words before the claim commit (docs/decisions/redirect-plan-gate.md).
   */
  kind: 'claimed' | 'done' | 'failed' | 'fixing' | 'review' | 'ended' | 'nocopy' | 'stale' | 'decision' | 'merged' | 'closed' | 'draft' | 'progress' | 'paused' | 'planned';
  request: number;
  /** What happened, in a line. */
  note?: string;
  /** For a run that is done: the branch it left, and the pull request it opened. */
  branch?: string;
  pull?: { repo: string; number: number };
  /** For a "stale", "decision" or "draft": the card or change the run asks the board for, which only the owner's page adds (D-104). */
  card?: CardDraftDTO;
  /** For a "merged": the Proposed decisions the work made true, which the owner's page marks Accepted (R-042). */
  decisions?: string[];
}

/** The owner stops a run, or the watching of its pull request (R-030). The agent heeds only its owner. */
export interface RunCancel {
  kind: 'cancel';
  request: number;
}

/**
 * The owner's go for another round on a run's draft (D-105): after a review waits, or with their own
 * words in `note`, as when they reply after the draft is ready. The agent heeds only its owner.
 */
export interface RunFix {
  kind: 'fix';
  request: number;
  /** The review report it approves: only the text that report showed runs, never what came after. */
  review?: number;
  note?: string;
  sentAt: number;
}

/**
 * The owner has their agent clone a repository its laptop has no folder for, after a "nocopy"
 * report on the request; the run that waits for it then goes on (R-036, D-108). The agent heeds
 * only its owner, and clones only a repository one of their projects links.
 */
export interface RunClone {
  kind: 'clone';
  request: number;
  repo: string;
  sentAt: number;
}

/** A board card's status line, without "Status:" and its final period (D-082). */
export const cardStatus = (text: string) => /^Status:\s*(.*?)\.?\s*$/.exec(text.split('\n').filter((l) => l.trim())[1] ?? '')?.[1] ?? '';

/**
 * The brief a card's run follows, as the owner's page shows it and both sides hash it (D-105): the
 * card, then the decisions the team holds, without the superseded ones.
 */
export const briefText = (card: string, decisions: string[]) => [card.trim(), ...heldDecisions(decisions)].join('\n\n');

/** Whether the team holds a decision still, so a run follows it: every one but the superseded. */
export const isHeld = (decision: string) => !cardStatus(decision).toLowerCase().startsWith('superseded');

/** The decisions a run follows, each trimmed. */
export const heldDecisions = (decisions: string[]) => decisions.filter(isHeld).map((d) => d.trim());

/**
 * The owner's conversation with their agent, in their direct chat (R-035, D-102): a prompt, the
 * agent's answers, and the owner's replies and cancels. Each is a message of its own whose sealed
 * field names the conversation by its prompt's client id, which the sender signs, unlike the
 * server's message id. The text holds the words. The owner's page signs the send time into each of
 * its own, so the agent can refuse an old one played again (K-42).
 */
export type PromptDTO =
  // A prompt names its project's board and, unless the project links none, one of its repositories
  // (R-038), and the harness that answers, which every reply then resumes; none for the host harness.
  | { kind: 'prompt'; repo?: string; sentAt: number; project?: number; harness?: string }
  | { kind: 'reply'; to: string; sentAt: number }
  | { kind: 'cancel'; to: string; sentAt: number }
  | { kind: 'answer'; to: string; card?: CardDraftDTO }
  | { kind: 'failed'; to: string }
  // The agent's laptop has no folder of the prompt's repository, and the turn waits for a clone; the
  // owner's clone has it made; a note says what the agent does meanwhile, and changes no state (R-036).
  | { kind: 'nocopy'; to: string }
  | { kind: 'clone'; to: string; repo: string; sentAt: number }
  | { kind: 'note'; to: string };

/**
 * A board card an agent drafted when its owner asked (D-104): a new decision, idea or issue, or a
 * change to the card it replaces, named by its doc and section, with a hash of the text the agent
 * saw. It goes on the board only when the owner's page writes it. Since R-041 it says what the
 * agent's check read, and which cards, decisions or open pull requests (`#12`) it repeats or goes
 * against, each one the brief held (D-116).
 */
export interface CardDraftDTO {
  kind: 'D' | 'R' | 'K' | 'Q';
  title: string;
  body: string;
  replaces?: { card: string; doc: string; section: string; seen: string };
  checked?: string;
  related?: Array<{ id: string; kind: 'duplicate' | 'conflict'; why: string }>;
  /** A proposal's new status line for the card it changes, as its file in the repository says (R-040). */
  status?: string;
}

/**
 * How the owner's agent keeps a linked repository's `docs/roadmap.md` and `docs/decisions.md` as
 * copies of the board (R-040, D-117), sealed in the owner's direct chat with it. The owner's page
 * asks for the repository's entries when the owner links it, and imports them; the agent answers
 * in parts. Once a proposal file reaches the default branch, the agent sends it as a card draft,
 * and it names the cards that open pull requests claim, whose status the owner's page then sets.
 */
export type BoardSyncDTO =
  | { kind: 'link'; project: number; repo: string; sentAt: number }
  | { kind: 'entries'; to: string; part: number; parts: number; entries: string[] }
  | { kind: 'failed'; to: string }
  | { kind: 'proposal'; project: number; repo: string; card: CardDraftDTO }
  | { kind: 'claims'; project: number; repo: string; claims: Array<{ card: string; pull: number }> };

/**
 * A request about a board card, sent to the member asked in their direct chat with the asker, so
 * only they get a push (the card-notes decision). It names the card inside the sealed content only.
 */
export interface CardNoteDTO {
  kind: 'ready' | 'review' | 'waiting';
  card: string;
  docId: string;
  section: string;
}

/**
 * A request from the owner's laptop that the owner approves on their page, and the approval, in
 * their direct chat, sealed (docs/decisions/harness-linking.md, docs/decisions/connect-approval.md).
 * `kind` says what is asked; each kind has its own steps. The laptop's `request` names what it asks,
 * and the approval or decline names the request by its message's client id (`to`) with the signed
 * time it was sent. A connect's approval also signs the repository and the folder the owner saw.
 */
export type AskDTO =
  | { kind: 'link'; step: 'request'; harness: string }
  | { kind: 'connect'; step: 'request'; repo: string; folder: string }
  | { kind: 'link'; step: 'approve'; to: string; sentAt: number }
  | { kind: 'connect'; step: 'approve'; to: string; sentAt: number; repo: string; folder: string }
  | { kind: 'link' | 'connect'; step: 'decline'; to: string; sentAt: number }
  | { kind: 'link' | 'connect'; step: 'done' | 'failed'; to: string; note?: string };

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
  /** As in PullRequestDTO. Absent on cards from before cards named reviewers, which then show none. */
  reviewers?: string[];
  assignees?: string[];
}

/** What a GitHub card says happened to a pull request. */
export type PullEvent = 'opened' | 'ready' | 'reopened' | 'merged' | 'closed';

/**
 * The body of a message of kind "github". The server writes it from GitHub's webhook into each
 * channel that links the repository, so it is plain text, not end-to-end encrypted (D-050).
 */
export interface GithubCardDTO {
  event: PullEvent;
  /** The pull request as GitHub described it at that moment. GitHub's webhook says nothing of checks or reviews. */
  pull: PullCardDTO;
  /** GitHub login of the person who opened it. */
  author: string | null;
  /** GitHub login of the person who marked it ready, merged, closed or reopened it. */
  actor: string | null;
}

/** A repository linked to a project through the GitHub App. Its pull requests go to the channel as cards. */
export interface ProjectRepoDTO {
  /** GitHub's id, which stays the same when the repository is renamed or moved. */
  repoId: number;
  /** "owner/name", as GitHub last named it. */
  repo: string;
  conversationId: number;
  addedBy: number | null;
  addedAt: number;
}

/** A repository the user just showed GitHub they reach through the app, so they can link it. */
export interface RepoChoiceDTO {
  repoId: number;
  repo: string;
}

export interface ProjectReposDTO {
  /** False until the server owner sets up the GitHub App. */
  configured: boolean;
  repos: ProjectRepoDTO[];
  /** For the project's owner after they signed in to the app: the repositories they can link. Empty otherwise. */
  choices: RepoChoiceDTO[];
}

/** Links a repository the owner can reach through the GitHub App to a channel. */
export interface LinkRepoInput {
  repoId: number;
  conversationId: number;
}

export interface PullListsDTO {
  /** Open pull requests that ask this user, or one of their teams, for a review. GitHub's search finds both. */
  reviewRequested: PullRequestDTO[];
  /** Open pull requests this user opened. */
  authored: PullRequestDTO[];
  /**
   * Organizations that restrict OAuth Apps and have not approved WebChat. GitHub leaves their pull
   * requests out of the lists above, so the pane names them instead (K-6). Absent in lists stored
   * before WebChat read it.
   */
  hiddenOrganizations?: string[];
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
  /** False until the server owner sets up the GitHub App that projects link repositories through. */
  appConfigured: boolean;
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
  /**
   * True while a timer or a scheduler has polled in the last 10 minutes, so alerts arrive with
   * every tab closed. False means they arrive only while a WebChat tab is open.
   */
  alertsWhileClosed: boolean;
}

/** Messages the service worker posts to open pages. */
export type WorkerToPageMessage =
  | { type: 'push'; payload: PushPayload }
  | { type: 'open-conversation'; conversationId: number }
  | { type: 'subscription-changed' };

/** Response header that names the server's build. A tab reloads when the value changes. */
export const BUILD_HEADER = 'x-webchat-build';

/**
 * True for Apple's push service, which Safari and web apps on iPhone and iPad use. WebKit revokes a
 * subscription after a few pushes that show no notification, so such an endpoint never gets a push
 * that only wakes an open tab (D-047).
 */
export function showsEveryPush(endpoint: string | null): boolean {
  if (!endpoint) return false;
  try {
    const host = new URL(endpoint).hostname;
    return host === 'push.apple.com' || host.endsWith('.push.apple.com');
  } catch {
    return false;
  }
}

/** What a message's content says in a chat list, a toast or a notification. An agent's answer is Markdown, shown as plain words (D-103). */
export function previewOf(content: { text: string; pull?: { title: string } | null; prompt?: PromptDTO | null }) {
  if (content.pull) return `Pull request: ${content.pull.title}`;
  if (content.prompt?.kind === 'answer') return content.text.replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/```\w*|\*\*|__|`/g, '');
  return content.text;
}

export const LIMITS = {
  messageLength: 4000,
  /** Characters of the quoted message a reply carries. */
  quoteLength: 160,
  /**
   * Base64url ciphertext of the longest message with its quote, each character up to 4 UTF-8
   * bytes: that is under 17 KB, which pads to 32 KB (PAD_MIN_BYTES in shared/e2ee.ts), plus the
   * 16-byte tag.
   */
  ciphertextLength: 43_712,
  groupTitleLength: 60,
  projectNameLength: 60,
  channelNameLength: 40,
  /** People added to a project or group at once. Each needs every channel key, and requests stop at 256 KB. */
  addMembersAtOnce: 20,
  displayNameLength: 40,
  /** GitHub's own limit for a pull request title. */
  pullTitleLength: 256,
  /** Reviewers, and assignees, that the poll reads and a card names. */
  pullPeople: 10,
  /** Repositories one project links. Each pull request event in them becomes a message. */
  reposPerProject: 10,
  pageSize: 50,
  docTitleLength: 120,
  docSectionLength: 10_000,
  /**
   * Base64url ciphertext of the longest section: JSON escapes a UTF-16 unit to at most 6 bytes, so
   * it stays under 64 KB, which is its padding band, plus the 16-byte tag.
   */
  docCiphertextLength: 87_403,
  /** Sections a new doc starts with, from a template. */
  docSectionsAtOnce: 20,
  /** Revisions of a section that its history shows. */
  docHistory: 100,
  /** A run report's note, and a run request's card title. */
  runNoteLength: 1000,
  /** A branch name in a run report. */
  branchLength: 200,
  /** Repositories one laptop's check-in names (R-036). */
  agentRepos: 50,
  /** A card draft's check line, and its related cards with their reasons (R-041). */
  checkedLength: 500,
  relatedPerDraft: 10,
  relatedWhyLength: 300,
  /** Skills an agent offers its owner, and a skill's description, so its answer stays one message (R-039). */
  setupSkills: 40,
  skillDescriptionLength: 140,
  /** Harnesses an agent's answer lists, and the length of a name, a version, a path or a refusal (D-115). */
  harnesses: 8,
  harnessFieldLength: 500,
  /** A pairing's sealed picks, in base64url characters. */
  pairingPicks: 4096,
} as const;

/** Slack-style channel names (D-027): lowercase letters and digits in any script, joined by single hyphens. */
const CHANNEL_NAME = /^[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+(-[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+)*$/u;

export const isChannelName = (name: string) => name.length <= LIMITS.channelNameLength && CHANNEL_NAME.test(name);

/** A GitHub repository as "owner/name". GitHub refuses "." and ".." as names, and the agent joins the name onto its clone folder, so they are refused here too. */
export const isRepoName = (name: string) => name.length <= 200 && /^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/.test(name);

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
