import { env } from "cloudflare:workers";
import { z } from "zod";
import { ChatError } from "./team-auth";
import { saveNote } from "./channel-data";
import { publish } from "./team-store";
import type { AgentArtifact } from "../lib/agent-parts";

export async function storeArtifact(
  serverId: string,
  request: Request,
  read: (r: Request, max: number) => Promise<Uint8Array<ArrayBuffer>>,
) {
  const url = new URL(request.url);
  const { threadId, runId, name } = z
    .object({
      threadId: z.string().uuid(),
      runId: z.string().uuid(),
      name: z
        .string()
        .min(1)
        .max(240)
        .refine(
          (v) => !/[\\/\x00-\x1f]/.test(v) && !v.startsWith("."),
          "Invalid delivery name.",
        ),
    })
    .parse(Object.fromEntries(url.searchParams));
  const mapping = await env.DB.prepare(
    "SELECT t.room_id,t.bot_id,r.kind FROM agent_threads t JOIN people p ON p.id=t.bot_id JOIN room_members rm ON rm.room_id=t.room_id AND rm.person_id=p.id JOIN rooms r ON r.id=t.room_id WHERE t.thread_id=? AND p.server_id=? AND p.active=1",
  )
    .bind(threadId, serverId)
    .first<{ room_id: string; bot_id: string; kind: string }>();
  if (
    !mapping ||
    !(await env.CONVERSATIONS.getByName(threadId).canExecute(runId, serverId))
  )
    throw new ChatError(403, "This task cannot publish files.");
  const message = await env.DB.prepare(
    "SELECT id,parent_id FROM chat_messages WHERE run_id=? AND room_id=? AND author_id=? AND deleted_at IS NULL",
  )
    .bind(runId, mapping.room_id, mapping.bot_id)
    .first<{ id: string; parent_id: string | null }>();
  if (!message) throw new ChatError(409, "Agent reply is unavailable.");
  const markdown = /\.(md|markdown)$/i.test(name) && mapping.kind === "channel";
  const bytes = await read(request, markdown ? 400000 : 10 * 1024 * 1024);
  const contentHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(runId + ":" + name + ":" + contentHash),
      ),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const saved = await env.DB.prepare(
    "SELECT data FROM agent_artifacts WHERE id=? AND run_id=?",
  )
    .bind(id, runId)
    .first<{ data: string }>();
  if (saved) return JSON.parse(saved.data) as AgentArtifact;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM agent_artifacts WHERE run_id=?",
  )
    .bind(runId)
    .first<{ n: number }>();
  if ((count?.n || 0) >= 16)
    throw new ChatError(400, "At most sixteen deliveries per task.");
  let artifact: AgentArtifact;
  if (markdown) {
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ChatError(400, "Markdown must be UTF-8.");
    }
    const source = `\n\n[Source conversation](/?room=${mapping.room_id}&thread=${message.parent_id || message.id})`;
    const title = (
      content.match(/^#\s+(.+)$/m)?.[1] || name.replace(/\.(md|markdown)$/i, "")
    ).slice(0, 160);
    const note = await saveNote(mapping.room_id, mapping.bot_id, {
      requestId: id,
      title,
      content: content + source,
    });
    artifact = { id, name, noteId: note.id };
  } else {
    const files = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM chat_files WHERE message_id=? AND id<>?",
    )
      .bind(message.id, id)
      .first<{ n: number }>();
    if ((files?.n || 0) >= 8)
      throw new ChatError(400, "At most eight files per reply.");
    const types: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      pdf: "application/pdf",
      csv: "text/csv",
      txt: "text/plain",
      md: "text/markdown",
      markdown: "text/markdown",
      json: "application/json",
      zip: "application/zip",
      svg: "image/svg+xml",
    };
    const type =
      types[name.split(".").at(-1)!.toLowerCase()] ||
      "application/octet-stream";
    const file = { id, name, size: bytes.length, type };
    await env.FILES.put(id, bytes, { httpMetadata: { contentType: type } });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO chat_files(id,room_id,uploader_id,message_id,name,size,type,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM chat_messages WHERE id=? AND deleted_at IS NULL)",
      ).bind(
        id,
        mapping.room_id,
        mapping.bot_id,
        message.id,
        name,
        bytes.length,
        type,
        Date.now(),
        message.id,
      ),
      env.DB.prepare(
        "UPDATE chat_messages SET attachments=(SELECT json_group_array(json_object('id',id,'name',name,'size',size,'type',type)) FROM chat_files WHERE message_id=?) WHERE id=? AND deleted_at IS NULL",
      ).bind(message.id, message.id),
    ]);
    artifact = { id, name, file };
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_artifacts VALUES (?,?,?,?,?,?)",
  )
    .bind(id, runId, message.id, name, JSON.stringify(artifact), Date.now())
    .run();
  await publish(mapping.room_id);
  return artifact;
}
