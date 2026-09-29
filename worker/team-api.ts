import { inboxApi } from "./read-state";
import { unreadMessageSql } from "./read-query";
import { interactionResponseSchema } from "../lib/interaction-schema";
import { projectApi } from "./project-api";
import { casualSettings, isCasual, assertCasualActive } from "./casual";
import { cloudBotInput, modelCredential } from "./cloud-config";
import { workspaceInfo } from "./workspace-settings";
import { queuePush, drainPush } from "./push";
import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { workbench } from "./workbench-api";
import {
  authenticate,
  checkOrigin,
  hash,
  secret,
  SESSION_AGE,
  sessionCookie,
} from "./auth";
import {
  ChatError,
  bearerIdentity,
  passwordHash,
  requireRoom,
  type Identity,
} from "./team-auth";
import {
  hydrate,
  mentions,
  personColumns,
  publish,
  type StoredChat,
} from "./team-store";
import type { Person, Room } from "../lib/chat";
import type { Attachment } from "../lib/protocol";

const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
const fail = (error: unknown) => {
  if (error instanceof ChatError)
    return json({ error: error.message }, error.status);
  if (error instanceof z.ZodError)
    return json({ error: error.issues[0]?.message || "Invalid request." }, 400);
  if (error instanceof Error && error.message.includes("UNIQUE constraint"))
    return json({ error: "That name or identifier is already in use." }, 409);
  console.error(
    JSON.stringify({
      event: "chat_error",
      message: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  return json({ error: "The request could not be completed." }, 500);
};
export async function bytes(request: Request, max = 1024 * 1024) {
  if (Number(request.headers.get("Content-Length")) > max)
    throw new ChatError(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new ChatError(413, "Request is too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
export async function body(request: Request) {
  try {
    return JSON.parse(new TextDecoder().decode(await bytes(request)));
  } catch (e) {
    if (e instanceof ChatError) throw e;
    throw new ChatError(400, "Invalid JSON.");
  }
}
function owner(who: Identity) {
  if (who.role !== "owner" || who.kind !== "human")
    throw new ChatError(403, "Owner access required.");
}
function human(who: Identity) {
  if (who.kind !== "human") throw new ChatError(403, "Member access required.");
}
async function person(id: string) {
  const p = await env.DB.prepare(
    `SELECT ${personColumns} FROM people WHERE id=? AND active=1`,
  )
    .bind(id)
    .first<Person>();
  if (!p) throw new ChatError(404, "Member not found.");
  return p;
}
async function message(id: string, who: Identity, write = false) {
  const m = await env.DB.prepare("SELECT * FROM chat_messages WHERE id=?")
    .bind(id)
    .first<StoredChat>();
  if (!m) throw new ChatError(404, "Message not found.");
  await requireRoom(m.room_id, who, write);
  return m;
}
async function room(id: string) {
  const r = await env.DB.prepare("SELECT * FROM rooms WHERE id=?")
    .bind(id)
    .first<Room>();
  if (!r) throw new ChatError(404, "Conversation not found.");
  return r;
}
function event(roomId: string, id: string, type: string) {
  return env.DB.prepare(
    "INSERT INTO chat_events(room_id,message_id,type,created_at) VALUES (?,?,?,?)",
  ).bind(roomId, id, type, Date.now());
}
async function listRooms(who: Identity) {
  const list = await env.DB.prepare(
    `SELECT r.*,EXISTS(SELECT 1 FROM casual_rooms cr WHERE cr.room_id=r.id) AS casual,EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=r.id AND rm.person_id=?1) AS joined,
    COALESCE((SELECT MAX(seq) FROM chat_messages m WHERE m.room_id=r.id),0) AS last_seq,
    COALESCE((SELECT last_seq FROM room_reads rr WHERE rr.room_id=r.id AND rr.person_id=?1),0) AS last_read,
    (SELECT COUNT(*) FROM chat_messages m WHERE m.room_id=r.id AND ${unreadMessageSql("?1")}) AS unread,
    (SELECT COUNT(*) FROM chat_messages m JOIN message_mentions mm ON mm.message_id=m.id AND mm.person_id=?1 WHERE m.room_id=r.id AND ${unreadMessageSql("?1")}) AS mentions
    FROM rooms r WHERE EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=r.id AND rm.person_id=?1) OR (?2='human' AND r.kind='channel' AND r.private=0) ORDER BY r.kind,r.name LIMIT 500`,
  )
    .bind(who.id, who.kind)
    .all<Room>();
  const rooms = list.results.filter(
    (r) => !who.roomScope || r.id === who.roomScope,
  );
  if (!rooms.length) return [];
  const membership = await env.DB.prepare(
    `SELECT rm.room_id,p.${personColumns.split(",").join(",p.")} FROM room_members rm JOIN people p ON p.id=rm.person_id WHERE rm.room_id IN (SELECT value FROM json_each(?)) AND p.active=1 ORDER BY p.kind,p.name`,
  )
    .bind(JSON.stringify(rooms.map((r) => r.id)))
    .all<Person & { room_id: string }>();
  const members = new Map<string, Person[]>();
  for (const { room_id, ...person } of membership.results) {
    const list = members.get(room_id) || [];
    list.push(person);
    members.set(room_id, list);
  }
  return rooms.map((r) => ({
    ...r,
    members: members.get(r.id) || [],
    unread: r.joined ? r.unread : 0,
    mentions: r.joined ? r.mentions : 0,
  }));
}
async function join(request: Request) {
  if (!checkOrigin(request)) throw new ChatError(403, "Origin not allowed.");
  const input = z
    .object({
      ticket: z.string().length(64),
      name: z.string().trim().min(1).max(60),
      handle: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
      password: z.string().min(12).max(256),
    })
    .parse(await body(request));
  const ticketHash = await hash(input.ticket),
    now = Date.now();
  if (
    !(await env.DB.prepare(
      "SELECT 1 FROM invitations WHERE token_hash=? AND expires_at>?",
    )
      .bind(ticketHash, now)
      .first())
  )
    throw new ChatError(
      401,
      "This invitation has expired or was already used.",
    );
  const id = crypto.randomUUID(),
    token = secret(),
    encoded = await passwordHash(input.password);
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO people(id,handle,name,kind,password_hash,created_at) SELECT ?,?,?,'human',?,? WHERE EXISTS(SELECT 1 FROM invitations WHERE token_hash=? AND expires_at>?)",
    ).bind(id, input.handle, input.name, encoded, now, ticketHash, now),
    env.DB.prepare(
      "DELETE FROM invitations WHERE token_hash=? AND expires_at>?",
    ).bind(ticketHash, now),
    env.DB.prepare(
      "INSERT INTO sessions(token_hash,expires_at,person_id) SELECT ?,?,id FROM people WHERE id=?",
    ).bind(await hash(token), now + SESSION_AGE * 1000, id),
    env.DB.prepare(
      "INSERT INTO room_members(room_id,person_id,joined_at) SELECT r.id,p.id,? FROM rooms r JOIN people p ON p.id=? WHERE r.id='general' AND r.private=0",
    ).bind(now, id),
  ]);
  if (!results[0].meta.changes)
    throw new ChatError(401, "This invitation was already used.");
  await publish("general");
  return json({ ok: true }, 201, {
    "Set-Cookie": sessionCookie(request, token),
  });
}
async function agentStatements(
  m: Pick<StoredChat, "id" | "room_id" | "parent_id" | "text">,
  who: Identity,
  mentioned: Person[],
): Promise<D1PreparedStatement[]> {
  if (who.kind !== "human") return [];
  const r = await room(m.room_id);
  let bots = mentioned.filter(
    (p) => p.kind === "bot" && (p.server_id || p.cloud_agent),
  );
  const casual = await isCasual(r.id);
  if (casual) {
    const config = await casualSettings();
    await assertCasualActive(r.id, config.bot_id || "");
  }
  if ((r.kind === "dm" || casual) && !m.parent_id)
    bots = (
      await env.DB.prepare(
        `SELECT p.${personColumns.split(",").join(",p.")} FROM room_members rm JOIN people p ON p.id=rm.person_id WHERE rm.room_id=? AND p.kind='bot' AND p.active=1 AND (p.server_id IS NOT NULL OR p.cloud_agent=1)`,
      )
        .bind(r.id)
        .all<Person>()
    ).results;
  if (m.parent_id) {
    const automatic = await env.DB.prepare(
      `SELECT p.${personColumns.split(",").join(",p.")} FROM thread_preferences t JOIN people p ON p.id=t.bot_id JOIN room_members rm ON rm.person_id=p.id AND rm.room_id=? WHERE t.root_id=? AND p.active=1 AND (p.server_id IS NOT NULL OR p.cloud_agent=1)`,
    )
      .bind(r.id, m.parent_id)
      .first<Person>();
    if (automatic && !bots.some((p) => p.id === automatic.id))
      bots.push(automatic);
  }
  const statements: D1PreparedStatement[] = [];
  for (const bot of bots) {
    const rootId = m.parent_id || (r.kind === "dm" || casual ? r.id : m.id);
    const digest = await hash(r.id + ":" + rootId + ":" + bot.id);
    const threadId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO agent_threads(thread_id,room_id,root_id,bot_id) VALUES (?,?,?,?)",
      ).bind(threadId, r.id, rootId, bot.id),
      env.DB.prepare(
        "INSERT OR IGNORE INTO agent_requests(message_id,bot_id,thread_id) VALUES (?,?,?)",
      ).bind(m.id, bot.id, threadId),
    );
  }
  return statements;
}
async function send(request: Request, roomId: string, who: Identity) {
  await requireRoom(roomId, who, true);
  const input = z
    .object({
      id: z.string().uuid().optional(),
      text: z.string().trim().max(32000).default(""),
      parentId: z.string().uuid().nullable().optional(),
      attachments: z.array(z.string().uuid()).max(8).default([]),
    })
    .parse(await body(request));
  if (!input.text && !input.attachments.length)
    throw new ChatError(400, "Write a message or attach a file.");
  const id = input.id || crypto.randomUUID();
  const existing = await env.DB.prepare(
    "SELECT * FROM chat_messages WHERE id=?",
  )
    .bind(id)
    .first<StoredChat>();
  if (existing) {
    if (
      existing.author_id !== who.id ||
      existing.room_id !== roomId ||
      existing.text !== input.text ||
      (existing.parent_id || null) !== (input.parentId || null)
    )
      throw new ChatError(409, "This message identifier is already in use.");
    if (who.kind === "human")
      waitUntil(env.CHAT_DISPATCHERS.getByName(roomId).kick(roomId));
    return json({
      message: (await hydrate([existing], who))[0],
      duplicate: true,
    });
  }
  if (input.parentId) {
    const parent = await message(input.parentId, who);
    if (parent.room_id !== roomId || parent.parent_id)
      throw new ChatError(
        400,
        "Replies must belong to a root message in this conversation.",
      );
  }
  const attachments: Attachment[] = [];
  for (const fileId of input.attachments) {
    const f = await env.DB.prepare(
      "SELECT id,name,size,type FROM chat_files WHERE id=? AND room_id=? AND uploader_id=? AND message_id IS NULL",
    )
      .bind(fileId, roomId, who.id)
      .first<Attachment>();
    if (!f) throw new ChatError(400, "Attachment is unavailable.");
    attachments.push(f);
  }
  const tagged = await mentions(input.text, roomId);
  const agents = await agentStatements(
    {
      id,
      room_id: roomId,
      parent_id: input.parentId || null,
      text: input.text,
    },
    who,
    tagged,
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO chat_messages(id,room_id,parent_id,author_id,text,created_at,attachments,mention_refs) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      roomId,
      input.parentId || null,
      who.id,
      input.text,
      Date.now(),
      JSON.stringify(attachments),
      JSON.stringify(Object.fromEntries(tagged.map((p) => [p.handle, p.id]))),
    ),
    ...attachments.map((f) =>
      env.DB.prepare(
        "UPDATE chat_files SET message_id=? WHERE id=? AND message_id IS NULL",
      ).bind(id, f.id),
    ),
    ...tagged.map((p) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO message_mentions VALUES (?,?)",
      ).bind(id, p.id),
    ),
    event(roomId, id, "message.created"),
    ...agents,
    queuePush(env.DB, id),
  ]);
  const stored = await message(id, who);
  waitUntil(
    Promise.all([
      publish(roomId),
      drainPush(env),
      ...(agents.length
        ? [env.CHAT_DISPATCHERS.getByName(roomId).kick(roomId)]
        : []),
    ]),
  );
  return json(
    { message: (await hydrate([stored], who))[0], duplicate: false },
    201,
  );
}
export async function chatFile(
  request: Request,
  id: string,
): Promise<Response> {
  try {
    const who =
      (await authenticate(request)) || (await bearerIdentity(request, true));
    if (!who) throw new ChatError(401, "Sign in to download this file.");
    const f = await env.DB.prepare("SELECT * FROM chat_files WHERE id=?")
      .bind(id)
      .first<
        Attachment & {
          room_id: string;
          uploader_id: string;
          message_id: string | null;
        }
      >();
    if (!f) throw new ChatError(404, "File not found.");
    await requireRoom(f.room_id, who);
    if (!f.message_id && f.uploader_id !== who.id)
      throw new ChatError(404, "File not found.");
    if (
      f.message_id &&
      !(await env.DB.prepare(
        "SELECT 1 FROM chat_messages WHERE id=? AND deleted_at IS NULL",
      )
        .bind(f.message_id)
        .first())
    )
      throw new ChatError(404, "File not found.");
    const object = await env.FILES.get(f.id);
    if (!object) throw new ChatError(404, "File not found.");
    const preview =
      new URL(request.url).searchParams.get("preview") === "1" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(f.type);
    return new Response(object.body, {
      headers: {
        "Content-Type": preview ? f.type : "application/octet-stream",
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "Content-Length": String(object.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return fail(e);
  }
}
export async function handleChat(request: Request): Promise<Response> {
  try {
    return await route(request);
  } catch (e) {
    return fail(e);
  }
}
async function route(request: Request): Promise<Response> {
  const url = new URL(request.url),
    method = request.method;
  let path = url.pathname;
  if (path === "/api/join" && method === "POST") return join(request);
  if (path.startsWith("/api/hooks/") && method === "POST") {
    const token = path.slice("/api/hooks/".length);
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new ChatError(401, "Invalid webhook.");
    const record = await env.DB.prepare(
      "SELECT p.*,t.room_id AS roomScope FROM bot_tokens t JOIN people p ON p.id=t.bot_id WHERE t.token_hash=? AND t.kind='webhook' AND p.active=1",
    )
      .bind(await hash(token))
      .first<Person & { roomScope: string }>();
    if (!record) throw new ChatError(401, "Invalid webhook.");
    return send(request, record.roomScope, {
      ...record,
      expires: Date.now() + 60000,
    });
  }
  const who = (await authenticate(request)) || (await bearerIdentity(request));
  if (!who) throw new ChatError(401, "Sign in to your workspace.");
  if (
    who.kind === "human" &&
    (!["GET", "HEAD"].includes(method) || request.headers.get("Upgrade")) &&
    !checkOrigin(request)
  )
    throw new ChatError(403, "Origin not allowed.");
  if (path.startsWith("/api/v1/")) {
    if (who.kind !== "bot") throw new ChatError(403, "Use a bot API token.");
    path = path.replace("/api/v1/", "/api/chat/");
  }
  if (
    who.taskRunId &&
    !(
      (method === "GET" &&
        /^\/api\/chat\/(rooms\/[^/]+\/(repositories|connections)|repositories\/[^/]+\/(issues|labels|assignees)(\/\d+(\/comments)?)?)$/.test(
          path,
        )) ||
      (method === "GET" &&
        /^\/api\/chat\/(casual\/context|rooms\/[^/]+\/(notes|files|workers))$/.test(
          path,
        )) ||
      (method === "POST" && path === "/api/chat/casual/suggestions") ||
      (["POST", "PUT"].includes(method) &&
        /^\/api\/chat\/rooms\/[^/]+\/notes(?:\/[^/]+)?$/.test(path)) ||
      (method === "POST" &&
        /^\/api\/chat\/rooms\/[^/]+\/repositories$/.test(path))
    )
  )
    throw new ChatError(
      403,
      "This endpoint is unavailable to task credentials.",
    );
  if (who.taskRunId && who.roomScope)
    await assertCasualActive(who.roomScope, who.id);
  const inbox = await inboxApi(request, who, path, () => body(request));
  if (inbox) return inbox;
  const project = await projectApi(request, who, path);
  if (project) return project;
  const extra = await workbench(request, who, path);
  if (extra) return extra;
  if (path === "/api/chat/workspace" && method === "GET") {
    human(who);
    const [me, people, rooms] = await Promise.all([
      person(who.id),
      env.DB.prepare(
        `SELECT ${personColumns} FROM people WHERE active=1 ORDER BY kind,name`,
      ).all<Person>(),
      listRooms(who),
    ]);
    return json({
      ...(await workspaceInfo()),
      me,
      casual: await casualSettings(),
      people: people.results,
      rooms,
    });
  }
  if (path === "/api/chat/socket" && method === "GET") {
    human(who);
    const headers = new Headers(request.headers);
    headers.set("x-session-hash", who.sessionHash!);
    headers.set("x-session-expires", String(who.expires));
    return env.INBOXES.getByName(who.id).fetch(
      new Request(request, { headers }),
    );
  }
  if (path === "/api/chat/profile" && method === "PATCH") {
    human(who);
    const input = z
      .object({
        name: z.string().trim().min(1).max(60),
        handle: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{1,39}$/)
          .optional(),
        password: z.string().min(12).max(256).optional(),
      })
      .parse(await body(request));
    const handle = z
      .string()
      .regex(/^[a-z][a-z0-9_-]{1,39}$/)
      .optional()
      .parse((input as { handle?: string }).handle);
    const statements = [
      env.DB.prepare(
        "UPDATE people SET name=?,handle=COALESCE(?,handle) WHERE id=?",
      ).bind(input.name, handle || null, who.id),
    ];
    if (input.password)
      statements.push(
        env.DB.prepare("UPDATE people SET password_hash=? WHERE id=?").bind(
          await passwordHash(input.password),
          who.id,
        ),
      );
    await env.DB.batch(statements);
    return json(await person(who.id));
  }
  if (path === "/api/chat/invitations" && method === "POST") {
    owner(who);
    const ticket = secret(),
      expires = Date.now() + 7 * 86400000;
    await env.DB.prepare("INSERT INTO invitations VALUES (?,?,?)")
      .bind(await hash(ticket), expires, who.id)
      .run();
    return json({ url: `${url.origin}/#invite=${ticket}`, expires }, 201);
  }
  const personId = path.match(/^\/api\/chat\/people\/([^/]+)$/)?.[1];
  if (personId && method === "DELETE") {
    owner(who);
    const target = await person(personId);
    if (target.role === "owner")
      throw new ChatError(403, "The owner cannot be removed.");
    await env.DB.batch([
      env.DB.prepare("UPDATE people SET active=0 WHERE id=?").bind(personId),
      env.DB.prepare("DELETE FROM sessions WHERE person_id=?").bind(personId),
      env.DB.prepare("DELETE FROM bot_tokens WHERE bot_id=?").bind(personId),
    ]);
    await env.INBOXES.getByName(personId).closeAll();
    if (target.server_id)
      await env.CONNECTORS.getByName(target.server_id).revoke();
    return json({ ok: true });
  }
  if (path === "/api/chat/rooms" && method === "GET")
    return json({ rooms: await listRooms(who) });
  if (path === "/api/chat/rooms" && method === "POST") {
    human(who);
    const input = z
      .object({
        id: z.string().uuid().optional(),
        kind: z.enum(["channel", "dm", "group"]).default("channel"),
        name: z.string().trim().max(80).default(""),
        topic: z.string().max(200).default(""),
        private: z.boolean().default(false),
        members: z.array(z.string()).max(20).default([]),
      })
      .parse(await body(request));
    const ids = [...new Set([who.id, ...input.members])];
    for (const id of ids) await person(id);
    if (
      input.kind === "channel" &&
      !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.name)
    )
      throw new ChatError(400, "Use lowercase letters, numbers and hyphens.");
    if (input.kind === "dm" && ids.length !== 2)
      throw new ChatError(400, "Choose one person.");
    if (input.kind === "group" && (ids.length < 3 || ids.length > 20))
      throw new ChatError(400, "Choose between two and nineteen people.");
    if (
      who.role !== "owner" &&
      (await Promise.all(ids.map(person))).some((p) => p.kind === "bot")
    )
      throw new ChatError(403, "Only the owner can add bots to conversations.");
    const dmKey = input.kind === "dm" ? ids.slice().sort().join(":") : null;
    if (dmKey) {
      const existing = await env.DB.prepare(
        "SELECT id FROM rooms WHERE dm_key=?",
      )
        .bind(dmKey)
        .first<{ id: string }>();
      if (existing) return json(existing);
    }
    if (input.id) {
      const existing = await env.DB.prepare("SELECT * FROM rooms WHERE id=?")
        .bind(input.id)
        .first<Room>();
      if (existing) {
        if (
          existing.created_by !== who.id ||
          existing.kind !== input.kind ||
          existing.name !== input.name ||
          existing.topic !== input.topic ||
          existing.private !==
            (input.kind === "channel" ? Number(input.private) : 1)
        )
          throw new ChatError(
            409,
            "This conversation identifier is already in use.",
          );
        await requireRoom(existing.id, who, true);
        return json({ id: existing.id });
      }
    }
    const id = input.id || crypto.randomUUID(),
      now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rooms(id,kind,name,topic,private,created_by,created_at,dm_key) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        input.kind,
        input.name,
        input.topic,
        input.kind === "channel" ? Number(input.private) : 1,
        who.id,
        now,
        dmKey,
      ),
      ...ids.map((p) =>
        env.DB.prepare("INSERT INTO room_members VALUES (?,?,?)").bind(
          id,
          p,
          now,
        ),
      ),
    ]);
    await publish(id);
    return json({ id }, 201);
  }
  const roomMatch = path.match(
    /^\/api\/chat\/rooms\/([^/]+)(?:\/(messages|read|join|members|stop|export)(?:\/([^/]+))?)?$/,
  );
  if (roomMatch) {
    const [, id, action, target] = roomMatch;
    if (
      !["GET", "HEAD"].includes(method) &&
      (!action || action === "members" || action === "join") &&
      (await isCasual(id))
    )
      throw new ChatError(
        403,
        "Casual chat is private and its participants are managed in settings.",
      );
    await requireRoom(id, who);
    const r = await room(id);
    if (!action && method === "PATCH") {
      human(who);
      if (
        r.kind === "dm" ||
        (r.kind === "channel" &&
          r.created_by !== who.id &&
          who.role !== "owner")
      )
        throw new ChatError(403, "Channel owner access required.");
      const input = z
        .object({
          name: z.string().trim().min(1).max(80),
          topic: z.string().max(200).default(""),
        })
        .parse(await body(request));
      if (r.kind === "channel" && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.name))
        throw new ChatError(400, "Use lowercase letters, numbers and hyphens.");
      await env.DB.prepare("UPDATE rooms SET name=?,topic=? WHERE id=?")
        .bind(input.name, input.topic, id)
        .run();
      await publish(id);
      return json({ ok: true });
    }
    if (action === "join" && method === "POST") {
      human(who);
      if (r.private || r.kind !== "channel")
        throw new ChatError(403, "An invitation is required.");
      await env.DB.prepare("INSERT OR IGNORE INTO room_members VALUES (?,?,?)")
        .bind(id, who.id, Date.now())
        .run();
      return json({ ok: true });
    }
    if (action === "members" && method === "POST") {
      human(who);
      await requireRoom(id, who, true);
      if (r.kind !== "channel")
        throw new ChatError(
          400,
          "Start a new group conversation to change its participants.",
        );
      if (r.created_by !== who.id && who.role !== "owner")
        throw new ChatError(403, "Channel owner access required.");
      const input = z
        .object({ personId: z.string() })
        .parse(await body(request));
      const p = await person(input.personId);
      if (p.kind === "bot") owner(who);
      await env.DB.prepare("INSERT OR IGNORE INTO room_members VALUES (?,?,?)")
        .bind(id, p.id, Date.now())
        .run();
      await publish(id);
      return json({ ok: true });
    }
    if (action === "members" && target && method === "DELETE") {
      human(who);
      if (r.kind !== "channel")
        throw new ChatError(400, "Group participants cannot be changed.");
      if (target !== who.id && r.created_by !== who.id && who.role !== "owner")
        throw new ChatError(403, "Channel owner access required.");
      if (target === r.created_by)
        throw new ChatError(403, "The channel creator cannot be removed.");
      await env.DB.prepare(
        "DELETE FROM room_members WHERE room_id=? AND person_id=?",
      )
        .bind(id, target)
        .run();
      const jobs = await env.DB.prepare(
        "SELECT thread_id FROM agent_threads WHERE room_id=? AND bot_id=?",
      )
        .bind(id, target)
        .all<{ thread_id: string }>();
      for (const job of jobs.results)
        await env.CONVERSATIONS.getByName(job.thread_id).cancel();
      await env.INBOXES.getByName(target).notify(id);
      await publish(id);
      return json({ ok: true });
    }
    if (action === "read" && method === "POST") {
      human(who);
      const input = z
        .object({ seq: z.number().int().nonnegative() })
        .parse(await body(request));
      const latest = await env.DB.prepare(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM chat_messages WHERE room_id=?",
      )
        .bind(id)
        .first<{ seq: number }>();
      await env.DB.prepare(
        "INSERT INTO room_reads VALUES (?,?,?) ON CONFLICT(room_id,person_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq)",
      )
        .bind(id, who.id, Math.min(input.seq, latest!.seq))
        .run();
      waitUntil(env.INBOXES.getByName(who.id).notify(id));
      return json({ ok: true });
    }
    if (action === "messages" && method === "POST")
      return send(request, id, who);
    if (action === "messages" && method === "GET") {
      const parent = url.searchParams.get("parent");
      if (parent) {
        const root = await message(parent, who);
        if (root.room_id !== id || root.parent_id)
          throw new ChatError(404, "Thread not found.");
      }
      const before = z.coerce
        .number()
        .int()
        .positive()
        .parse(url.searchParams.get("before") || Number.MAX_SAFE_INTEGER);
      const around = url.searchParams.get("around");
      if (around) {
        const target = await message(around, who);
        if (target.room_id !== id || target.parent_id !== parent)
          throw new ChatError(404, "Message not found in this conversation.");
        const [earlier, later] = await Promise.all([
          env.DB.prepare(
            "SELECT * FROM chat_messages WHERE room_id=?1 AND parent_id IS ?2 AND seq<=?3 ORDER BY seq DESC LIMIT 51",
          )
            .bind(id, parent, target.seq)
            .all<StoredChat>(),
          env.DB.prepare(
            "SELECT * FROM chat_messages WHERE room_id=?1 AND parent_id IS ?2 AND seq>?3 ORDER BY seq ASC LIMIT 51",
          )
            .bind(id, parent, target.seq)
            .all<StoredChat>(),
        ]);
        return json({
          messages: await hydrate(
            [
              ...earlier.results.slice(0, 50).reverse(),
              ...later.results.slice(0, 50),
            ],
            who,
          ),
          hasMore: earlier.results.length > 50,
          hasNewer: later.results.length > 50,
          latest: later.results.at(-1)?.seq || target.seq,
        });
      }
      const rows = await env.DB.prepare(
        `SELECT * FROM chat_messages WHERE room_id=? AND ${parent ? "parent_id=?" : "parent_id IS NULL"} AND seq<? ORDER BY seq DESC LIMIT 101`,
      )
        .bind(id, ...(parent ? [parent] : []), before)
        .all<StoredChat>();
      const latest = await env.DB.prepare(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM chat_messages WHERE room_id=?",
      )
        .bind(id)
        .first<{ seq: number }>();
      return json({
        messages: await hydrate(rows.results.slice(0, 100).reverse(), who),
        hasMore: rows.results.length > 100,
        latest: latest!.seq,
      });
    }
    if (action === "stop" && method === "POST") {
      human(who);
      await requireRoom(id, who, true);
      const input = z
        .object({ messageId: z.string().uuid() })
        .parse(await body(request));
      const m = await message(input.messageId, who);
      if (m.room_id !== id || !m.run_id)
        throw new ChatError(400, "This message has no agent task.");
      const mapping = await env.DB.prepare(
        "SELECT thread_id FROM agent_threads WHERE room_id=? AND bot_id=? AND root_id=?",
      )
        .bind(id, m.author_id, r.kind === "dm" ? r.id : m.parent_id)
        .first<{ thread_id: string }>();
      if (mapping)
        await env.CONVERSATIONS.getByName(mapping.thread_id).cancel();
      return json({ ok: true });
    }
    if (action === "export" && method === "GET") {
      human(who);
      let before = Number.MAX_SAFE_INTEGER,
        first = true,
        done = false;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(controller) {
          if (done) {
            controller.close();
            return;
          }
          await requireRoom(id, who);
          const rows = await env.DB.prepare(
            "SELECT * FROM chat_messages WHERE room_id=? AND seq<? ORDER BY seq DESC LIMIT 100",
          )
            .bind(id, before)
            .all<StoredChat>();
          const messages = await hydrate(rows.results, who);
          controller.enqueue(
            encoder.encode(
              (first ? "[" : messages.length ? "," : "") +
                messages.map((m) => JSON.stringify(m)).join(","),
            ),
          );
          first = false;
          if (rows.results.length < 100) {
            controller.enqueue(encoder.encode("]"));
            done = true;
            controller.close();
          } else before = rows.results.at(-1)!.seq;
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="melancholy-${id}.json"`,
        },
      });
    }
  }
  const msgMatch = path.match(
    /^\/api\/chat\/messages\/([^/]+)(?:\/(reactions))?$/,
  );
  if (msgMatch) {
    const [, id, action] = msgMatch,
      m = await message(id, who, method !== "GET");
    if (!action && method === "GET")
      return json({ message: (await hydrate([m], who))[0] });
    if (!action && (method === "PATCH" || method === "DELETE")) {
      if (
        m.author_id !== who.id &&
        !(method === "DELETE" && who.role === "owner")
      )
        throw new ChatError(403, "You can only change your own messages.");
      if (m.deleted_at) throw new ChatError(410, "Message was deleted.");
      if (m.run_status === "queued" || m.run_status === "running")
        throw new ChatError(409, "Stop the task before deleting its message.");
      if (method === "PATCH") {
        const input = z
          .object({ text: z.string().trim().min(1).max(32000) })
          .parse(await body(request));
        const tagged = await mentions(input.text, m.room_id);
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE chat_messages SET text=?,edited_at=?,mention_refs=? WHERE id=?",
          ).bind(
            input.text,
            Date.now(),
            JSON.stringify(
              Object.fromEntries(tagged.map((p) => [p.handle, p.id])),
            ),
            id,
          ),
          env.DB.prepare(
            "DELETE FROM message_mentions WHERE message_id=?",
          ).bind(id),
          ...tagged.map((p) =>
            env.DB.prepare("INSERT INTO message_mentions VALUES (?,?)").bind(
              id,
              p.id,
            ),
          ),
          event(m.room_id, id, "message.updated"),
        ]);
      } else
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE chat_messages SET text='',attachments='[]',activity='[]',parts='[]',deleted_at=? WHERE id=?",
          ).bind(Date.now(), id),
          env.DB.prepare(
            "DELETE FROM message_mentions WHERE message_id=?",
          ).bind(id),
          env.DB.prepare(
            "DELETE FROM message_reactions WHERE message_id=?",
          ).bind(id),
          event(m.room_id, id, "message.deleted"),
        ]);
      await publish(m.room_id);
      return json({ ok: true });
    }
    if (action === "reactions" && (method === "PUT" || method === "DELETE")) {
      if (m.deleted_at) throw new ChatError(410, "Message was deleted.");
      const input = z
        .object({
          emoji: z
            .string()
            .min(1)
            .max(32)
            .regex(
              /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200D\uFE0F]+$/u,
              "Choose an emoji.",
            ),
        })
        .parse(await body(request));
      await env.DB.batch([
        method === "PUT"
          ? env.DB.prepare(
              "INSERT OR IGNORE INTO message_reactions VALUES (?,?,?)",
            ).bind(id, who.id, input.emoji)
          : env.DB.prepare(
              "DELETE FROM message_reactions WHERE message_id=? AND person_id=? AND emoji=?",
            ).bind(id, who.id, input.emoji),
        event(m.room_id, id, "reaction.updated"),
      ]);
      await publish(m.room_id);
      return json({ ok: true });
    }
  }
  const interactionRoute = path.match(
    /^\/api\/chat\/messages\/([^/]+)\/interactions\/([^/]+)$/,
  );
  if (interactionRoute && method === "POST") {
    human(who);
    const m = await message(interactionRoute[1], who, true);
    if (!m.run_id || m.deleted_at)
      throw new ChatError(409, "Task unavailable.");
    const r = await room(m.room_id);
    const mapping = await env.DB.prepare(
      "SELECT thread_id FROM agent_threads WHERE room_id=? AND bot_id=? AND root_id=?",
    )
      .bind(m.room_id, m.author_id, r.kind === "dm" ? r.id : m.parent_id)
      .first<{ thread_id: string }>();
    if (!mapping) throw new ChatError(404, "Task not found.");
    const response = interactionResponseSchema.parse(await body(request));
    const result = await env.CONVERSATIONS.getByName(mapping.thread_id).answer(
      m.run_id,
      decodeURIComponent(interactionRoute[2]),
      response,
      who.id,
      who.role === "owner",
    );
    if ("error" in result) throw new ChatError(result.status!, result.error!);
    return json(result);
  }
  if (path === "/api/chat/files" && method === "POST") {
    const roomId = z.string().min(1).parse(url.searchParams.get("room"));
    await requireRoom(roomId, who, true);
    const raw = await bytes(request, 11 * 1024 * 1024);
    const form = await new Response(raw, {
      headers: { "Content-Type": request.headers.get("Content-Type") || "" },
    }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string")
      throw new ChatError(400, "Choose a file.");
    if (file.size > 10 * 1024 * 1024)
      throw new ChatError(413, "Files must be 10 MB or smaller.");
    const id = crypto.randomUUID(),
      name = file.name.slice(0, 200) || "attachment",
      type = file.type || "application/octet-stream";
    await env.FILES.put(id, file.stream(), {
      httpMetadata: { contentType: type },
    });
    await env.DB.prepare(
      "INSERT INTO chat_files(id,room_id,uploader_id,name,size,type,created_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(id, roomId, who.id, name, file.size, type, Date.now())
      .run();
    return json({ id, name, size: file.size, type }, 201);
  }
  const fileId = path.match(/^\/api\/chat\/files\/([^/]+)$/)?.[1];
  if (fileId && method === "GET") return chatFile(request, fileId);
  if (path === "/api/chat/search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    if (!q) return json({ results: [] });
    const access =
      "(EXISTS(SELECT 1 FROM room_members rm WHERE rm.room_id=r.id AND rm.person_id=?) OR (?='human' AND r.kind='channel' AND r.private=0))";
    const rows = await env.DB.prepare(
      `SELECT m.* FROM chat_messages m JOIN rooms r ON r.id=m.room_id ${q.length >= 3 ? "JOIN chat_search f ON f.message_id=m.id" : ""} WHERE m.deleted_at IS NULL AND ${access} AND ${q.length >= 3 ? "chat_search MATCH ?" : "instr(lower(m.text),lower(?))>0"} ${who.roomScope ? "AND r.id=?" : ""} ORDER BY m.seq DESC LIMIT 50`,
    )
      .bind(
        who.id,
        who.kind,
        q.length >= 3 ? '"' + q.replaceAll('"', '""') + '"' : q,
        ...(who.roomScope ? [who.roomScope] : []),
      )
      .all<StoredChat>();
    return json({ results: await hydrate(rows.results, who) });
  }
  if (path === "/api/chat/cloud-bots" && method === "GET") {
    owner(who);
    return json({
      bots: (await env.DB.prepare("SELECT * FROM cloud_bots").all()).results,
    });
  }
  const cloudBotId = path.match(/^\/api\/chat\/cloud-bots\/([^/]+)$/)?.[1];
  if (cloudBotId && method === "PATCH") {
    owner(who);
    const input = cloudBotInput.parse(await body(request));
    await modelCredential(input.credentialId);
    const exists = await env.DB.prepare(
      "SELECT 1 FROM cloud_bots c JOIN people p ON p.id=c.bot_id WHERE c.bot_id=? AND p.active=1",
    )
      .bind(cloudBotId)
      .first();
    if (!exists) throw new ChatError(404, "Cloud bot not found.");
    const threads = await env.DB.prepare(
      "SELECT thread_id FROM agent_threads WHERE bot_id=?",
    )
      .bind(cloudBotId)
      .all<{ thread_id: string }>();
    for (const thread of threads.results) {
      if (await env.CONVERSATIONS.getByName(thread.thread_id).hasActiveRun())
        throw new ChatError(
          409,
          "Stop this bot's active tasks before changing its model settings.",
        );
    }
    await env.DB.prepare(
      "UPDATE cloud_bots SET credential_id=?,model=?,instructions=?,max_steps=?,context_window=? WHERE bot_id=?",
    )
      .bind(
        input.credentialId,
        input.model,
        input.instructions,
        input.maxSteps,
        input.contextWindow,
        cloudBotId,
      )
      .run();
    return json({ ok: true });
  }
  if (path === "/api/chat/bots" && method === "POST") {
    owner(who);
    const input = z
      .object({
        name: z.string().trim().min(1).max(60),
        handle: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
        execution: z.enum(["api", "cloudflare"]).default("api"),
        cloud: cloudBotInput.optional(),
      })
      .parse(await body(request));
    if (input.execution === "cloudflare" && !input.cloud)
      throw new ChatError(400, "Choose a model and LLM credential.");
    if (input.cloud) await modelCredential(input.cloud.credentialId);
    const id = crypto.randomUUID();
    const statements = [
      env.DB.prepare(
        "INSERT INTO people(id,handle,name,kind,created_at,cloud_agent) VALUES (?,?,?,'bot',?,?)",
      ).bind(
        id,
        input.handle,
        input.name,
        Date.now(),
        Number(input.execution === "cloudflare"),
      ),
    ];
    if (input.execution === "cloudflare" && input.cloud) {
      const c = input.cloud;
      statements.push(
        env.DB.prepare("INSERT INTO cloud_bots VALUES (?,?,?,?,?,?,?)").bind(
          id,
          c.credentialId,
          c.model,
          c.instructions,
          c.maxSteps,
          c.contextWindow,
          Date.now(),
        ),
      );
    }
    await env.DB.batch(statements);
    return json(await person(id), 201);
  }
  if (path === "/api/chat/tokens" && method === "GET") {
    owner(who);
    return json({
      tokens: (
        await env.DB.prepare(
          "SELECT id,bot_id,room_id,kind,created_at FROM bot_tokens ORDER BY created_at DESC",
        ).all()
      ).results,
    });
  }
  if (path === "/api/chat/tokens" && method === "POST") {
    owner(who);
    const input = z
      .object({
        botId: z.string(),
        kind: z.enum(["api", "webhook"]),
        roomId: z.string().optional(),
      })
      .parse(await body(request));
    const bot = await person(input.botId);
    if (bot.kind !== "bot") throw new ChatError(400, "Choose a bot.");
    if (input.kind === "webhook" && !input.roomId)
      throw new ChatError(400, "Choose a conversation for the webhook.");
    if (input.roomId) {
      await requireRoom(input.roomId, who, true);
      if (
        !(await env.DB.prepare(
          "SELECT 1 FROM room_members WHERE room_id=? AND person_id=?",
        )
          .bind(input.roomId, bot.id)
          .first())
      )
        throw new ChatError(400, "Add this bot to the conversation first.");
    }
    const id = crypto.randomUUID(),
      token = secret();
    await env.DB.prepare("INSERT INTO bot_tokens VALUES (?,?,?,?,?,?)")
      .bind(
        id,
        await hash(token),
        bot.id,
        input.roomId || null,
        input.kind,
        Date.now(),
      )
      .run();
    return json(
      {
        id,
        token,
        ...(input.kind === "webhook"
          ? { url: `${url.origin}/api/hooks/${token}` }
          : {}),
      },
      201,
    );
  }
  const tokenId = path.match(/^\/api\/chat\/tokens\/([^/]+)$/)?.[1];
  if (tokenId && method === "DELETE") {
    owner(who);
    await env.DB.prepare("DELETE FROM bot_tokens WHERE id=?")
      .bind(tokenId)
      .run();
    return json({ ok: true });
  }
  if (path === "/api/chat/events" && method === "GET") {
    if (who.kind !== "bot") throw new ChatError(403, "Use a bot API token.");
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(url.searchParams.get("after") || 0);
    const events = await env.DB.prepare(
      `SELECT e.* FROM chat_events e JOIN room_members rm ON rm.room_id=e.room_id WHERE rm.person_id=? AND e.seq>? ${who.roomScope ? "AND e.room_id=?" : ""} ORDER BY e.seq LIMIT 100`,
    )
      .bind(who.id, after, ...(who.roomScope ? [who.roomScope] : []))
      .all<{
        seq: number;
        room_id: string;
        message_id: string;
        type: string;
      }>();
    return json({
      events: events.results,
      cursor: events.results.at(-1)?.seq || after,
    });
  }
  throw new ChatError(404, "Not found.");
}
