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
