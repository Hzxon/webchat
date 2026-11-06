-- 09: alerts to the Bark app on iPhones without Web Push (R-018).
-- One Bark server link per person. The token is the secret in the server URL the Bark app calls.
CREATE TABLE IF NOT EXISTS webchat.bark_links (
  user_id    INTEGER PRIMARY KEY REFERENCES webchat.users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  -- Where the person's browser and phone reach this server, for the page a tap on an alert opens.
  origin     TEXT NOT NULL,
  -- 32 characters for AES-256-GCM, the same key typed into Bark. Null while alerts go in plain text.
  cipher_key TEXT,
  created_at BIGINT NOT NULL
);
-- Each Bark install that registered through a link: the key Bark shows for it, and its APNs token.
CREATE TABLE IF NOT EXISTS webchat.bark_devices (
  device_key   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  device_token TEXT NOT NULL UNIQUE,
  created_at   BIGINT NOT NULL,
  seen_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS bark_devices_by_user ON webchat.bark_devices (user_id);
