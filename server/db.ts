import type {
  AccountKeysInput,
  ConversationDTO,
  ConversationType,
  EnvelopeDTO,
  GithubEventDTO,
  GithubEventKind,
  MemberState,
  MessageDTO,
  MessageKind,
  ProjectDTO,
  SealedBackupDTO,
  UserDTO,
  WrappedKeyInput,
} from '../shared/types.js';
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

// Changes to tables that already exist. Each runs once, in order; webchat.meta's schema_version
// row records how many have run.
const MIGRATIONS = [
  // 1: end-to-end encryption.
  `
-- 1: password_hash covers the raw password (accounts from before encryption).
-- 2: it covers a login key the browser derives from the password; the server never sees the password.
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS dh_public TEXT;
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS sign_public TEXT;
-- The user's private keys, encrypted with a key only their password can derive.
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS key_backup TEXT;
ALTER TABLE webchat.conversations ADD COLUMN IF NOT EXISTS key_id TEXT;
ALTER TABLE webchat.messages ADD COLUMN IF NOT EXISTS envelope TEXT;
-- Each chat's key, encrypted separately for every member.
CREATE TABLE IF NOT EXISTS webchat.conversation_keys (
  conversation_id INTEGER NOT NULL REFERENCES webchat.conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  wrapped_by      INTEGER NOT NULL REFERENCES webchat.users(id),
  iv              TEXT NOT NULL,
  wrapped         TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
`,
  // 2: GitHub connector.
  `
CREATE TABLE IF NOT EXISTS webchat.github_accounts (
  user_id    INTEGER PRIMARY KEY REFERENCES webchat.users(id) ON DELETE CASCADE,
  github_id  BIGINT NOT NULL,
  login      TEXT NOT NULL,
  name       TEXT,
  -- The OAuth token, encrypted with a key derived from GITHUB_CLIENT_SECRET, which the database never holds.
  token      TEXT NOT NULL,
  notify     BOOLEAN NOT NULL DEFAULT true,
  -- The pull requests from the last poll, as JSON. The next poll compares against them.
  pulls      TEXT,
  fetched_at BIGINT,
  -- Set when a poll starts, so server instances never poll one account at the same time.
  polled_at  BIGINT NOT NULL DEFAULT 0,
  error      TEXT,
  -- GitHub refused the token. Polling stops until the user connects again.
  revoked    BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS webchat.github_events (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  actor      TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_events_by_user ON webchat.github_events (user_id, id);
`,
  // 3: projects with channels, replies and reactions.
  `
CREATE TABLE IF NOT EXISTS webchat.projects (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES webchat.users(id),
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS webchat.project_members (
  project_id INTEGER NOT NULL REFERENCES webchat.projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  added_by   INTEGER REFERENCES webchat.users(id),
  joined_at  BIGINT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_by_user ON webchat.project_members (user_id);
-- A channel is a chat inside a project. Every project member is a member of every channel in it.
ALTER TABLE webchat.conversations ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES webchat.projects(id) ON DELETE CASCADE;
ALTER TABLE webchat.conversations DROP CONSTRAINT IF EXISTS conversations_type_check;
ALTER TABLE webchat.conversations ADD CONSTRAINT conversations_type_check CHECK (type IN ('direct', 'group', 'channel'));
CREATE UNIQUE INDEX IF NOT EXISTS channels_name_key ON webchat.conversations (project_id, lower(title)) WHERE type = 'channel';
-- Newest row of any kind, so sync notices reactions. last_message_id stays the newest real message.
ALTER TABLE webchat.conversations ADD COLUMN IF NOT EXISTS last_event_id INTEGER NOT NULL DEFAULT 0;
UPDATE webchat.conversations SET last_event_id = last_message_id;
-- A reaction's target message and emoji are inside its envelope; the server sees only that one happened.
ALTER TABLE webchat.messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'reaction'));
`,
  // 4: removing people from projects and groups, and deleting them.
  `
-- The person who made a group, the only one who can remove people from it or delete it. Every copy
-- of a group's key was wrapped by them (or, for a group from before encryption, by whoever set its
-- key), so the copies name the owner of each group made before this column existed.
ALTER TABLE webchat.conversations ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES webchat.users(id);
UPDATE webchat.conversations c
SET created_by = (SELECT MIN(k.wrapped_by) FROM webchat.conversation_keys k WHERE k.conversation_id = c.id)
WHERE c.type = 'group';
`,
  // 5: delivered pointers never past a chat's newest event.
  `
-- POST /api/delivered once stored any id a client sent. Pull back the pointers it pushed too far.
UPDATE webchat.members m SET last_delivered_id = c.last_event_id
FROM webchat.conversations c
WHERE c.id = m.conversation_id AND m.last_delivered_id > c.last_event_id;
`,
];

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
  my_wrapped_by: number | null;
  my_iv: string | null;
  my_wrapped: string | null;
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
  sender_id: number;
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

