-- 08: projects link repositories through the GitHub App, and its webhooks post cards (D-050).
-- The author's browser no longer shares pull requests (D-046 is superseded).
DROP TABLE IF EXISTS webchat.pull_shares;
ALTER TABLE webchat.github_accounts DROP COLUMN IF EXISTS auto_share;
-- GitHub's id stays the same when a repository is renamed or moved, so links follow it. The repo
-- column now keeps the name as GitHub last sent it, for display.
ALTER TABLE webchat.project_repos ADD COLUMN IF NOT EXISTS repo_id BIGINT;
ALTER TABLE webchat.project_repos ADD COLUMN IF NOT EXISTS installation_id BIGINT;
-- A link made by typing a name proved nothing about access to the repository, so those links go.
DELETE FROM webchat.project_repos WHERE repo_id IS NULL OR installation_id IS NULL;
ALTER TABLE webchat.project_repos ALTER COLUMN repo_id SET NOT NULL;
ALTER TABLE webchat.project_repos ALTER COLUMN installation_id SET NOT NULL;
ALTER TABLE webchat.project_repos DROP CONSTRAINT IF EXISTS project_repos_pkey;
ALTER TABLE webchat.project_repos ADD PRIMARY KEY (project_id, repo_id);
CREATE INDEX IF NOT EXISTS project_repos_by_repo ON webchat.project_repos (repo_id);
-- Repositories someone just showed GitHub they reach through the app. Only these can they link.
CREATE TABLE IF NOT EXISTS webchat.github_app_grants (
  user_id         INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  repo_id         BIGINT NOT NULL,
  repo            TEXT NOT NULL,
  installation_id BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  PRIMARY KEY (user_id, repo_id)
);
-- Webhook deliveries already handled. GitHub sends one again when it thinks it failed.
CREATE TABLE IF NOT EXISTS webchat.github_deliveries (
  id          TEXT PRIMARY KEY,
  received_at BIGINT NOT NULL
);
-- A card the server writes from GitHub has no sender.
ALTER TABLE webchat.messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE webchat.messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE webchat.messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('message', 'reaction', 'github'));
