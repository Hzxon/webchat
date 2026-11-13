-- 22: the harnesses a coding agent asks to link ride its pairing, sealed under the pairing code, so
-- the owner's approval shows them and the server reads nothing (docs/decisions/harness-linking.md).
ALTER TABLE webchat.pairings ADD COLUMN IF NOT EXISTS picks TEXT;
