# Architecture

```text
Browser ── HTTPS / WebSocket ── Worker (vinext)
                                    │
                    ┌───────────────┼─────────────────┐
                    │               │                 │
                    D1              Inbox DO          R2
                    chat, members   per member        private files
                    search, events  invalidations
                    │
                    ChatDispatcher DO (per conversation)
                    │
                    Conversation DO (per thread / bot)
                    │
                    Connector DO (per server)
                    │ outbound WebSocket
                    Server connector ── Codex / Claude Code
```

The web application and storage run on Cloudflare. The connector runs on a
server with the agent CLI installed and authenticated. Model inference is
provided by that CLI's provider.

## Identity and authorization

Each installation is one workspace. The bootstrap workspace key signs in the
owner; every invited member has their own username and password. Passwords use
PBKDF2-SHA256 with 100,000 iterations and independent random salts. Sign-in
attempts are limited per Cloudflare client IP. Individual sessions use random
256-bit tokens stored as hashes and HttpOnly, Secure, SameSite=Strict cookies.
Mutations and browser socket upgrades require the same Origin.

One-use owner sign-in tickets expire in 24 hours. Member invitations expire
in seven days and are consumed in the same D1 transaction that creates the
account. The owner can deactivate members and revoke their sessions.

Public channels can be discovered and read by active human members; posting
requires joining. Private channels, DMs and groups require explicit membership.
These checks apply to messages, threads, search, exports, file downloads and
bot APIs. Group participants are fixed: create a new group to change them.
Channel creators and the owner can manage a channel they can access. Only the
owner provisions bots, credentials and server connections.

A bot has its own identity and can only read/post in conversations it has
joined. API tokens can be further restricted to one conversation. Incoming
webhooks are always bound to one bot and one conversation. Credentials are
shown once and stored as SHA256 hashes. Revocation takes effect on the next
request. Bots cannot invite members, manage servers or impersonate a person.

## Chat data and live updates

D1 is the source of truth for human/bot messages. Every message has a client
UUID and a monotonically increasing sequence. A root message has no parent;
thread replies point to that root in the same conversation. A DM has a unique,
sorted participant key, so creating the same DM twice returns one conversation.

Message writes, mention records, attachment associations and bot event records
and agent request records are committed in the same D1 batch. Editing requires authorship. The owner can also
remove messages in conversations they can read. Deletion creates a tombstone,
removes the body from search and prevents downloading its attachments; replies
remain accessible. It is not a physical purge of model-provider or CLI history.

Reactions are unique per message/person/emoji. Read cursors only move forward.
Unread and mention counts exclude deleted messages and a person's own messages.
Counts cover the entire conversation, including thread replies. Reading the
active conversation marks it read; there is no native push in this release.

Each member's Inbox Durable Object holds hibernating WebSockets. It sends only
invalidation identifiers; the browser fetches current data through authorized
HTTP endpoints. Notifications recheck session validity. Reconnect and periodic
refresh recover from missed invalidations. Ping/pong uses automatic responses.

History is paginated in 100-message pages. Search uses a trigram FTS5 index for
queries of at least three characters and a substring scan for shorter queries,
including two-character Chinese terms. Search always checks conversation access.

## Connected agent turns

A human's explicit bot mention, or a message in a one-to-one bot DM, creates a
persistent agent request in the message transaction. Messages from bots never
trigger agents, preventing bot reply loops. Dispatchers retry queued requests;
a minute Cron Trigger also recovers committed requests after a missed dispatch
notification. concurrent turns are
serialized by the existing conversation and connector protocols.

A channel thread has a separate CLI session per bot. A bot DM keeps one session
for the whole conversation. The existing Conversation DO stores the agent run,
its messages, tool events and a durable output projection queue. Responses are
projected into D1 as messages authored by the bot, then invalidate member inboxes.
Each projected run has a sequence checkpoint, so late output cannot overwrite
newer output or resurrect a deleted message. Failed projections retry on alarms.

The connector protocol uses job IDs, event sequence numbers and ACKs. Its local
private journal retains received jobs and unacknowledged output. Network
reconnects replay output without restarting the CLI. A process restart marks
an interrupted task failed instead of re-executing filesystem side effects.

Prompts go to stdin with `shell: false`. Executable, runtime, working directory
and permissions come from local connector config. The workspace token is removed
from the CLI child's environment. Other inherited environment variables and
filesystem credentials remain the server operator's responsibility. `inherit`
uses the operator's existing CLI policy; it never activates automatically after
a sandbox failure. The web UI cannot approve interactive tool escalations.

Earlier single-owner agent conversations remain available at `/legacy`. The
legacy listing/search excludes new shared-workspace agent sessions. Direct
access to a shared session still checks its conversation membership.

## Files and operations

R2 stays private. Uploads are limited to 10 MB each and eight files per message.
A draft upload is accessible only to its uploader. After posting, conversation
members can download it. Connector downloads use the server's bot membership.
Only PNG, JPEG, GIF and WebP are shown inline; other types download with a
restrictive content security policy. Deleted message attachments are inaccessible.

D1 and an individual paid SQLite Durable Object each have a 10 GB storage limit.
Room lists currently return up to 500 accessible conversations. Message history,
bot events, abandoned uploads and connector journals do not yet have automatic
retention or compaction. Monitor storage and write volume, especially streamed
agent output. Workspace exports include current chat messages and tool activity;
CLI logs and model-provider history are separate.

Deployments use additive D1 and Durable Object migrations. Back up D1 before an
upgrade. The Cloudflare app does not deploy or upgrade a server's connector;
restart that service separately when connector code changes. CI runs the same
checks listed in the README and requires an available GitHub Actions account.
