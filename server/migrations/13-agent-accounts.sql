-- 13: an account a coding agent's daemon runs, which cards can be handed to (R-027, D-085).
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS agent BOOLEAN NOT NULL DEFAULT FALSE;
