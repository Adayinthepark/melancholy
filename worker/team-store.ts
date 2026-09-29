import { unreadMessageSql } from "./read-query";
import { proseOnly } from "../lib/mentions";
import { env } from "cloudflare:workers";
import type { AgentRequest, Person, TeamMessage } from "../lib/chat";
import type { Attachment } from "../lib/protocol";
import type { Identity } from "./team-auth";
export const personColumns =
  "id,handle,name,kind,role,active,server_id,avatar_key,cloud_agent";
export type StoredChat = Omit<
  TeamMessage,
  | "attachments"
  | "activity"
  | "parts"
  | "author"
  | "reactions"
  | "reply_count"
  | "mention_refs"
  | "agent_requests"
> & {
  attachments: string;
  activity: string;
  parts?: string;
  mention_refs: string;
};
export async function publish(roomId: string) {
  const members = await env.DB.prepare(
    "SELECT p.id FROM room_members m JOIN people p ON p.id=m.person_id WHERE m.room_id=? AND p.active=1 AND p.kind='human'",
  )
    .bind(roomId)
    .all<{ id: string }>();
  await Promise.allSettled(
    members.results.map((p) => env.INBOXES.getByName(p.id).notify(roomId)),
  );
}
export async function hydrate(
  rows: StoredChat[],
  who: Identity,
): Promise<TeamMessage[]> {
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map((r) => r.id)),
    placeholders = "SELECT value FROM json_each(?)";
  const [people, reactions, replies, mentioned, unread, requests] =
    await Promise.all([
      env.DB.prepare(
        `SELECT ${personColumns} FROM people WHERE id IN (SELECT author_id FROM chat_messages WHERE id IN (${placeholders}))`,
      )
        .bind(ids)
        .all<Person>(),
      env.DB.prepare(
        `SELECT message_id,emoji,COUNT(*) AS count,MAX(person_id=?) AS mine FROM message_reactions WHERE message_id IN (${placeholders}) GROUP BY message_id,emoji`,
      )
        .bind(who.id, ids)
        .all<{
          message_id: string;
          emoji: string;
          count: number;
          mine: number;
        }>(),
      env.DB.prepare(
        `SELECT parent_id,COUNT(*) AS count FROM chat_messages WHERE parent_id IN (${placeholders}) AND deleted_at IS NULL GROUP BY parent_id`,
      )
        .bind(ids)
        .all<{ parent_id: string; count: number }>(),
      env.DB.prepare(
        `SELECT mm.message_id,p.${personColumns.split(",").join(",p.")} FROM message_mentions mm JOIN people p ON p.id=mm.person_id WHERE mm.message_id IN (${placeholders})`,
      )
        .bind(ids)
        .all<Person & { message_id: string }>(),
      env.DB.prepare(
        `SELECT m.id FROM chat_messages m WHERE m.id IN (SELECT value FROM json_each(?2)) AND ${unreadMessageSql("?1")}`,
      )
        .bind(who.id, ids)
        .all<{ id: string }>(),
      env.DB.prepare(
        `SELECT a.message_id,a.bot_id,p.name AS bot_name,a.reply_id,
        COALESCE(a.error,m.run_error) AS error,
        CASE WHEN a.error IS NOT NULL THEN 'failed'
          WHEN m.run_status IN ('queued','running') AND EXISTS (
            SELECT 1 FROM json_each(m.parts) part
            WHERE json_extract(part.value,'$.type')='interaction'
              AND json_extract(part.value,'$.interaction.state') IN ('pending','sending')
          ) THEN 'waiting'
          WHEN m.run_status IS NOT NULL THEN m.run_status
          WHEN a.dispatched=0 THEN 'pending' ELSE 'dispatched' END AS status
        FROM agent_requests a JOIN people p ON p.id=a.bot_id
        LEFT JOIN chat_messages m ON m.id=a.reply_id
        WHERE a.message_id IN (${placeholders})`,
      )
        .bind(ids)
        .all<AgentRequest & { message_id: string }>(),
    ]);
  return rows.map((r) => ({
    ...r,
    agent_requests: requests.results
      .filter((a) => a.message_id === r.id)
      .map(({ message_id: _, ...a }) => a),
    unread: unread.results.some((m) => m.id === r.id),
    attachments: JSON.parse(r.attachments) as Attachment[],
    activity: JSON.parse(r.activity),
    parts: JSON.parse(r.parts || "[]"),
    mention_refs: JSON.parse(r.mention_refs || "{}"),
    mentioned_people: mentioned.results.filter((p) => p.message_id === r.id),
    author: people.results.find((p) => p.id === r.author_id)!,
    reactions: reactions.results
      .filter((x) => x.message_id === r.id)
      .map((x) => ({ ...x, mine: !!x.mine })),
    reply_count: replies.results.find((x) => x.parent_id === r.id)?.count || 0,
  }));
}
export async function mentions(
  text: string,
  roomId: string,
): Promise<Person[]> {
  text = proseOnly(text);
  const handles = [
    ...new Set(
      [...text.matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9_-]{0,39})/g)].map(
        (m) => m[1].toLowerCase(),
      ),
    ),
  ];
  const ids = [...text.matchAll(/<@([a-z0-9-]+)>/g)].map((m) => m[1]);
  if (!handles.length && !ids.length) return [];
  return (
    await env.DB.prepare(
      `SELECT p.${personColumns.split(",").join(",p.")} FROM people p JOIN room_members m ON m.person_id=p.id WHERE m.room_id=? AND p.active=1 AND (p.handle IN (SELECT value FROM json_each(?)) OR p.id IN (SELECT value FROM json_each(?)))`,
    )
      .bind(roomId, JSON.stringify(handles), JSON.stringify(ids))
      .all<Person>()
  ).results;
}
