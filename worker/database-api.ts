import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { authenticate, checkOrigin, hash, secret } from "./auth";
import {
  bearerIdentity,
  requireRoom,
  ChatError,
  type Identity,
} from "./team-auth";
import { body } from "./team-api";
import { assertCasualActive, isCasual, taskCasualPrincipal } from "./casual";
import { databases, databaseCall } from "./database-store";
import { publish } from "./team-store";
import { scheduledMessageAllowed } from "./channel-timers";
import {
  recordId,
  collectionDefinition,
  type ChannelDatabase,
} from "../lib/channel-database";

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const scopesSchema = z
  .array(z.enum(["read", "write", "schema"]))
  .min(1)
  .max(3)
  .refine((s) => s.includes("read"), "Include read access.")
  .refine(
    (s) => !s.includes("schema") || s.includes("write"),
    "Schema access also requires write access.",
  );
type Grant = { database_id: string; scopes: string; created_by: string };
async function manager(roomId: string, who: Identity) {
  await requireRoom(roomId, who, true);
  if (
    who.kind !== "human" ||
    !(await env.DB.prepare(
      "SELECT 1 FROM rooms WHERE id=? AND kind='channel' AND (created_by=? OR ?='owner')",
    )
      .bind(roomId, who.id, who.role)
      .first())
  )
    throw new ChatError(
      403,
      "The channel creator or workspace owner manages databases and API access.",
    );
}
export async function databaseApi(request: Request): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname.slice("/api/data/v1".length),
    method = request.method;
  let who: Identity | null = null,
    grant: Grant | null = null;
  const bearer = request.headers.get("Authorization");
  if (bearer?.startsWith("Bearer mdb_")) {
    const token = bearer.slice(7);
    if (!/^mdb_[a-f0-9]{64}$/.test(token))
      throw new ChatError(401, "Invalid database token.");
    grant = await env.DB.prepare(
      "SELECT t.database_id,t.scopes,t.created_by FROM database_tokens t JOIN people p ON p.id=t.created_by JOIN channel_databases d ON d.id=t.database_id JOIN room_members m ON m.person_id=p.id AND m.room_id=d.room_id WHERE t.token_hash=? AND t.expires_at>? AND p.active=1 AND d.deleted_at IS NULL",
    )
      .bind(await hash(token), Date.now())
      .first<Grant>();
    if (!grant) throw new ChatError(401, "Database token expired or revoked.");
    const person = await env.DB.prepare(
      "SELECT * FROM people WHERE id=? AND active=1",
    )
      .bind(grant.created_by)
      .first<Identity>();
    who = person ? { ...person, expires: Date.now() + 60000 } : null;
  } else if (bearer) who = await bearerIdentity(request);
  else {
    who = await authenticate(request);
    if (who && !["GET", "HEAD"].includes(method) && !checkOrigin(request))
      throw new ChatError(403, "Origin not allowed.");
  }
  if (!who) throw new ChatError(401, "Sign in or use a database API token.");
  if (who.taskRunId && who.roomScope) {
    await assertCasualActive(who.roomScope, who.id);
    const mapping = await env.DB.prepare(
      "SELECT a.root_id FROM task_credentials t JOIN agent_threads a ON a.thread_id=t.thread_id WHERE t.run_id=?",
    )
      .bind(who.taskRunId)
      .first<{ root_id: string }>();
    if (!mapping || !(await scheduledMessageAllowed(mapping.root_id)))
      throw new ChatError(403, "This task no longer has channel access.");
  }
  // A live steward task may read the current human's channels. Never carry
  // that delegated principal into writes, token management or schema changes.
  const steward =
    who.taskRunId && who.roomScope && (await isCasual(who.roomScope))
      ? { ...(await taskCasualPrincipal(who)), expires: who.expires }
      : null;
  const permission = (scope: string) => {
    if (grant && !JSON.parse(grant.scopes).includes(scope))
      throw new ChatError(403, `This token does not grant ${scope} access.`);
  };
  const listing = path.match(/^\/channels\/([^/]+)\/databases$/);
  if (listing) {
    const roomId = listing[1];
    if (grant)
      throw new ChatError(403, "Use the database URL assigned to this token.");
    await requireRoom(
      roomId,
      method === "GET" ? steward || who : who,
      method !== "GET",
    );
    if (
      !(await env.DB.prepare(
        "SELECT 1 FROM rooms WHERE id=? AND kind='channel'",
      )
        .bind(roomId)
        .first())
    )
      throw new ChatError(404, "Channel not found.");
    if (method === "GET") return json({ databases: await databases(roomId) });
    if (method === "POST") {
      await manager(roomId, who);
      const data = z
        .object({
          id: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(80),
          description: z.string().max(1000).default(""),
        })
        .strict()
        .parse(await body(request));
      const existing = data.id
        ? await env.DB.prepare("SELECT * FROM channel_databases WHERE id=?")
            .bind(data.id)
            .first<ChannelDatabase & { deleted_at: number | null }>()
        : null;
      if (existing) {
        if (
          existing.room_id !== roomId ||
          existing.created_by !== who.id ||
          existing.name !== data.name ||
          existing.description !== data.description ||
          existing.deleted_at
        )
          throw new ChatError(409, "Database ID already exists.");
        return json(existing, 201);
      }
      if ((await databases(roomId)).length >= 20)
        throw new ChatError(400, "A channel supports up to 20 databases.");
      if (
        await env.DB.prepare(
          "SELECT 1 FROM channel_databases WHERE room_id=? AND name=?",
        )
          .bind(roomId, data.name)
          .first()
      )
        throw new ChatError(
          409,
          "This database name is already in use (or archived).",
        );
      const id = data.id || crypto.randomUUID();
      const result = await env.DB.prepare(
        "INSERT OR IGNORE INTO channel_databases(id,room_id,name,description,created_by,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM channel_databases WHERE room_id=? AND deleted_at IS NULL)<20 RETURNING *",
      )
        .bind(
          id,
          roomId,
          data.name,
          data.description,
          who.id,
          Date.now(),
          roomId,
        )
        .first<ChannelDatabase>();
      if (!result) {
        const retried = await env.DB.prepare(
          "SELECT * FROM channel_databases WHERE id=? AND room_id=? AND created_by=? AND name=? AND description=? AND deleted_at IS NULL",
        )
          .bind(id, roomId, who.id, data.name, data.description)
          .first<ChannelDatabase>();
        if (retried) return json(retried, 201);
        throw new ChatError(
          409,
          "Database name or ID is in use, or the channel database limit was reached.",
        );
      }
      return json(result, 201);
    }
  }
  const match = path.match(/^\/databases\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
  if (!match) throw new ChatError(404, "Database endpoint not found.");
  const [, id, tail = ""] = match;
  if (grant && grant.database_id !== id)
    throw new ChatError(404, "Database not found.");
  const database = await env.DB.prepare(
    "SELECT * FROM channel_databases WHERE id=? AND deleted_at IS NULL",
  )
    .bind(id)
    .first<ChannelDatabase>();
  if (!database) throw new ChatError(404, "Database not found.");
  const reading =
    method === "GET" ||
    (method === "POST" && /^collections\/[a-z][a-z0-9_]*\/query$/.test(tail));
  await requireRoom(database.room_id, reading ? steward || who : who, !reading);
  permission(reading ? "read" : "write");
  const call = async (action: string, input: unknown = {}) => {
    const value = await databaseCall(database, action, input, who!.id);
    if (!["collections", "query", "get", "history", "changes"].includes(action))
      waitUntil(publish(database.room_id));
    return json(value);
  };
  const schemaAccess = async () => {
    permission("schema");
    await manager(database.room_id, who!); // Token issuer must still be a channel manager.
  };
  if (!tail) {
    if (method === "GET")
      return json({
        ...database,
        ...(await databaseCall<object>(database, "collections", {}, who.id)),
        api: `${url.origin}/api/data/v1/databases/${id}`,
      });
    if (method === "PATCH" || method === "DELETE") {
      if (grant)
        throw new ChatError(
          403,
          "Database lifecycle requires a signed-in manager.",
        );
      await manager(database.room_id, who);
      if (database.managed)
        throw new ChatError(
          403,
          "The Project database is managed by the workspace.",
        );
      const data = z
        .object({
          version: z.number().int().positive(),
          name: z.string().trim().min(1).max(80).optional(),
          description: z.string().max(1000).optional(),
        })
        .strict()
        .parse(await body(request));
      if (method === "DELETE") {
        const result = await env.DB.prepare(
          "UPDATE channel_databases SET deleted_at=?,version=version+1 WHERE id=? AND version=? AND deleted_at IS NULL RETURNING id",
        )
          .bind(Date.now(), id, data.version)
          .first();
        if (!result)
          throw new ChatError(409, "Database changed. Reload first.");
        await env.DB.prepare("DELETE FROM database_tokens WHERE database_id=?")
          .bind(id)
          .run();
        return json({ archived: true });
      }
      if (
        data.name &&
        (await env.DB.prepare(
          "SELECT 1 FROM channel_databases WHERE room_id=? AND name=? AND id!=?",
        )
          .bind(database.room_id, data.name, id)
          .first())
      )
        throw new ChatError(409, "Database name already exists.");
      const result = await env.DB.prepare(
        "UPDATE channel_databases SET name=?,description=?,version=version+1 WHERE id=? AND version=? RETURNING *",
      )
        .bind(
          data.name || database.name,
          data.description ?? database.description,
          id,
          data.version,
        )
        .first();
      if (!result) throw new ChatError(409, "Database changed. Reload first.");
      return json(result);
    }
  }
  if (tail === "tokens" || tail.startsWith("tokens/")) {
    if (grant || who.kind !== "human")
      throw new ChatError(403, "API tokens cannot manage credentials.");
    await manager(database.room_id, who);
    if (tail === "tokens" && method === "GET")
      return json({
        tokens: (
          await env.DB.prepare(
            "SELECT id,name,scopes,created_at,expires_at FROM database_tokens WHERE database_id=? ORDER BY created_at DESC",
          )
            .bind(id)
            .all()
        ).results.map((t) => ({ ...t, scopes: JSON.parse(String(t.scopes)) })),
      });
    if (tail === "tokens" && method === "POST") {
      const input = z
        .object({
          name: z.string().trim().min(1).max(80),
          scopes: scopesSchema,
          days: z.number().int().min(1).max(365).default(90),
        })
        .strict()
        .parse(await body(request));
      const token = "mdb_" + secret(),
        tokenId = crypto.randomUUID(),
        expires = Date.now() + input.days * 86400000;
      // Bound count, even when several clients provision tokens concurrently.
      const inserted = await env.DB.prepare(
        "INSERT INTO database_tokens(id,database_id,name,token_hash,scopes,created_by,created_at,expires_at) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM database_tokens WHERE database_id=?)<30 RETURNING id",
      )
        .bind(
          tokenId,
          id,
          input.name,
          await hash(token),
          JSON.stringify(input.scopes),
          who.id,
          Date.now(),
          expires,
          id,
        )
        .first();
      if (!inserted)
        throw new ChatError(
          400,
          "Revoke an old token before creating another (limit 30).",
        );
      return json({ id: tokenId, token, expires_at: expires }, 201);
    }
    if (/^tokens\/[a-f0-9-]+$/.test(tail) && method === "DELETE") {
      await env.DB.prepare(
        "DELETE FROM database_tokens WHERE id=? AND database_id=?",
      )
        .bind(tail.slice(7), id)
        .run();
      return json({ ok: true });
    }
  }
  if ((tail === "schema" || tail === "collections") && method === "GET")
    return call("collections");
  if (tail === "schema" && method === "PUT") {
    await schemaAccess();
    const input = z
      .object({
        collections: z
          .array(
            z
              .object({
                definition: collectionDefinition,
                version: z.number().int().nonnegative(),
              })
              .strict(),
          )
          .min(1)
          .max(32),
      })
      .strict()
      .parse(await body(request));
    return call("schema", input.collections);
  }
  if (tail === "changes" && method === "GET")
    return call("changes", {
      after: Number(url.searchParams.get("after") || 0),
      limit: Number(url.searchParams.get("limit") || 100),
    });
  if (tail === "batch" && method === "POST")
    return call("batch", await body(request));
  const collection = tail.match(
    /^collections\/([a-z][a-z0-9_]{0,39})(?:\/(query|records)(?:\/([a-zA-Z0-9_-]{1,100})(?:\/(history|content))?)?)?$/,
  );
  if (collection) {
    const [, name, resource, record, suffix] = collection;
    if (!resource && method === "PUT") {
      await schemaAccess();
      const input = z
        .object({
          definition: collectionDefinition,
          version: z.number().int().nonnegative(),
        })
        .strict()
        .parse(await body(request));
      if (input.definition.name !== name)
        throw new ChatError(400, "Collection name must match the URL.");
      return call("schema", [input]);
    }
    if (!resource && method === "DELETE") {
      await schemaAccess();
      return call("drop", {
        collection: name,
        version: Number(url.searchParams.get("version")),
      });
    }
    if (resource === "query" && method === "POST")
      return call("query", { collection: name, query: await body(request) });
    if (resource === "records" && method === "GET") {
      if (
        record &&
        suffix === "content" &&
        database.managed &&
        name === "files"
      ) {
        permission("read");
        const file = await env.DB.prepare(
          "SELECT f.* FROM chat_files f JOIN chat_messages m ON m.id=f.message_id WHERE f.id=? AND f.room_id=? AND m.deleted_at IS NULL",
        )
          .bind(record, database.room_id)
          .first<{ name: string; type: string }>();
        if (!file) throw new ChatError(404, "File not found.");
        const object = await env.FILES.get(record);
        if (!object) throw new ChatError(404, "File not found.");
        return new Response(object.body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
          },
        });
      }
      if (suffix === "content") throw new ChatError(404, "File not found.");
      if (record)
        return call(suffix === "history" ? "history" : "get", {
          collection: name,
          id: record,
          ...(url.searchParams.has("before")
            ? { before: Number(url.searchParams.get("before")) }
            : {}),
        });
      return call("query", {
        collection: name,
        query: {
          ...(url.searchParams.has("limit")
            ? { limit: Number(url.searchParams.get("limit")) }
            : {}),
          ...(url.searchParams.get("cursor")
            ? { cursor: url.searchParams.get("cursor") }
            : {}),
        },
      });
    }
    if (
      resource === "records" &&
      !suffix &&
      ((method === "POST" && !record) ||
        (record && ["PUT", "DELETE"].includes(method)))
    ) {
      const raw = z
        .object({
          requestId: recordId,
          id: recordId.optional(),
          data: z.record(z.string(), z.unknown()).optional(),
          version: z.number().int().positive().optional(),
        })
        .strict()
        .parse(await body(request));
      const operation = {
        op:
          method === "POST" ? "create" : method === "PUT" ? "update" : "delete",
        collection: name,
        id: record || raw.id || raw.requestId,
        ...(method !== "DELETE" ? { data: raw.data } : {}),
        ...(method !== "POST" ? { version: raw.version } : {}),
      };
      return call("batch", {
        requestId: raw.requestId,
        operations: [operation],
      });
    }
  }
  throw new ChatError(404, "Database endpoint not found.");
}
