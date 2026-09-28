import { workspaceInfo } from "./workspace-settings";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { jobEnvironment } from "./integrations";
import {
  authenticate,
  checkOrigin,
  COOKIE,
  hash,
  keyMatches,
  secret,
  SESSION_AGE,
  sessionCookie,
} from "./auth";
import type { Attachment, Runtime, Server, Thread } from "../lib/protocol";
import { handleChat, chatFile } from "./team-api";
import { verifyPassword, requireRoom, ChatError } from "./team-auth";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
async function limitedBody(
  request: Request,
  max = 1024 * 1024,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("content-length")) > max)
    throw new HttpError(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel();
      throw new HttpError(413, "Request is too large.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
async function body(request: Request): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await limitedBody(request)));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Invalid JSON.");
  }
}
async function thread(id: string): Promise<Thread> {
  const record = await env.DB.prepare("SELECT * FROM threads WHERE id=?")
    .bind(id)
    .first<Thread>();
  if (!record) throw new HttpError(404, "Thread not found.");
  return record;
}
type ServerRecord = Omit<Server, "online"> & { token_hash: string };
async function server(id: string): Promise<ServerRecord> {
  const record = await env.DB.prepare("SELECT * FROM servers WHERE id=?")
    .bind(id)
    .first<ServerRecord>();
  if (!record) throw new HttpError(404, "Server not found.");
  return record;
}
async function connectorIdentity(
  request: Request,
): Promise<ServerRecord | null> {
  const bearer = request.headers.get("Authorization");
  if (!bearer?.startsWith("Bearer ") || bearer.length > 200) return null;
  return env.DB.prepare("SELECT * FROM servers WHERE token_hash=?")
    .bind(await hash(bearer.slice(7)))
    .first<ServerRecord>();
}

