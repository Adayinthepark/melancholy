CREATE TABLE people (
  id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('human','bot')),
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  password_hash TEXT, active INTEGER NOT NULL DEFAULT 1,
  server_id TEXT UNIQUE REFERENCES servers(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO people(id,handle,name,kind,role,created_at) VALUES ('owner','owner','Owner','human','owner',0);
ALTER TABLE sessions ADD COLUMN person_id TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE login_tickets ADD COLUMN person_id TEXT NOT NULL DEFAULT 'owner';
CREATE TABLE invitations (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES people(id));
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('channel','dm','group')),
  name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', private INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES people(id), created_at INTEGER NOT NULL,
  dm_key TEXT UNIQUE
);
CREATE UNIQUE INDEX channel_names ON rooms(name) WHERE kind='channel';
CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id), person_id TEXT NOT NULL REFERENCES people(id),
  joined_at INTEGER NOT NULL, PRIMARY KEY(room_id,person_id)
);
CREATE TABLE room_reads (
  room_id TEXT NOT NULL REFERENCES rooms(id), person_id TEXT NOT NULL REFERENCES people(id),
  last_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id,person_id)
);
INSERT INTO rooms(id,kind,name,topic,private,created_by,created_at)
SELECT id,'channel',name,description,0,'owner',0 FROM channels;
INSERT INTO room_members SELECT id,'owner',0 FROM rooms;
INSERT INTO people(id,handle,name,kind,server_id,created_at)
SELECT id,runtime||'-'||substr(id,1,8),name,'bot',id,created_at FROM servers;
INSERT INTO room_members SELECT 'engineering',id,created_at FROM people WHERE kind='bot' AND EXISTS(SELECT 1 FROM rooms WHERE id='engineering');
CREATE TABLE chat_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL REFERENCES rooms(id), parent_id TEXT REFERENCES chat_messages(id),
  author_id TEXT NOT NULL REFERENCES people(id), text TEXT NOT NULL,
  created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER,
  attachments TEXT NOT NULL DEFAULT '[]', run_id TEXT, run_status TEXT,
  run_error TEXT, event_seq INTEGER NOT NULL DEFAULT 0, activity TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX chat_room_seq ON chat_messages(room_id,seq);
CREATE INDEX chat_parent_seq ON chat_messages(parent_id,seq);
CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id), person_id TEXT NOT NULL REFERENCES people(id),
  emoji TEXT NOT NULL, PRIMARY KEY(message_id,person_id,emoji)
);
CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id), person_id TEXT NOT NULL REFERENCES people(id),
  PRIMARY KEY(message_id,person_id)
);
CREATE TABLE chat_files (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  uploader_id TEXT NOT NULL REFERENCES people(id), name TEXT NOT NULL, size INTEGER NOT NULL,
  type TEXT NOT NULL, message_id TEXT REFERENCES chat_messages(id), created_at INTEGER NOT NULL
);
CREATE TABLE bot_tokens (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL REFERENCES people(id), room_id TEXT REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK(kind IN ('api','webhook')), created_at INTEGER NOT NULL
);
CREATE TABLE chat_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id),
  message_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX chat_events_room_seq ON chat_events(room_id,seq);
CREATE TABLE agent_threads (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), room_id TEXT NOT NULL REFERENCES rooms(id),
  root_id TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES people(id),
  UNIQUE(room_id,root_id,bot_id)
);
CREATE TABLE agent_requests (
  message_id TEXT NOT NULL REFERENCES chat_messages(id), bot_id TEXT NOT NULL REFERENCES people(id),
  thread_id TEXT NOT NULL REFERENCES threads(id), dispatched INTEGER NOT NULL DEFAULT 0,
  error TEXT, PRIMARY KEY(message_id,bot_id)
);
CREATE INDEX agent_requests_pending ON agent_requests(thread_id) WHERE dispatched=0;
CREATE VIRTUAL TABLE chat_search USING fts5(message_id UNINDEXED, text, tokenize='trigram');
CREATE TRIGGER chat_search_insert AFTER INSERT ON chat_messages WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO chat_search(message_id,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER chat_search_update AFTER UPDATE OF text,deleted_at ON chat_messages BEGIN
  DELETE FROM chat_search WHERE message_id=old.id;
  INSERT INTO chat_search(message_id,text) SELECT new.id,new.text WHERE new.deleted_at IS NULL;
END;
