-- 07: delivered pointers never past a chat's newest event.
-- POST /api/delivered once stored any id a client sent. Pull back the pointers it pushed too far.
UPDATE webchat.members m SET last_delivered_id = c.last_event_id
FROM webchat.conversations c
WHERE c.id = m.conversation_id AND m.last_delivered_id > c.last_event_id;
