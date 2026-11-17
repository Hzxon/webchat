import { readFileSync, readdirSync } from 'node:fs';

// Everything lives in its own schema. Supabase exposes only the "public" schema through its
// auto-generated REST API, so these tables are reachable only through this server.
export const SCHEMA = `
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
export const migrationsDir = new URL('../migrations/', import.meta.url);
export const MIGRATIONS = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name, i) => {
    if (Number(name.slice(0, 2)) !== i + 1) throw new Error(`server/migrations: expected number ${i + 1}, found ${name}`);
    return readFileSync(new URL(name, migrationsDir), 'utf8');
  });

export const statements = (sql: string) =>
  sql
    .split(/;\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.replace(/--.*$/gm, '').trim());
