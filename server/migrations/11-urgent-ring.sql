-- 11: unread urgent messages are looked for every few seconds, to ring them again (D-079).
CREATE INDEX IF NOT EXISTS urgent_messages ON webchat.messages (created_at) WHERE urgent;