/** Each account keeps this many of its newest pull request events. */
const GITHUB_EVENTS_KEPT = 50;

export interface ProjectRow {
  id: number;
  name: string;
  created_by: number;
  created_at: number;
}

/** A channel key for the people being added to a project, wrapped by the member adding them. */
export interface SharedChannelKey {
  conversationId: number;
  keyId: string;
  wrappedKeys: WrappedKeyInput[];
}

/** Why a project change was refused: its members or channels changed since the client looked. */
export type ProjectChangeRefusal = 'stale' | 'name_taken' | 'already_member' | 'not_member';

export interface PushSubscriptionRow {
  endpoint: string;
  user_id: number;
  p256dh: string;
  auth: string;
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

export const keyBackupOf = (row: UserRow) =>
  row.key_backup ? (JSON.parse(row.key_backup) as SealedBackupDTO) : null;

export const isAttentive = (user: UserRow, now = Date.now()) => user.attentive_until > now;

const one = async <T>(rows: Promise<T[]>) => (await rows)[0];

const sameIds = (a: number[], b: number[]) => {
  const set = new Set(a);
  return set.size === a.length && a.length === b.length && b.every((id) => set.has(id));
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
    const [rows, members, lastMessages] = await Promise.all([
      sql.query<ConversationRow>(
        `SELECT c.id, c.type, c.title, c.project_id, c.created_by, c.updated_at, c.key_id,
           k.wrapped_by AS my_wrapped_by, k.iv AS my_iv, k.wrapped AS my_wrapped,
           (SELECT COUNT(*)::int FROM webchat.messages x
             WHERE x.conversation_id = c.id AND x.id > m.last_read_id AND x.sender_id <> m.user_id
               AND x.kind = 'message') AS unread
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
    ]);
    const membersByChat = new Map<number, MemberState[]>();
    for (const row of members) {
      const list = membersByChat.get(row.conversation_id) ?? [];
      list.push(toMemberState(row));
      membersByChat.set(row.conversation_id, list);
    }
    const lastByChat = new Map(lastMessages.map((row) => [row.conversation_id, toMessageDTO(row)]));
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      projectId: row.project_id,
      createdBy: row.created_by,
      members: membersByChat.get(row.id) ?? [],
      lastMessage: lastByChat.get(row.id) ?? null,
      unread: row.unread,
      updatedAt: row.updated_at,
      keyId: row.key_id,
      myKey:
        row.my_wrapped_by !== null && row.my_iv && row.my_wrapped
          ? { wrappedBy: row.my_wrapped_by, iv: row.my_iv, data: row.my_wrapped }
          : null,
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
      createdBy: row.created_by,
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
    key: { keyId: string; wrappedBy: number; wrappedKeys: WrappedKeyInput[] },
  ) {
    const now = Date.now();
    const created = await one(
      q.query<{ id: number }>(
        `INSERT INTO webchat.conversations (type, title, project_id, created_at, updated_at, key_id)
         VALUES ('channel', $1, $2, $3, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
        [title, projectId, now, key.keyId],
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

  /** Locks a project for a change to its members or channels, and returns its members. */
  async function lockProject(q: Querier, projectId: number) {
    await q.query('SELECT id FROM webchat.projects WHERE id = $1 FOR UPDATE', [projectId]);
    return (
      await q.query<{ user_id: number }>('SELECT user_id FROM webchat.project_members WHERE project_id = $1', [projectId])
    ).map((row) => row.user_id);
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
    purgeExpired: async () => {
      const now = Date.now();
      await sql.query('DELETE FROM webchat.sessions WHERE expires_at <= $1', [now]);
      await sql.query('DELETE FROM webchat.rate_limits WHERE window_start <= $1', [now - 24 * 3600_000]);
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
      one(sql.query<UserRow>('SELECT * FROM webchat.users WHERE lower(username) = lower($1)', [username])),
    listUsers: () => sql.query<UserRow>('SELECT * FROM webchat.users ORDER BY lower(display_name)'),

    /**
     * Records a check-in from a tab. An attentive tab claims the user's attention; when that same
     * tab stops being attentive, the claim ends at once instead of waiting for it to expire.
     */
    async checkIn(userId: number, attentive: boolean, tabId: string, endpoint: string | null) {
      const now = Date.now();
      if (attentive) {
        await sql.query(
          `UPDATE webchat.users
           SET last_active_at = $2, attentive_until = $3, attentive_tab = $4, attentive_endpoint = $5
           WHERE id = $1`,
          [userId, now, now + ATTENTION_TTL_MS, tabId, endpoint],
        );
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

    /**
     * Creates a chat with its members and its key, wrapped for each member. For a direct chat that
     * already exists, returns the existing id and ignores the new key.
     */
    createConversation(
      type: ConversationType,
      title: string | null,
      memberIds: number[],
      key: { keyId: string; wrappedBy: number; wrappedKeys: WrappedKeyInput[] },
    ): Promise<number> {
      const now = Date.now();
      const directKey = type === 'direct' ? `${Math.min(...memberIds)}:${Math.max(...memberIds)}` : null;
      return sql.transaction(async (tx) => {
        const created = await one(
          tx.query<{ id: number }>(
            `INSERT INTO webchat.conversations (type, title, direct_key, created_at, updated_at, key_id, created_by)
             VALUES ($1, $2, $3, $4, $4, $5, $6) ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
            // Only a group has an owner: the person who made it, who also wraps its key.
            [type, title, directKey, now, key.keyId, type === 'group' ? key.wrappedBy : null],
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
     * Gives a chat from before encryption its key. Only the first caller wins; returns false if the
     * chat already has one. A group without an owner becomes the caller's, as migration 4 did for
     * the groups keyed before it.
     */
    setConversationKey(conversationId: number, keyId: string, wrappedBy: number, wrappedKeys: WrappedKeyInput[]) {
      return sql.transaction(async (tx) => {
        const updated = await tx.query(
          `UPDATE webchat.conversations
           SET key_id = $2, created_by = CASE WHEN type = 'group' THEN COALESCE(created_by, $3) ELSE created_by END
           WHERE id = $1 AND key_id IS NULL RETURNING id`,
          [conversationId, keyId, wrappedBy],
        );
        if (updated.length === 0) return false;
        await insertWrappedKeys(tx, conversationId, wrappedBy, wrappedKeys);
        return true;
      });
    },
    conversationKeyId: async (conversationId: number) =>
      (
        await one(
          sql.query<{ key_id: string | null }>('SELECT key_id FROM webchat.conversations WHERE id = $1', [conversationId]),
        )
      )?.key_id ?? null,
    /** Creates a project with its members and its #general channel, keyed for every member. */
    createProject(
      name: string,
      createdBy: number,
      memberIds: number[],
      key: { keyId: string; wrappedKeys: WrappedKeyInput[] },
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
     * this moment, so a member added meanwhile cannot be left out.
     */
    createChannel(
      projectId: number,
      title: string,
      createdBy: number,
      key: { keyId: string; wrappedKeys: WrappedKeyInput[] },
    ): Promise<number | ProjectChangeRefusal> {
      return sql.transaction(async (tx) => {
        const memberIds = await lockProject(tx, projectId);
        if (!sameIds(memberIds, key.wrappedKeys.map((k) => k.userId))) return 'stale';
        return (await insertChannel(tx, projectId, title, memberIds, { ...key, wrappedBy: createdBy })) ?? 'name_taken';
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
        const memberIds = await lockProject(tx, projectId);
        // The route checked this before the lock. Check again under it: every copy below names the
        // adder as its wrapper, and pages refuse a copy that a non-member made (D-039).
        if (!memberIds.includes(addedBy)) return 'not_member';
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
     * Removes someone from a project and from every channel in it. Each channel's key must come
     * wrapped again, by the member removing them, for exactly the people who stay, so no copy left
     * was made by the person removed. Stale when that person is gone already.
     */
    removeProjectMember(
      projectId: number,
      removedBy: number,
      userId: number,
      channelKeys: SharedChannelKey[],
    ): Promise<true | ProjectChangeRefusal> {
      return sql.transaction(async (tx) => {
        const memberIds = await lockProject(tx, projectId);
        const staying = memberIds.filter((id) => id !== userId);
        if (staying.length === memberIds.length) return 'stale';
        const channels = await tx.query<{ id: number; key_id: string | null }>(
          'SELECT id, key_id FROM webchat.conversations WHERE project_id = $1',
          [projectId],
        );
        const keyFor = new Map(channelKeys.map((k) => [k.conversationId, k]));
        const covered = (channel: { id: number; key_id: string | null }) => {
          const key = keyFor.get(channel.id);
          return key !== undefined && key.keyId === channel.key_id && sameIds(staying, key.wrappedKeys.map((k) => k.userId));
        };
        if (channels.length !== keyFor.size || !channels.every(covered)) return 'stale';

        await tx.query('DELETE FROM webchat.project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
        for (const channel of channels) {
          await tx.query('DELETE FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [channel.id, userId]);
          await tx.query('DELETE FROM webchat.conversation_keys WHERE conversation_id = $1', [channel.id]);
          await insertWrappedKeys(tx, channel.id, removedBy, keyFor.get(channel.id)!.wrappedKeys);
        }
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

    conversationsFor: (userId: number) => conversations(userId, null),
    conversationFor: async (userId: number, conversationId: number) => (await conversations(userId, conversationId))[0],
    getConversation: (conversationId: number) =>
      one(
        sql.query<{ type: ConversationType; created_by: number | null }>(
          'SELECT type, created_by FROM webchat.conversations WHERE id = $1',
          [conversationId],
        ),
      ),

    /**
     * Removes someone from a group. Its key, if it has one, must come wrapped again, by the member
     * removing them, for exactly the people who stay. Returns false when the group changed since
     * the client looked, such as that person being gone already.
     */
    removeGroupMember(
      conversationId: number,
      removedBy: number,
      userId: number,
      key: { keyId: string; wrappedKeys: WrappedKeyInput[] } | null,
    ): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const chat = await one(
          tx.query<{ key_id: string | null }>('SELECT key_id FROM webchat.conversations WHERE id = $1 FOR UPDATE', [
            conversationId,
          ]),
        );
        const memberIds = (
          await tx.query<{ user_id: number }>('SELECT user_id FROM webchat.members WHERE conversation_id = $1', [
            conversationId,
          ])
        ).map((row) => row.user_id);
        const staying = memberIds.filter((id) => id !== userId);
        if (!chat || staying.length === memberIds.length || chat.key_id !== (key?.keyId ?? null)) return false;
        if (key && !sameIds(staying, key.wrappedKeys.map((k) => k.userId))) return false;

        await tx.query('DELETE FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
        await tx.query('DELETE FROM webchat.conversation_keys WHERE conversation_id = $1', [conversationId]);
        if (key) await insertWrappedKeys(tx, conversationId, removedBy, key.wrappedKeys);
        return true;
      });
    },

    /** Deletes a chat for everyone, with its messages and keys. */
    deleteConversation: async (conversationId: number) => {
      await sql.query('DELETE FROM webchat.conversations WHERE id = $1', [conversationId]);
    },
    memberIds: async (conversationId: number) =>
      (
        await sql.query<{ user_id: number }>('SELECT user_id FROM webchat.members WHERE conversation_id = $1', [
          conversationId,
        ])
      ).map((row) => row.user_id),
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
     */
    insertMessage(
      conversationId: number,
      senderId: number,
      kind: MessageKind,
      envelope: EnvelopeDTO,
      urgent: boolean,
      clientId: string,
    ) {
      return sql.transaction(async (tx) => {
        const now = Date.now();
        const row = (await one(
          tx.query<MessageRow>(
            `INSERT INTO webchat.messages (conversation_id, sender_id, kind, body, envelope, urgent, client_id, created_at)
             VALUES ($1, $2, $3, '', $4, $5, $6, $7) RETURNING *`,
            [conversationId, senderId, kind, JSON.stringify(envelope), urgent, clientId, now],
          ),
        ))!;
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
             WHERE m.user_id = $1 AND x.id > m.last_read_id AND x.sender_id <> $1 AND x.kind = 'message'`,
            [userId],
          ),
        )
      )?.total ?? 0,

    /**
     * One cheap query that changes whenever anything this user sees changes: a new message or
     * reaction, a read or delivered pointer, a new or deleted chat, channel or project, someone
     * joining or leaving one of them, a new person, or someone coming online or going offline.
     */
    async stamp(userId: number): Promise<string> {
      const row = await one(
        sql.query<{
          messages: number;
          pointers: number;
          chats: number;
          seats: number;
          keyed: number;
          people: number;
          withKeys: number;
          online: string | null;
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
             (SELECT COUNT(*)::int FROM webchat.users) AS people,
             (SELECT string_agg(id::text, ',' ORDER BY id) FROM webchat.users WHERE last_active_at > $2) AS online`,
          [userId, Date.now() - ONLINE_WINDOW_MS],
        ),
      );
      return row
        ? `${row.messages}.${row.pointers}.${row.chats}.${row.seats}.${row.keyed}.${row.people}.${row.withKeys}.${row.online ?? ''}`
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
