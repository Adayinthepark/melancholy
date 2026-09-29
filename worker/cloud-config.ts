import { scheduledMessageAllowed } from "./channel-timers";
import { assertCasualActive, isCasual } from "./casual";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { ChatError } from "./team-auth";
import { unseal } from "./credential-crypto";
import { providerPresets } from "../lib/credentials";
import type { Credential } from "./credential-store";

export const cloudBotInput = z.object({
  credentialId: z.string().uuid(),
  model: z.string().trim().min(1).max(120),
  instructions: z.string().trim().max(12000).default(""),
  maxSteps: z.number().int().min(1).max(100).default(40),
  contextWindow: z.number().int().min(16000).max(200000).default(64000),
});
export type CloudBotConfig = {
  bot_id: string;
  credential_id: string | null;
  model: string;
  instructions: string;
  max_steps: number;
  context_window: number;
};
export async function modelCredential(id: string | null) {
  const row = await env.DB.prepare("SELECT * FROM credentials WHERE id=?")
    .bind(id)
    .first<Credential>();
  if (!row || row.provider === "custom")
    throw new ChatError(400, "Choose an LLM credential.");
  return row;
}
export async function cloudAccess(threadId: string) {
  const row = await env.DB.prepare(
    "SELECT c.*,t.room_id,t.root_id FROM cloud_bots c JOIN people p ON p.id=c.bot_id JOIN agent_threads t ON t.bot_id=p.id JOIN room_members m ON m.person_id=p.id AND m.room_id=t.room_id WHERE t.thread_id=? AND p.active=1 AND p.cloud_agent=1",
  )
    .bind(threadId)
    .first<CloudBotConfig & { room_id: string; root_id: string }>();
  if (!row)
    throw new ChatError(
      403,
      "This cloud agent no longer has access to the conversation.",
    );
  await assertCasualActive(row.room_id, row.bot_id);
  if (!(await scheduledMessageAllowed(row.root_id)))
    throw new ChatError(403, "The timer creator no longer has channel access.");
  return { ...row, casual: await isCasual(row.room_id) };
}
export async function cloudModel(config: CloudBotConfig) {
  const credential = await modelCredential(config.credential_id);
  const fields = JSON.parse(await unseal(credential)) as Record<string, string>;
  const preset = providerPresets[credential.provider];
  const apiKey = fields[preset.key];
  if (!apiKey)
    throw new ChatError(400, "The selected model credential is empty.");
  return {
    provider: credential.provider,
    apiKey,
    baseUrl: (fields[preset.baseKey!] || preset.base!).replace(/\/$/, ""),
  };
}
