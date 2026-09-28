# melancholy connector

Connect an existing Codex or Claude Code installation to a melancholy workspace.
Node.js 22 or newer is required. The connector opens an outbound WebSocket;
no public port or reverse proxy is needed on the server.

In the workspace, open **Settings → Connect server**, name the machine, and
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
workspace sandbox; for Claude it selects `acceptEdits`. Commands that need an
interactive approval cannot be approved from the web UI in this release.

Use `permission: "inherit"` only when the server's existing CLI policy is the
intended execution policy, such as an already isolated container. This passes
no sandbox or permission override to the CLI and may grant access outside
`cwd`. It is an explicit local configuration choice, never an automatic fallback
when a sandbox fails. A browser cannot change this setting.

Each thread gets an independent CLI session. Subsequent turns use the explicit
session ID, never the CLI's global `--last` or `--continue` selection. The default
turn timeout is 900 seconds. Stop sends a termination signal to the CLI process
group and forces termination after five seconds if needed. Network reconnects preserve an active child process and replay pending
output; a connector process restart marks an active turn interrupted.

The journal is stored under `~/.local/state/melancholy/` by default. Preserve it
across restarts to retain received-job deduplication. It contains conversation
output and should be treated as private data.

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

Use the connector from the same release as the Worker. Version 0.3 fetches
`/api/connector/environment` before spawning each task and fails explicitly if
that authenticated request fails. Enable GitHub/Cloudflare connections in the
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
