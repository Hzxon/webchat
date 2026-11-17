import { type ConversationType, type DocRevisionDTO, type EnvelopeDTO, type FirstChatKeyInput, type GithubEventDTO, type GithubEventKind, type MemberState, type MessageDTO, type MessageKind, type ProjectRepoDTO, type SealedBackupDTO, type UserDTO, type WrappedKeyInput } from '../../shared/types.js';

/** A user counts as online while their app checked in within this window. */
export const ONLINE_WINDOW_MS = 60_000;
/** An agent checks in every 60 seconds once it has been idle for an hour, so it counts as online for twice that. */
export const AGENT_ONLINE_WINDOW_MS = 2 * 60_000;
/** How long an "I am looking" check-in lasts. Attentive tabs check in more often than this. */
export const ATTENTION_TTL_MS = 45_000;
/** Sync re-sends recent messages too, in case a slow insert committed after a newer one. */
export const SYNC_OVERLAP_MS = 15_000;
/** Most messages one check-in returns. A check-in that leaves some behind says so (`more`). */
export const SYNC_PAGE_SIZE = 500;
/** How long a doc section stays locked after its editor's last check-in or save. A tab in the background checks in every minute. */
export const DOC_LOCK_MS = 2 * 60_000;

export interface FileRow {
  id: string;
  conversation_id: number | null;
  uploader_id: number;
  size: number;
  created_at: number;
  sent: boolean;
}

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: number;
  last_active_at: number | null;
  attentive_until: number;
  attentive_tab: string | null;
  attentive_endpoint: string | null;
  auth_version: number;
  dh_public: string | null;
  sign_public: string | null;
  key_backup: string | null;
  agent_owner: number | null;
  protocol: number;
  deleted_at: number | null;
  /** An agent's sessions, by repository, from listUsers only. */
  repos?: Array<{ repo: string; last_seen: number; protocol: number }>;
}

export interface PairingRow {
  id: string;
  dh_public: string;
  sign_public: string;
  proof: string;
  login_hash: string;
  expires_at: number;
  agent_id: number | null;
  owner_proof: string | null;
  picks: string | null;
}


export interface ConversationRow {
  id: number;
  type: ConversationType;
  title: string | null;
  project_id: number | null;
  created_by: number | null;
  updated_at: number;
  unread: number;
  key_id: string | null;
  needs_new_key: boolean;
  muted: boolean;
  my_wrapped_by: number | null;
  my_iv: string | null;
  my_wrapped: string | null;
}

export interface KeyLinkRow {
  conversation_id: number;
  key_id: string;
  previous_key_id: string;
  iv: string;
  wrapped: string;
}

export interface MemberRow {
  conversation_id: number;
  user_id: number;
  last_delivered_id: number;
  last_read_id: number;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  sender_id: number | null;
  kind: MessageKind;
  body: string;
  envelope: string | null;
  urgent: boolean;
  client_id: string | null;
  created_at: number;
}

export interface GithubAccountRow {
  user_id: number;
  github_id: number;
  login: string;
  name: string | null;
  token: string;
  notify: boolean;
  pulls: string | null;
  fetched_at: number | null;
  polled_at: number;
  error: string | null;
  revoked: boolean;
  created_at: number;
}

export interface GithubEventRow {
  id: number;
  kind: GithubEventKind;
  repo: string;
  number: number;
  title: string;
  url: string;
  actor: string | null;
  created_at: number;
}

export interface DocRow {
  id: string;
  conversation_id: number;
  created_by: number;
  created_at: number;
  version: number;
  updated_by: number;
  updated_at: number;
}

export interface DocRevisionRow {
  id: number;
  doc_id: string;
  section: string;
  author_id: number;
  envelope: string;
  created_at: number;
  updated_at: number;
}

