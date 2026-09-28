# Connections and Issues

1. Open **Workspace settings → GitHub / Cloudflare**. Add a GitHub personal access token or a
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

Open the usage button on a channel, thread or server. **Workspace settings → Usage** shows global totals. Input includes cached tokens;
cached input is not added twice. Reports are attributed to the server, channel
and thread that executed the turn, even if names change later.

Only CLI-reported usage after upgrading the Worker and connector is recorded.
A cancelled or failed CLI may not emit usage; older runs are not backfilled.
Codex often does not report its model name in the JSON usage event, so the UI
shows the runtime instead. Provider billing remains authoritative.

## LLM keys and custom credentials

Workspace administration lives at `/settings/workspace`. Its navigation includes
General, Members, Cloudflare, GitHub, LLM keys, Custom credentials, Servers, Bots,
and Usage. The account menu opens Profile settings separately. Workspace settings
are owner-only; changes to the workspace name persist in D1.

Under **LLM keys**, add an OpenAI compatible, Anthropic compatible, DeepSeek,
Kimi or GLM key. Compatible providers accept an HTTPS API base URL. This saves
credentials without making a paid inference call or claiming the key was verified.
The provider presets export:

| Provider             | Environment variables                     |
| -------------------- | ----------------------------------------- |
| OpenAI compatible    | `OPENAI_API_KEY`, `OPENAI_BASE_URL`       |
| Anthropic compatible | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |
| DeepSeek             | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`   |
| Kimi                 | `MOONSHOT_API_KEY`, `MOONSHOT_BASE_URL`   |
| GLM                  | `ZHIPU_API_KEY`, `ZHIPU_BASE_URL`         |

The connector passes these values to the active CLI child. It does not change
the CLI model configuration or switch an existing subscription to API billing.
For another service using an OpenAI/Anthropic protocol, choose the compatible
preset and its endpoint, then configure the agent on the server accordingly.

**Custom credentials** stores up to 20 named values per entry. Multiline content
is preserved; a private-key file up to 16 KB can populate a field. The App Store
Connect template uses `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_PRIVATE_KEY`. These
are values for the agent to use; the application does not mint Apple JWTs itself.
Names must be service-prefixed and end in `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`,
`_ID`, `_URL`, `_JSON` or `_CERTIFICATE`. Process configuration and bridge variables
are reserved and cannot be overridden through this form.

Use **Channel access** on a credential, or a channel's repository settings, to
enable it for a conversation. Being saved alone never grants an agent access.
Conflicting variable names are rejected; disable the older grant first. Replacing
values retains current grants and requires the same provider and variable names.
Removing a credential deletes its grants. Running processes may already hold the
old values; stop the task and revoke the upstream credential for immediate removal.

## Storage

Secret values are AES-256-GCM ciphertext in Cloudflare D1. A random IV and the
record ID as authenticated data prevent ciphertext reuse between records. The
separate encryption root is `INTEGRATIONS_KEY`, held in **Workers Secrets**. It
is not in D1, browser responses or source control. Back it up separately and do
not replace it without migrating existing ciphertext. Metadata APIs never return
secret values, even to the owner. Replacement is write-only.

Cloudflare Secrets Store currently binds each named secret to a Worker at
configuration time and limits its beta to 100 secrets per account. D1 ciphertext
with a Workers Secret root lets workspace credentials be added and revoked at
runtime without deploying new bindings or giving the application an account-wide
Secrets Store management token. See [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[Secrets Store bindings](https://developers.cloudflare.com/secrets-store/integrations/workers/)
and [current limits](https://developers.cloudflare.com/secrets-store/manage-secrets/).
