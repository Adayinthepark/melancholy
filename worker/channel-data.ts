import { env } from "cloudflare:workers";
import { z } from "zod";
import { ChatError } from "./team-auth";
export const noteInput = z.object({
  requestId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  content: z.string().max(100000),
  version: z.number().int().positive().optional(),
});
export async function notes(roomId: string) {
  return (
    await env.DB.prepare(
      "SELECT * FROM channel_notes WHERE room_id=? ORDER BY updated_at DESC LIMIT 200",
    )
      .bind(roomId)
      .all()
  ).results;
}
export async function saveNote(
  roomId: string,
  authorId: string,
  input: unknown,
  id?: string,
) {
  const data = noteInput.parse(input),
    now = Date.now();
  if (id) {
    if (!data.version)
      throw new ChatError(400, "Read the current note version before editing.");
    const result = await env.DB.prepare(
      "UPDATE channel_notes SET title=?,content=?,version=version+1,updated_by=?,updated_at=? WHERE id=? AND room_id=? AND version=?",
    )
      .bind(data.title, data.content, authorId, now, id, roomId, data.version)
      .run();
    if (!result.meta.changes)
      throw new ChatError(
        409,
        "This note changed or was deleted. Reload it before saving.",
      );
  } else {
    id = data.requestId || crypto.randomUUID();
    const existing = await env.DB.prepare(
      "SELECT * FROM channel_notes WHERE id=?",
    )
      .bind(id)
      .first<{
        room_id: string;
        created_by: string;
        title: string;
        content: string;
      }>();
    if (existing) {
      if (
        existing.room_id !== roomId ||
        existing.created_by !== authorId ||
        existing.title !== data.title ||
        existing.content !== data.content
      )
        throw new ChatError(
          409,
          "This note request identifier is already in use.",
        );
      return existing;
    }

    await env.DB.prepare(
      "INSERT INTO channel_notes(id,room_id,title,content,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(id, roomId, data.title, data.content, authorId, authorId, now, now)
      .run();
  }
  return env.DB.prepare("SELECT * FROM channel_notes WHERE id=?")
    .bind(id)
    .first();
}
export async function channelFiles(
  roomId: string,
  before = Number.MAX_SAFE_INTEGER,
) {
  const files = (
    await env.DB.prepare(
      "SELECT f.*,m.seq,m.parent_id FROM chat_files f JOIN chat_messages m ON m.id=f.message_id WHERE f.room_id=? AND m.deleted_at IS NULL AND m.seq<? ORDER BY m.seq DESC,f.id LIMIT 101",
    )
      .bind(roomId, before)
      .all()
  ).results;
  // Page by messages, so several files in the boundary message stay together.
  const boundary = files.length > 100 ? Number(files[100].seq) : null;
  return {
    files: boundary ? files.filter((f) => Number(f.seq) > boundary) : files,
    next: boundary ? boundary + 1 : null,
  };
}
