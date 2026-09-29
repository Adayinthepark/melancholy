ALTER TABLE chat_messages ADD COLUMN parts TEXT NOT NULL DEFAULT '[]';
CREATE TABLE agent_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX agent_artifacts_run ON agent_artifacts(run_id);
