ALTER TABLE people ADD COLUMN avatar_key TEXT;
ALTER TABLE chat_messages ADD COLUMN mention_refs TEXT NOT NULL DEFAULT '{}';
UPDATE chat_messages SET mention_refs=COALESCE((SELECT json_group_object(p.handle,p.id) FROM message_mentions mm JOIN people p ON p.id=mm.person_id WHERE mm.message_id=chat_messages.id),'{}');
CREATE TABLE thread_preferences (
 root_id TEXT PRIMARY KEY REFERENCES chat_messages(id),
 bot_id TEXT REFERENCES people(id), changed_by TEXT NOT NULL REFERENCES people(id), updated_at INTEGER NOT NULL
);
CREATE TABLE integrations (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('github','cloudflare')),
 name TEXT NOT NULL, identity TEXT NOT NULL, secret TEXT NOT NULL, account_id TEXT,
 created_by TEXT NOT NULL REFERENCES people(id), created_at INTEGER NOT NULL
);
CREATE TABLE room_integrations (
 room_id TEXT NOT NULL REFERENCES rooms(id), integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
 agent_enabled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id,integration_id)
);
CREATE TABLE room_repositories (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
 full_name TEXT NOT NULL COLLATE NOCASE, url TEXT NOT NULL,
 approved INTEGER NOT NULL DEFAULT 0, proposed_by TEXT NOT NULL REFERENCES people(id), created_at INTEGER NOT NULL,
 UNIQUE(room_id,full_name)
);
CREATE TABLE issue_threads (
 root_id TEXT PRIMARY KEY REFERENCES chat_messages(id), repository_id TEXT NOT NULL REFERENCES room_repositories(id) ON DELETE CASCADE,
 number INTEGER NOT NULL, url TEXT NOT NULL
);
CREATE TABLE agent_usage (
 run_id TEXT PRIMARY KEY, server_id TEXT NOT NULL, room_id TEXT, root_id TEXT, thread_id TEXT NOT NULL,
 runtime TEXT NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
 cached_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
 cost_usd REAL, reported_at INTEGER NOT NULL, event_seq INTEGER NOT NULL
);
CREATE INDEX agent_usage_room ON agent_usage(room_id,root_id);
CREATE INDEX agent_usage_server ON agent_usage(server_id,reported_at);
