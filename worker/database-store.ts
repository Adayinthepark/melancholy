import { env } from "cloudflare:workers";
import type { ChannelDatabase } from "../lib/channel-database";
import type { DataReply } from "./channel-database";
import { ChatError } from "./team-auth";

export function unwrap<T>(reply: DataReply): T {
  if (!reply.ok) throw new ChatError(reply.status, reply.error);
  return reply.value as T;
}
export async function projectDatabase(
  roomId: string,
): Promise<ChannelDatabase | null> {
  const room = await env.DB.prepare(
    "SELECT created_by,created_at FROM rooms WHERE id=? AND kind='channel'",
  )
    .bind(roomId)
    .first<{ created_by: string; created_at: number }>();
  if (!room) return null;
  const id = "project-" + roomId;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO channel_databases(id,room_id,name,description,managed,created_by,created_at) VALUES (?,?,'Project','Notes and posted files',1,?,?)",
  )
    .bind(id, roomId, room.created_by, room.created_at)
    .run();
  return env.DB.prepare("SELECT * FROM channel_databases WHERE id=?")
    .bind(id)
    .first<ChannelDatabase>();
}
export async function databases(roomId: string) {
  await projectDatabase(roomId);
  return (
    await env.DB.prepare(
      "SELECT id,room_id,name,description,managed,created_by,created_at,version FROM channel_databases WHERE room_id=? AND deleted_at IS NULL ORDER BY managed DESC,created_at,id",
    )
      .bind(roomId)
      .all<ChannelDatabase>()
  ).results;
}
export async function databaseCall<T>(
  database: ChannelDatabase,
  action: string,
  input: unknown,
  actor: string,
): Promise<T> {
  const stub = env.CHANNEL_DATABASES.getByName(database.id);
  if (database.managed) unwrap(await stub.prepareProject(database.room_id));
  return unwrap<T>(await stub.call(action, input, actor));
}
