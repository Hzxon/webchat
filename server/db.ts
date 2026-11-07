import { readFileSync, readdirSync } from 'node:fs';
import {
  LIMITS,
  type AccountKeysInput,
  type ConversationDTO,
  type ConversationType,
  type DocDTO,
  type DocRevisionDTO,
  type EnvelopeDTO,
  type FirstChatKeyInput,
  type GithubEventDTO,
  type GithubEventKind,
  type KeyLinkDTO,
  type MemberState,
  type MessageDTO,
  type MessageKind,
  type ProjectDTO,
  type ProjectRepoDTO,
  type RepoChoiceDTO,
  type RotatedChannelKeyInput,
  type RotatedKeyInput,
  PAIRING_TTL_MS,
  type PairingDTO,
  type PairingInput,
  type SealedBackupDTO,
  type UserDTO,
  type WrappedKeyInput,
} from '../shared/types.js';
import { randomBytes, toBase64Url } from '../shared/e2ee.js';
import type { Querier, Sql } from './sql.js';

// Everything lives in its own schema. Supabase exposes only the "public" schema through its
// auto-generated REST API, so these tables are reachable only through this server.
const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS webchat;

CREATE TABLE IF NOT EXISTS webchat.meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webchat.users (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username           TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  password_hash      TEXT NOT NULL,
  created_at         BIGINT NOT NULL,
  last_active_at     BIGINT,
  -- While now < attentive_until, the user is looking at the app in the tab named here.
  attentive_until    BIGINT NOT NULL DEFAULT 0,
  attentive_tab      TEXT,
  attentive_endpoint TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON webchat.users (lower(username));

CREATE TABLE IF NOT EXISTS webchat.sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS webchat.conversations (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  title           TEXT,
  -- "<smaller user id>:<larger user id>" for direct chats, so each pair has one chat.
  direct_key      TEXT UNIQUE,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  last_message_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS webchat.members (
  conversation_id   INTEGER NOT NULL REFERENCES webchat.conversations(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  last_delivered_id INTEGER NOT NULL DEFAULT 0,
  last_read_id      INTEGER NOT NULL DEFAULT 0,
  joined_at         BIGINT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_by_user ON webchat.members (user_id);

CREATE TABLE IF NOT EXISTS webchat.messages (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES webchat.conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES webchat.users(id),
  body            TEXT NOT NULL,
  urgent          BOOLEAN NOT NULL DEFAULT false,
  client_id       TEXT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON webchat.messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS webchat.push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_by_user ON webchat.push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS webchat.rate_limits (
  key          TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count        INTEGER NOT NULL
);
`;

// Changes to tables that already exist, one file each under server/migrations/, named by their
// number and run in that order; webchat.meta's schema_version row records how many have run. Files
// rather than one array, so two branches that each add a migration never append at the same spot
// (D-106). A gap or a repeated number fails here, before any statement runs.
const migrationsDir = new URL('migrations/', import.meta.url);
export const MIGRATIONS = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name, i) => {
    if (Number(name.slice(0, 2)) !== i + 1) throw new Error(`server/migrations: expected number ${i + 1}, found ${name}`);
    return readFileSync(new URL(name, migrationsDir), 'utf8');
  });

const statements = (sql: string) =>
  sql
    .split(/;\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.replace(/--.*$/gm, '').trim());

/** A user counts as online while their app checked in within this window. */
const ONLINE_WINDOW_MS = 60_000;
/** How long an "I am looking" check-in lasts. Attentive tabs check in more often than this. */
export const ATTENTION_TTL_MS = 45_000;
/** Sync re-sends recent messages too, in case a slow insert committed after a newer one. */
const SYNC_OVERLAP_MS = 15_000;
/** Most messages one check-in returns. A check-in that leaves some behind says so (`more`). */
const SYNC_PAGE_SIZE = 500;
/** How long a doc section stays locked after its editor's last check-in or save. A tab in the background checks in every minute. */
const DOC_LOCK_MS = 2 * 60_000;

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

interface PairingRow {
  id: string;
  dh_public: string;
  sign_public: string;
  proof: string;
  login_hash: string;
  expires_at: number;
  agent_id: number | null;
  owner_proof: string | null;
}


interface ConversationRow {
  id: number;
  type: ConversationType;
  title: string | null;
  project_id: number | null;
  created_by: number | null;
  updated_at: number;
  unread: number;
  key_id: string | null;
  needs_new_key: boolean;
  my_wrapped_by: number | null;
  my_iv: string | null;
  my_wrapped: string | null;
}

interface KeyLinkRow {
  conversation_id: number;
  key_id: string;
  previous_key_id: string;
  iv: string;
  wrapped: string;
}

interface MemberRow {
  conversation_id: number;
  user_id: number;
  last_delivered_id: number;
  last_read_id: number;
}

interface MessageRow {
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

interface GithubEventRow {
  id: number;
  kind: GithubEventKind;
  repo: string;
  number: number;
  title: string;
  url: string;
  actor: string | null;
  created_at: number;
}

interface DocRow {
  id: string;
  conversation_id: number;
  created_by: number;
  created_at: number;
  version: number;
  updated_by: number;
  updated_at: number;
}

interface DocRevisionRow {
  id: number;
  doc_id: string;
  section: string;
  author_id: number;
  envelope: string;
  created_at: number;
  updated_at: number;
}

const toDocRevisionDTO = (row: DocRevisionRow): DocRevisionDTO => ({
  id: row.id,
  docId: row.doc_id,
  section: row.section,
  authorId: row.author_id,
  envelope: JSON.parse(row.envelope) as EnvelopeDTO,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Each account keeps this many of its newest pull request events. */
const GITHUB_EVENTS_KEPT = 50;

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
const JOB_SECRET = 'github_poll_secret';
/** The meta row with the time pollAll last started, from a timer or a scheduler. */
const GITHUB_SCHEDULED_AT = 'github_scheduled_at';

const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

interface ProjectRepoRow {
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
const GRANT_TTL_MS = 30 * 60_000;
/** Webhook deliveries are remembered this long. GitHub redelivers within hours, if at all. */
const DELIVERY_TTL_MS = 3 * 24 * 3600_000;
/** A repository nobody opened Claude Code in for this long leaves the agent's menu (D-094). */
const AGENT_REPO_TTL_MS = 30 * 24 * 3600_000;
/** A reserved chat id left unused this long goes; a page uses its own at once (D-111). */
const CONVERSATION_ID_TTL_MS = 3600_000;
/** An unread urgent message alerts as a page opens for as long as its push waits for an offline device (D-023). */
const URGENT_WAIT_MS = 3 * 24 * 3600_000;

/**
 * Urgent messages from the last 3 days, each joined as `msg` with a member `m` who did not send it
 * and has not read it. `now` is SQL for the time in milliseconds: a parameter, or the database clock.
 */
const unreadUrgentFrom = (now: string) =>
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
type FirstKey = FirstChatKeyInput & { wrappedBy: number };

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

function toMessageDTO(row: MessageRow): MessageDTO {
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

function toMemberState(row: MemberRow): MemberState {
  return { userId: row.user_id, lastDeliveredId: row.last_delivered_id, lastReadId: row.last_read_id };
}

export function toUserDTO(row: UserRow, now = Date.now()): UserDTO {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    online: row.last_active_at !== null && now - row.last_active_at < ONLINE_WINDOW_MS,
    lastSeen: row.last_active_at,
    keys: row.dh_public && row.sign_public ? { dh: row.dh_public, sign: row.sign_public } : null,
    agentOwner: row.agent_owner,
    protocol: row.protocol,
    agentRepos: (row.repos ?? []).map((r) => ({ repo: r.repo, online: now - r.last_seen < ONLINE_WINDOW_MS, lastSeen: r.last_seen, protocol: r.protocol })),
    deleted: row.deleted_at !== null,
  };
}

function toGithubEventDTO(row: GithubEventRow): GithubEventDTO {
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

const toProjectRepoDTO = (row: ProjectRepoRow): ProjectRepoDTO => ({
  repoId: row.repo_id,
  repo: row.repo,
  conversationId: row.conversation_id,
  addedBy: row.added_by,
  addedAt: row.added_at,
});

export const keyBackupOf = (row: UserRow) =>
  row.key_backup ? (JSON.parse(row.key_backup) as SealedBackupDTO) : null;

export const isAttentive = (user: UserRow, now = Date.now()) => user.attentive_until > now;

const one = async <T>(rows: Promise<T[]>) => (await rows)[0];

const sameIds = (a: number[], b: number[]) => {
  const set = new Set(a);
  return set.size === a.length && new Set(b).size === b.length && a.length === b.length && b.every((id) => set.has(id));
};

export type Db = Awaited<ReturnType<typeof openDb>>;

/** Wraps a connection in the app's queries. Creates the tables on first use. */
export async function openDb(sql: Sql) {
  await sql.transaction(async (tx) => {
    // Several serverless instances can start at once; the lock makes them create tables one at a time.
    await tx.query('SELECT pg_advisory_xact_lock(7349201)');
    // One statement per query: PGlite's query() does not accept several at once.
    for (const statement of statements(SCHEMA)) await tx.query(statement);
    const version = Number(
      (await one(tx.query<{ value: string }>("SELECT value FROM webchat.meta WHERE key = 'schema_version'")))?.value ?? 0,
    );
    for (const migration of MIGRATIONS.slice(version)) {
      for (const statement of statements(migration)) await tx.query(statement);
    }
    if (version < MIGRATIONS.length) {
      await tx.query(
        `INSERT INTO webchat.meta (key, value) VALUES ('schema_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(MIGRATIONS.length)],
      );
    }
  });

  async function conversations(userId: number, onlyId: number | null): Promise<ConversationDTO[]> {
    const [rows, members, lastMessages, links] = await Promise.all([
      sql.query<ConversationRow>(
        `SELECT c.id, c.type, c.title, c.project_id, c.created_by, c.updated_at, c.key_id, c.needs_new_key,
           k.wrapped_by AS my_wrapped_by, k.iv AS my_iv, k.wrapped AS my_wrapped,
           (SELECT COUNT(*)::int FROM webchat.messages x
             WHERE x.conversation_id = c.id AND x.id > m.last_read_id AND x.sender_id IS DISTINCT FROM m.user_id
               AND x.kind <> 'reaction') AS unread
         FROM webchat.conversations c JOIN webchat.members m ON m.conversation_id = c.id
         LEFT JOIN webchat.conversation_keys k ON k.conversation_id = c.id AND k.user_id = m.user_id
         WHERE m.user_id = $1 AND ($2::int IS NULL OR c.id = $2)
         ORDER BY c.updated_at DESC, c.id DESC`,
        [userId, onlyId],
      ),
      sql.query<MemberRow>(
        `SELECT mm.conversation_id, mm.user_id, mm.last_delivered_id, mm.last_read_id
         FROM webchat.members mm
         WHERE mm.conversation_id IN (
           SELECT conversation_id FROM webchat.members WHERE user_id = $1 AND ($2::int IS NULL OR conversation_id = $2))
         ORDER BY mm.joined_at, mm.user_id`,
        [userId, onlyId],
      ),
      sql.query<MessageRow>(
        `SELECT msg.* FROM webchat.messages msg
         JOIN webchat.conversations c ON c.last_message_id = msg.id
         JOIN webchat.members m ON m.conversation_id = c.id
         WHERE m.user_id = $1 AND ($2::int IS NULL OR c.id = $2)`,
        [userId, onlyId],
      ),
      sql.query<KeyLinkRow>(
        `SELECT l.conversation_id, l.key_id, l.previous_key_id, l.iv, l.wrapped FROM webchat.key_links l
         WHERE l.conversation_id IN (
           SELECT conversation_id FROM webchat.members WHERE user_id = $1 AND ($2::int IS NULL OR conversation_id = $2))
         ORDER BY l.created_at`,
        [userId, onlyId],
      ),
    ]);
    const membersByChat = new Map<number, MemberState[]>();
    for (const row of members) {
      const list = membersByChat.get(row.conversation_id) ?? [];
      list.push(toMemberState(row));
      membersByChat.set(row.conversation_id, list);
    }
    const linksByChat = new Map<number, KeyLinkDTO[]>();
    for (const row of links) {
      const list = linksByChat.get(row.conversation_id) ?? [];
      list.push({ keyId: row.key_id, previousKeyId: row.previous_key_id, iv: row.iv, data: row.wrapped });
      linksByChat.set(row.conversation_id, list);
    }
    const lastByChat = new Map(lastMessages.map((row) => [row.conversation_id, toMessageDTO(row)]));
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      projectId: row.project_id,
      ownerId: row.created_by,
      members: membersByChat.get(row.id) ?? [],
      lastMessage: lastByChat.get(row.id) ?? null,
      unread: row.unread,
      updatedAt: row.updated_at,
      keyId: row.key_id,
      myKey:
        row.my_wrapped_by !== null && row.my_iv && row.my_wrapped
          ? { wrappedBy: row.my_wrapped_by, iv: row.my_iv, data: row.my_wrapped }
          : null,
      keyLinks: linksByChat.get(row.id) ?? [],
      needsNewKey: row.needs_new_key,
    }));
  }

  async function markRead(q: Querier, conversationId: number, userId: number, messageId: number) {
    const row = await one(
      q.query<MemberRow>(
        `UPDATE webchat.members
         SET last_read_id = GREATEST(last_read_id, $1), last_delivered_id = GREATEST(last_delivered_id, $1)
         WHERE conversation_id = $2 AND user_id = $3 AND (last_read_id < $1 OR last_delivered_id < $1)
         RETURNING conversation_id, user_id, last_delivered_id, last_read_id`,
        [messageId, conversationId, userId],
      ),
    );
    return row && toMemberState(row);
  }

  async function insertWrappedKeys(q: Querier, conversationId: number, wrappedBy: number, wrappedKeys: WrappedKeyInput[]) {
    for (const k of wrappedKeys) {
      await q.query(
        `INSERT INTO webchat.conversation_keys (conversation_id, user_id, wrapped_by, iv, wrapped)
         VALUES ($1, $2, $3, $4, $5)`,
        [conversationId, k.userId, wrappedBy, k.iv, k.data],
      );
    }
  }

  async function projects(userId: number, onlyId: number | null): Promise<ProjectDTO[]> {
    const [rows, members] = await Promise.all([
      sql.query<ProjectRow>(
        `SELECT p.* FROM webchat.projects p JOIN webchat.project_members pm ON pm.project_id = p.id
         WHERE pm.user_id = $1 AND ($2::int IS NULL OR p.id = $2)
         ORDER BY lower(p.name), p.id`,
        [userId, onlyId],
      ),
      sql.query<{ project_id: number; user_id: number }>(
        `SELECT pm.project_id, pm.user_id FROM webchat.project_members pm
         WHERE pm.project_id IN (
           SELECT project_id FROM webchat.project_members WHERE user_id = $1 AND ($2::int IS NULL OR project_id = $2))
         ORDER BY pm.joined_at, pm.user_id`,
        [userId, onlyId],
      ),
    ]);
    const membersOf = new Map<number, number[]>();
    for (const row of members) membersOf.set(row.project_id, [...(membersOf.get(row.project_id) ?? []), row.user_id]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerId: row.created_by,
      createdAt: row.created_at,
      memberIds: membersOf.get(row.id) ?? [],
    }));
  }

  /** Inserts a channel with its members and key. Returns undefined if the project has a channel of that name. */
  async function insertChannel(
    q: Querier,
    projectId: number,
    title: string,
    memberIds: number[],
    key: FirstKey,
  ) {
    const now = Date.now();
    const created = await one(
      q.query<{ id: number }>(
        `INSERT INTO webchat.conversations (id, type, title, project_id, created_at, updated_at, key_id)
         OVERRIDING SYSTEM VALUE VALUES ($1, 'channel', $2, $3, $4, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
        [key.conversationId, title, projectId, now, key.keyId],
      ),
    );
    if (!created) return undefined;
    for (const userId of memberIds) {
      await q.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [
        created.id,
        userId,
        now,
      ]);
    }
    await insertWrappedKeys(q, created.id, key.wrappedBy, key.wrappedKeys);
    return created.id;
  }

  /** Locks a project for a change to its members, owner or channels, and returns who is in it and who owns it. */
  async function lockProject(q: Querier, projectId: number) {
    const project = await one(
      q.query<{ created_by: number }>('SELECT created_by FROM webchat.projects WHERE id = $1 FOR UPDATE', [projectId]),
    );
    const memberIds = (
      await q.query<{ user_id: number }>('SELECT user_id FROM webchat.project_members WHERE project_id = $1', [projectId])
    ).map((row) => row.user_id);
    return { ownerId: project?.created_by ?? null, memberIds };
  }

  const chatMembers = async (q: Querier, conversationId: number) =>
    (
      await q.query<{ user_id: number }>('SELECT user_id FROM webchat.members WHERE conversation_id = $1', [conversationId])
    ).map((row) => row.user_id);

  const projectChannels = (q: Querier, projectId: number) =>
    q.query<{ id: number; key_id: string | null }>('SELECT id, key_id FROM webchat.conversations WHERE project_id = $1', [
      projectId,
    ]);

  /**
   * Whether a new key may replace a chat's current one: it names the current key as the one it
   * replaces, is wrapped for exactly these people, and has an id the chat never used, so the chain
   * of earlier keys has one way back.
   */
  async function canReplace(
    q: Querier,
    chat: { id: number; key_id: string | null },
    key: RotatedKeyInput | undefined,
    memberIds: number[],
  ) {
    if (!key || chat.key_id === null || key.link.previousKeyId !== chat.key_id || key.keyId === chat.key_id) return false;
    if (!sameIds(memberIds, key.wrappedKeys.map((k) => k.userId))) return false;
    const used = await q.query('SELECT 1 FROM webchat.key_links WHERE conversation_id = $1 AND previous_key_id = $2', [
      chat.id,
      key.keyId,
    ]);
    return used.length === 0;
  }

  /** Puts a new key in place of a chat's current one: a copy for every member, and the old key inside it. */
  async function replaceKey(q: Querier, conversationId: number, wrappedBy: number, key: RotatedKeyInput) {
    await q.query('DELETE FROM webchat.conversation_keys WHERE conversation_id = $1', [conversationId]);
    await insertWrappedKeys(q, conversationId, wrappedBy, key.wrappedKeys);
    await q.query(
      `INSERT INTO webchat.key_links (conversation_id, key_id, previous_key_id, iv, wrapped, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conversationId, key.keyId, key.link.previousKeyId, key.link.iv, key.link.data, Date.now()],
    );
    await q.query('UPDATE webchat.conversations SET key_id = $2, needs_new_key = false WHERE id = $1', [
      conversationId,
      key.keyId,
    ]);
  }

  /**
   * Takes someone out of a chat at their own request. They hold its key and cannot make a new one
   * for the others, so the chat waits for a member who stays to replace it.
   */
  /** Docs in the chats this user is in, or only one of them, with each title and the locks held now (R-020). */
  async function docs(userId: number, onlyId: string | null): Promise<DocDTO[]> {
    const mine = `JOIN webchat.members m ON m.conversation_id = d.conversation_id AND m.user_id = $1
      WHERE ($2::text IS NULL OR d.id = $2)`;
    const [rows, titles, locks] = await Promise.all([
      sql.query<DocRow>(`SELECT d.* FROM webchat.docs d ${mine} ORDER BY d.created_at, d.id`, [userId, onlyId]),
      sql.query<DocRevisionRow>(
        `SELECT DISTINCT ON (r.doc_id) r.* FROM webchat.doc_revisions r JOIN webchat.docs d ON d.id = r.doc_id ${mine}
           AND r.section = 'title' ORDER BY r.doc_id, r.id DESC`,
        [userId, onlyId],
      ),
      sql.query<{ doc_id: string; section: string; user_id: number }>(
        `SELECT l.doc_id, l.section, l.user_id FROM webchat.doc_locks l JOIN webchat.docs d ON d.id = l.doc_id ${mine}
           AND l.expires_at > $3`,
        [userId, onlyId, Date.now()],
      ),
    ]);
    const titleOf = new Map(titles.map((r) => [r.doc_id, toDocRevisionDTO(r)]));
    return rows.map((d) => ({
      id: d.id,
      conversationId: d.conversation_id,
      createdBy: d.created_by,
      createdAt: d.created_at,
      version: d.version,
      updatedBy: d.updated_by,
      updatedAt: d.updated_at,
      title: titleOf.get(d.id) ?? null,
      locks: locks.filter((l) => l.doc_id === d.id).map((l) => ({ section: l.section, userId: l.user_id })),
    }));
  }

  /**
   * Deletes one account (R-028, D-088). The row stays, without its name, secrets or keys, so old
   * messages keep their sender. The person leaves every group and channel the way leaving does,
   * so each needs a new key before anyone sends again. Groups with nobody else, and direct chats,
   * which have nobody left to name them, are deleted. False when the person still owns a project
   * or group with other people in it: they hand it over or delete it first, as for leaving.
   * A new table with rows per user needs a line in the list below, since the row is never deleted.
   */
  async function removeAccount(tx: Querier, userId: number): Promise<boolean> {
    const projects = [];
    for (const { project_id } of await tx.query<{ project_id: number }>(
      'SELECT project_id FROM webchat.project_members WHERE user_id = $1 ORDER BY project_id',
      [userId],
    )) {
      projects.push({ id: project_id, ...(await lockProject(tx, project_id)) });
    }
    const chats = await tx.query<{ id: number; type: ConversationType; created_by: number | null; members: number }>(
      `SELECT c.id, c.type, c.created_by,
         (SELECT COUNT(*)::int FROM webchat.members WHERE conversation_id = c.id) AS members
       FROM webchat.conversations c JOIN webchat.members m ON m.conversation_id = c.id
       WHERE m.user_id = $1 ORDER BY c.id FOR UPDATE OF c`,
      [userId],
    );
    if (
      projects.some((p) => p.ownerId === userId && p.memberIds.length > 1) ||
      chats.some((c) => c.type === 'group' && c.created_by === userId && c.members > 1)
    ) {
      return false;
    }
    for (const project of projects) {
      if (project.memberIds.length === 1) await tx.query('DELETE FROM webchat.projects WHERE id = $1', [project.id]);
      else await tx.query('DELETE FROM webchat.project_members WHERE project_id = $1 AND user_id = $2', [project.id, userId]);
    }
    // The channels of a project deleted above are gone already, so these queries skip them.
    for (const chat of chats) {
      if (chat.type === 'direct' || (chat.type === 'group' && chat.members === 1)) {
        await tx.query('DELETE FROM webchat.conversations WHERE id = $1', [chat.id]);
      } else {
        await leaveChat(tx, chat.id, userId);
      }
    }
    for (const table of ['sessions', 'push_subscriptions', 'bark_devices', 'bark_links', 'github_events', 'github_accounts', 'github_app_grants', 'doc_locks', 'agent_repos']) {
      await tx.query(`DELETE FROM webchat.${table} WHERE user_id = $1`, [userId]);
    }
    // The username is freed. A hyphen is not allowed in one, so nobody can sign up as the stand-in.
    await tx.query(
      `UPDATE webchat.users
       SET username = 'deleted-' || id, display_name = 'Deleted account', password_hash = '', last_active_at = NULL,
         attentive_until = 0, attentive_tab = NULL, attentive_endpoint = NULL, dh_public = NULL, sign_public = NULL,
         key_backup = NULL, agent = FALSE, busy = FALSE, deleted_at = $2
       WHERE id = $1`,
      [userId, Date.now()],
    );
    return true;
  }

  async function leaveChat(q: Querier, conversationId: number, userId: number) {
    await q.query('DELETE FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
    await q.query('DELETE FROM webchat.conversation_keys WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
    await q.query('UPDATE webchat.conversations SET needs_new_key = true WHERE id = $1 AND key_id IS NOT NULL', [
      conversationId,
    ]);
  }

  return {
    close: () => sql.close(),

    /**
     * Stores the value unless the key already has one, and returns whichever value won. Server
     * instances that start at the same moment all end up with the same value.
     */
    async claimMeta(key: string, value: string): Promise<string> {
      await sql.query('INSERT INTO webchat.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
      const row = await one(sql.query<{ value: string }>('SELECT value FROM webchat.meta WHERE key = $1', [key]));
      return row!.value;
    },
    getMeta: async (key: string): Promise<string | null> =>
      (await one(sql.query<{ value: string }>('SELECT value FROM webchat.meta WHERE key = $1', [key])))?.value ?? null,

    /**
     * Replaces a value only while it still is what the caller last read (null: nothing stored yet).
     * False means another instance changed it first, and the caller should read that instead.
     */
    setMetaIf: async (key: string, expected: string | null, value: string): Promise<boolean> => {
      const rows =
        expected === null
          ? await sql.query('INSERT INTO webchat.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key', [
              key,
              value,
            ])
          : await sql.query('UPDATE webchat.meta SET value = $3 WHERE key = $1 AND value = $2 RETURNING key', [key, expected, value]);
      return rows.length > 0;
    },

    /** Counts one hit in a fixed window. Returns false once the key is over its limit. */
    async takeRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
      const now = Date.now();
      const row = await one(
        sql.query<{ count: number }>(
          `INSERT INTO webchat.rate_limits AS r (key, window_start, count) VALUES ($1, $2, 1)
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN r.window_start <= $3 THEN 1 ELSE r.count + 1 END,
             window_start = CASE WHEN r.window_start <= $3 THEN $2 ELSE r.window_start END
           RETURNING count`,
          [key, now, now - windowMs],
        ),
      );
      return (row?.count ?? 0) <= limit;
    },
    /** Takes back one hit, for an attempt that should not count. */
    returnRateLimit: async (key: string) => {
      await sql.query('UPDATE webchat.rate_limits SET count = count - 1 WHERE key = $1 AND count > 0', [key]);
    },
    purgeExpired: async () => {
      const now = Date.now();
      await sql.query('DELETE FROM webchat.sessions WHERE expires_at <= $1', [now]);
      await sql.query('DELETE FROM webchat.rate_limits WHERE window_start <= $1', [now - 24 * 3600_000]);
      await sql.query('DELETE FROM webchat.github_app_grants WHERE expires_at <= $1', [now]);
      await sql.query('DELETE FROM webchat.github_deliveries WHERE received_at <= $1', [now - DELIVERY_TTL_MS]);
      await sql.query('DELETE FROM webchat.pairings WHERE expires_at <= $1', [now]);
      await sql.query('DELETE FROM webchat.agent_repos WHERE last_seen <= $1', [now - AGENT_REPO_TTL_MS]);
      await sql.query('DELETE FROM webchat.conversation_ids WHERE created_at <= $1', [now - CONVERSATION_ID_TTL_MS]);
    },

    /** Creates an account with its keys. Returns undefined when the username is taken. */
    createUser: async (username: string, displayName: string, loginKeyHash: string, keys: AccountKeysInput) =>
      one(
        sql.query<UserRow>(
          `INSERT INTO webchat.users
             (username, display_name, password_hash, created_at, auth_version, dh_public, sign_public, key_backup)
           VALUES ($1, $2, $3, $4, 2, $5, $6, $7)
           ON CONFLICT DO NOTHING RETURNING *`,
          [username, displayName, loginKeyHash, Date.now(), keys.dh, keys.sign, JSON.stringify(keys.backup)],
        ),
      ),
    /** Deletes an account and the agents it owns. False when removeAccount refuses the person. */
    deleteUser(userId: number): Promise<boolean> {
      return sql.transaction(async (tx) => {
        if (!(await removeAccount(tx, userId))) return false;
        // The person's agents go too (R-030): nobody else may hand them cards. An agent owns nothing.
        for (const { id } of await tx.query<{ id: number }>(
          'SELECT id FROM webchat.users WHERE agent_owner = $1 AND deleted_at IS NULL ORDER BY id',
          [userId],
        )) {
          if (!(await removeAccount(tx, id))) throw new Error(`Agent ${id} owns a project or group with others in it.`);
        }
        return true;
      });
    },

    /**
     * Deletes an agent its owner removes (R-033): it leaves every chat as a deleted account does, and
     * loses its owner, so no menu offers it again. False when it is not this owner's.
     */
    removeAgent: (ownerId: number, agentId: number) =>
      sql.transaction(async (tx) => {
        const agent = await one(
          tx.query<UserRow>('SELECT * FROM webchat.users WHERE id = $1 AND agent_owner = $2 AND deleted_at IS NULL FOR UPDATE', [agentId, ownerId]),
        );
        if (!agent) return false;
        if (!(await removeAccount(tx, agentId))) throw new Error(`Agent ${agentId} owns a project or group with others in it.`);
        await tx.query('UPDATE webchat.users SET agent_owner = NULL WHERE id = $1', [agentId]);
        return true;
      }),

    /** Files the agent's half of a pairing (R-030). False when the code was used already. */
    createPairing: async (input: PairingInput, loginHash: string) =>
      (
        await sql.query(
          `INSERT INTO webchat.pairings (id, dh_public, sign_public, proof, login_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
          [input.id, input.keys.dh, input.keys.sign, input.proof, loginHash, Date.now() + PAIRING_TTL_MS],
        )
      ).length > 0,
    /** A pairing while it lasts, with the agent's account and its owner's keys once approved. */
    async pairing(id: string): Promise<PairingDTO | undefined> {
      const row = await one(sql.query<PairingRow>('SELECT * FROM webchat.pairings WHERE id = $1 AND expires_at > $2', [id, Date.now()]));
      if (!row) return;
      const agent = row.agent_id === null ? undefined : await one(sql.query<UserRow>('SELECT * FROM webchat.users WHERE id = $1', [row.agent_id]));
      const owner = agent?.agent_owner ? await one(sql.query<UserRow>('SELECT * FROM webchat.users WHERE id = $1', [agent.agent_owner])) : undefined;
      const approved =
        agent && owner?.dh_public && owner.sign_public && row.owner_proof
          ? { user: toUserDTO(agent), owner: { id: owner.id, keys: { dh: owner.dh_public, sign: owner.sign_public } }, proof: row.owner_proof }
          : null;
      return { keys: { dh: row.dh_public, sign: row.sign_public }, proof: row.proof, approved };
    },
    /**
     * Makes the agent's account for the owner who approves, once, while the pairing lasts. Nobody but
     * the agent signs in to it, so its username is random. Undefined when the pairing is gone or done.
     */
    approvePairing: (id: string, ownerId: number, displayName: string, ownerProof: string) =>
      sql.transaction(async (tx) => {
        const row = await one(
          tx.query<PairingRow>('SELECT * FROM webchat.pairings WHERE id = $1 AND expires_at > $2 AND agent_id IS NULL FOR UPDATE', [id, Date.now()]),
        );
        if (!row) return undefined;
        const agent = (await one(
          tx.query<UserRow>(
            `INSERT INTO webchat.users (username, display_name, password_hash, created_at, auth_version, dh_public, sign_public, agent_owner)
             VALUES ($1, $2, $3, $4, 2, $5, $6, $7) RETURNING *`,
            [`agent_${Buffer.from(randomBytes(5)).toString('hex')}`, displayName, row.login_hash, Date.now(), row.dh_public, row.sign_public, ownerId],
          ),
        ))!;
        await tx.query('UPDATE webchat.pairings SET agent_id = $2, owner_proof = $3 WHERE id = $1', [id, agent.id, ownerProof]);
        return agent;
      }),
    /** Switches an account from a raw-password hash to a login-key hash. */
    upgradeAuth: (userId: number, loginKeyHash: string) =>
      one(
        sql.query<UserRow>(
          'UPDATE webchat.users SET password_hash = $2, auth_version = 2 WHERE id = $1 AND auth_version = 1 RETURNING *',
          [userId, loginKeyHash],
        ),
      ),
    /** Stores an account's keys once. Returns undefined if the account already has keys. */
    setUserKeys: (userId: number, keys: AccountKeysInput) =>
      one(
        sql.query<UserRow>(
          `UPDATE webchat.users SET dh_public = $2, sign_public = $3, key_backup = $4
           WHERE id = $1 AND dh_public IS NULL RETURNING *`,
          [userId, keys.dh, keys.sign, JSON.stringify(keys.backup)],
        ),
      ),
    getUser: (id: number) => one(sql.query<UserRow>('SELECT * FROM webchat.users WHERE id = $1', [id])),
    findUserByUsername: (username: string) =>
      one(sql.query<UserRow>('SELECT * FROM webchat.users WHERE lower(username) = lower($1) AND deleted_at IS NULL', [username])),
    listUsers: () =>
      sql.query<UserRow>(
        `SELECT u.*, (SELECT json_agg(json_build_object('repo', r.repo, 'last_seen', r.last_seen, 'protocol', r.protocol) ORDER BY r.repo)
           FROM webchat.agent_repos r WHERE r.user_id = u.id) AS repos
         FROM webchat.users u ORDER BY lower(u.display_name)`,
      ),

    /**
     * Records a check-in from a tab. An attentive tab claims the user's attention; when that same
     * tab stops being attentive, the claim ends at once instead of waiting for it to expire. An
     * agent's laptop checks in once for every repository it has a folder for, and names what it can
     * do; an older plugin checks in for the one repository its session is open in (D-094).
     */
    async checkIn(userId: number, attentive: boolean, tabId: string, endpoint: string | null, repos: string[] = [], protocol = 0, laptop = false) {
      const now = Date.now();
      if (attentive) {
        await Promise.all([
          sql.query(
            `UPDATE webchat.users
             SET last_active_at = $2, attentive_until = $3, attentive_tab = $4, attentive_endpoint = $5, protocol = COALESCE($6::integer, protocol)
             WHERE id = $1`,
            [userId, now, now + ATTENTION_TTL_MS, tabId, endpoint, laptop ? protocol : null],
          ),
          ...repos.map((repo) =>
            sql.query(
              `INSERT INTO webchat.agent_repos (user_id, repo, last_seen, protocol) VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, repo) DO UPDATE SET last_seen = EXCLUDED.last_seen, protocol = EXCLUDED.protocol`,
              [userId, repo, now, protocol],
            ),
          ),
        ]);
        // A laptop names every folder it has, so the folders it no longer names are gone from it (R-038).
        if (laptop) await sql.query('DELETE FROM webchat.agent_repos WHERE user_id = $1 AND last_seen < $2', [userId, now]);
      } else {
        await sql.query(
          `UPDATE webchat.users SET attentive_until = 0
           WHERE id = $1 AND attentive_tab = $2 AND attentive_until > 0`,
          [userId, tabId],
        );
      }
    },

    createSession: async (tokenHash: string, userId: number, expiresAt: number) => {
      await sql.query(
        'INSERT INTO webchat.sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
        [tokenHash, userId, Date.now(), expiresAt],
      );
    },
    sessionUser: (tokenHash: string) =>
      one(
        sql.query<UserRow>(
          `SELECT u.* FROM webchat.sessions s JOIN webchat.users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.expires_at > $2`,
          [tokenHash, Date.now()],
        ),
      ),
    deleteSession: async (tokenHash: string) => {
      await sql.query('DELETE FROM webchat.sessions WHERE token_hash = $1', [tokenHash]);
    },

    findDirect: async (userA: number, userB: number) =>
      (
        await one(
          sql.query<{ id: number }>('SELECT id FROM webchat.conversations WHERE direct_key = $1', [
            `${Math.min(userA, userB)}:${Math.max(userA, userB)}`,
          ]),
        )
      )?.id,

    /** Takes the next chat id for a chat this user is about to create, so the copies of its first key can name it (D-111). */
    async reserveConversationId(userId: number): Promise<number> {
      const row = await one(
        sql.query<{ id: number }>(
          `INSERT INTO webchat.conversation_ids (id, user_id, created_at)
           VALUES (nextval(pg_get_serial_sequence('webchat.conversations', 'id')), $1, $2) RETURNING id`,
          [userId, Date.now()],
        ),
      );
      return row!.id;
    },

    /** Uses up an id reserveConversationId gave this user. False when it gave none, or it was used. */
    takeConversationId: async (conversationId: number, userId: number) =>
      (await one(
        sql.query('DELETE FROM webchat.conversation_ids WHERE id = $1 AND user_id = $2 RETURNING id', [conversationId, userId]),
      )) !== undefined,

    /**
     * Creates a chat with its members and its key, wrapped for each member. For a direct chat that
     * already exists, returns the existing id and ignores the new key.
     */
    createConversation(type: ConversationType, title: string | null, memberIds: number[], key: FirstKey): Promise<number> {
      const now = Date.now();
      const directKey = type === 'direct' ? `${Math.min(...memberIds)}:${Math.max(...memberIds)}` : null;
      return sql.transaction(async (tx) => {
        const created = await one(
          tx.query<{ id: number }>(
            `INSERT INTO webchat.conversations (id, type, title, direct_key, created_at, updated_at, key_id, created_by)
             OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $5, $6, $7) ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
            // Only a group has an owner: the person who made it, who also wraps its key.
            [key.conversationId, type, title, directKey, now, key.keyId, type === 'group' ? key.wrappedBy : null],
          ),
        );
        if (!created) {
          const existing = await one(
            tx.query<{ id: number }>('SELECT id FROM webchat.conversations WHERE direct_key = $1', [directKey]),
          );
          return existing!.id;
        }
        for (const userId of memberIds) {
          await tx.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [
            created.id,
            userId,
            now,
          ]);
        }
        await insertWrappedKeys(tx, created.id, key.wrappedBy, key.wrappedKeys);
        return created.id;
      });
    },

    /**
     * Gives a chat from before encryption its key. Only the first caller wins. 'stale' when the
     * caller left, or the copies do not cover exactly the members. A group without an owner becomes
     * the caller's, as migration 4 did for the groups keyed before it.
     */
    setConversationKey(
      conversationId: number,
      keyId: string,
      wrappedBy: number,
      wrappedKeys: WrappedKeyInput[],
    ): Promise<true | 'has_key' | 'stale'> {
      return sql.transaction(async (tx) => {
        // Adding, removing and leaving lock this row too, so the members stay as checked until the key is stored.
        const chat = await one(
          tx.query<{ key_id: string | null }>('SELECT key_id FROM webchat.conversations WHERE id = $1 FOR UPDATE', [
            conversationId,
          ]),
        );
        if (chat?.key_id !== null) return 'has_key';
        const memberIds = await chatMembers(tx, conversationId);
        if (!memberIds.includes(wrappedBy) || !sameIds(memberIds, wrappedKeys.map((k) => k.userId))) return 'stale';
        await tx.query(
          `UPDATE webchat.conversations
           SET key_id = $2, created_by = CASE WHEN type = 'group' THEN COALESCE(created_by, $3) ELSE created_by END
           WHERE id = $1`,
          [conversationId, keyId, wrappedBy],
        );
        await insertWrappedKeys(tx, conversationId, wrappedBy, wrappedKeys);
        return true;
      });
    },
    /** A chat's current key id, and whether someone who holds that key left. */
    conversationKey: async (conversationId: number) =>
      (await one(
        sql.query<{ key_id: string | null; needs_new_key: boolean }>(
          'SELECT key_id, needs_new_key FROM webchat.conversations WHERE id = $1',
          [conversationId],
        ),
      )) ?? { key_id: null, needs_new_key: false },
    /** Creates a project with its members and its #general channel, keyed for every member. */
    createProject(
      name: string,
      createdBy: number,
      memberIds: number[],
      key: FirstChatKeyInput,
    ): Promise<{ projectId: number; channelId: number }> {
      const now = Date.now();
      return sql.transaction(async (tx) => {
        const project = (await one(
          tx.query<{ id: number }>(
            'INSERT INTO webchat.projects (name, created_by, created_at) VALUES ($1, $2, $3) RETURNING id',
            [name, createdBy, now],
          ),
        ))!;
        for (const userId of memberIds) {
          await tx.query(
            'INSERT INTO webchat.project_members (project_id, user_id, added_by, joined_at) VALUES ($1, $2, $3, $4)',
            [project.id, userId, createdBy, now],
          );
        }
        const channelId = (await insertChannel(tx, project.id, 'general', memberIds, { ...key, wrappedBy: createdBy }))!;
        return { projectId: project.id, channelId };
      });
    },

    /**
     * Adds a channel to a project. Its key must be wrapped for exactly the project's members at
     * this moment, so a member added meanwhile cannot be left out. An id below #general's would
     * make it #general, which pages tell by the lowest id (D-081, D-111).
     */
    createChannel(
      projectId: number,
      title: string,
      createdBy: number,
      key: FirstChatKeyInput,
    ): Promise<number | ProjectChangeRefusal> {
      return sql.transaction(async (tx) => {
        const { memberIds } = await lockProject(tx, projectId);
        if (!sameIds(memberIds, key.wrappedKeys.map((k) => k.userId))) return 'stale';
        if (key.conversationId < Math.min(...(await projectChannels(tx, projectId)).map((c) => c.id))) return 'stale';
        return (await insertChannel(tx, projectId, title, memberIds, { ...key, wrappedBy: createdBy })) ?? 'name_taken';
      });
    },

    /**
     * Deletes a channel for everyone, with its messages, keys and repository links. Never #general,
     * the project's first channel, whose key opens its docs and board (D-081). It takes the
     * project's lock, as adding or removing people does, since they must bring a key for every
     * channel there is.
     */
    deleteChannel(projectId: number, conversationId: number): Promise<true | 'not_found' | 'general'> {
      return sql.transaction(async (tx) => {
        await lockProject(tx, projectId);
        const ids = (await projectChannels(tx, projectId)).map((c) => c.id);
        if (!ids.includes(conversationId)) return 'not_found';
        if (conversationId === Math.min(...ids)) return 'general';
        await tx.query('DELETE FROM webchat.conversations WHERE id = $1', [conversationId]);
        return true;
      });
    },

    /**
     * Adds people to a project and to every channel in it. Each channel's key must come wrapped for
     * them, so they can read its history. Their read pointers start at the newest message, so that
     * history does not count as unread.
     */
    addProjectMembers(
      projectId: number,
      addedBy: number,
      userIds: number[],
      channelKeys: SharedChannelKey[],
    ): Promise<true | ProjectChangeRefusal> {
      const now = Date.now();
      return sql.transaction(async (tx) => {
        const { memberIds } = await lockProject(tx, projectId);
        // Removed meanwhile: the copies they wrapped would come from someone outside the project.
        if (!memberIds.includes(addedBy)) return 'stale';
        if (userIds.some((id) => memberIds.includes(id))) return 'already_member';
        const channels = await tx.query<{ id: number; key_id: string | null; last_message_id: number }>(
          'SELECT id, key_id, last_message_id FROM webchat.conversations WHERE project_id = $1',
          [projectId],
        );
        const keyFor = new Map(channelKeys.map((k) => [k.conversationId, k]));
        if (channels.length !== keyFor.size || channels.some((c) => keyFor.get(c.id)?.keyId !== c.key_id)) return 'stale';

        for (const userId of userIds) {
          await tx.query(
            'INSERT INTO webchat.project_members (project_id, user_id, added_by, joined_at) VALUES ($1, $2, $3, $4)',
            [projectId, userId, addedBy, now],
          );
          for (const channel of channels) {
            await tx.query(
              `INSERT INTO webchat.members (conversation_id, user_id, joined_at, last_delivered_id, last_read_id)
               VALUES ($1, $2, $3, $4, $4)`,
              [channel.id, userId, now, channel.last_message_id],
            );
          }
        }
        for (const channel of channels) await insertWrappedKeys(tx, channel.id, addedBy, keyFor.get(channel.id)!.wrappedKeys);
        return true;
      });
    },

    /**
     * Removes someone from a project and from every channel in it. Each channel gets a new key from
     * the member removing them, wrapped for exactly the people who stay, so the person removed
     * cannot read what is sent next. Stale when that person is gone already, or a key changed.
     */
    removeProjectMember(
      projectId: number,
      removedBy: number,
      userId: number,
      channelKeys: RotatedChannelKeyInput[],
    ): Promise<true | ProjectChangeRefusal> {
      return sql.transaction(async (tx) => {
        const { memberIds } = await lockProject(tx, projectId);
        const staying = memberIds.filter((id) => id !== userId);
        if (staying.length === memberIds.length) return 'stale';
        const channels = await projectChannels(tx, projectId);
        const keyFor = new Map(channelKeys.map((k) => [k.conversationId, k]));
        if (channels.length !== keyFor.size) return 'stale';
        for (const channel of channels) if (!(await canReplace(tx, channel, keyFor.get(channel.id), staying))) return 'stale';

        await tx.query('DELETE FROM webchat.project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
        for (const channel of channels) {
          await tx.query('DELETE FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [channel.id, userId]);
          await replaceKey(tx, channel.id, removedBy, keyFor.get(channel.id)!);
        }
        return true;
      });
    },

    /**
     * Takes someone out of a project and every channel in it, at their own request. The owner must
     * hand it over first, so a project always has an owner among its members.
     */
    leaveProject(projectId: number, userId: number): Promise<true | ProjectChangeRefusal> {
      return sql.transaction(async (tx) => {
        const { ownerId, memberIds } = await lockProject(tx, projectId);
        if (!memberIds.includes(userId)) return 'stale';
        if (ownerId === userId) return 'owner';
        await tx.query('DELETE FROM webchat.project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
        for (const channel of await projectChannels(tx, projectId)) await leaveChat(tx, channel.id, userId);
        return true;
      });
    },

    /** Makes another member the owner. False unless the caller still owns the project and the other person is in it. */
    handOverProject(projectId: number, ownerId: number, newOwnerId: number): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const project = await lockProject(tx, projectId);
        if (project.ownerId !== ownerId || !project.memberIds.includes(newOwnerId)) return false;
        await tx.query('UPDATE webchat.projects SET created_by = $2 WHERE id = $1', [projectId, newOwnerId]);
        return true;
      });
    },

    /** Deletes a project for everyone. Its channels, their messages and their keys go with it. */
    deleteProject: async (projectId: number) => {
      await sql.query('DELETE FROM webchat.projects WHERE id = $1', [projectId]);
    },

    projectsFor: (userId: number) => projects(userId, null),
    projectFor: async (userId: number, projectId: number) => (await projects(userId, projectId))[0],
    getProject: (projectId: number) =>
      one(sql.query<ProjectRow>('SELECT * FROM webchat.projects WHERE id = $1', [projectId])),
    isProjectMember: async (projectId: number, userId: number) =>
      (
        await sql.query('SELECT 1 FROM webchat.project_members WHERE project_id = $1 AND user_id = $2', [
          projectId,
          userId,
        ])
      ).length > 0,

    projectRepos: async (projectId: number) =>
      (
        await sql.query<ProjectRepoRow>(
          `SELECT repo_id, repo, conversation_id, added_by, added_at FROM webchat.project_repos
           WHERE project_id = $1 ORDER BY lower(repo)`,
          [projectId],
        )
      ).map(toProjectRepoDTO),

    /**
     * Links a repository someone reaches through the GitHub App to a project, or moves its link to
     * another channel. Refused when the channel is not one of the project's, or the project links
     * as many repositories as it may.
     */
    linkProjectRepo(projectId: number, grant: GithubRepoGrant, conversationId: number, addedBy: number) {
      return sql.transaction(async (tx): Promise<true | 'no_channel' | 'too_many'> => {
        await lockProject(tx, projectId);
        const channel = await tx.query('SELECT 1 FROM webchat.conversations WHERE id = $1 AND project_id = $2', [
          conversationId,
          projectId,
        ]);
        if (channel.length === 0) return 'no_channel';
        const others = await one(
          tx.query<{ count: number }>(
            'SELECT COUNT(*)::int AS count FROM webchat.project_repos WHERE project_id = $1 AND repo_id <> $2',
            [projectId, grant.repoId],
          ),
        );
        if ((others?.count ?? 0) >= LIMITS.reposPerProject) return 'too_many';
        await tx.query(
          `INSERT INTO webchat.project_repos (project_id, repo_id, repo, installation_id, conversation_id, added_by, added_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (project_id, repo_id) DO UPDATE SET
             repo = EXCLUDED.repo, installation_id = EXCLUDED.installation_id, conversation_id = EXCLUDED.conversation_id`,
          [projectId, grant.repoId, grant.repo, grant.installationId, conversationId, addedBy, Date.now()],
        );
        return true;
      });
    },
    unlinkProjectRepo: async (projectId: number, repoId: number) => {
      await sql.query('DELETE FROM webchat.project_repos WHERE project_id = $1 AND repo_id = $2', [projectId, repoId]);
    },

    /** Replaces the repositories someone may link with the ones they just showed GitHub they reach. */
    saveGithubGrants: (userId: number, grants: GithubRepoGrant[]) =>
      sql.transaction(async (tx) => {
        await tx.query('DELETE FROM webchat.github_app_grants WHERE user_id = $1', [userId]);
        const expiresAt = Date.now() + GRANT_TTL_MS;
        for (const g of grants) {
          await tx.query(
            `INSERT INTO webchat.github_app_grants (user_id, repo_id, repo, installation_id, expires_at)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, repo_id) DO NOTHING`,
            [userId, g.repoId, g.repo, g.installationId, expiresAt],
          );
        }
      }),
    /** The repositories someone may link now, without the ones this project links already. */
    githubChoices: async (userId: number, projectId: number): Promise<RepoChoiceDTO[]> =>
      (
        await sql.query<{ repo_id: number; repo: string }>(
          `SELECT g.repo_id, g.repo FROM webchat.github_app_grants g
           WHERE g.user_id = $1 AND g.expires_at > $2
             AND NOT EXISTS (SELECT 1 FROM webchat.project_repos r WHERE r.project_id = $3 AND r.repo_id = g.repo_id)
           ORDER BY lower(g.repo)`,
          [userId, Date.now(), projectId],
        )
      ).map((row) => ({ repoId: row.repo_id, repo: row.repo })),
    githubGrant: async (userId: number, repoId: number): Promise<GithubRepoGrant | undefined> => {
      const row = await one(
        sql.query<{ repo_id: number; repo: string; installation_id: number }>(
          'SELECT repo_id, repo, installation_id FROM webchat.github_app_grants WHERE user_id = $1 AND repo_id = $2 AND expires_at > $3',
          [userId, repoId, Date.now()],
        ),
      );
      return row && { repoId: row.repo_id, repo: row.repo, installationId: row.installation_id };
    },

    /** The channels that link a repository. Its name is brought up to date first, as GitHub names it now. */
    async githubChannelsFor(repoId: number, repo: string): Promise<number[]> {
      await sql.query('UPDATE webchat.project_repos SET repo = $2 WHERE repo_id = $1 AND repo <> $2', [repoId, repo]);
      return (
        await sql.query<{ conversation_id: number }>(
          'SELECT DISTINCT conversation_id FROM webchat.project_repos WHERE repo_id = $1',
          [repoId],
        )
      ).map((row) => row.conversation_id);
    },
    /** Forgets links and grants through an installation, or only for some of its repositories. */
    async dropGithubInstallation(installationId: number, repoIds: number[] | null = null) {
      for (const table of ['project_repos', 'github_app_grants']) {
        await sql.query(
          `DELETE FROM webchat.${table} WHERE installation_id = $1 AND ($2::bigint[] IS NULL OR repo_id = ANY($2::bigint[]))`,
          [installationId, repoIds],
        );
      }
    },
    /** True the first time a webhook delivery comes in. GitHub may send the same one again. */
    claimGithubDelivery: async (deliveryId: string) =>
      (
        await sql.query(
          'INSERT INTO webchat.github_deliveries (id, received_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
          [deliveryId, Date.now()],
        )
      ).length > 0,
    releaseGithubDelivery: async (deliveryId: string) => {
      await sql.query('DELETE FROM webchat.github_deliveries WHERE id = $1', [deliveryId]);
    },

    conversationsFor: (userId: number) => conversations(userId, null),
    conversationFor: async (userId: number, conversationId: number) => (await conversations(userId, conversationId))[0],
    getConversation: (conversationId: number) =>
      one(
        sql.query<{ type: ConversationType; created_by: number | null; project_id: number | null }>(
          'SELECT type, created_by, project_id FROM webchat.conversations WHERE id = $1',
          [conversationId],
        ),
      ),

    /**
     * Adds people to a group. Its key, if it has one, must come wrapped for them by the member
     * adding them, so they can read its history. Their read pointers start at the newest message,
     * so that history does not count as unread. Stale when the key changed since the client looked,
     * or the member adding them was removed meanwhile.
     */
    addGroupMembers(
      conversationId: number,
      addedBy: number,
      userIds: number[],
      key: { keyId: string; wrappedKeys: WrappedKeyInput[] } | null,
    ): Promise<true | 'stale' | 'already_member'> {
      const now = Date.now();
      return sql.transaction(async (tx) => {
        const chat = await one(
          tx.query<{ key_id: string | null; last_message_id: number }>(
            'SELECT key_id, last_message_id FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        const memberIds = (
          await tx.query<{ user_id: number }>('SELECT user_id FROM webchat.members WHERE conversation_id = $1', [
            conversationId,
          ])
        ).map((row) => row.user_id);
        if (!chat || !memberIds.includes(addedBy) || chat.key_id !== (key?.keyId ?? null)) return 'stale';
        if (userIds.some((id) => memberIds.includes(id))) return 'already_member';

        for (const userId of userIds) {
          await tx.query(
            `INSERT INTO webchat.members (conversation_id, user_id, joined_at, last_delivered_id, last_read_id)
             VALUES ($1, $2, $3, $4, $4)`,
            [conversationId, userId, now, chat.last_message_id],
          );
        }
        if (key) await insertWrappedKeys(tx, conversationId, addedBy, key.wrappedKeys);
        return true;
      });
    },

    /**
     * Removes someone from a group. A group with a key gets a new one from the member removing
     * them, wrapped for exactly the people who stay. Returns false when the group changed since the
     * client looked, such as that person being gone already.
     */
    removeGroupMember(
      conversationId: number,
      removedBy: number,
      userId: number,
      key: RotatedKeyInput | null,
    ): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const chat = await one(
          tx.query<{ id: number; key_id: string | null }>(
            'SELECT id, key_id FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        const memberIds = await chatMembers(tx, conversationId);
        const staying = memberIds.filter((id) => id !== userId);
        if (!chat || staying.length === memberIds.length) return false;
        // A group from before encryption has no key to replace.
        if (chat.key_id === null ? key !== null : !(await canReplace(tx, chat, key ?? undefined, staying))) return false;

        await tx.query('DELETE FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
        if (key) await replaceKey(tx, conversationId, removedBy, key);
        return true;
      });
    },

    /** Takes someone out of a group at their own request. The owner must hand it over first. */
    leaveGroup(conversationId: number, userId: number): Promise<true | LeaveRefusal> {
      return sql.transaction(async (tx) => {
        const chat = await one(
          tx.query<{ type: ConversationType; created_by: number | null }>(
            'SELECT type, created_by FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        const memberIds = await chatMembers(tx, conversationId);
        if (chat?.type !== 'group' || !memberIds.includes(userId)) return 'stale';
        if (chat.created_by === userId) return 'owner';
        if (memberIds.length === 1) return 'last_member';
        await leaveChat(tx, conversationId, userId);
        return true;
      });
    },

    /**
     * Makes another member the group's owner. False unless the caller still owns it, or it has no
     * owner yet, and the other person is in it.
     */
    handOverGroup(conversationId: number, ownerId: number, newOwnerId: number): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const chat = await one(
          tx.query<{ type: ConversationType; created_by: number | null }>(
            'SELECT type, created_by FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        const owns = chat?.type === 'group' && (chat.created_by === null || chat.created_by === ownerId);
        if (!owns || !(await chatMembers(tx, conversationId)).includes(newOwnerId)) return false;
        await tx.query('UPDATE webchat.conversations SET created_by = $2 WHERE id = $1', [conversationId, newOwnerId]);
        return true;
      });
    },

    /**
     * Replaces the key of a chat that someone left with a new key from a member who stays. False
     * when the chat needs no new key, or its members or key changed since the client looked.
     */
    replaceConversationKey(conversationId: number, replacedBy: number, key: RotatedKeyInput): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const projectId =
          (
            await one(
              tx.query<{ project_id: number | null }>('SELECT project_id FROM webchat.conversations WHERE id = $1', [
                conversationId,
              ]),
            )
          )?.project_id ?? null;
        // A channel's members are its project's, so lock the project first, as every change to them does.
        if (projectId !== null) await lockProject(tx, projectId);
        const chat = await one(
          tx.query<{ id: number; key_id: string | null; needs_new_key: boolean }>(
            'SELECT id, key_id, needs_new_key FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        if (!chat?.needs_new_key || !(await canReplace(tx, chat, key, await chatMembers(tx, conversationId)))) return false;
        await replaceKey(tx, conversationId, replacedBy, key);
        return true;
      });
    },

    /** Deletes a chat for everyone, with its messages and keys. */
    deleteConversation: async (conversationId: number) => {
      await sql.query('DELETE FROM webchat.conversations WHERE id = $1', [conversationId]);
    },
    memberIds: (conversationId: number) => chatMembers(sql, conversationId),
    isMember: async (conversationId: number, userId: number) =>
      (
        await sql.query('SELECT 1 FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [
          conversationId,
          userId,
        ])
      ).length > 0,

    /**
     * Stores an encrypted message, moves the chat to the top, and marks it read for its sender. A
     * reaction only bumps the chat's newest event, so it neither reorders chats nor counts as unread.
     * A client id the sender used before in this chat is the same send again, after its answer was
     * lost: nothing changes, and `repeated` says so (D-061).
     */
    insertMessage(
      conversationId: number,
      senderId: number,
      kind: Exclude<MessageKind, 'github'>,
      envelope: EnvelopeDTO,
      urgent: boolean,
      clientId: string,
    ) {
      return sql.transaction(async (tx): Promise<{ message: MessageDTO; repeated: boolean }> => {
        const now = Date.now();
        const row = await one(
          tx.query<MessageRow>(
            `INSERT INTO webchat.messages (conversation_id, sender_id, kind, body, envelope, urgent, client_id, created_at)
             VALUES ($1, $2, $3, '', $4, $5, $6, $7)
             ON CONFLICT (conversation_id, sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING *`,
            [conversationId, senderId, kind, JSON.stringify(envelope), urgent, clientId, now],
          ),
        );
        if (!row) {
          const stored = (await one(
            tx.query<MessageRow>('SELECT * FROM webchat.messages WHERE conversation_id = $1 AND sender_id = $2 AND client_id = $3', [
              conversationId,
              senderId,
              clientId,
            ]),
          ))!;
          return { message: toMessageDTO(stored), repeated: true };
        }
        if (kind === 'message') {
          await tx.query(
            `UPDATE webchat.conversations
             SET last_message_id = GREATEST(last_message_id, $1), last_event_id = GREATEST(last_event_id, $1), updated_at = $2
             WHERE id = $3`,
            [row.id, now, conversationId],
          );
          await markRead(tx, conversationId, senderId, row.id);
        } else {
          await tx.query('UPDATE webchat.conversations SET last_event_id = GREATEST(last_event_id, $1) WHERE id = $2', [
            row.id,
            conversationId,
          ]);
        }
        return { message: toMessageDTO(row), repeated: false };
      });
    },
    /** Stores a card from GitHub, as plain JSON with no sender, and moves the chat to the top like a message. */
    insertGithubCard(conversationId: number, card: string) {
      return sql.transaction(async (tx) => {
        const now = Date.now();
        const row = (await one(
          tx.query<MessageRow>(
            `INSERT INTO webchat.messages (conversation_id, sender_id, kind, body, envelope, urgent, client_id, created_at)
             VALUES ($1, NULL, 'github', $2, NULL, false, NULL, $3) RETURNING *`,
            [conversationId, card, now],
          ),
        ))!;
        await tx.query(
          `UPDATE webchat.conversations
           SET last_message_id = GREATEST(last_message_id, $1), last_event_id = GREATEST(last_event_id, $1), updated_at = $2
           WHERE id = $3`,
          [row.id, now, conversationId],
        );
        return toMessageDTO(row);
      });
    },
    messagesBefore: async (conversationId: number, beforeId: number, limit: number) =>
      (
        await sql.query<MessageRow>(
          'SELECT * FROM webchat.messages WHERE conversation_id = $1 AND id < $2::bigint ORDER BY id DESC LIMIT $3',
          [conversationId, beforeId, limit],
        )
      )
        .reverse()
        .map(toMessageDTO),

    /** Moves the read pointer forward, never past the newest message. */
    async markRead(conversationId: number, userId: number, messageId: number) {
      const newest = await one(
        sql.query<{ last_message_id: number }>('SELECT last_message_id FROM webchat.conversations WHERE id = $1', [
          conversationId,
        ]),
      );
      return markRead(sql, conversationId, userId, Math.min(messageId, newest?.last_message_id ?? 0));
    },

    /**
     * Marks messages from others as delivered to this user, per chat, up to the given ids but never
     * past the chat's newest event. The service worker sends these ids, so a client could send any.
     */
    async markDelivered(userId: number, upTo: Map<number, number>) {
      for (const [conversationId, messageId] of upTo) {
        await sql.query(
          `UPDATE webchat.members m SET last_delivered_id = LEAST($1, c.last_event_id)
           FROM webchat.conversations c
           WHERE c.id = m.conversation_id AND m.conversation_id = $2 AND m.user_id = $3
             AND m.last_delivered_id < LEAST($1, c.last_event_id)`,
          [messageId, conversationId, userId],
        );
      }
    },

    unreadTotal: async (userId: number) =>
      (
        await one(
          sql.query<{ total: number }>(
            `SELECT COUNT(*)::int AS total FROM webchat.messages x
             JOIN webchat.members m ON m.conversation_id = x.conversation_id
             WHERE m.user_id = $1 AND x.id > m.last_read_id AND x.sender_id IS DISTINCT FROM $1 AND x.kind <> 'reaction'`,
            [userId],
          ),
        )
      )?.total ?? 0,

    /**
     * One cheap query that changes whenever anything this user sees changes: a new message or
     * reaction, a read or delivered pointer, a new or deleted chat, channel or project, someone
     * joining or leaving one of them, a new key, a new owner, a new person, someone coming online
     * or going offline, a doc saved, added or deleted, or a doc section locked or freed.
     */
    async stamp(userId: number): Promise<string> {
      const row = await one(
        sql.query<{
          messages: number;
          pointers: number;
          chats: number;
          seats: number;
          keyed: number;
          rekeyed: number;
          owners: string;
          people: number;
          withKeys: number;
          online: string | null;
          agents: string | null;
          repos: string | null;
          docs: string;
          locks: string;
        }>(
          `WITH mine AS (SELECT conversation_id FROM webchat.members WHERE user_id = $1)
           SELECT
             (SELECT COALESCE(SUM(last_event_id), 0) FROM webchat.conversations WHERE id IN (SELECT * FROM mine)) AS messages,
             (SELECT COUNT(*)::int FROM webchat.conversations
               WHERE id IN (SELECT * FROM mine) AND key_id IS NOT NULL) AS keyed,
             (SELECT COUNT(*)::int FROM webchat.users WHERE dh_public IS NOT NULL) AS "withKeys",
             -- BIGINT, so two INTEGER pointers near the top of their range cannot overflow the sum.
             (SELECT COALESCE(SUM(last_read_id::bigint + last_delivered_id), 0) FROM webchat.members
               WHERE conversation_id IN (SELECT * FROM mine)) AS pointers,
             (SELECT COUNT(*)::int FROM mine) AS chats,
             -- Join times rather than a count, so one person leaving and another joining between
             -- two check-ins still changes it.
             (SELECT COALESCE(SUM(joined_at), 0)::bigint FROM webchat.members
               WHERE conversation_id IN (SELECT * FROM mine)) AS seats,
             -- Links are only ever added, one per new key, so their times change with every rotation.
             (SELECT COALESCE(SUM(created_at), 0)::bigint FROM webchat.key_links
               WHERE conversation_id IN (SELECT * FROM mine)) AS rekeyed,
             -- A hash of who owns each project and group, so a handover always shows, even two at once.
             (SELECT md5(COALESCE(string_agg(pair, ',' ORDER BY pair), '')) FROM (
               SELECT 'c' || id || ':' || created_by AS pair FROM webchat.conversations
                 WHERE id IN (SELECT * FROM mine) AND created_by IS NOT NULL
               UNION ALL
               SELECT 'p' || p.id || ':' || p.created_by FROM webchat.projects p
                 JOIN webchat.project_members pm ON pm.project_id = p.id WHERE pm.user_id = $1
             ) owned) AS owners,
             (SELECT COUNT(*)::int FROM webchat.users) AS people,
             (SELECT string_agg(id::text, ',' ORDER BY id) FROM webchat.users WHERE last_active_at > $2) AS online,
             -- Agents with their owners, so the board offers each owner theirs (K-45), and what their laptops can do (R-036).
             (SELECT md5(string_agg(id || ':' || agent_owner || ':' || protocol, ',' ORDER BY id)) FROM webchat.users WHERE agent_owner IS NOT NULL) AS agents,
             -- Each agent's sessions by repository: which exist, which are online, and what they can do (D-094, D-103).
             (SELECT md5(string_agg(user_id || ':' || repo || ':' || protocol || ':' || (last_seen > $2), ',' ORDER BY user_id, repo))
               FROM webchat.agent_repos) AS repos,
             -- Every save grows a doc's version, and a doc deleted leaves the list.
             (SELECT md5(COALESCE(string_agg(id || ':' || version, ',' ORDER BY id), '')) FROM webchat.docs
               WHERE conversation_id IN (SELECT * FROM mine)) AS docs,
             -- Who edits which section, while the lock lasts.
             (SELECT md5(COALESCE(string_agg(l.doc_id || ':' || l.section || ':' || l.user_id, ',' ORDER BY l.doc_id, l.section), ''))
               FROM webchat.doc_locks l JOIN webchat.docs d ON d.id = l.doc_id
               WHERE d.conversation_id IN (SELECT * FROM mine) AND l.expires_at > $3) AS locks`,
          [userId, Date.now() - ONLINE_WINDOW_MS, Date.now()],
        ),
      );
      return row
        ? `${row.messages}.${row.pointers}.${row.chats}.${row.seats}.${row.keyed}.${row.rekeyed}.${row.owners}.${row.people}.${row.withKeys}.${row.online ?? ''}.${row.agents ?? ''}.${row.repos ?? ''}.${row.docs}.${row.locks}`
        : '';
    },

    /**
     * Messages in the user's chats after the cursor, plus recent ones as an overlap, at most
     * SYNC_PAGE_SIZE. Rows after the cursor come first, so a busy overlap never crowds them out.
     */
    messagesSince: async (userId: number, cursor: number) =>
      (
        await sql.query<MessageRow>(
          `SELECT msg.* FROM webchat.messages msg
           JOIN webchat.members m ON m.conversation_id = msg.conversation_id AND m.user_id = $1
           WHERE msg.id > $2::bigint OR msg.created_at > $3
           ORDER BY msg.id > $2::bigint DESC, msg.id LIMIT ${SYNC_PAGE_SIZE}`,
          [userId, cursor, Date.now() - SYNC_OVERLAP_MS],
        )
      )
        .sort((a, b) => a.id - b.id)
        .map(toMessageDTO),

    /** Each chat's newest urgent message from someone else above the user's read pointer (D-078). */
    unreadUrgent: async (userId: number) =>
      (
        await sql.query<MessageRow>(
          `SELECT DISTINCT ON (msg.conversation_id) msg.* FROM ${unreadUrgentFrom('$2::bigint')} AND m.user_id = $1
           ORDER BY msg.conversation_id, msg.id DESC`,
          [userId, Date.now()],
        )
      )
        .sort((a, b) => a.id - b.id)
        .map(toMessageDTO),

    /** For every member, the newest urgent message of each chat they have not read: what rings again (D-079). */
    urgentRings: async () =>
      (
        await sql.query<MessageRow & { recipient_id: number }>(
          `SELECT DISTINCT ON (m.user_id, msg.conversation_id) m.user_id AS recipient_id, msg.*
           FROM ${unreadUrgentFrom('$1::bigint')}
           ORDER BY m.user_id, msg.conversation_id, msg.id DESC`,
          [Date.now()],
        )
      ).map((row) => ({ recipientId: row.recipient_id, message: toMessageDTO(row) })),

    latestMessageId: async (userId: number) =>
      (
        await one(
          sql.query<{ id: number }>(
            `SELECT COALESCE(MAX(c.last_event_id), 0) AS id FROM webchat.conversations c
             JOIN webchat.members m ON m.conversation_id = c.id WHERE m.user_id = $1`,
            [userId],
          ),
        )
      )?.id ?? 0,

    docsFor: (userId: number) => docs(userId, null),
    docFor: async (userId: number, docId: string) => (await docs(userId, docId))[0],
    getDoc: (docId: string) => one(sql.query<DocRow>('SELECT * FROM webchat.docs WHERE id = $1', [docId])),

    /** Stores a new doc with its title and first sections. False when its id is taken. */
    createDoc(docId: string, conversationId: number, userId: number, revisions: Array<{ section: string; envelope: EnvelopeDTO }>) {
      return sql.transaction(async (tx) => {
        const now = Date.now();
        const created = await tx.query(
          `INSERT INTO webchat.docs (id, conversation_id, created_by, created_at, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [docId, conversationId, userId, now],
        );
        if (created.length === 0) return false;
        for (const r of revisions) {
          await tx.query(
            `INSERT INTO webchat.doc_revisions (doc_id, section, author_id, envelope, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5)`,
            [docId, r.section, userId, JSON.stringify(r.envelope), now],
          );
        }
        return true;
      });
    },

    /** The newest revision of each section of a doc, the title among them. */
    docSections: async (docId: string) =>
      (
        await sql.query<DocRevisionRow>(
          'SELECT DISTINCT ON (section) * FROM webchat.doc_revisions WHERE doc_id = $1 ORDER BY section, id DESC',
          [docId],
        )
      ).map(toDocRevisionDTO),

    /** A section's revisions, newest first. */
    sectionHistory: async (docId: string, section: string) =>
      (
        await sql.query<DocRevisionRow>(
          `SELECT * FROM webchat.doc_revisions WHERE doc_id = $1 AND section = $2 ORDER BY id DESC LIMIT ${LIMITS.docHistory}`,
          [docId, section],
        )
      ).map(toDocRevisionDTO),

    /**
     * Locks a section for this user, or keeps the lock they hold, and returns who holds it now: this
     * user, or someone else whose lock has not run out.
     */
    lockSection: async (docId: string, section: string, userId: number) => {
      const now = Date.now();
      const row = await one(
        sql.query<{ user_id: number }>(
          `WITH claimed AS (
             INSERT INTO webchat.doc_locks AS l (doc_id, section, user_id, expires_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (doc_id, section) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at,
               revision_id = CASE WHEN l.user_id = EXCLUDED.user_id THEN l.revision_id END
             WHERE l.user_id = EXCLUDED.user_id OR l.expires_at <= $5
             RETURNING user_id
           )
           SELECT user_id FROM claimed
           UNION ALL
           SELECT user_id FROM webchat.doc_locks WHERE doc_id = $1 AND section = $2 AND NOT EXISTS (SELECT 1 FROM claimed)`,
          [docId, section, userId, now + DOC_LOCK_MS, now],
        ),
      );
      return row?.user_id;
    },
    unlockSection: async (docId: string, section: string, userId: number) => {
      await sql.query('DELETE FROM webchat.doc_locks WHERE doc_id = $1 AND section = $2 AND user_id = $3', [docId, section, userId]);
    },
    /** Keeps the lock of the section a tab is editing, while its user is still in the doc's chat. */
    renewSectionLock: async (userId: number, docId: string, section: string) => {
      await sql.query(
        `UPDATE webchat.doc_locks l SET expires_at = $4
         WHERE l.doc_id = $1 AND l.section = $2 AND l.user_id = $3
           AND EXISTS (SELECT 1 FROM webchat.docs d JOIN webchat.members m ON m.conversation_id = d.conversation_id
                       WHERE d.id = l.doc_id AND m.user_id = l.user_id)`,
        [docId, section, userId, Date.now() + DOC_LOCK_MS],
      );
    },

    /**
     * Saves a section for the holder of its lock. The editing session's first save adds a revision,
     * and later ones replace it, so the history keeps one revision per session. Null without the lock.
     */
    saveSection(docId: string, section: string, userId: number, envelope: EnvelopeDTO) {
      return sql.transaction(async (tx): Promise<DocRevisionDTO | null> => {
        const now = Date.now();
        const lock = await one(
          tx.query<{ revision_id: number | null }>(
            `SELECT revision_id FROM webchat.doc_locks
             WHERE doc_id = $1 AND section = $2 AND user_id = $3 AND expires_at > $4 FOR UPDATE`,
            [docId, section, userId, now],
          ),
        );
        if (!lock) return null;
        const json = JSON.stringify(envelope);
        const row = (await one(
          lock.revision_id
            ? tx.query<DocRevisionRow>('UPDATE webchat.doc_revisions SET envelope = $1, updated_at = $2 WHERE id = $3 RETURNING *', [
                json,
                now,
                lock.revision_id,
              ])
            : tx.query<DocRevisionRow>(
                `INSERT INTO webchat.doc_revisions (doc_id, section, author_id, envelope, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
                [docId, section, userId, json, now],
              ),
        ))!;
        await tx.query('UPDATE webchat.doc_locks SET revision_id = $1, expires_at = $2 WHERE doc_id = $3 AND section = $4', [
          row.id,
          now + DOC_LOCK_MS,
          docId,
          section,
        ]);
        await tx.query('UPDATE webchat.docs SET version = version + 1, updated_by = $1, updated_at = $2 WHERE id = $3', [
          userId,
          now,
          docId,
        ]);
        return toDocRevisionDTO(row);
      });
    },
    deleteDoc: async (docId: string) => {
      await sql.query('DELETE FROM webchat.docs WHERE id = $1', [docId]);
    },

    savePushSubscription: async (userId: number, endpoint: string, p256dh: string, auth: string) => {
      await sql.query(
        `INSERT INTO webchat.push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [endpoint, userId, p256dh, auth, Date.now()],
      );
    },
    deletePushSubscription: async (endpoint: string) => {
      await sql.query('DELETE FROM webchat.push_subscriptions WHERE endpoint = $1', [endpoint]);
    },
    deleteUserPushSubscription: async (endpoint: string, userId: number) => {
      await sql.query('DELETE FROM webchat.push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, userId]);
    },
    pushSubscriptionsFor: (userId: number) =>
      sql.query<PushSubscriptionRow>(
        'SELECT endpoint, user_id, p256dh, auth FROM webchat.push_subscriptions WHERE user_id = $1',
        [userId],
      ),

    barkLinkFor: (userId: number) => one(sql.query<BarkLinkRow>('SELECT * FROM webchat.bark_links WHERE user_id = $1', [userId])),
    barkLinkByToken: (token: string) => one(sql.query<BarkLinkRow>('SELECT * FROM webchat.bark_links WHERE token = $1', [token])),
    /** Makes the person's link, or keeps the one they have. */
    createBarkLink: async (userId: number, token: string, origin: string): Promise<BarkLinkRow> => {
      await sql.query(
        `INSERT INTO webchat.bark_links (user_id, token, origin, cipher_key, created_at) VALUES ($1, $2, $3, NULL, $4)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, token, origin, Date.now()],
      );
      return (await one(sql.query<BarkLinkRow>('SELECT * FROM webchat.bark_links WHERE user_id = $1', [userId])))!;
    },
    setBarkCipherKey: async (userId: number, cipherKey: string | null) => {
      await sql.query('UPDATE webchat.bark_links SET cipher_key = $2 WHERE user_id = $1', [userId, cipherKey]);
    },
    deleteBarkLink: async (userId: number) => {
      await sql.query('DELETE FROM webchat.bark_devices WHERE user_id = $1', [userId]);
      await sql.query('DELETE FROM webchat.bark_links WHERE user_id = $1', [userId]);
    },
    /**
     * Records a Bark install. The app registers again on every launch, so the same phone, found by
     * its APNs token or by the key it was given, keeps its key. A phone that moves to another
     * account leaves the old one, so only one person's alerts reach it.
     */
    registerBarkDevice: async (userId: number, deviceToken: string, key: string | null, newKey: string): Promise<BarkDeviceRow> => {
      const now = Date.now();
      await sql.query('DELETE FROM webchat.bark_devices WHERE device_token = $1 AND user_id <> $2', [deviceToken, userId]);
      const existing = await one(
        sql.query<BarkDeviceRow>(
          'SELECT * FROM webchat.bark_devices WHERE user_id = $1 AND (device_token = $2 OR device_key = $3) ORDER BY created_at LIMIT 1',
          [userId, deviceToken, key ?? ''],
        ),
      );
      if (existing) {
        await sql.query('UPDATE webchat.bark_devices SET device_token = $2, seen_at = $3 WHERE device_key = $1', [
          existing.device_key,
          deviceToken,
          now,
        ]);
        return { ...existing, device_token: deviceToken, seen_at: now };
      }
      await sql.query(
        'INSERT INTO webchat.bark_devices (device_key, user_id, device_token, created_at, seen_at) VALUES ($1, $2, $3, $4, $5)',
        [newKey, userId, deviceToken, now, now],
      );
      return { device_key: newKey, user_id: userId, device_token: deviceToken, created_at: now, seen_at: now };
    },
    barkDevicesFor: (userId: number) =>
      sql.query<BarkDeviceRow>('SELECT * FROM webchat.bark_devices WHERE user_id = $1 ORDER BY created_at', [userId]),
    deleteBarkDevice: async (deviceKey: string) => {
      await sql.query('DELETE FROM webchat.bark_devices WHERE device_key = $1', [deviceKey]);
    },

    /**
     * Links a GitHub account, replacing any linked before. The first poll after this only records
     * the pull requests, so connecting never sends a burst of alerts.
     */
    saveGithubAccount(userId: number, account: { githubId: number; login: string; name: string | null; token: string }) {
      return sql.transaction(async (tx) => {
        const previous = await one(
          tx.query<{ github_id: number }>('SELECT github_id FROM webchat.github_accounts WHERE user_id = $1', [userId]),
        );
        if (previous && previous.github_id !== account.githubId) {
          await tx.query('DELETE FROM webchat.github_events WHERE user_id = $1', [userId]);
        }
        await tx.query(
          `INSERT INTO webchat.github_accounts (user_id, github_id, login, name, token, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE SET
             github_id = EXCLUDED.github_id, login = EXCLUDED.login, name = EXCLUDED.name, token = EXCLUDED.token,
             pulls = NULL, fetched_at = NULL, polled_at = 0, error = NULL, revoked = false`,
          [userId, account.githubId, account.login, account.name, account.token, Date.now()],
        );
      });
    },
    githubAccount: (userId: number) =>
      one(sql.query<GithubAccountRow>('SELECT * FROM webchat.github_accounts WHERE user_id = $1', [userId])),
    deleteGithubAccount: (userId: number) =>
      sql.transaction(async (tx) => {
        await tx.query('DELETE FROM webchat.github_events WHERE user_id = $1', [userId]);
        await tx.query('DELETE FROM webchat.github_accounts WHERE user_id = $1', [userId]);
      }),
    setGithubNotify: async (userId: number, notify: boolean) => {
      await sql.query('UPDATE webchat.github_accounts SET notify = $2 WHERE user_id = $1', [userId, notify]);
    },
    /**
     * Claims an account for one poll, unless it was polled less than minIntervalMs ago or GitHub
     * revoked its token. Returns undefined when there is nothing to do.
     */
    claimGithubPoll: (userId: number, minIntervalMs: number) => {
      const now = Date.now();
      return one(
        sql.query<GithubAccountRow>(
          `UPDATE webchat.github_accounts SET polled_at = $2
           WHERE user_id = $1 AND NOT revoked AND polled_at <= $3 RETURNING *`,
          [userId, now, now - minIntervalMs],
        ),
      );
    },
    githubAccountsDue: async (minIntervalMs: number) =>
      (
        await sql.query<{ user_id: number }>(
          'SELECT user_id FROM webchat.github_accounts WHERE NOT revoked AND polled_at <= $1 ORDER BY polled_at',
          [Date.now() - minIntervalMs],
        )
      ).map((row) => row.user_id),
    /** Records that pollAll started, so the pane can tell whether alerts arrive with every tab closed. */
    markGithubScheduledPoll: async () => {
      await sql.query(
        'INSERT INTO webchat.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [GITHUB_SCHEDULED_AT, String(Date.now())],
      );
    },
    /** When pollAll last started, or 0 if it never has. */
    githubScheduledPollAt: async () =>
      Number(
        (await one(sql.query<{ value: string }>('SELECT value FROM webchat.meta WHERE key = $1', [GITHUB_SCHEDULED_AT])))
          ?.value ?? 0,
      ),
    jobSecret: async () =>
      (await one(sql.query<{ value: string }>('SELECT value FROM webchat.meta WHERE key = $1', [JOB_SECRET])))?.value ??
      null,
    /**
     * Makes the database call url on the job's schedule with the job secret, through Supabase Cron:
     * pg_cron keeps the clock and pg_net sends the request. A job that already matches is left
     * alone, even one the owner deactivated, so every server start can call this cheaply. Throws
     * where the extensions are missing or the role may not enable them. Returns true when it
     * scheduled the job.
     */
    scheduleJob: (job: DatabaseJob, url: string) =>
      sql.transaction(async (tx) => {
        // Instances that start at the same moment would race to create the extensions.
        await tx.query('SELECT pg_advisory_xact_lock(7349202)');
        await tx.query('INSERT INTO webchat.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [
          JOB_SECRET,
          toBase64Url(randomBytes(32)),
        ]);
        // Reading the secret on every run keeps it out of the job's text, which Supabase's Cron page shows.
        const command =
          `SELECT net.http_get(url := ${sqlLiteral(url)}, headers := jsonb_build_object('authorization', ` +
          `'Bearer ' || (SELECT value FROM webchat.meta WHERE key = ${sqlLiteral(JOB_SECRET)})), ` +
          // pg_net gives up after 2 seconds by default; a poll of every due account takes longer.
          'timeout_milliseconds := 25000)' +
          (job.when ? ` WHERE ${job.when}` : '');
        const installed = await tx.query("SELECT 1 FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net')");
        if (installed.length === 2) {
          const current = await one(
            tx.query<{ schedule: string; command: string }>('SELECT schedule, command FROM cron.job WHERE jobname = $1', [
              job.name,
            ]),
          );
          if (current?.schedule === job.schedule && current.command === command) return false;
        }
        await tx.query('CREATE EXTENSION IF NOT EXISTS pg_cron');
        // Supabase keeps extensions in their own schema. pg_net's functions still live in "net".
        await tx.query('CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions');
        await tx.query('SELECT cron.schedule($1, $2, $3)', [job.name, job.schedule, command]);
        return true;
      }),
    saveGithubPulls: async (userId: number, login: string, pulls: string) => {
      await sql.query(
        'UPDATE webchat.github_accounts SET login = $2, pulls = $3, fetched_at = $4, error = NULL WHERE user_id = $1',
        [userId, login, pulls, Date.now()],
      );
    },
    setGithubError: async (userId: number, error: string, revoked: boolean) => {
      await sql.query('UPDATE webchat.github_accounts SET error = $2, revoked = $3 WHERE user_id = $1', [
        userId,
        error,
        revoked,
      ]);
    },
    /** Stores new events, drops the oldest beyond the ones kept, and returns the stored events. */
    addGithubEvents(userId: number, events: Array<Omit<GithubEventDTO, 'id' | 'createdAt'>>) {
      return sql.transaction(async (tx) => {
        const now = Date.now();
        const added: GithubEventDTO[] = [];
        for (const e of events) {
          const row = await one(
            tx.query<GithubEventRow>(
              `INSERT INTO webchat.github_events (user_id, kind, repo, number, title, url, actor, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
              [userId, e.kind, e.repo, e.number, e.title, e.url, e.actor, now],
            ),
          );
          added.push(toGithubEventDTO(row!));
        }
        await tx.query(
          `DELETE FROM webchat.github_events WHERE user_id = $1 AND id NOT IN (
             SELECT id FROM webchat.github_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2)`,
          [userId, GITHUB_EVENTS_KEPT],
        );
        return added;
      });
    },
    githubEvents: async (userId: number) =>
      (
        await sql.query<GithubEventRow>('SELECT * FROM webchat.github_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [
          userId,
          GITHUB_EVENTS_KEPT,
        ])
      ).map(toGithubEventDTO),
  };
}
