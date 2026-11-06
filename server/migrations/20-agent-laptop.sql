-- 20: one Claude Code window serves every repository its laptop has a folder for, and checks in once
-- for all of them, so the level of what it can do moves to the agent's own row (R-036, D-094).
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS protocol INTEGER NOT NULL DEFAULT 0;
