-- 04: removing people from projects and groups, and deleting them.
-- The person who made a group, the only one who can remove people from it or delete it. Every copy
-- of a group's key was wrapped by them (or, for a group from before encryption, by whoever set its
-- key), so the copies name the owner of each group made before this column existed.
ALTER TABLE webchat.conversations ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES webchat.users(id);
UPDATE webchat.conversations c
SET created_by = (SELECT MIN(k.wrapped_by) FROM webchat.conversation_keys k WHERE k.conversation_id = c.id)
WHERE c.type = 'group';
