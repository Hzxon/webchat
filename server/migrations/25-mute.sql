-- 25: a person mutes a chat for themselves (the mute decision, proposed). The server then pushes
-- them none of its messages except urgent ones, so it learns which chats each person muted.
ALTER TABLE webchat.members ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT false;
