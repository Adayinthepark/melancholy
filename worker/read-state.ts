import { env } from "cloudflare:workers";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { ChatError, type Identity } from "./team-auth";
import { hydrate, type StoredChat } from "./team-store";

import { unreadMessageSql } from "./read-query";
const membership = `EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=m.room_id AND rm.person_id=?1)`;
const mention = `EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.person_id=?1)`;
const filterSchema = z.enum(["unread", "mentions"]);
const seqSchema = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export async function inboxApi(
  request: Request,
  who: Identity,
  path: string,
  body: () => Promise<unknown>,
) {
  if (
    !["/api/chat/inbox", "/api/chat/inbox/read", "/api/chat/read"].includes(
      path,
    )
  )
    return null;
  if (who.kind !== "human") throw new ChatError(403, "Member access required.");
  const unread = unreadMessageSql("?1");
  if (path === "/api/chat/inbox" && request.method === "GET") {
    const url = new URL(request.url);
    const filter = filterSchema.parse(
      url.searchParams.get("filter") || "unread",
    );
    const before = seqSchema.parse(
      url.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
    );
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(url.searchParams.get("limit") || 30);
    const snapshot = await env.DB.prepare(
      `SELECT COALESCE(MAX(m.seq),0) AS seq FROM chat_messages m WHERE ${membership}`,
    )
      .bind(who.id)
      .first<{ seq: number }>();
    const rows = await env.DB.prepare(
      `SELECT m.*,${mention} AS mentioned FROM chat_messages m
      WHERE ${membership} AND m.deleted_at IS NULL AND m.author_id<>?1 AND m.seq<?2
      AND ${filter === "mentions" ? mention : unread}
      ORDER BY m.seq DESC LIMIT ?3`,
    )
      .bind(who.id, before, limit + 1)
      .all<StoredChat & { mentioned: number }>();
    const selected = rows.results.slice(0, limit);
    return Response.json({
      messages: await hydrate(selected, who),
      hasMore: rows.results.length > limit,
      before: selected.at(-1)?.seq || null,
      through: snapshot?.seq || 0,
    });
  }
  if (path === "/api/chat/read" && request.method === "POST") {
    const input = z
      .object({
        messageIds: z.array(z.string().min(1).max(100)).min(1).max(100),
      })
      .parse(await body());
    const ids = [...new Set(input.messageIds)];
    const encoded = JSON.stringify(ids);
    const allowed = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM chat_messages m WHERE m.id IN (SELECT value FROM json_each(?2)) AND ${membership}`,
    )
      .bind(who.id, encoded)
      .first<{ count: number }>();
    if (allowed?.count !== ids.length)
      throw new ChatError(404, "Message not found.");
    await env.DB.prepare(
      `INSERT OR IGNORE INTO message_reads(person_id,message_id,read_at)
      SELECT ?1,m.id,?3 FROM chat_messages m WHERE m.id IN (SELECT value FROM json_each(?2)) AND ${membership} AND ${unread}`,
    )
      .bind(who.id, encoded, Date.now())
      .run();
    waitUntil(env.INBOXES.getByName(who.id).notify("read"));
    return Response.json({ ok: true });
  }
  if (path === "/api/chat/inbox/read" && request.method === "POST") {
    const input = z
      .object({ filter: filterSchema, through: seqSchema })
      .parse(await body());
    await env.DB.prepare(
      `INSERT OR IGNORE INTO message_reads(person_id,message_id,read_at)
      SELECT ?1,m.id,?3 FROM chat_messages m WHERE ${membership} AND ${unread} AND m.seq<=?2
      ${input.filter === "mentions" ? `AND ${mention}` : ""}`,
    )
      .bind(who.id, input.through, Date.now())
      .run();
    waitUntil(env.INBOXES.getByName(who.id).notify("read"));
    return Response.json({ ok: true });
  }
  return null;
}
