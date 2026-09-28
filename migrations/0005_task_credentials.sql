CREATE TABLE task_credentials (
 run_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id),
 bot_id TEXT NOT NULL REFERENCES people(id), expires_at INTEGER NOT NULL
);
CREATE INDEX task_credentials_expiry ON task_credentials(expires_at);
