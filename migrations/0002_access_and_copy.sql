CREATE TABLE login_tickets (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
UPDATE channels SET description='Threads and conversations' WHERE id='general';
UPDATE channels SET description='Code and reviews' WHERE id='engineering';
