-- 26: a batch of an agent session's steps is an "events" message, which the server never pushes or
-- counts, and leaves out of a chat's history unless asked for (R-072).
ALTER TABLE webchat.messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE webchat.messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('message', 'reaction', 'github', 'sync', 'events'));
