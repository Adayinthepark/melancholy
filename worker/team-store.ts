import { env } from "cloudflare:workers";
import type { Person, TeamMessage } from "../lib/chat";
import type { Attachment } from "../lib/protocol";
import type { Identity } from "./team-auth";
export const personColumns = "id,handle,name,kind,role,active,server_id";
export type StoredChat = Omit<
  TeamMessage,
  "attachments" | "activity" | "author" | "reactions" | "reply_count"
> & { attachments: string; activity: string };
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
  const [people, reactions, replies] = await Promise.all([
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
  ]);
  return rows.map((r) => ({
    ...r,
    attachments: JSON.parse(r.attachments) as Attachment[],
    activity: JSON.parse(r.activity),
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
  const handles = [
    ...new Set(
      [...text.matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9_-]{0,39})/g)].map(
        (m) => m[1].toLowerCase(),
      ),
    ),
  ];
  if (!handles.length) return [];
  return (
    await env.DB.prepare(
      `SELECT p.${personColumns.split(",").join(",p.")} FROM people p JOIN room_members m ON m.person_id=p.id WHERE m.room_id=? AND p.active=1 AND p.handle IN (SELECT value FROM json_each(?))`,
    )
      .bind(roomId, JSON.stringify(handles))
      .all<Person>()
  ).results;
}
