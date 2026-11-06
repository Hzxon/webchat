-- 12: shared Markdown docs in projects (R-020, D-081).
-- The browser makes the id, so it signs it into every revision before the server sees the doc.
-- The doc belongs to its project's #general channel, whose key encrypts it and whose members edit it.
CREATE TABLE IF NOT EXISTS webchat.docs (
  id              TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES webchat.conversations(id) ON DELETE CASCADE,
  created_by      INTEGER NOT NULL REFERENCES webchat.users(id),
  created_at      BIGINT NOT NULL,
  -- Grows with every save, so check-ins notice it (D-021).
  version         INTEGER NOT NULL DEFAULT 1,
  updated_by      INTEGER NOT NULL REFERENCES webchat.users(id),
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_by_conversation ON webchat.docs (conversation_id);
-- One row per section per editing session. The newest row of a section is what the doc shows.
CREATE TABLE IF NOT EXISTS webchat.doc_revisions (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES webchat.docs(id) ON DELETE CASCADE,
  section    TEXT NOT NULL,
  author_id  INTEGER NOT NULL REFERENCES webchat.users(id),
  envelope   TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_revisions_by_section ON webchat.doc_revisions (doc_id, section, id DESC);
-- One editor per section. A lock lasts while its holder's tab keeps checking in.
CREATE TABLE IF NOT EXISTS webchat.doc_locks (
  doc_id      TEXT NOT NULL REFERENCES webchat.docs(id) ON DELETE CASCADE,
  section     TEXT NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES webchat.users(id) ON DELETE CASCADE,
  -- The revision this editing session writes over, from its first save.
  revision_id INTEGER,
  expires_at  BIGINT NOT NULL,
  PRIMARY KEY (doc_id, section)
);
