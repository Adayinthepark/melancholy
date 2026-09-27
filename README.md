# melancholy

A workspace for conversations with agents on your own machines.

Connect Codex or Claude Code, open a thread, and keep working. Each thread
retains its CLI session. Messages, execution logs and attachments stay in your
Cloudflare account; the agent runs against the project on your server.

[async.love](https://async.love) is the owner's private workspace.

## What works

- Channels and independent agent threads.
- Codex and Claude Code connectors using an existing CLI installation.
- Live message and tool updates, session resumption, and stopping a turn.
- Durable history, retry deduplication, and reconnect recovery.
- File attachments, image previews, and authenticated downloads.
- Message search, thread renaming, archiving, and JSON exports.
- A compact shadcn/ui interface with light and dark themes and mobile navigation.

Version 0.1 is a single-owner workspace. Multi-user membership, private-channel
permissions, Slack imports, native push and calls are not implemented.

## Stack

| Part                    | Implementation                                 |
| ----------------------- | ---------------------------------------------- |
| Web application         | vinext, React, TypeScript, shadcn/ui           |
| Hosting                 | Cloudflare Workers and Static Assets           |
| Conversations and relay | SQLite Durable Objects, hibernating WebSockets |
| Directory and search    | D1, FTS5                                       |
| Attachments             | Private R2 bucket                              |
| Server connector        | Node.js 22+, Codex CLI or Claude Code          |

[Architecture and limits](docs/architecture.md) · [Connector setup](packages/connector/README.md) · [Contributing](CONTRIBUTING.md)

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Set a random `WORKSPACE_KEY` of at least 32 characters in `.dev.vars`, then use
that key to sign in. Local mode uses Miniflare storage. No Cloudflare deployment
or paid model call is required to run the web app and automated tests.

To make real agent calls, use **Settings → Connect server** and follow the
[connector instructions](packages/connector/README.md). The default agent
permission is read-only; allow edits through the server's local configuration.

## Deploy your own workspace

The checked-in Wrangler configuration describes the owner's `async.love`
installation. Forks must replace the account, domain and resource identifiers.

1. Sign in with `npx wrangler login`.
2. Create your database and bucket with `npx wrangler d1 create <name>` and
   `npx wrangler r2 bucket create <name>`.
3. Update `wrangler.jsonc`: `name`, `account_id`, `routes`, `WORKSPACE_NAME`,
   D1 identifiers and R2 bucket name. Keep the DO bindings and migrations.
4. Run `npm run db:remote` for the database name in your scripts/config.
5. Set the production key with `npx wrangler secret put WORKSPACE_KEY`.
6. Run `npm run deploy`.

You can generate a key locally with:

```sh
openssl rand -hex 32
```

Do not commit keys or connector configuration. The application fails closed
when `WORKSPACE_KEY` is missing. To rotate owner access, replace the secret
and delete existing D1 session records. Connector tokens can be revoked
individually in Settings.

Workers Paid starts at $5/month. Actual charges depend on active DO duration,
storage and operations; agent inference is billed by the configured CLI
provider. See the [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Checks

```sh
npm run typecheck
npm test
npm run test:connector
npx playwright install chromium
npm run test:e2e
npm run build
```

The project includes frontend-design, shadcn, vinext, Durable Objects, Workers
best practices and Wrangler skills under `.agents/skills`. Their origins are
recorded in `skills-lock.json`.

## License

MIT. See [third-party notices](THIRD_PARTY_NOTICES.md) for bundled components,
fonts and skills.
