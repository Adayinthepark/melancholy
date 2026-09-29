-- Link each accepted request to its exact reply, including queued follow-ups.
-- Existing conversations acquire the link on their next durable projection.
ALTER TABLE agent_requests ADD COLUMN reply_id TEXT REFERENCES chat_messages(id);
