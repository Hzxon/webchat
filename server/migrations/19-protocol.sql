-- 19: what a plugin session can do, by the level its check-ins name, so the page never offers one
-- a question it would leave unanswered (R-035, D-103). Older plugins name none.
ALTER TABLE webchat.agent_repos ADD COLUMN IF NOT EXISTS protocol INTEGER NOT NULL DEFAULT 0;
