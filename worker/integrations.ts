import { unseal } from "./credential-crypto";
export { seal, unseal } from "./credential-crypto";
import { credentialEnvironment } from "./credential-store";
import { env } from "cloudflare:workers";
import { hash, secret } from "./auth";
import { ChatError } from "./team-auth";
export type Integration = {
  id: string;
  provider: "github" | "cloudflare";
  name: string;
  identity: string;
  account_id: string | null;
  secret: string;
};
export async function connection(id: string) {
  const row = await env.DB.prepare("SELECT * FROM integrations WHERE id=?")
    .bind(id)
    .first<Integration>();
  if (!row) throw new ChatError(404, "Connection not found.");
  return row;
}
export async function providerRequest(
  provider: "github" | "cloudflare",
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const base =
    provider === "github"
      ? "https://api.github.com"
      : "https://api.cloudflare.com/client/v4";
  const response = await fetch(base + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "melancholy",
      "Content-Type": "application/json",
      ...(provider === "github"
        ? { "X-GitHub-Api-Version": "2022-11-28" }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new ChatError(
      response.status === 404 ? 404 : response.status === 429 ? 429 : 502,
      `${provider === "github" ? "GitHub" : "Cloudflare"} returned ${response.status}. Check this connection's access and permissions.`,
    );
  return response.json();
}
export async function github<T>(
  id: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const c = await connection(id);
  if (c.provider !== "github")
    throw new ChatError(400, "Choose a GitHub connection.");
  return providerRequest(
    "github",
    await unseal(c),
    path,
    method,
    body,
  ) as Promise<T>;
}
export function repositoryName(value: string) {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value) ||
    value.split("/").some((x) => x === "." || x === "..")
  )
    throw new ChatError(400, "Use owner/repository.");
  return value;
}
export async function jobEnvironment(
  serverId: string,
  threadId: string,
  runId: string,
  origin = "",
) {
  if (
    !(await env.CONVERSATIONS.getByName(threadId).canExecute(runId, serverId))
  )
    throw new ChatError(403, "This task is not active.");
  const mapping = await env.DB.prepare(
    "SELECT t.room_id,t.bot_id FROM agent_threads t JOIN people p ON p.id=t.bot_id JOIN room_members m ON m.person_id=p.id AND m.room_id=t.room_id WHERE t.thread_id=? AND p.server_id=? AND p.active=1",
  )
    .bind(threadId, serverId)
    .first<{ room_id: string; bot_id: string }>();
  if (!mapping)
    throw new ChatError(
      403,
      "This agent no longer has access to the conversation.",
    );
  const rows = await env.DB.prepare(
    "SELECT i.* FROM integrations i JOIN room_integrations r ON r.integration_id=i.id WHERE r.room_id=? AND r.agent_enabled=1",
  )
    .bind(mapping.room_id)
    .all<Integration>();
  const result: Record<string, string> = await credentialEnvironment(
    mapping.room_id,
  );
  for (const c of rows.results) {
    const token = await unseal(c);
    if (c.provider === "github") {
      result.GH_TOKEN = token;
      result.GITHUB_TOKEN = token;
    } else {
      result.CLOUDFLARE_API_TOKEN = token;
      if (c.account_id) result.CLOUDFLARE_ACCOUNT_ID = c.account_id;
    }
  }
  if (origin) {
    const token = secret();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM task_credentials WHERE expires_at<?").bind(
        Date.now(),
      ),
      env.DB.prepare(
        "INSERT INTO task_credentials VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at",
      ).bind(
        runId,
        await hash(token),
        serverId,
        threadId,
        mapping.room_id,
        mapping.bot_id,
        Date.now() + 86400000,
      ),
    ]);
    result.MELANCHOLY_API_TOKEN = token;
    result.MELANCHOLY_URL = origin;
    result.MELANCHOLY_ROOM_ID = mapping.room_id;
  }
  return result;
}
export async function repositoryContext(roomId: string, rootId: string) {
  const repositories = await env.DB.prepare(
    "SELECT full_name,url FROM room_repositories WHERE room_id=? AND approved=1",
  )
    .bind(roomId)
    .all<{ full_name: string; url: string }>();
  const issue = await env.DB.prepare(
    "SELECT url FROM issue_threads WHERE root_id=?",
  )
    .bind(rootId)
    .first<{ url: string }>();
  const root = await env.DB.prepare(
    "SELECT text FROM chat_messages WHERE id=? AND room_id=? AND deleted_at IS NULL",
  )
    .bind(rootId, roomId)
    .first<{ text: string }>();
  return (
    (root ? "\n\nThread opening message:\n" + root.text : "") +
    "\n\nWorkspace context:\n" +
    repositories.results
      .map((r) => `Repository: ${r.full_name} (${r.url})`)
      .join("\n") +
    (issue ? "\nGitHub issue: " + issue.url : "") +
    "\nApproved service credentials, when enabled for this channel, are provided in environment variables. Never print credentials. For workspace repository proposals, use MELANCHOLY_API_TOKEN with GET /api/v1/rooms/$MELANCHOLY_ROOM_ID/repositories or POST the same endpoint with {fullName,connectionId}; requests require owner approval. GET /api/v1/rooms/$MELANCHOLY_ROOM_ID/connections returns available connection IDs. This workspace token is scoped to this active task and cannot approve proposals. Use the connected repositories for this conversation; do not assume the current directory is the correct checkout."
  );
}
