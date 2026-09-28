-- Purge standalone Durable Objects, connector job copies and R2 files before
-- applying this migration to an existing installation. Keep agent_threads IDs.
CREATE TABLE agent_threads_next (
  thread_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  root_id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES people(id),
  UNIQUE(room_id,root_id,bot_id)
);
INSERT INTO agent_threads_next SELECT * FROM agent_threads;
CREATE TABLE agent_requests_next (
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  bot_id TEXT NOT NULL REFERENCES people(id),
  thread_id TEXT NOT NULL REFERENCES agent_threads_next(thread_id),
  dispatched INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY(message_id,bot_id)
);
INSERT INTO agent_requests_next SELECT * FROM agent_requests;
DROP TABLE agent_requests;
DROP TABLE agent_threads;
ALTER TABLE agent_threads_next RENAME TO agent_threads;
ALTER TABLE agent_requests_next RENAME TO agent_requests;
CREATE INDEX agent_requests_pending ON agent_requests(thread_id) WHERE dispatched=0;
DELETE FROM agent_usage WHERE thread_id NOT IN (SELECT thread_id FROM agent_threads);
DROP TRIGGER search_insert;
DROP TRIGGER search_update;
DROP TABLE search;
DROP TABLE search_messages;
DROP TABLE files;
DROP TABLE threads;
DROP TABLE channels;
