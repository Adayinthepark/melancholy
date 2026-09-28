# Cloudflare agents (experimental)

Cloud agents run without a connected server. In **Workspace settings → Bots**,
choose **Cloudflare · built-in Pi**, select an existing LLM key, enter the exact
model ID from that provider, and create the bot. Add it to a conversation or
start a DM. Mentions, automatic thread replies, stopping, files and usage use
the existing workspace interface.

The owner can configure the model, instructions and step limit later. Finish
or stop active tasks before changing those settings. An existing Server bot
keeps its CLI sessions; switching an existing bot between runtimes is not
supported. Create another bot to use another runtime.

## What runs where

- Cloudflare Agents SDK owns durable acceptance, background execution and recovery.
- Pi's actual `@earendil-works/pi-agent-core` package runs the model/tool loop.
- Cloudflare Computer stores each thread/bot's files in Durable Object SQLite.
- Shell and JavaScript execution run in isolated Dynamic Workers with no network
  or credential bindings. The two backends share the persistent files.
- The chosen external model provides reasoning and decides which tools to call.

The current integration uses Pi's core, not the complete Pi CLI and extension
runtime. It supplies workspace-specific tools, instructions, transcript
checkpoints, tool-result journaling and context summarization. Multi-step
planning quality depends on the selected model and must be evaluated on real
tasks; installing an SDK is not an intelligence or benchmark guarantee.

## Tools and limits

Tools include `update_plan`, `read`, `write`, exact-match `edit`, `bash`,
`javascript`, `read_thread`, `search_messages`, `github_read`,
`import_attachment`, and `publish_file`.

`bash` is a lightweight emulated shell: commands such as `ls`, `cat`, `grep`
and `sed` work. It cannot install npm dependencies, run arbitrary native
programs, or start background services. `javascript` executes an ES module
with `export default async function(input)` and workspace-backed
`node:fs/promises`. It is useful for data transformations and JavaScript checks.
Full Linux builds still require a connected Server. The Container backend is
not provisioned by this release.

GitHub reads require both an approved repository link and agent access enabled
for its GitHub connection in that conversation. This tool does not create
issues, push commits or open PRs. It never gives the model a GitHub token.
Thread reads and attachment imports stay in the current thread; message
search stays in the current conversation. Files published by an agent follow
the same membership and deleted-message checks as ordinary attachments.

Tasks default to 40 model steps, configurable from 1 to 100, and stop after
10 minutes. Individual code executions have a 30 second limit. A follow-up
continues using the same files and transcript. Large tool results are bounded;
read large files in parts. Context is summarized between conversation turns
when it approaches the configured window. A single task that fills the window
stops with an explicit error instead of silently discarding context.

## Credentials and billing

Selecting a model key explicitly grants that bot use of the key in conversations
it joins. Only the owner creates/configures bots or adds them to conversations.
Other members of those conversations can invoke the bot and spend that key's
provider balance. This is a workspace-owned credential, not a personal key.

Keys stay encrypted in D1 under the existing Workers secret. The model key is
decrypted only for an active task and is never placed in client-synchronized
state, tools, job payloads or the Computer filesystem. Access and credential
existence are rechecked before model requests and tool calls. Model requests
do not follow redirects. Revoking the key or removing the bot stops further
work at the next boundary; an already accepted provider request may still cost
money. Rotate keys through the existing LLM key screen.

Inference uses the selected provider account. Cloudflare bills Workers,
Durable Objects and Dynamic Worker resources separately. Usage records include
reported input/output/cache tokens, including summarization; prices remain
unknown rather than using guessed rates. There is no hard monetary budget,
AI Gateway routing or automatic provider fallback in this release.

## Recovery

Each thread/bot has a separate Cloud Agent object. The existing Conversation
object remains responsible for durable output projection, task status and
deduplication. The Agent object journals finalized model messages and tool
results. Completed tool results can be restored without executing that tool
again. An interrupted tool with no recorded result is reported as uncertain;
the model must inspect state before deciding to retry. This is not an
exactly-once guarantee for arbitrary operations.

Computer and this integration are experimental. Versions are pinned. Keep
important work in version control or download it as an attachment. Do not
rely on the virtual filesystem as the only copy of valuable project data.

## Deployment

Apply D1 migration `0009_cloud_agents.sql`, retain the `CLOUD_AGENTS` SQLite
Durable Object binding/migration and the `LOADER` Worker Loader binding, then
build and deploy normally. No container image or separate server is required.
The Vite configuration resolves `just-bash` to its portable browser build so
Node native addons are not bundled into Workers.

Runtime tests exercise the real Pi loop with deterministic model streams,
shared JavaScript/shell files, restart continuity, cancellation, request
deduplication, authorization, private downloads and token projection. They do
not measure a provider model's task-solving quality or make paid model calls.

Sources: [Agents SDK](https://developers.cloudflare.com/agents/),
[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/agent),
[Computer](https://github.com/cloudflare/computer).
