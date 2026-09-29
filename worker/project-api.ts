import { integrationHealth } from "./integration-health";
import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { body } from "./team-api";
import { hash } from "./auth";
import { ChatError, requireRoom, type Identity } from "./team-auth";
import {
  casualSettings,
  taskCasualPrincipal,
  workspaceOverview,
  readChannel,
  suggestChannel,
} from "./casual";
import {
  notes,
  getNote,
  saveNote,
  deleteNote,
  channelFiles,
} from "./channel-data";
import {
  connection,
  github,
  providerRequest,
  repositoryName,
  unseal,
} from "./integrations";
import { publish } from "./team-store";
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const human = (who: Identity) => {
  if (who.kind !== "human") throw new ChatError(403, "Member access required.");
};
const admin = (who: Identity) => {
  human(who);
  if (who.role !== "owner") throw new ChatError(403, "Owner access required.");
};
async function channel(id: string, who: Identity, write = false) {
  await requireRoom(id, who, write);
  if (
    !(await env.DB.prepare("SELECT 1 FROM rooms WHERE id=? AND kind='channel'")
      .bind(id)
      .first())
  )
    throw new ChatError(404, "Channel not found.");
}
async function executable(botId: string, roomId?: string) {
  if (
    !(await env.DB.prepare(
      "SELECT 1 FROM people p WHERE id=? AND kind='bot' AND active=1 AND (server_id IS NOT NULL OR cloud_agent=1) AND (? IS NULL OR EXISTS(SELECT 1 FROM room_members WHERE person_id=p.id AND room_id=?))",
    )
      .bind(botId, roomId || null, roomId || null)
      .first())
  )
    throw new ChatError(
      400,
      "Choose a Server or Cloudflare agent in this channel.",
    );
}
export async function projectApi(
  request: Request,
  who: Identity,
  path: string,
): Promise<Response | null> {
  const method = request.method,
    url = new URL(request.url);
  if (path === "/api/chat/casual/settings") {
    human(who);
    if (method === "GET") return json(await casualSettings());
    if (method === "PUT") {
      admin(who);
      const input = z
        .object({ enabled: z.boolean(), botId: z.string().nullable() })
        .parse(await body(request));
      if (input.enabled && !input.botId)
        throw new ChatError(400, "Choose an agent first.");
      if (input.botId) await executable(input.botId);
      await env.DB.prepare(
        "UPDATE casual_settings SET enabled=?,bot_id=?,updated_at=? WHERE id='workspace'",
      )
        .bind(Number(input.enabled), input.botId, Date.now())
        .run();
      return json(await casualSettings());
    }
  }
  if (path === "/api/chat/casual/open" && method === "POST") {
    human(who);
    const config = await casualSettings();
    if (!config.enabled || !config.bot_id)
      throw new ChatError(
        400,
        "Enable Casual chat in workspace settings first.",
      );
    await executable(config.bot_id);
    const id =
        "casual-" + (await hash(who.id + ":" + config.bot_id)).slice(0, 32),
      now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO rooms(id,kind,name,topic,private,created_by,created_at) VALUES (?,'group','Casual chat','Your private workspace steward',1,?,?)",
      ).bind(id, who.id, now),
      env.DB.prepare("INSERT OR IGNORE INTO room_members VALUES (?,?,?)").bind(
        id,
        who.id,
        now,
      ),
      env.DB.prepare("INSERT OR IGNORE INTO room_members VALUES (?,?,?)").bind(
        id,
        config.bot_id,
        now,
      ),
      env.DB.prepare("INSERT OR IGNORE INTO casual_rooms VALUES (?,?,?)").bind(
        id,
        who.id,
        config.bot_id,
      ),
    ]);
    return json({ id });
  }
  if (path === "/api/chat/casual/context" && method === "GET") {
    const principal =
      who.kind === "human" ? who : await taskCasualPrincipal(who);
    const integrationId = url.searchParams.get("integrationId");
    if (integrationId)
      return json(await integrationHealth(principal, integrationId));
    const id = url.searchParams.get("channelId");
    return json(
      id
        ? await readChannel(
            principal,
            id,
            (url.searchParams.get("query") || "").slice(0, 200),
          )
        : await workspaceOverview(principal),
    );
  }
  if (path === "/api/chat/casual/suggestions" && method === "POST") {
    await taskCasualPrincipal(who);
    const result = await suggestChannel(
      who.roomScope!,
      who.id,
      await body(request),
    );
    waitUntil(publish(who.roomScope!));
    return json(result, 201);
  }
  const suggestions = path.match(
    /^\/api\/chat\/rooms\/([^/]+)\/suggestions(?:\/([^/]+))?$/,
  );
  if (suggestions) {
    human(who);
    const [, roomId, id] = suggestions;
    await requireRoom(roomId, who, true);
    if (
      !(await env.DB.prepare(
        "SELECT 1 FROM casual_rooms WHERE room_id=? AND user_id=?",
      )
        .bind(roomId, who.id)
        .first())
    )
      throw new ChatError(404, "Casual chat not found.");
    if (method === "GET")
      return json({
        suggestions: (
          await env.DB.prepare(
            "SELECT * FROM channel_suggestions WHERE room_id=? AND dismissed=0 ORDER BY created_at DESC LIMIT 10",
          )
            .bind(roomId)
            .all()
        ).results,
      });
    if (method === "DELETE" && id) {
      await env.DB.prepare(
        "UPDATE channel_suggestions SET dismissed=1 WHERE id=? AND room_id=?",
      )
        .bind(id, roomId)
        .run();
      return json({ ok: true });
    }
  }
  const data = path.match(
    /^\/api\/chat\/rooms\/([^/]+)\/(notes|files|timers|workers)(?:\/([^/]+))?$/,
  );
  if (data) {
    const [, roomId, kind, id] = data;
    await channel(roomId, who, method !== "GET");
    if (kind === "notes") {
      if (method === "GET")
        return id
          ? json(await getNote(roomId, id))
          : json({ notes: await notes(roomId) });
      if ((method === "POST" && !id) || (method === "PUT" && id)) {
        const note = await saveNote(roomId, who.id, await body(request), id);
        waitUntil(publish(roomId));
        return json(note, method === "POST" ? 201 : 200);
      }
      if (method === "DELETE" && id) {
        human(who);
        const version = z.coerce
          .number()
          .int()
          .positive()
          .parse(url.searchParams.get("version"));
        await deleteNote(roomId, who.id, id, version);
        waitUntil(publish(roomId));
        return json({ ok: true });
      }
    }
    if (kind === "files" && method === "GET") {
      const before = z.coerce
        .number()
        .int()
        .positive()
        .parse(url.searchParams.get("before") || Number.MAX_SAFE_INTEGER);
      return json(await channelFiles(roomId, before));
    }
    if (kind === "workers") {
      if (method === "GET")
        return json({
          workers: (
            await env.DB.prepare(
              "SELECT w.id,w.integration_id,w.script_name,i.name AS connection_name,i.account_id FROM room_workers w JOIN integrations i ON i.id=w.integration_id WHERE w.room_id=? ORDER BY w.script_name",
            )
              .bind(roomId)
              .all()
          ).results,
        });
      admin(who);
      if (method === "POST") {
        const input = z
          .object({
            connectionId: z.string().uuid(),
            scriptName: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/),
          })
          .parse(await body(request));
        const c = await connection(input.connectionId);
        if (c.provider !== "cloudflare" || !c.account_id)
          throw new ChatError(400, "Choose a Cloudflare account.");
        const found = (await providerRequest(
          "cloudflare",
          await unseal(c),
          `/accounts/${c.account_id}/workers/scripts/${input.scriptName}/settings`,
        )) as { success: boolean };
        if (!found.success)
          throw new ChatError(502, "Cloudflare could not verify this Worker.");
        await env.DB.batch([
          env.DB.prepare(
            "INSERT OR IGNORE INTO room_integrations(room_id,integration_id) VALUES (?,?)",
          ).bind(roomId, c.id),
          env.DB.prepare(
            "INSERT OR IGNORE INTO room_workers VALUES (?,?,?,?,?)",
          ).bind(
            crypto.randomUUID(),
            roomId,
            c.id,
            input.scriptName,
            Date.now(),
          ),
        ]);
        return json({ ok: true });
      }
      if (method === "DELETE" && id) {
        await env.DB.prepare(
          "DELETE FROM room_workers WHERE id=? AND room_id=?",
        )
          .bind(id, roomId)
          .run();
        return json({ ok: true });
      }
    }
    if (kind === "timers") {
      human(who);
      if (method === "GET")
        return json({
          timers: (
            await env.DB.prepare(
              "SELECT t.*,(SELECT message_id FROM timer_runs WHERE timer_id=t.id ORDER BY scheduled_at DESC LIMIT 1) AS last_message_id,(SELECT COUNT(*) FROM timer_runs WHERE timer_id=t.id) AS runs FROM channel_timers t WHERE room_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200",
            )
              .bind(roomId)
              .all()
          ).results,
        });
      if (method === "POST" && !id) {
        const input = z
          .object({
            id: z.string().uuid().optional(),
            name: z.string().trim().min(1).max(120),
            prompt: z.string().trim().min(1).max(16000),
            botId: z.string(),
            nextAt: z
              .number()
              .int()
              .min(Date.now() - 60000)
              .max(Date.now() + 5 * 365 * 86400000),
            intervalMinutes: z.number().int().min(0).max(525600),
          })
          .parse(await body(request));
        if (input.intervalMinutes > 0 && input.intervalMinutes < 5)
          throw new ChatError(
            400,
            "Repeating timers need an interval of at least five minutes.",
          );
        await executable(input.botId, roomId);
        const count = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM channel_timers WHERE room_id=? AND deleted_at IS NULL",
        )
          .bind(roomId)
          .first<{ n: number }>();
        if ((count?.n || 0) >= 200)
          throw new ChatError(400, "Remove an old timer first.");
        const timerId = input.id || crypto.randomUUID();
        const existing = await env.DB.prepare(
          "SELECT * FROM channel_timers WHERE id=?",
        )
          .bind(timerId)
          .first<{
            room_id: string;
            created_by: string;
            name: string;
            prompt: string;
            bot_id: string;
            interval_minutes: number;
          }>();
        if (existing) {
          if (
            existing.room_id !== roomId ||
            existing.created_by !== who.id ||
            existing.name !== input.name ||
            existing.prompt !== input.prompt ||
            existing.bot_id !== input.botId ||
            existing.interval_minutes !== input.intervalMinutes
          )
            throw new ChatError(
              409,
              "This timer identifier is already in use.",
            );
          return json({ id: timerId });
        }

        await env.DB.prepare(
          "INSERT INTO channel_timers(id,room_id,name,prompt,bot_id,created_by,next_at,interval_minutes,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
          .bind(
            timerId,
            roomId,
            input.name,
            input.prompt,
            input.botId,
            who.id,
            input.nextAt,
            input.intervalMinutes,
            Date.now(),
          )
          .run();
        return json({ id: timerId }, 201);
      }
      if (id && ["PATCH", "DELETE"].includes(method)) {
        const row = await env.DB.prepare(
          "SELECT created_by,bot_id,interval_minutes,next_at FROM channel_timers WHERE id=? AND room_id=? AND deleted_at IS NULL",
        )
          .bind(id, roomId)
          .first<{
            created_by: string;
            bot_id: string;
            interval_minutes: number;
            next_at: number;
          }>();
        if (!row) throw new ChatError(404, "Timer not found.");
        if (who.role !== "owner" && row.created_by !== who.id)
          throw new ChatError(
            403,
            "Only the creator or workspace owner can change this timer.",
          );
        if (method === "DELETE")
          await env.DB.prepare(
            "UPDATE channel_timers SET deleted_at=?,enabled=0,version=version+1 WHERE id=?",
          )
            .bind(Date.now(), id)
            .run();
        else {
          const input = z
            .object({
              enabled: z.boolean(),
              version: z.number().int().positive(),
            })
            .parse(await body(request));
          if (input.enabled) await executable(row.bot_id, roomId);
          const result = await env.DB.prepare(
            "UPDATE channel_timers SET enabled=?,next_at=CASE WHEN interval_minutes=0 AND next_at<=? THEN ? ELSE next_at END,version=version+1,last_error=NULL WHERE id=? AND version=?",
          )
            .bind(
              Number(input.enabled),
              Date.now(),
              Date.now() + 60000,
              id,
              input.version,
            )
            .run();
          if (!result.meta.changes)
            throw new ChatError(
              409,
              "This timer changed. Reload before updating.",
            );
        }
        return json({ ok: true });
      }
    }
  }
  const listWorkers = path.match(
    /^\/api\/chat\/connections\/([^/]+)\/workers$/,
  );
  if (listWorkers && method === "GET") {
    admin(who);
    const c = await connection(listWorkers[1]);
    if (c.provider !== "cloudflare" || !c.account_id)
      throw new ChatError(400, "Choose a Cloudflare account.");
    const result = (await providerRequest(
      "cloudflare",
      await unseal(c),
      `/accounts/${c.account_id}/workers/scripts`,
    )) as { success: boolean; result: { id: string; modified_on?: string }[] };
    if (!result.success || !Array.isArray(result.result))
      throw new ChatError(502, "Cloudflare could not list Workers.");
    return json({
      workers: result.result.map((w) => ({
        name: w.id,
        modifiedAt: w.modified_on,
      })),
    });
  }
  const createRepo = path.match(
    /^\/api\/chat\/rooms\/([^/]+)\/create-repository$/,
  );
  if (createRepo && method === "POST") {
    admin(who);
    const roomId = createRepo[1];
    await channel(roomId, who, true);
    const input = z
      .object({
        connectionId: z.string().uuid(),
        name: z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}$/),
        organization: z
          .string()
          .regex(/^[a-zA-Z0-9-]+$/)
          .optional(),
        private: z.boolean().default(true),
      })
      .parse(await body(request));
    const account = await github<{ login: string }>(
      input.connectionId,
      "/user",
    );
    const fullName = repositoryName(
      (input.organization || account.login) + "/" + input.name,
    );
    const linked = await env.DB.prepare(
      "SELECT id,url FROM room_repositories WHERE room_id=? AND full_name=? AND approved=1",
    )
      .bind(roomId, fullName)
      .first();
    if (linked) return json(linked);
    // A retry can safely attach an existing repo with this explicit owner/name.
    let repo: { full_name: string; html_url: string };
    try {
      repo = await github(input.connectionId, "/repos/" + fullName);
    } catch (e) {
      if (!(e instanceof ChatError) || e.status !== 404) throw e;
      repo = await github(
        input.connectionId,
        input.organization
          ? "/orgs/" + input.organization + "/repos"
          : "/user/repos",
        "POST",
        { name: input.name, private: input.private, auto_init: true },
      );
    }
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO room_integrations(room_id,integration_id) VALUES (?,?)",
      ).bind(roomId, input.connectionId),
      env.DB.prepare(
        "INSERT INTO room_repositories(id,room_id,integration_id,full_name,url,approved,proposed_by,created_at) VALUES (?,?,?,?,?,1,?,?) ON CONFLICT(room_id,full_name) DO UPDATE SET approved=1,integration_id=excluded.integration_id,url=excluded.url",
      ).bind(
        id,
        roomId,
        input.connectionId,
        repo.full_name,
        repo.html_url,
        who.id,
        Date.now(),
      ),
    ]);
    return json(
      await env.DB.prepare(
        "SELECT id,url,full_name FROM room_repositories WHERE room_id=? AND full_name=?",
      )
        .bind(roomId, repo.full_name)
        .first(),
      201,
    );
  }
  return null;
}
