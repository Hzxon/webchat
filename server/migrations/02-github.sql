-- 02: GitHub connector.
CREATE TABLE IF NOT EXISTS webchat.github_accounts (
  user_id    INTEGER PRIMARY KEY REFERENCES webchat.users(id) ON DELETE CASCADE,
  github_id  BIGINT NOT NULL,
  login      TEXT NOT NULL,
  name       TEXT,
  -- The OAuth token, encrypted with a key derived from GITHUB_CLIENT_SECRET, which the database never holds.
  token      TEXT NOT NULL,
  notify     BOOLEAN NOT NULL DEFAULT true,
  -- The pull requests from the last poll, as JSON. The next poll compares against them.
  pulls      TEXT,
  fetched_at BIGINT,
  -- Set when a poll starts, so server instances never poll one account at the same time.
  polled_at  BIGINT NOT NULL DEFAULT 0,
  error      TEXT,
  -- GitHub refused the token. Polling stops until the user connects again.
  revoked    BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS webchat.github_events (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  actor      TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_events_by_user ON webchat.github_events (user_id, id);
