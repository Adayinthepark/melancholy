# melancholy

Read `README.md` and `docs/architecture.md` before changing runtime behavior.
Product scope: a minimal Slack-style workspace for people and agents, including
public/private channels, direct/group messages, threads, mentions, reactions,
editing/deletion, unread counts, files, search and scoped bot integrations.

- Frontend: vinext App Router and the installed shadcn/ui primitives.
- Hosting: Cloudflare Workers, SQLite Durable Objects, D1 and private R2.
- Server connector: Node.js, `packages/connector`, outbound WebSocket.
- Keep the neutral palette and restrained typography in `docs/design.md`.
- Do not insert mock conversations, fake connected states, marketing sections,
  or decorative AI motifs into the production workspace.
- Preserve per-thread CLI session IDs and durable event deduplication.
- Read applicable skills in `.agents/skills`; their source lock is committed.
- Never commit `.dev.vars`, connector configuration, tokens, or live journals.
- Run typecheck, Worker tests, connector tests, relevant browser tests and the
  production build for changes to runtime behavior.
- Deploy only to the explicitly requested account and hostname. For a new
  installation, replace this workspace's resource IDs in `wrangler.jsonc`.
