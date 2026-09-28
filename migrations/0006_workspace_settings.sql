CREATE TABLE workspace_settings (
 id TEXT PRIMARY KEY CHECK(id='workspace'), name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
);
CREATE TABLE credentials (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL,
 identity TEXT NOT NULL, secret TEXT NOT NULL, env_keys TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES people(id), created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE room_credentials (
 room_id TEXT NOT NULL REFERENCES rooms(id),
 credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
 agent_enabled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id,credential_id)
);
