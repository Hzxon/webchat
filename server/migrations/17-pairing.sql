-- 17: a coding agent pairs with its owner through a one-time code, and says which repository its
-- Claude Code session is open in (R-030, D-093).
CREATE TABLE IF NOT EXISTS webchat.pairings (
  -- A hash of the code. The code itself never reaches the server.
  id          TEXT PRIMARY KEY,
  dh_public   TEXT NOT NULL,
  sign_public TEXT NOT NULL,
  proof       TEXT NOT NULL,
  -- The agent's login key, hashed as a password is.
  login_hash  TEXT NOT NULL,
  expires_at  BIGINT NOT NULL,
  -- Set once, when the owner approves.
  agent_id    INTEGER REFERENCES webchat.users(id) ON DELETE CASCADE,
  owner_proof TEXT
);
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS agent_repo TEXT;
