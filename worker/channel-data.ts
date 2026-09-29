import { env } from "cloudflare:workers";
import { z } from "zod";
import { ChatError } from "./team-auth";
import { projectDatabase, databaseCall } from "./database-store";
import type { DataRecord } from "../lib/channel-database";
export const noteInput = z.object({
  requestId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  content: z.string().max(100000),
  version: z.number().int().positive().optional(),
});
const flatNote = (roomId: string, record: DataRecord) => ({
  id: record.id,
  room_id: roomId,
  title: String(record.data.title),
  content: String(record.data.content),
  version: record.version,
  created_by: record.created_by,
  updated_by: record.updated_by,
  created_at: record.created_at,
  updated_at: record.updated_at,
});
export async function notes(roomId: string) {
  const db = await projectDatabase(roomId);
  if (!db) return [];
  const first = await databaseCall<{
    records: DataRecord[];
    next: string | null;
  }>(
    db,
    "query",
    {
      collection: "notes",
      query: { orderBy: "updated_at", direction: "desc", limit: 100 },
    },
    "system",
  );
  if (first.next) {
    const second = await databaseCall<{ records: DataRecord[] }>(
      db,
      "query",
      {
        collection: "notes",
        query: {
          orderBy: "updated_at",
          direction: "desc",
          limit: 100,
          cursor: first.next,
        },
      },
      "system",
    );
    first.records.push(...second.records);
  }
  return first.records.map((r) => flatNote(roomId, r));
}
export async function saveNote(
  roomId: string,
  authorId: string,
  input: unknown,
  id?: string,
) {
  const data = noteInput.parse(input),
    db = await projectDatabase(roomId);
  if (!db) throw new ChatError(404, "Channel not found.");
  if (id && !data.version)
    throw new ChatError(400, "Read the current note version before editing.");
  const requestId = data.requestId || crypto.randomUUID();
  const result = await databaseCall<{ records: DataRecord[] }>(
    db,
    "batch",
    {
      requestId,
      operations: [
        {
          op: id ? "update" : "create",
          collection: "notes",
          id: id || requestId,
          data: { title: data.title, content: data.content },
          ...(id ? { version: data.version } : {}),
        },
      ],
    },
    authorId,
  );
  return flatNote(roomId, result.records[0]);
}
export async function deleteNote(
  roomId: string,
  authorId: string,
  id: string,
  version: number,
) {
  const db = await projectDatabase(roomId);
  if (!db) throw new ChatError(404, "Channel not found.");
  return databaseCall(
    db,
    "batch",
    {
      requestId: crypto.randomUUID(),
      operations: [{ op: "delete", collection: "notes", id, version }],
    },
    authorId,
  );
}
export async function channelFiles(
  roomId: string,
  before = Number.MAX_SAFE_INTEGER,
) {
  const db = await projectDatabase(roomId);
  if (!db) {
    const files = (
      await env.DB.prepare(
        "SELECT f.*,m.seq,m.parent_id FROM chat_files f JOIN chat_messages m ON m.id=f.message_id WHERE f.room_id=? AND m.deleted_at IS NULL AND m.seq<? ORDER BY m.seq DESC,f.id LIMIT 101",
      )
        .bind(roomId, before)
        .all()
    ).results;
    const boundary = files.length > 100 ? Number(files[100].seq) : null;
    return {
      files: boundary ? files.filter((f) => Number(f.seq) > boundary) : files,
      next: boundary ? boundary + 1 : null,
    };
  }
  const page = await databaseCall<{
    records: DataRecord[];
    next: string | null;
  }>(
    db,
    "query",
    {
      collection: "files",
      query: {
        orderBy: "seq",
        direction: "desc",
        filters: [{ field: "seq", op: "lt", value: before }],
        limit: 100,
      },
    },
    "system",
  );
  const files = page.records.map((r) => ({
    ...r.data,
    id: r.id,
    room_id: roomId,
    created_at: r.created_at,
    seq: Number(r.data.seq),
  }));
  const boundary = page.next ? Number(page.records.at(-1)!.data.seq) : null;
  return {
    files: boundary ? files.filter((f) => Number(f.seq) > boundary) : files,
    next: boundary ? boundary + 1 : null,
  };
}
