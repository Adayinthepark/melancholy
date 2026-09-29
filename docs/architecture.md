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

Cloud bots are an alternative branch after Conversation DO: `CloudAgent`
(Agents SDK) runs Pi's agent core and stores its private transcript and
Computer filesystem in SQLite. Dynamic Worker shell/JavaScript backends share
that filesystem. The native runtime projects the same sequenced events into
Conversation DO, so D1 chat, permissions, cancellation and usage keep their
existing paths. Model credentials are resolved from the bot's explicit key
selection; GitHub tools separately enforce conversation integration grants.
No CLI or Server connector runs inside this branch. See
[Cloud agents](cloud-agents.md) for current limits and recovery semantics.

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
Counts cover the entire conversation, including thread replies. Legacy room cursors
remain valid, while `message_reads` records individually viewed or acknowledged
messages. The browser acknowledges messages after a short visible dwell in a
focused window; hidden channels, project tabs and unopened threads remain unread.
Inbox previews do not mark messages read. Inbox queries require current membership,
exclude own/deleted messages and use sequence pagination. Mark-all inserts receipts
only through the displayed snapshot, so later messages remain unread. Mentions
also retains read mentions. Read changes invalidate only that member’s sockets.
Older inbox targets load a bounded context window and can return to the latest replies. Optional Web Push notifies subscribed devices
about DMs, mentions, participated threads and terminal agent results.

Each member's Inbox Durable Object holds hibernating WebSockets. It sends only
invalidation identifiers; the browser fetches current data through authorized
HTTP endpoints. Notifications recheck session validity. Reconnect and periodic
refresh recover from missed invalidations. Ping/pong uses automatic responses.

Web Push subscriptions are bound to one authenticated browser session. Message
and terminal agent projection transactions insert per-subscription delivery rows
into D1. Immediate delivery and Cron recovery share atomic expiring claims;
before sending they recheck membership, active identity, session expiry, message
deletion and read position. Delivery uses RFC 8291 encryption and VAPID keys in
Worker secrets, with an explicit push-host allowlist and no redirects. Generic
payloads contain no chat text. Session deletion cascades to subscriptions and
queued deliveries. Expired subscriptions and old delivery records are pruned.
Web Push is best effort; retries can overlap an uncertain provider acceptance,
so stable notification tags also merge duplicate events on the device.

The PWA service worker caches only the public offline page and app icon. Private
HTML, APIs, attachments and credentials are never written into Cache Storage.
Offline navigation presents a reconnect screen rather than stale workspace data.

History is paginated in 100-message pages. Search uses a trigram FTS5 index for
queries of at least three characters and a substring scan for shorter queries,
including two-character Chinese terms. Search always checks conversation access.

## Connected agent turns

A human's explicit bot mention, a reply in an auto-trigger thread, or a message in a one-to-one bot DM, creates a
persistent agent request in the message transaction. Messages from bots never
trigger agents, preventing bot reply loops. Dispatchers retry queued requests;
a minute Cron Trigger also recovers committed requests after a missed dispatch
notification. concurrent turns are
serialized by the existing conversation and connector protocols.

A channel thread has a separate CLI session per bot. A bot DM keeps one session
for top-level messages. A reply thread inside a DM gets its own session. The existing Conversation DO stores the agent run,
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
from the CLI child's environment. Approved provider credentials are fetched for the active run and injected only
into that CLI process. Inherited GitHub/Cloudflare credential variables are
removed first. Other inherited environment variables and filesystem credentials remain the server operator's responsibility. `inherit`
uses the operator's existing CLI policy; it never activates automatically after
a sandbox failure. The web UI forwards native pending approvals and questions to the task author or
a workspace owner. Responses do not change the configured CLI policy.

`agent_threads` is the sole registry for connected agent sessions. The retired
single-owner workspace, its HTTP/WebSocket endpoints, duplicate search index,
and channel/thread/file directory have been removed. Upgrading an existing
installation also requires deleting standalone Conversation objects, connector
job copies and their R2 attachments before applying migration 0007. Current
`agent_threads` IDs and their durable CLI sessions must be retained.

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

## Workbench data

Profile names and usernames can change; member IDs stay stable. Mentions use
`<@person-id>` on the wire, with a snapshot mapping for older `@username` text.
The frontend resolves these to current display names. Code spans/fences remain
literal. Avatar objects are private R2 images with authenticated retrieval.

The browser appends pending messages before waiting for HTTP. The stable UUID
is reused for retries, including lost acknowledgements. D1 persistence precedes
the HTTP acknowledgement; inbox invalidation and agent dispatch use `waitUntil`.
The existing minute recovery job retries durable agent requests after interruption.
Pending drafts are memory-only; reloading discards an unsent draft.

Workspace settings live in a shared App Router layout. Client navigation keeps
its sidebar and authenticated workspace data mounted while each section loads
its own content. Section changes revalidate workspace metadata in the background;
only an unauthorized response returns the user to login. Skeletons match the
content region rather than replacing the page. Credential values are not cached.
Channel and thread message requests have separate loading state and request
sequences: opening a thread preserves the channel, and late responses cannot
replace another room or thread. Read markers only use the loaded room's messages.

Provider tokens and custom credential bundles are encrypted with AES-GCM, random 96-bit IVs and the
connection ID as authenticated context. `INTEGRATIONS_KEY` is a dedicated Worker
secret. Only the owner can manage connections, link repositories, approve bot
proposals and enable agent credentials per channel. Enabling one connection
of a provider disables other connections of that provider for agent use in
that channel. Human channel members can edit Issues through a linked repository;
this delegates the owner's connected GitHub permissions to that conversation.
Tokens are never returned by browser APIs. LLM/custom bundles use additive
`credentials` and `room_credentials` tables; existing repository integration
records and their foreign keys are preserved. Conflicting variable names fail
closed during both grant creation and task environment assembly.

