-- 18: an agent's Claude Code sessions each take their own repository's runs, so an agent checks in
-- once per repository. This replaces the agent_repo column of 17 (R-032, D-094).
CREATE TABLE IF NOT EXISTS webchat.agent_repos (
  user_id   INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  repo      TEXT NOT NULL,
  last_seen BIGINT NOT NULL,
  busy      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, repo)
);
