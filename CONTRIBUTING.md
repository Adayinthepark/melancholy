# Contributing

Keep changes focused and include a reproduction when fixing a bug.

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Before opening a pull request:

```sh
npm run typecheck
npm test
npm run test:connector
npm run test:e2e
npm run build
```

Install Chromium and WebKit with `npx playwright install chromium webkit` before browser tests.
Use `npx playwright install --with-deps chromium webkit` on a fresh Linux runner.
Browser tests use the key in your local `.dev.vars`; no live agent credentials
are required. Never include real prompts, tokens or connector journals in a PR.

The design is neutral, compact, and content-first. Use the shadcn components
already in the repository, maintain keyboard navigation, and check both themes
at desktop and phone widths. New product copy should describe an action or a
state, without promotional language.

Changes to storage or delivery should account for duplicate events, process
restarts, permission revocation and failed external operations. Review
[architecture](docs/architecture.md) before changing the protocol.
