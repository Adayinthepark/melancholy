CREATE TABLE message_reads (
  person_id TEXT NOT NULL REFERENCES people(id),
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(person_id, message_id)
);
CREATE INDEX message_reads_message ON message_reads(message_id);
CREATE INDEX message_mentions_person ON message_mentions(person_id, message_id);
