# Connections and Issues

1. Open **Settings → Connections**. Add a GitHub personal access token or a
   Cloudflare API token. Tokens are checked before the encrypted record is saved.
2. Open a channel's **Repositories and issues → Repositories & connections**.
   Link one or more GitHub repositories using `owner/repository`.
3. In that channel, enable the connections the coding agent should receive.
   Linking a repository alone does not export its token to the server.
4. Use **Issues** to browse open/closed issues, create or edit an issue, set
   labels/assignees, comment, close/reopen and **Work in thread**.
5. Choose an agent under **Auto trigger** in the thread. Its future human
   replies start turns without a mention. Open the expanded thread page for
   focused work.

The GitHub token needs access to the selected repositories and **Issues:
read/write** for editing. Grant additional permissions only for the operations
you want the coding agent to perform (for example Contents write for pushing
code). Cloudflare tokens need the specific account/resource permissions for
that project's deployments. The optional Cloudflare account ID is passed to
Wrangler as `CLOUDFLARE_ACCOUNT_ID`. This release accepts user API tokens;
it does not install a GitHub App or perform an OAuth browser flow.

Channel members can operate on Issues through the shared connection. Attach
private repositories only to conversations whose members should have that
access. The owner manages all connections and approvals. Disconnecting a
connection removes its channel links and repository/Issue associations.

GitHub data is fetched when the Issue view opens or its filters change. Lists
are paginated in 30-item GitHub pages (pull requests are excluded); the detail
pane displays the first 100 comments and links to the full GitHub Issue.
There is no automatic GitHub webhook synchronization in this release.

## Bot proposals

An API bot may `POST /api/v1/rooms/:room/repositories` with:

```json
{ "fullName": "owner/repository", "connectionId": "CONNECTION_ID" }
```

The owner must already have linked that GitHub connection to the room. The
response is `202` with `approved: false`; the proposed repository is invisible
to Issue APIs until approved under **Repositories & connections**. A bot cannot
approve its own proposal. Repeating a pending/existing link returns `409`.

Connected coding agents receive a task-scoped API token. They can use:

| Method | Path                                               | Purpose                            |
| ------ | -------------------------------------------------- | ---------------------------------- |
| GET    | `/api/v1/rooms/:room/connections`                  | Connection metadata, never secrets |
| GET    | `/api/v1/rooms/:room/repositories`                 | Approved links and own proposals   |
| POST   | `/api/v1/rooms/:room/repositories`                 | Submit a proposal for approval     |
| GET    | `/api/v1/repositories/:id/issues`                  | Read approved repo Issues          |
| GET    | `/api/v1/repositories/:id/issues/:number`          | Read an Issue                      |
| GET    | `/api/v1/repositories/:id/issues/:number/comments` | Read comments                      |

The task token is accepted only while that run is active, in that one channel.
Use the explicitly enabled `GH_TOKEN` for coding and Issue changes from the CLI.

## Usage

Open the usage button on a channel, thread or server. **Settings → Integrations
→ Workspace token usage** shows global totals. Input includes cached tokens;
cached input is not added twice. Reports are attributed to the server, channel
and thread that executed the turn, even if names change later.

Only CLI-reported usage after upgrading the Worker and connector is recorded.
A cancelled or failed CLI may not emit usage; older runs are not backfilled.
Codex often does not report its model name in the JSON usage event, so the UI
shows the runtime instead. Provider billing remains authoritative.
