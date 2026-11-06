-- 01: end-to-end encryption.
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
