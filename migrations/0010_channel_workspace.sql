CREATE TABLE casual_settings (
 id TEXT PRIMARY KEY CHECK(id='workspace'), enabled INTEGER NOT NULL DEFAULT 0,
 bot_id TEXT REFERENCES people(id), updated_at INTEGER NOT NULL
);
INSERT INTO casual_settings VALUES ('workspace',0,NULL,0);
CREATE TABLE casual_rooms (
 room_id TEXT PRIMARY KEY REFERENCES rooms(id), user_id TEXT NOT NULL REFERENCES people(id),
 bot_id TEXT NOT NULL REFERENCES people(id), UNIQUE(user_id,bot_id)
);
CREATE TABLE channel_notes (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), title TEXT NOT NULL,
 content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL REFERENCES people(id), updated_by TEXT NOT NULL REFERENCES people(id),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX channel_notes_room ON channel_notes(room_id,updated_at);
CREATE TABLE room_workers (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
 integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
 script_name TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(room_id,integration_id,script_name)
);
CREATE TABLE channel_suggestions (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES casual_rooms(room_id),
 name TEXT NOT NULL, topic TEXT NOT NULL, brief TEXT NOT NULL,
 created_at INTEGER NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE channel_timers (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), name TEXT NOT NULL,
 prompt TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES people(id),
 created_by TEXT NOT NULL REFERENCES people(id), interval_minutes INTEGER NOT NULL DEFAULT 0,
 next_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 version INTEGER NOT NULL DEFAULT 1, last_error TEXT, deleted_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX channel_timers_due ON channel_timers(next_at) WHERE enabled=1;
CREATE TABLE timer_runs (
 id TEXT PRIMARY KEY, timer_id TEXT NOT NULL REFERENCES channel_timers(id),
 scheduled_at INTEGER NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(timer_id,scheduled_at)
);
CREATE UNIQUE INDEX timer_runs_message ON timer_runs(message_id);