export const toDocRevisionDTO = (row: DocRevisionRow): DocRevisionDTO => ({
  id: row.id,
  docId: row.doc_id,
  section: row.section,
  authorId: row.author_id,
  envelope: JSON.parse(row.envelope) as EnvelopeDTO,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Each account keeps this many of its newest pull request events. */
export const GITHUB_EVENTS_KEPT = 50;

/** A Supabase Cron job that calls the server on Vercel, where nothing runs between requests (D-057). */
export interface DatabaseJob {
  name: string;
  schedule: string;
  /** SQL the job checks on every run. It calls the server only while this holds. */
  when?: string;
}

/** Calls GET /api/github/poll at the same pace as the self-hosted timer's default. */
export const GITHUB_POLL_JOB: DatabaseJob = { name: 'webchat-github-poll', schedule: '*/2 * * * *' };
/**
 * The meta row with the bearer token every job sends. The jobs read it on every run, so it is
 * stored once. It is named for the first job, and deployments already hold it under that name.
 */
export const JOB_SECRET = 'github_poll_secret';
/** The meta row with the time pollAll last started, from a timer or a scheduler. */
export const GITHUB_SCHEDULED_AT = 'github_scheduled_at';

export const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

export interface ProjectRepoRow {
  repo_id: number;
  repo: string;
  conversation_id: number;
  added_by: number | null;
  added_at: number;
}

/** A repository someone reaches through the GitHub App, and the installation that covers it. */
export interface GithubRepoGrant {
  repoId: number;
  repo: string;
  installationId: number;
}

/** How long someone may link the repositories they showed GitHub they reach, before signing in to the app again. */
export const GRANT_TTL_MS = 30 * 60_000;
/** Webhook deliveries are remembered this long. GitHub redelivers within hours, if at all. */
export const DELIVERY_TTL_MS = 3 * 24 * 3600_000;
/** A repository nobody opened Claude Code in for this long leaves the agent's menu (D-094). */
export const AGENT_REPO_TTL_MS = 30 * 24 * 3600_000;
/** A reserved chat id left unused this long goes; a page uses its own at once (D-111). */
export const CONVERSATION_ID_TTL_MS = 3600_000;
/** An unread urgent message alerts as a page opens for as long as its push waits for an offline device (D-023). */
export const URGENT_WAIT_MS = 3 * 24 * 3600_000;

/**
 * Urgent messages from the last 3 days, each joined as `msg` with a member `m` who did not send it
 * and has not read it. `now` is SQL for the time in milliseconds: a parameter, or the database clock.
 */
export const unreadUrgentFrom = (now: string) =>
  `webchat.messages msg JOIN webchat.members m ON m.conversation_id = msg.conversation_id
   WHERE msg.urgent AND msg.created_at > ${now} - ${URGENT_WAIT_MS} AND msg.id > m.last_read_id
     AND msg.sender_id IS DISTINCT FROM m.user_id`;

/** How often an unread urgent message rings again while its recipient looks away (D-079). */
export const URGENT_RING_SECONDS = 15;
/** Calls GET /api/urgent/ring, only while an urgent message is unread, so a quiet day costs no function calls. */
export const URGENT_RING_JOB: DatabaseJob = {
  name: 'webchat-urgent-ring',
  schedule: `${URGENT_RING_SECONDS} seconds`,
  when: `EXISTS (SELECT 1 FROM ${unreadUrgentFrom('(extract(epoch FROM now()) * 1000)::bigint')})`,
};

export interface ProjectRow {
  id: number;
  name: string;
  created_by: number;
  created_at: number;
}

/** A new chat's first key, for the id reserved for the chat, and who wrapped it (D-111). */
export type FirstKey = FirstChatKeyInput & { wrappedBy: number };

/** A channel key for the people being added to a project, wrapped by the member adding them. */
export interface SharedChannelKey {
  conversationId: number;
  keyId: string;
  wrappedKeys: WrappedKeyInput[];
}

/**
 * Why a project change was refused: its members or channels changed since the client looked, or
 * the owner tried to leave without handing the project over.
 */
export type ProjectChangeRefusal = 'stale' | 'name_taken' | 'already_member' | 'owner';

/** Why leaving a group was refused. A group without an owner cannot lose its last member either. */
export type LeaveRefusal = 'stale' | 'owner' | 'last_member';

export interface PushSubscriptionRow {
  endpoint: string;
  user_id: number;
  p256dh: string;
  auth: string;
}

export interface BarkLinkRow {
  user_id: number;
  token: string;
  origin: string;
  cipher_key: string | null;
  created_at: number;
}

export interface BarkDeviceRow {
  device_key: string;
  user_id: number;
  device_token: string;
  created_at: number;
  seen_at: number;
}

export function toMessageDTO(row: MessageRow): MessageDTO {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: row.kind,
    body: row.body,
    envelope: row.envelope ? (JSON.parse(row.envelope) as EnvelopeDTO) : null,
    urgent: row.urgent,
    createdAt: row.created_at,
    clientId: row.client_id,
  };
}

export function toMemberState(row: MemberRow): MemberState {
  return { userId: row.user_id, lastDeliveredId: row.last_delivered_id, lastReadId: row.last_read_id };
}

export function toUserDTO(row: UserRow, now = Date.now()): UserDTO {
  const span = row.agent_owner === null ? ONLINE_WINDOW_MS : AGENT_ONLINE_WINDOW_MS;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    online: row.last_active_at !== null && now - row.last_active_at < span,
    lastSeen: row.last_active_at,
    keys: row.dh_public && row.sign_public ? { dh: row.dh_public, sign: row.sign_public } : null,
    agentOwner: row.agent_owner,
    protocol: row.protocol,
    agentRepos: (row.repos ?? []).map((r) => ({ repo: r.repo, online: now - r.last_seen < AGENT_ONLINE_WINDOW_MS, lastSeen: r.last_seen, protocol: r.protocol })),
    deleted: row.deleted_at !== null,
  };
}

export function toGithubEventDTO(row: GithubEventRow): GithubEventDTO {
  return {
    id: row.id,
    kind: row.kind,
    repo: row.repo,
    number: row.number,
    title: row.title,
    url: row.url,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export const toProjectRepoDTO = (row: ProjectRepoRow): ProjectRepoDTO => ({
  repoId: row.repo_id,
  repo: row.repo,
  conversationId: row.conversation_id,
  addedBy: row.added_by,
  addedAt: row.added_at,
});

export const keyBackupOf = (row: UserRow) =>
  row.key_backup ? (JSON.parse(row.key_backup) as SealedBackupDTO) : null;

export const isAttentive = (user: UserRow, now = Date.now()) => user.attentive_until > now;

export const one = async <T>(rows: Promise<T[]>) => (await rows)[0];

export const sameIds = (a: number[], b: number[]) => {
  const set = new Set(a);
  return set.size === a.length && new Set(b).size === b.length && a.length === b.length && b.every((id) => set.has(id));
};
