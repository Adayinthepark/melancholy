# melancholy connector

Connect an existing Codex or Claude Code installation to a melancholy workspace.
Node.js 22 or newer is required. The connector opens an outbound WebSocket;
no public port or reverse proxy is needed on the server.

In the workspace, open **Workspace settings → Servers**, name the machine, and
choose the runtime. Save the generated configuration as `melancholy.json` on
the server, outside your source repository. Set `cwd` to the project directory.

```json
{
  "url": "https://your-workspace.example",
  "token": "TOKEN_FROM_WORKSPACE_SETTINGS",
  "runtime": "codex",
  "cwd": "/srv/project",
  "permission": "read-only"
}
```

```sh
chmod 600 melancholy.json
npx --yes --package=github:adayinthepark/melancholy melancholy-connect --config ./melancholy.json
```

Or from a checkout:

```sh
npm ci
node packages/connector/bin.mjs --config /path/to/melancholy.json
```

`MELANCHOLY_TOKEN` can supply the token instead of the file. CLI flags include
`--url`, `--runtime`, `--cwd`, `--permission`, `--timeout` and `--state-dir`.
`--help` lists the available options. Tokens are not accepted as command-line
arguments. Keep the configuration and journal out of Git.

Authenticate the selected CLI on this server before connecting. The connector
uses the CLI's existing model and authentication settings. It does not select
a model or host inference on Cloudflare.

The default permission is `read-only`. Set `workspace-write` in the local
configuration when the agent should edit the project. For Codex this sets the
workspace sandbox; for Claude it selects `acceptEdits`. Native CLI approval requests are forwarded to the chat. A task author or workspace
owner with channel access can approve that request or decline it. The connector
does not change the CLI approval policy or add lasting permission rules.

Use `permission: "inherit"` only when the server's existing CLI policy is the
intended execution policy, such as an already isolated container. This passes
no sandbox or permission override to the CLI and may grant access outside
`cwd`. It is an explicit local configuration choice, never an automatic fallback
when a sandbox fails. A browser cannot change this setting.

Each thread gets an independent CLI session. Subsequent turns use the explicit
session ID, never the CLI's global `--last` or `--continue` selection. The default
turn timeout is 900 seconds, including time spent waiting for input. Stop sends a termination signal to the CLI process
group and forces termination after five seconds if needed. Network reconnects preserve an active child process and replay pending
output; a connector process restart marks an active turn interrupted.

The journal is stored under `~/.local/state/melancholy/` by default. Preserve it
across restarts to retain received-job deduplication. It contains conversation
output and should be treated as private data.

### Attachment downloads

Before starting the CLI, the connector downloads the message's attachments from
the private file API using the server bot's channel membership. Files are capped
at 10 MB, checked against their expected size, and atomically saved with private
permissions. The CLI receives their local paths; it does not need R2 credentials.

Each download has a 60-second deadline covering headers and body. Network failures,
timeouts, HTTP 408/429 and 5xx responses retry up to three total attempts. HTTP
401/403/404 and oversized files fail without retry. Download/retry/failure details
appear in the action list. Stop also aborts pending downloads. An exhausted failure
names the file and states that the agent has not started.

During an active task, the CLI may also download earlier attachments from the
same conversation with `GET $MELANCHOLY_URL/api/files/FILE_ID` and
`Authorization: Bearer $MELANCHOLY_API_TOKEN`. The thread context includes the
opening message's attachment IDs, so continuing a failed first turn does not
require re-uploading. The token expires with the task; drafts, deleted messages,
and inaccessible conversations remain unavailable.

## Run as a service

Use a dedicated server account with access to the project and its CLI login.
Adjust executable paths to match the machine. A systemd example:

