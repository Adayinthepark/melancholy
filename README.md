# melancholy

A minimal Slack-style workspace for people and agents. Runs on Cloudflare.

Public and private channels, direct messages, group conversations and threads
share one interface. Connect a server running Codex or Claude Code and talk to
its bot in a channel or a direct message. Agent sessions stay on that server;
workspace data stays in your Cloudflare account.

[async.love](https://async.love) is the owner's private installation.

## Features

- Invite-only member accounts with individual credentials.
- Public/private channels, one-to-one messages, group messages and thread replies.
- Markdown, member mentions, emoji reactions, editing and deletion.
- Unread and mention counts, synchronized read positions and live updates.
- Private file uploads, image previews, paginated history and message search.
- Bot identities, scoped API tokens, incoming webhooks and an event cursor API.
- Codex and Claude Code connectors, explicit session resumption, execution logs
  and task cancellation.
- shadcn/ui, light/dark themes and mobile navigation.

This is a small workspace application, not an implementation of Slack's API.
Calls, native push, Slack imports, email delivery, SSO and enterprise audit
controls are outside the current release. Unread notifications are in-app.

## Stack

| Part                                     | Implementation                                 |
| ---------------------------------------- | ---------------------------------------------- |
| Frontend                                 | vinext, React, TypeScript, shadcn/ui           |
| Hosting                                  | Cloudflare Workers and Static Assets           |
| Members, chat, search, bot events        | D1, FTS5                                       |
| Realtime delivery and agent coordination | SQLite Durable Objects, hibernating WebSockets |
| Attachments                              | Private R2 bucket                              |
| Server connector                         | Node.js 22+, Codex CLI or Claude Code          |

[Architecture](docs/architecture.md) · [Bot API](docs/bot-api.md) ·
[Connector setup](packages/connector/README.md) · [Contributing](CONTRIBUTING.md)

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Set a random `WORKSPACE_KEY` of at least 32 characters in `.dev.vars`. On the
sign-in screen, choose **Use workspace key** for the owner account. In Settings,
set a display name and password; the owner can then sign in as `owner`.

Create a one-use invitation in **Settings → Members** for each teammate. The
recipient chooses a username, display name and password. Invitations expire
in seven days. Removing a member's access invalidates their browser sessions.

Public channels are visible to workspace members. Joining is required to post.
Private channels and direct/group conversations are visible only to their
participants, including in search, exports and file downloads. The owner
identity does not bypass these conversation checks in the shared workspace.

## Agents and bots

In **Settings → Integrations → Connect an agent server**, create a server and
follow the connector instructions. Add its bot through a channel's member
settings, then `@mention` its username. In a direct message with that bot, each
message starts an agent turn. Channel replies continue the CLI session for
that thread and bot; mention the bot again to request a follow-up.

Only the owner can add bots to conversations. Members of those conversations
can invoke connected agents, using the permissions configured on the server.
The connector defaults to read-only. Browser users cannot change CLI sandbox
settings. Model authentication and inference billing remain with the CLI.

Standalone bots can use the [message API and incoming webhooks](docs/bot-api.md).
Credentials are shown once, stored as hashes and revocable in Settings.

## Deploy your own workspace

The checked-in Wrangler configuration describes the owner's `async.love`
installation. Forks must replace its account, domain and resource identifiers.

1. Sign in with `npx wrangler login`.
2. Create a database and bucket with `npx wrangler d1 create <name>` and
   `npx wrangler r2 bucket create <name>`.
3. Update `wrangler.jsonc`: Worker name, account, domain, workspace name, D1
   database and R2 bucket. Keep the Durable Object bindings and migrations.
4. Apply the migrations with `npm run db:remote` (adjust the database name in
   package scripts for your installation).
5. Set `WORKSPACE_KEY` using `npx wrangler secret put WORKSPACE_KEY`.
6. Run `npm run deploy`.

Generate a key with `openssl rand -hex 32`. Never commit it or connector config.
Existing installations retain their owner sessions and earlier agent history;
that history is available to the owner at `/legacy`.

Workers Paid starts at $5/month. Actual charges depend on database writes,
active Durable Object time, storage and request volume. Model inference is
separate. [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Checks

```sh
npm run typecheck
npm test
npm run test:connector
npx playwright install chromium
npm run test:e2e
npm run build
```

Runtime tests exercise permissions across multiple members, private search and
files, invitations, messages, pagination, bot scopes, event delivery and agent
session continuity. Browser tests use separate member sessions to exercise
channels, threads, reactions, editing, files, direct/group messages and unread
counts. They do not make paid model calls.

Project skills include frontend-design, shadcn, vinext, Durable Objects,
Workers best practices and Wrangler. Sources are recorded in `skills-lock.json`.

## License

MIT. See [third-party notices](THIRD_PARTY_NOTICES.md) for components, fonts and
bundled skills.
