-- 24: photos and files (R-005, D-123). A row per file whose ciphertext is in the store, or is being
-- uploaded. The name, type and key are sealed in the message; the server knows the chat, the
-- uploader, the size and the time. A deleted chat leaves its rows without one, for the next sweep
-- to delete their ciphertext.
CREATE TABLE IF NOT EXISTS webchat.files (
  id              TEXT PRIMARY KEY,
  conversation_id INTEGER REFERENCES webchat.conversations(id) ON DELETE SET NULL,
  uploader_id     INTEGER NOT NULL REFERENCES webchat.users(id),
  size            INTEGER NOT NULL,
  created_at      BIGINT NOT NULL,
  -- A message names it. An upload no message followed is deleted after an hour.
  sent            BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS files_created_at ON webchat.files (created_at);
