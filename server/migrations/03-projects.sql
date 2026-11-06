-- 03: projects with channels, replies and reactions.
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
