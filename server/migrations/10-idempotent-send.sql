-- 10: a send repeated after a lost answer stores nothing twice (K-9, D-061).
CREATE UNIQUE INDEX IF NOT EXISTS messages_by_client_id
  ON webchat.messages (conversation_id, sender_id, client_id) WHERE client_id IS NOT NULL;
