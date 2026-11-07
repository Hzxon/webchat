-- 21: chat ids handed out before the chat exists, so the copies of its first key can name it. Each
-- is used once, and only by the person it was reserved for (K-43, D-111).
CREATE TABLE IF NOT EXISTS webchat.conversation_ids (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);
