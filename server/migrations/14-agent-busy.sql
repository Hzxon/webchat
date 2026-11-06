-- 14: an agent says in its check-ins whether it is running a card, so a card is offered only to idle ones (R-027).
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS busy BOOLEAN NOT NULL DEFAULT FALSE;