```ini
[Unit]
Description=melancholy connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=melancholy
WorkingDirectory=/opt/melancholy
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /opt/melancholy/packages/connector/bin.mjs --config /etc/melancholy/connector.json
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

Use an explicit, backed-up `--state-dir` for container deployments. Removing a
server in workspace settings revokes its token and closes its connection.

## Channel credentials and usage

Use the connector from the same release as the Worker. Version 0.3 and later fetch
`/api/connector/environment` before spawning each task and fails explicitly if
that authenticated request fails. Enable service credentials in the
channel's repository settings. The child receives `GH_TOKEN`, `GITHUB_TOKEN`,
`CLOUDFLARE_API_TOKEN` and, when configured, `CLOUDFLARE_ACCOUNT_ID`.
These provider variables are removed from the inherited environment first.
The service's `MELANCHOLY_TOKEN` is never passed to the child.

A short-lived, channel-scoped `MELANCHOLY_API_TOKEN`, `MELANCHOLY_URL` and
`MELANCHOLY_ROOM_ID` let the agent read repository context and propose new
repository links. This token is invalid once the run ends and cannot approve
its own proposals. See [connections](../../docs/connections.md).

Exact token values are redacted from emitted text, tools and error details.
This is a transport precaution, not an isolation boundary: a privileged CLI
can still read the server's filesystem and other locally configured logins.
Use a dedicated OS account/container when those credentials must be isolated.
Disabling a channel connection affects future fetches; stop an active task
and revoke the provider token if it must lose access immediately.

Codex and Claude usage reports are sent as absolute per-run counters. Missing
usage stays unreported; the connector does not estimate tokens from text.
Claude usage and multi-model result handling are covered by fixtures; a live
Claude installation is still required to validate a particular CLI version.

Version 0.4 supports LLM and custom credentials added under Workspace settings after
upgrading and restarting the connector. The worker sends only active grants.
The connector accepts service credential variable names and rejects process or
bridge configuration overrides; `environment-policy.mjs` is shared with the
Worker validator. Values apply only to the child environment, never `process.env`.
Existing operator CLI authentication is retained unless the task explicitly
provides that provider's key. Exact approved values are redacted from emitted
text and tool events; transformed/encoded secret values are not guaranteed to
be redacted. Use an isolated OS account when host credentials must be inaccessible.

## Deliveries and interactive tasks (0.5)

Upgrade the Worker and restart the connector from this release together. Codex
now uses **app-server JSON-RPC**, retaining explicit thread IDs from previous
`codex exec` sessions. Tested with Codex CLI **0.153.4**. Claude uses the CLI's
**stream-json input/output and stdio control protocol**, including its initialize
handshake; a current Claude Code CLI is required. No additional model API key or
SDK-hosted runtime is required. Unsupported protocol requests are rejected and
shown as failed actions; they are never silently approved.

The connector creates `.melancholy/outputs/<run-id>/` beneath its configured
`cwd`, supplies its absolute path in `MELANCHOLY_OUTPUT_DIR`, and tells the agent
to put final deliverables there. Add `.melancholy/` to the project's `.gitignore`.
The local CLI's filesystem policy still applies. When the CLI closes, the
connector collects this directory before marking the task finished:

- Channel `.md` / `.markdown` files become Notes in the Project database, with
  the bot author and a source-conversation link. These remain normal editable,
  versioned Notes, available through Data and the existing API.
- Other files go to private R2 and the channel's Files index. The chat shows
  document cards, image previews and download links. In DMs, Markdown is a
  downloadable file because DMs do not have a channel Notes collection.
- Collection is explicit: ordinary repository changes and files elsewhere on
  the server are not copied. Previous tasks are not backfilled. Hidden files,
  `.tmp` and `.part` files are ignored; symlinks, hardlinks and credential-file
  names are refused. Exact task credential values also block publication.
- Limits: 16 deliveries, 8 binary/non-document attachments per reply, 10 MB per
  file, 99,000 Markdown characters recommended. Failed delivery is visible in
  chat, and the original files remain on the server. Upload retries deduplicate
  by run, filename and content. A document saved to Notes has its own lifecycle;
  deleting its source message does not delete the Note.

Each CLI text item and tool call has a stable ID. Streaming updates and completed
tool results update that item in place, preserving the order of commentary,
actions, questions and final text. Older stored messages cannot recover ordering
that the old connector did not record; they remain readable.

Codex command/file approvals, turn-scoped permission requests and
`request_user_input` questions are supported. Claude `can_use_tool` approvals
and `AskUserQuestion` are supported, including multiple choice and free text.
The original tool arguments stay in the connector process; browser responses
cannot replace them. Only a native pending request creates a questionnaire.
Plain prose such as “May I continue?” is a normal chat reply.

Responses require a signed-in human with write access to that conversation who
is either the task author or a workspace owner. Responses are durably queued
until the live connector receives them. Refreshing or a WebSocket reconnect
preserves pending questions; double submissions, stopped/expired requests and
responses for other jobs are rejected. Connector process restarts still mark
interrupted tasks failed instead of repeating possible side effects. The local
turn timeout also closes unanswered prompts. Secret-input questions and other
unsupported elicitation types are rejected rather than collecting credentials
in a shared conversation.

Protocol references: [Codex app-server](https://developers.openai.com/codex/app-server/)
and [Claude approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input).
