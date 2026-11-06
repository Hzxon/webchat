-- 06: sharing new pull requests into the channel of a project that links their repository.
CREATE TABLE IF NOT EXISTS webchat.project_repos (
  project_id      INTEGER NOT NULL REFERENCES webchat.projects(id) ON DELETE CASCADE,
  -- "owner/name" in lower case, because GitHub ignores case in repository names.
  repo            TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES webchat.conversations(id) ON DELETE CASCADE,
  added_by        INTEGER REFERENCES webchat.users(id),
  added_at        BIGINT NOT NULL,
  PRIMARY KEY (project_id, repo)
);
-- A pull request waiting for its author's page to share it into a channel, and afterwards the
-- record that it was, so it never goes there twice. Only GitHub's node id is kept here.
CREATE TABLE IF NOT EXISTS webchat.pull_shares (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES webchat.conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  pull_id         TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  claimed_at      BIGINT,
  UNIQUE (conversation_id, pull_id)
);
CREATE INDEX IF NOT EXISTS pull_shares_by_user ON webchat.pull_shares (user_id);
ALTER TABLE webchat.github_accounts ADD COLUMN IF NOT EXISTS auto_share BOOLEAN NOT NULL DEFAULT true;