A connector can fetch credentials only for a run on its server that is queued
or running. Each fetch rechecks bot membership and current channel grants.
Jobs and delivery journals never contain provider credentials. A random task
API token is also issued for repository metadata/proposals in that one channel;
its hash is stored in D1, and each request rechecks run state and bot membership.
It cannot approve repository links, edit Issues or access other rooms. Expired
task tokens are pruned when new tasks fetch credentials.

Issue APIs call GitHub directly; lists refresh on opening or changing filters.
There is no outbound webhook registration or background Issue synchronization.
Linked Issue threads add repository and Issue URLs to the agent prompt.

Usage comes from Codex `turn.completed.usage` or Claude's final `result.usage`.
The Conversation DO stores absolute per-run usage and a durable projection
queue. D1 upserts are guarded by event sequence, so replayed reports do not add
usage twice. Rows retain server, room, root message and CLI session IDs. Global
and filtered totals include all reports; detail tables cap at 500 latest groups.
Input totals include cache reads and writes; cached input is a subset. Pricing
is shown only if reported by the CLI; unknown model names are not inferred.
Cancelled/crashed turns without a usage report cannot be counted, and reports
before this release cannot be reconstructed. These are usage records, not a
replacement for the provider's billing statement.

## Project workspace and private steward

`casual_settings` selects one executable bot for the optional workspace steward.
`casual_rooms` maps a human/bot pair to a private group room with fixed members.
Top-level human turns use the room ID as the session root, like a bot DM, while
ordinary channel threads retain their existing identities. Current settings and
human/bot membership gate dispatch, model tools and task APIs. Cross-channel
reads explicitly resolve the human principal; they do not weaken `requireRoom`
or grant a general bot token access to other rooms. Integration overview and
health responses contain metadata only. Suggestions are proposals; channel
creation and external resource changes stay in authenticated human actions.

The Project database stores versioned Markdown with author and update provenance.
`room_workers` links named Workers to existing integration IDs without granting
credential use. Files projects posted, nondeleted `chat_files` into the Project
database; R2 remains private. GitHub Issues use the existing live API proxy.

The minute Cron scans due `channel_timers`. A D1 batch gates each occurrence on
its timer version, enabled flag, due time, membership and previous run completion.
A deterministic occurrence ID and unique `(timer_id, scheduled_at)` protect the
outbox against concurrent triggers. Timer roots have separate agent sessions,
and replies can continue with the assigned bot. Missed intervals coalesce and
next-at jumps forward. Pausing is for future scheduling; stopping a queued or
running turn uses the existing conversation cancellation path. Soft deletion
preserves occurrence provenance and chat history. See [project workspace](project-workspace.md)
for setup, access boundaries, cadence semantics and supported actions.

## Channel databases

Each channel can own several databases. D1 `channel_databases` is the catalog,
with channel membership and scoped, hashed, expiring integration tokens checked
on every request. Each catalog ID resolves to one SQLite `ChannelDatabase` DO.
JSON collections, validated records, schema versions, record history, changes
and request deduplication live in that object. Record batches and multi-collection
schema changes use synchronous SQLite transactions. No arbitrary SQL is exposed.

A channel's managed Project database owns Notes. Legacy D1 Notes import once
with stable IDs and provenance; all Notes writers now use DO records. The old
table is a migration archive, not a live replica. Files is a managed collection
projecting posted R2 attachment metadata. D1 triggers append publication and
deletion events in the source transaction; the DO consumes them before reads,
persisting its replay cursor atomically with records and changes. Downloads
recheck the live D1 message and room ACL. Neither drafts nor deleted-file history
are exposed by database APIs. R2 remains the blob store; Issues and Timer retain
their existing authorities. See [Channel databases](channel-databases.md) for API,
authorization, limits, migration and backup implications.

### Ordered agent output, deliveries and input requests

The UI groups consecutive activity parts into a small action button; its dialog
shows full commands and outputs, with live statuses. Text, deliveries and input
requests keep their positions between groups.

Conversation keeps stable ordered parts alongside the compatibility `text` and
`activity` fields. Connector `seq` remains the delivery deduplication cursor;
a separate local projection revision also advances for web answers. D1's
`event_seq` guards this projection revision, so answering a question cannot
consume the next CLI event or let a stale projection overwrite it.

Native interactive requests are recorded as pending parts. The response API
checks human membership, task ownership/owner role, active run and answer
schema. Conversation atomically records the first answer and retries delivery
through Connector until an `interaction_resolved` event arrives. The local
adapter deduplicates request IDs and distinguishes answered from expired
requests. Approval responses are one-shot (or the requested Codex turn-scoped
permissions); session grants and policy amendments are not exposed.

`POST /api/connector/artifacts` accepts bounded file bytes from an authenticated
Server for its active thread/run. It verifies bot membership and the existing
reply, derives a deterministic delivery ID, writes Markdown through the managed
Notes database or other bytes into R2, then records the result in
`agent_artifacts`. File index triggers update the existing managed `files`
collection. The connector emits the returned artifact reference in sequence;
Conversation resolves the saved metadata instead of trusting supplied links.
Deleting a reply clears parts and existing file authorization denies downloads.
Notes remain independent documents with their provenance link.