export async function handleApi(request: Request): Promise<Response> {
  try {
    return await route(request);
  } catch (error) {
    if (error instanceof HttpError || error instanceof ChatError)
      return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json(
        { error: error.issues[0]?.message ?? "Invalid request." },
        400,
      );
    // Keep prompts, credentials and downstream exception details out of public responses.
    console.error(
      JSON.stringify({
        event: "api_error",
        path: new URL(request.url).pathname,
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return json(
      { error: "The request could not be completed. Try again." },
      500,
    );
  }
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (
    path.startsWith("/api/chat/") ||
    path.startsWith("/api/v1/") ||
    path.startsWith("/api/hooks/") ||
    path === "/api/join"
  )
    return handleChat(request);
  if (path === "/api/health" && method === "GET")
    return json({ ok: true, version: "0.3.0" });

  if (path === "/api/connector/environment" && method === "POST") {
    const identity = await connectorIdentity(request);
    if (!identity) throw new HttpError(401, "Invalid connector token.");
    const input = z
      .object({ threadId: z.string().uuid(), runId: z.string().uuid() })
      .parse(await body(request));
    return json({
      environment: await jobEnvironment(
        identity.id,
        input.threadId,
        input.runId,
        url.origin,
      ),
    });
  }
  if (path === "/api/connector" && method === "GET") {
    const identity = await connectorIdentity(request);
    if (!identity) throw new HttpError(401, "Invalid connector token.");
    const headers = new Headers(request.headers);
    headers.set("x-connector-id", identity.id);
    return env.CONNECTORS.getByName(identity.id).fetch(
      new Request(request, { headers }),
    );
  }
  if (path === "/api/login" && method === "POST") {
    if (!checkOrigin(request)) throw new HttpError(403, "Origin not allowed.");
    const address = await hash(
      request.headers.get("CF-Connecting-IP") || "local",
    );
    if (!(await env.INBOXES.getByName("login:" + address).allowLogin()))
      throw new HttpError(
        429,
        "Too many sign-in attempts. Try again in a minute.",
      );
    const input = z
      .object({
        key: z.string().min(1).max(256).optional(),
        handle: z.string().min(1).max(40).optional(),
        password: z.string().min(1).max(256).optional(),
      })
      .parse(await body(request));
    let personId = "owner";
    const member = input.handle
      ? await env.DB.prepare(
          "SELECT id,password_hash FROM people WHERE handle=? AND kind='human' AND active=1",
        )
          .bind(input.handle.toLowerCase())
          .first<{ id: string; password_hash: string | null }>()
      : null;
    const valid = input.key
      ? await keyMatches(input.key)
      : !!(
          member?.password_hash &&
          input.password &&
          (await verifyPassword(input.password, member.password_hash))
        );
    if (!valid) throw new HttpError(401, "Invalid sign-in credentials.");
    if (!input.key && member) personId = member.id;
    const token = secret();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
      env.DB.prepare(
        "INSERT INTO sessions(token_hash,expires_at,person_id) VALUES (?,?,?)",
      ).bind(await hash(token), now + SESSION_AGE * 1000, personId),
    ]);
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie(request, token),
    });
  }
  if (path === "/api/redeem" && method === "POST") {
    if (!checkOrigin(request)) throw new HttpError(403, "Origin not allowed.");
    const input = z
      .object({ ticket: z.string().length(64) })
      .parse(await body(request));
    const used = await env.DB.prepare(
      "DELETE FROM login_tickets WHERE token_hash=? AND expires_at>? AND person_id IN (SELECT id FROM people WHERE active=1) RETURNING person_id",
    )
      .bind(await hash(input.ticket), Date.now())
      .first<{ person_id: string }>();
    if (!used)
      throw new HttpError(
        401,
        "This sign-in link has expired or was already used.",
      );
    const token = secret();
    await env.DB.prepare(
      "INSERT INTO sessions(token_hash,expires_at,person_id) VALUES (?,?,?)",
    )
      .bind(await hash(token), Date.now() + SESSION_AGE * 1000, used.person_id)
      .run();
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie(request, token),
    });
  }

  const fileId = path.match(/^\/api\/files\/([a-f0-9-]+)$/)?.[1];
  const session = await authenticate(request);
  if (fileId && method === "GET") {
    if (
      await env.DB.prepare("SELECT id FROM chat_files WHERE id=?")
        .bind(fileId)
        .first()
    )
      return chatFile(request, fileId);
    const file = await env.DB.prepare("SELECT * FROM files WHERE id=?")
      .bind(fileId)
      .first<Attachment & { thread_id: string }>();
    if (!file) throw new HttpError(404, "File not found.");
    if (!session || session.role !== "owner") {
      const identity = await connectorIdentity(request);
      if (!identity || (await thread(file.thread_id)).server_id !== identity.id)
        throw new HttpError(401, "Sign in to download this file.");
    }
    const object = await env.FILES.get(file.id);
    if (!object) throw new HttpError(404, "File not found.");
    const preview =
      url.searchParams.get("preview") === "1" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        file.type,
      );
    return new Response(object.body, {
      headers: {
        "Content-Type": preview ? file.type : "application/octet-stream",
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Content-Length": String(object.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  if (!session) throw new HttpError(401, "Sign in to your workspace.");
  if (
    (!["GET", "HEAD"].includes(method) || request.headers.get("Upgrade")) &&
    !checkOrigin(request)
  )
    throw new HttpError(403, "Origin not allowed.");
  if (path === "/api/logout" && method === "POST") {
    const token = request.headers
      .get("Cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(COOKIE + "="))
      ?.slice(COOKIE.length + 1);
    if (token)
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(await hash(token))
        .run();
    // New workspace sockets are scoped to this exact browser session.
    await env.INBOXES.getByName(session.id).closeSession(session.sessionHash!);
    const rooms = await env.DB.prepare(
      "SELECT id FROM threads WHERE archived=0 AND NOT EXISTS(SELECT 1 FROM agent_threads a WHERE a.thread_id=threads.id)",
    ).all<{ id: string }>();
    await Promise.all(
      (session.role === "owner" ? rooms.results : []).map((r) =>
        env.CONVERSATIONS.getByName(r.id).closeSessions(),
      ),
    );
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie(request, "", 0),
    });
  }
  if (path === "/api/login-links" && method === "POST") {
    const ticket = secret();
    const expires = Date.now() + 86400000;
    await env.DB.prepare(
      "INSERT INTO login_tickets(token_hash,expires_at,person_id) VALUES (?,?,?)",
    )
      .bind(await hash(ticket), expires, session.id)
      .run();
    return json({ url: `${url.origin}/#ticket=${ticket}`, expires }, 201);
  }
  if (session.role !== "owner")
    throw new HttpError(403, "Owner access required.");
  if (path === "/api/workspace" && method === "GET") {
    const [channels, threads, records] = await Promise.all([
      env.DB.prepare("SELECT * FROM channels ORDER BY rowid").all(),
      env.DB.prepare(
        "SELECT * FROM threads WHERE archived=0 AND NOT EXISTS(SELECT 1 FROM agent_threads a WHERE a.thread_id=threads.id) ORDER BY updated_at DESC LIMIT 200",
      ).all<Thread>(),
      env.DB.prepare(
        "SELECT id,name,runtime,cwd,hostname,created_at FROM servers ORDER BY created_at",
      ).all<Omit<Server, "online">>(),
    ]);
    const servers = await Promise.all(
      records.results.map(async (s) => ({
        ...s,
        online: await env.CONNECTORS.getByName(s.id).online(),
      })),
    );
    return json({
      ...(await workspaceInfo()),
      channels: channels.results,
      threads: threads.results,
      servers,
    });
  }
  if (path === "/api/channels" && method === "POST") {
    const input = z
      .object({
        name: z
          .string()
          .trim()
          .regex(
            /^[a-z0-9][a-z0-9-]{0,39}$/,
            "Use lowercase letters, numbers, and hyphens.",
          ),
        description: z.string().max(200).default(""),
      })
      .parse(await body(request));
    if (
      await env.DB.prepare("SELECT id FROM channels WHERE name=?")
        .bind(input.name)
        .first()
    )
      throw new HttpError(409, "This channel already exists.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO channels VALUES (?,?,?)")
      .bind(id, input.name, input.description)
      .run();
    return json({ id, ...input }, 201);
  }
  if (path === "/api/servers" && method === "POST") {
    const input = z
      .object({
        name: z.string().trim().min(1).max(60),
        runtime: z.enum(["codex", "claude"]),
      })
      .parse(await body(request));
    const id = crypto.randomUUID();
    const token = secret();
    await env.DB.prepare(
      "INSERT INTO servers (id,name,runtime,token_hash,created_at) VALUES (?,?,?,?,?)",
    )
      .bind(id, input.name, input.runtime, await hash(token), Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO people(id,handle,name,kind,server_id,created_at) VALUES (?,?,?,'bot',?,?)",
    )
      .bind(
        id,
        input.runtime + "-" + id.slice(0, 8),
        input.name,
        id,
        Date.now(),
      )
      .run();
    return json({ id, token, ...input }, 201);
  }
  const serverId = path.match(/^\/api\/servers\/([a-f0-9-]+)$/)?.[1];
  if (serverId && method === "PATCH") {
    await server(serverId);
    const input = z
      .object({ name: z.string().trim().min(1).max(60) })
      .parse(await body(request));
    await env.DB.batch([
      env.DB.prepare("UPDATE servers SET name=? WHERE id=?").bind(
        input.name,
        serverId,
      ),
      env.DB.prepare("UPDATE people SET name=? WHERE server_id=?").bind(
        input.name,
        serverId,
      ),
    ]);
    return json({ ok: true });
  }
  if (serverId && method === "DELETE") {
    await server(serverId);
    await env.DB.prepare("UPDATE people SET active=0 WHERE server_id=?")
      .bind(serverId)
      .run();
    await env.DB.prepare("DELETE FROM servers WHERE id=?").bind(serverId).run();
    await env.CONNECTORS.getByName(serverId).revoke();
    return json({ ok: true });
  }
  if (path === "/api/threads" && method === "POST") {
    const input = z
      .object({
        channelId: z.string().max(100),
        serverId: z.string().uuid(),
        title: z.string().trim().min(1).max(120).default("New thread"),
      })
      .parse(await body(request));
    if (
      !(await env.DB.prepare("SELECT id FROM channels WHERE id=?")
        .bind(input.channelId)
        .first())
    )
      throw new HttpError(404, "Channel not found.");
    await server(input.serverId);
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,0)")
      .bind(id, input.channelId, input.title, input.serverId, now, now)
      .run();
    return json(await thread(id), 201);
  }
  const match = path.match(
    /^\/api\/threads\/([a-f0-9-]+)(?:\/(messages|socket|stop|export))?$/,
  );
  if (match) {
    const record = await thread(match[1]);
    const linked = await env.DB.prepare(
      "SELECT room_id FROM agent_threads WHERE thread_id=?",
    )
      .bind(record.id)
      .first<{ room_id: string }>();
    if (linked) {
      try {
        await requireRoom(linked.room_id, session);
      } catch {
        throw new HttpError(404, "Thread not found.");
      }
    }
    const room = env.CONVERSATIONS.getByName(record.id);
    const action = match[2];
    if (!action && method === "GET") return json(record);
    if (!action && method === "PATCH") {
      const input = z
        .object({
          title: z.string().trim().min(1).max(120).optional(),
          archived: z.boolean().optional(),
        })
        .parse(await body(request));
      if (input.archived) await room.cancel();
      await env.DB.prepare("UPDATE threads SET title=?,archived=? WHERE id=?")
        .bind(
          input.title ?? record.title,
          input.archived === undefined
            ? record.archived
            : Number(input.archived),
          record.id,
        )
        .run();
      return json(await thread(record.id));
    }
    if (action === "socket" && method === "GET") {
      const headers = new Headers(request.headers);
      headers.set("x-session-expires", String(session.expires));
      return room.fetch(new Request(request, { headers }));
    }
    if (action === "messages" && method === "GET") {
      const before = url.searchParams.get("before");
      return json(
        await room.snapshot(
          before ? z.coerce.number().int().positive().parse(before) : undefined,
        ),
      );
    }
    if (action === "messages" && method === "POST") {
      if (record.archived) throw new HttpError(409, "This thread is archived.");
      if (!record.server_id)
        throw new HttpError(
          409,
          "This thread's server was removed. Start a new thread.",
        );
      const input = z
        .object({
          id: z.string().uuid(),
          text: z.string().trim().min(1).max(32000),
          attachments: z.array(z.string().uuid()).max(8).default([]),
        })
        .parse(await body(request));
      const target = await server(record.server_id);
      const attachments: Attachment[] = [];
      for (const id of input.attachments) {
        const file = await env.DB.prepare(
          "SELECT id,name,size,type FROM files WHERE id=? AND thread_id=?",
        )
          .bind(id, record.id)
          .first<Attachment>();
        if (!file)
          throw new HttpError(400, "Attachment not found in this thread.");
        attachments.push(file);
      }
      let result;
      try {
        result = await room.send({
          threadId: record.id,
          serverId: target.id,
          runtime: target.runtime as Runtime,
          text: input.text,
          id: input.id,
          attachments,
        });
      } catch (e) {
        if (e instanceof Error && e.message.includes("already running"))
          throw new HttpError(
            409,
            "A turn is already running. Stop it before sending another.",
          );
        throw e;
      }
      if (result.error) throw new HttpError(409, result.error);
      if (record.title === "New thread")
        await env.DB.prepare(
          "UPDATE threads SET title=?,updated_at=? WHERE id=?",
        )
          .bind(input.text.slice(0, 80), Date.now(), record.id)
          .run();
      return json(result, 202);
    }
    if (action === "stop" && method === "POST") {
      await room.cancel();
      return json({ ok: true });
    }
    if (action === "export" && method === "GET") {
      let before: number | undefined;
      let initial = true;
      let finished = false;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (finished) {
            controller.close();
            return;
          }
          const page = await room.snapshot(before);
          const prefix = initial
            ? `{"thread":${JSON.stringify(record)},"messages":[`
            : page.messages.length
              ? ","
              : "";
          controller.enqueue(
            encoder.encode(
              prefix +
                page.messages
                  .slice()
                  .reverse()
                  .map((m) => JSON.stringify(m))
                  .join(","),
            ),
          );
          initial = false;
          if (!page.hasMore) {
            controller.enqueue(encoder.encode("]}"));
            finished = true;
            controller.close();
          } else before = page.messages[0].created_at;
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="melancholy-${record.id}.json"`,
        },
      });
    }
  }
  if (path === "/api/files" && method === "POST") {
    const threadId = z.string().uuid().parse(url.searchParams.get("thread"));
    await thread(threadId);
    const bytes = await limitedBody(request, 11 * 1024 * 1024);
    const form = await new Response(bytes, {
      headers: { "Content-Type": request.headers.get("Content-Type") ?? "" },
    }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string")
      throw new HttpError(400, "Choose a file.");
    if (file.size > 10 * 1024 * 1024)
      throw new HttpError(413, "Files must be 10 MB or smaller.");
    const id = crypto.randomUUID();
    const name = file.name.slice(0, 200) || "attachment";
    await env.FILES.put(id, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
    await env.DB.prepare("INSERT INTO files VALUES (?,?,?,?,?,?)")
      .bind(
        id,
        name,
        file.size,
        file.type || "application/octet-stream",
        threadId,
        Date.now(),
      )
      .run();
    return json({ id, name, size: file.size, type: file.type }, 201);
  }
  if (path === "/api/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    if (!q) return json({ results: [] });
    const results =
      q.length >= 3
        ? await env.DB.prepare(
            "SELECT s.thread_id,s.message_id,s.text,t.title,t.channel_id FROM search s JOIN threads t ON t.id=s.thread_id WHERE search MATCH ? AND t.archived=0 AND NOT EXISTS(SELECT 1 FROM agent_threads a WHERE a.thread_id=t.id) LIMIT 30",
          )
            .bind('"' + q.replaceAll('"', '""') + '"')
            .all()
        : await env.DB.prepare(
            "SELECT s.thread_id,s.message_id,s.text,t.title,t.channel_id FROM search_messages s JOIN threads t ON t.id=s.thread_id WHERE instr(lower(s.text),lower(?))>0 AND t.archived=0 AND NOT EXISTS(SELECT 1 FROM agent_threads a WHERE a.thread_id=t.id) LIMIT 30",
          )
            .bind(q)
            .all();
    return json({
      results: results.results.map((r) => ({
        ...r,
        text: String(r.text).slice(0, 500),
      })),
    });
  }
  throw new HttpError(404, "Not found.");
}
