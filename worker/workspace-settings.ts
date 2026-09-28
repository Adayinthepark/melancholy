import { env } from "cloudflare:workers";
export async function workspaceInfo() {
  const row = await env.DB.prepare(
    "SELECT name,description FROM workspace_settings WHERE id='workspace'",
  ).first<{ name: string; description: string }>();
  return row || { name: env.WORKSPACE_NAME, description: "" };
}
