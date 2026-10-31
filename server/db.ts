import type {
  AccountKeysInput,
  ConversationDTO,
  ConversationType,
  EnvelopeDTO,
  MemberState,
  MessageDTO,
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
  body: string;
  envelope: string | null;
  urgent: boolean;
  client_id: string | null;
  created_at: number;
}

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

export const keyBackupOf = (row: UserRow) =>
  row.key_backup ? (JSON.parse(row.key_backup) as SealedBackupDTO) : null;

export const isAttentive = (user: UserRow, now = Date.now()) => user.attentive_until > now;

const one = async <T>(rows: Promise<T[]>) => (await rows)[0];

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
        `SELECT c.id, c.type, c.title, c.updated_at, c.key_id,
           k.wrapped_by AS my_wrapped_by, k.iv AS my_iv, k.wrapped AS my_wrapped,
           (SELECT COUNT(*)::int FROM webchat.messages x
             WHERE x.conversation_id = c.id AND x.id > m.last_read_id AND x.sender_id <> m.user_id) AS unread
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
           SELECT conversation_id FROM webchat.members WHERE user_id = $1 AND ($2::int IS NULL OR conversation_id = $2))`,
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
            `INSERT INTO webchat.conversations (type, title, direct_key, created_at, updated_at, key_id)
             VALUES ($1, $2, $3, $4, $4, $5) ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
            [type, title, directKey, now, key.keyId],
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
     * chat already has one.
     */
    setConversationKey(conversationId: number, keyId: string, wrappedBy: number, wrappedKeys: WrappedKeyInput[]) {
      return sql.transaction(async (tx) => {
        const updated = await tx.query(
          'UPDATE webchat.conversations SET key_id = $2 WHERE id = $1 AND key_id IS NULL RETURNING id',
          [conversationId, keyId],
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
    conversationsFor: (userId: number) => conversations(userId, null),
    conversationFor: async (userId: number, conversationId: number) => (await conversations(userId, conversationId))[0],
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

    /** Stores an encrypted message, moves the chat to the top, and marks it read for its sender. */
    insertMessage(conversationId: number, senderId: number, envelope: EnvelopeDTO, urgent: boolean, clientId: string) {
      return sql.transaction(async (tx) => {
        const now = Date.now();
        const row = (await one(
          tx.query<MessageRow>(
            `INSERT INTO webchat.messages (conversation_id, sender_id, body, envelope, urgent, client_id, created_at)
             VALUES ($1, $2, '', $3, $4, $5, $6) RETURNING *`,
            [conversationId, senderId, JSON.stringify(envelope), urgent, clientId, now],
          ),
        ))!;
        await tx.query(
          `UPDATE webchat.conversations SET last_message_id = GREATEST(last_message_id, $1), updated_at = $2
           WHERE id = $3`,
          [row.id, now, conversationId],
        );
        await markRead(tx, conversationId, senderId, row.id);
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

    /** Marks messages from others as delivered to this user, per chat, up to the given ids. */
    async markDelivered(userId: number, upTo: Map<number, number>) {
      for (const [conversationId, messageId] of upTo) {
        await sql.query(
          `UPDATE webchat.members SET last_delivered_id = $1
           WHERE conversation_id = $2 AND user_id = $3 AND last_delivered_id < $1`,
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
             WHERE m.user_id = $1 AND x.id > m.last_read_id AND x.sender_id <> $1`,
            [userId],
          ),
        )
      )?.total ?? 0,

    /**
     * One cheap query that changes whenever anything this user sees changes: a new message, a read
     * or delivered pointer, a new chat or person, or someone coming online or going offline.
     */
    async stamp(userId: number): Promise<string> {
      const row = await one(
        sql.query<{
          messages: number;
          pointers: number;
          chats: number;
          keyed: number;
          people: number;
          withKeys: number;
          online: string | null;
        }>(
          `WITH mine AS (SELECT conversation_id FROM webchat.members WHERE user_id = $1)
           SELECT
             (SELECT COALESCE(SUM(last_message_id), 0) FROM webchat.conversations WHERE id IN (SELECT * FROM mine)) AS messages,
             (SELECT COUNT(*)::int FROM webchat.conversations
               WHERE id IN (SELECT * FROM mine) AND key_id IS NOT NULL) AS keyed,
             (SELECT COUNT(*)::int FROM webchat.users WHERE dh_public IS NOT NULL) AS "withKeys",
             (SELECT COALESCE(SUM(last_read_id + last_delivered_id), 0) FROM webchat.members
               WHERE conversation_id IN (SELECT * FROM mine)) AS pointers,
             (SELECT COUNT(*)::int FROM mine) AS chats,
             (SELECT COUNT(*)::int FROM webchat.users) AS people,
             (SELECT string_agg(id::text, ',' ORDER BY id) FROM webchat.users WHERE last_active_at > $2) AS online`,
          [userId, Date.now() - ONLINE_WINDOW_MS],
        ),
      );
      return row
        ? `${row.messages}.${row.pointers}.${row.chats}.${row.keyed}.${row.people}.${row.withKeys}.${row.online ?? ''}`
        : '';
    },

    /** Messages in the user's chats after the cursor, plus recent ones as an overlap. */
    messagesSince: async (userId: number, cursor: number) =>
      (
        await sql.query<MessageRow>(
          `SELECT msg.* FROM webchat.messages msg
           JOIN webchat.members m ON m.conversation_id = msg.conversation_id AND m.user_id = $1
           WHERE msg.id > $2::bigint OR msg.created_at > $3
           ORDER BY msg.id LIMIT 500`,
          [userId, cursor, Date.now() - SYNC_OVERLAP_MS],
        )
      ).map(toMessageDTO),

    latestMessageId: async (userId: number) =>
      (
        await one(
          sql.query<{ id: number }>(
            `SELECT COALESCE(MAX(c.last_message_id), 0) AS id FROM webchat.conversations c
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
  };
}
