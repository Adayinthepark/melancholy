import { workspaceInfo } from "./workspace-settings";
import { databaseApi } from "./database-api";
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
import type { Server } from "../lib/protocol";
import { handleChat, chatFile } from "./team-api";
import { verifyPassword, ChatError } from "./team-auth";
import { handlePush } from "./push";

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
  if (path.startsWith("/api/data/v1/")) return databaseApi(request);
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
  if (fileId && method === "GET") return chatFile(request, fileId);
  const session = await authenticate(request);
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
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie(request, "", 0),
    });
  }
  const pushResponse = await handlePush(request, env, session, () =>
    body(request),
  );
  if (pushResponse) return pushResponse;
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
    const records = await env.DB.prepare(
      "SELECT id,name,runtime,cwd,hostname,created_at FROM servers ORDER BY created_at",
    ).all<Omit<Server, "online">>();
    const servers = await Promise.all(
      records.results.map(async (s) => ({
        ...s,
        online: await env.CONNECTORS.getByName(s.id).online(),
      })),
    );
    return json({
      ...(await workspaceInfo()),
      servers,
    });
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
  throw new HttpError(404, "Not found.");
}
