-- 16: the person an agent runs cards for, which replaces the agent flag of 13 (K-45, D-089).
ALTER TABLE webchat.users ADD COLUMN IF NOT EXISTS agent_owner INTEGER REFERENCES webchat.users(id) ON DELETE SET NULL;
