-- D1 is the channel database catalog and access control plane. Records live in DOs.
CREATE TABLE channel_databases (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  managed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  UNIQUE(room_id,name)
);
CREATE INDEX channel_databases_room ON channel_databases(room_id,deleted_at);
CREATE TABLE database_tokens (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES channel_databases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX database_tokens_db ON database_tokens(database_id);
-- Transactional source events: all human, connector and cloud-agent attachment
-- publishers use chat_files/chat_messages, so they all participate automatically.
CREATE TABLE channel_file_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX channel_file_events_room ON channel_file_events(room_id,seq);
CREATE TRIGGER channel_file_insert AFTER INSERT ON chat_files
WHEN NEW.message_id IS NOT NULL
BEGIN
  INSERT INTO channel_file_events(room_id,file_id,payload)
  SELECT NEW.room_id,NEW.id,json_object('name',NEW.name,'size',NEW.size,'type',NEW.type,'message_id',NEW.message_id,'parent_id',m.parent_id,'seq',m.seq,'uploader_id',NEW.uploader_id,'created_at',NEW.created_at)
  FROM chat_messages m JOIN rooms r ON r.id=m.room_id WHERE m.id=NEW.message_id AND m.deleted_at IS NULL AND r.kind='channel';
END;
CREATE TRIGGER channel_file_update AFTER UPDATE ON chat_files
BEGIN
  INSERT INTO channel_file_events(room_id,file_id,payload)
  SELECT OLD.room_id,OLD.id,NULL WHERE OLD.message_id IS NOT NULL AND EXISTS(SELECT 1 FROM rooms WHERE id=OLD.room_id AND kind='channel');
  INSERT INTO channel_file_events(room_id,file_id,payload)
  SELECT NEW.room_id,NEW.id,json_object('name',NEW.name,'size',NEW.size,'type',NEW.type,'message_id',NEW.message_id,'parent_id',m.parent_id,'seq',m.seq,'uploader_id',NEW.uploader_id,'created_at',NEW.created_at)
  FROM chat_messages m JOIN rooms r ON r.id=m.room_id WHERE m.id=NEW.message_id AND m.deleted_at IS NULL AND r.kind='channel';
END;
CREATE TRIGGER channel_file_delete AFTER DELETE ON chat_files
BEGIN
  INSERT INTO channel_file_events(room_id,file_id,payload) SELECT OLD.room_id,OLD.id,NULL WHERE OLD.message_id IS NOT NULL AND EXISTS(SELECT 1 FROM rooms WHERE id=OLD.room_id AND kind='channel');
END;
CREATE TRIGGER channel_message_file_visibility AFTER UPDATE OF deleted_at ON chat_messages
WHEN NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO channel_file_events(room_id,file_id,payload)
  SELECT f.room_id,f.id,CASE WHEN NEW.deleted_at IS NOT NULL THEN NULL ELSE json_object('name',f.name,'size',f.size,'type',f.type,'message_id',f.message_id,'parent_id',NEW.parent_id,'seq',NEW.seq,'uploader_id',f.uploader_id,'created_at',f.created_at) END
  FROM chat_files f JOIN rooms r ON r.id=f.room_id WHERE f.message_id=NEW.id AND r.kind='channel';
END;
CREATE TRIGGER channel_message_file_delete BEFORE DELETE ON chat_messages
BEGIN
  INSERT INTO channel_file_events(room_id,file_id,payload)
  SELECT f.room_id,f.id,NULL FROM chat_files f JOIN rooms r ON r.id=f.room_id WHERE f.message_id=OLD.id AND r.kind='channel';
END;
INSERT INTO channel_file_events(room_id,file_id,payload)
SELECT f.room_id,f.id,json_object('name',f.name,'size',f.size,'type',f.type,'message_id',f.message_id,'parent_id',m.parent_id,'seq',m.seq,'uploader_id',f.uploader_id,'created_at',f.created_at)
FROM chat_files f JOIN chat_messages m ON m.id=f.message_id JOIN rooms r ON r.id=f.room_id WHERE m.deleted_at IS NULL AND r.kind='channel';
