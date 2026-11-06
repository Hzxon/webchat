-- 05: key rotation, leaving, and handing projects and groups over.
-- A chat's earlier keys, each encrypted with the key that replaced it. Whoever holds the current
-- key opens the earlier ones in turn and reads the whole history. From here on, projects.created_by
-- and conversations.created_by name the owner, who can hand it to another member.
CREATE TABLE IF NOT EXISTS webchat.key_links (
  conversation_id INTEGER NOT NULL REFERENCES webchat.conversations(id) ON DELETE CASCADE,
  key_id          TEXT NOT NULL,
  previous_key_id TEXT NOT NULL,
  iv              TEXT NOT NULL,
  wrapped         TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (conversation_id, key_id)
);
-- Someone who holds the current key left. Messages wait until a member who stays replaces it.
ALTER TABLE webchat.conversations ADD COLUMN IF NOT EXISTS needs_new_key BOOLEAN NOT NULL DEFAULT false;
