CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude')),
  token_hash TEXT NOT NULL UNIQUE,
  cwd TEXT,
  hostname TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  title TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX threads_channel_updated ON threads(channel_id, updated_at DESC);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  type TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE search USING fts5(thread_id UNINDEXED, message_id UNINDEXED, text, tokenize='trigram');
CREATE TABLE search_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TRIGGER search_insert AFTER INSERT ON search_messages BEGIN
  INSERT INTO search(thread_id, message_id, text) VALUES(new.thread_id,new.message_id,new.text);
END;
CREATE TRIGGER search_update AFTER UPDATE ON search_messages BEGIN
  DELETE FROM search WHERE message_id=old.message_id;
  INSERT INTO search(thread_id, message_id, text) VALUES(new.thread_id,new.message_id,new.text);
END;
INSERT INTO channels VALUES ('general','general','Everything starts somewhere.');
INSERT INTO channels VALUES ('engineering','engineering','Code, reviews, and things in progress.');
