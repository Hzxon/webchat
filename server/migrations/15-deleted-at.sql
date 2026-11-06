-- 15: when an account was deleted. The row stays, so old messages keep their sender (R-028, D-088).
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
