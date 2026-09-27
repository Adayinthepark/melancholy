# Architecture

```text
Browser ── HTTPS / WebSocket ── Cloudflare Worker (vinext)
                                      │
                         ┌────────────┼────────────┐
                         │            │            │
                    Conversation     D1             R2
                    Durable Object   directory      attachments
                         │           search
                    Connector
                    Durable Object
                         │
                   outbound WebSocket
                         │
                    Server connector ── Codex / Claude Code
```

## Boundaries

The web application and its storage run on Cloudflare. The connector runs on
a machine with the agent CLI installed and authenticated. Agent inference is
provided by the CLI's configured provider and is billed separately.

The first release has one owner identity per deployment. Channels organize
threads; they are not access-control boundaries. Every signed-in browser has
owner access. Do not give an owner workspace key to an untrusted collaborator.
Individual member accounts and private-channel permissions are future work.

## Conversation storage

Each thread maps to its own SQLite Durable Object. User messages, assistant
messages, run records, sequence checkpoints and tool events live there. A
single transaction records a message and its pending job before acknowledging
the send. Repeating the same client message ID returns the same run.

Only one turn runs in a thread at a time. A follow-up resumes the last CLI
session saved for that thread and server. A different thread starts a separate
CLI session. The connector executes one turn at a time per connector process.

The room's alarm retries dispatch to the connector object and updates the D1
search projection. Search is eventually consistent and can lag a new message.
Message writes remain valid when indexing fails. Each object can sleep while
its browser WebSockets stay connected. Ping/pong uses the automatic response
API and does not require a JavaScript timer in the Durable Object.

## Connector delivery

The server opens one outbound WebSocket. Its bearer token is checked against
a hash in D1. A token is scoped to one connector identity; only jobs assigned
to that connector accept its output. Tokens are shown once on creation.

The connector object persists jobs before delivery. The local connector saves
received job IDs, event sequence numbers and an output queue in a private
on-disk journal. Events are acknowledged after the room stores them. On a
network reconnect, unacknowledged events are resent. The room ignores older
sequence numbers and terminal runs ignore late output.

Restarting a connector during a turn marks that turn interrupted. It does not
automatically re-execute the CLI: filesystem changes and other external side
effects cannot be made exactly-once by a WebSocket protocol. Already received
job IDs are never run again by the same journal. Preserve the state directory
when restarting a service.

Messages contain prompts, not executable command lines. CLI executables and
the working directory come from the server's local configuration. The prompt
goes to stdin with `shell: false`. Authentication and model preferences stay in
the existing CLI configuration. The workspace server token is removed from
the CLI child environment. Other inherited environment variables remain the
server operator's responsibility.

## Access and files

A workspace key signs in the owner. The Worker stores hashes of random session
tokens, and the browser gets an HttpOnly, Secure, SameSite=Strict cookie on
HTTPS. Mutations and browser WebSocket upgrades require a matching Origin.
One-use sign-in tickets expire after 24 hours. API data is never publicly cached.

R2 is private. Browser downloads require a session. Connector downloads require
its token and a thread assigned to that connector. Individual uploads are
limited to 10 MB, with at most eight attachments per message. Only a small set
of raster image formats are shown inline; other files download as attachments.
The connector downloads files into its private state directory before invoking
the CLI and includes local file paths in the prompt.

## Limits and operations

- D1 and an individual paid SQLite Durable Object each have a 10 GB limit.
- Message pages contain up to 100 messages. Exports stream every message in
  reverse chronological order. They currently exclude tool event bodies.
- The directory returns the 200 most recently updated active threads.
- Search uses a trigram FTS5 index for queries of at least three characters;
  shorter queries use a bounded-result scan, including two-character Chinese
  queries. Large histories will need a more specialized indexing strategy.
- The first release retains message and connector journals; retention and
  compaction are not yet automated. Monitor D1, DO and connector disk usage.
- There is no native mobile push, Slack import, audio/video, multi-user access,
  interactive tool-approval UI, or Slack API compatibility in this release.
- Codex's noninteractive JSON events provide message and execution updates.
  Claude's adapter additionally consumes partial text deltas. Granularity
  depends on the installed CLI version.
- `vinext` is actively developed. Package versions are locked and production
  builds should be tested when upgrading.

## Verification

`npm test` runs authorization and Durable Object tests in workerd, including
eviction/recovery, isolation, deduplication, ordering and cancellation.
`npm run test:connector` tests both CLI adapters. `npm run test:e2e` exercises
the real browser and local Worker, without making paid model calls.

A live-model smoke check is separate: connect a test server, send a short
prompt, then ask it to quote its previous reply. Inspect the room's run records
to confirm that both turns retain the same CLI session ID. Never use a fake
agent in production to make a disconnected workspace look active.
