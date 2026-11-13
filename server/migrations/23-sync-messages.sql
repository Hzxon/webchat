-- 23: an agent's board traffic with its owner's page is a "sync" message, which the server pushes
-- and counts like a reaction (K-69).
ALTER TABLE webchat.messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE webchat.messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('message', 'reaction', 'github', 'sync'));
