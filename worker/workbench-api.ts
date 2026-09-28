import { workspaceInfo } from "./workspace-settings";
import { credentialProviders } from "../lib/credentials";
import {
  credentialColumns,
  saveCredential,
  grantCredential,
} from "./credential-store";
import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { ChatError, requireRoom, type Identity } from "./team-auth";
import { bytes, body } from "./team-api";
import {
  seal,
  connection,
  github,
  providerRequest,
  repositoryName,
} from "./integrations";
import { personColumns, publish } from "./team-store";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const admin = (who: Identity) => {
  if (who.kind !== "human" || who.role !== "owner")
    throw new ChatError(403, "Owner access required.");
};
const human = (who: Identity) => {
  if (who.kind !== "human") throw new ChatError(403, "Member access required.");
};
type Repo = {
  id: string;
  room_id: string;
  integration_id: string;
  full_name: string;
  approved: number;
  url: string;
};
export async function workbench(
  request: Request,
  who: Identity,
  path: string,
): Promise<Response | null> {
  const method = request.method,
    url = new URL(request.url);
  if (path === "/api/chat/settings") {
    admin(who);
    if (method === "GET") return json(await workspaceInfo());
    if (method === "PATCH") {
      const input = z
        .object({
          name: z.string().trim().min(1).max(60),
          description: z.string().trim().max(500).default(""),
        })
        .parse(await body(request));
      await env.DB.prepare(
        "INSERT INTO workspace_settings VALUES ('workspace',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,updated_at=excluded.updated_at",
      )
        .bind(input.name, input.description, Date.now())
        .run();
      return json(input);
    }
  }
  if (path === "/api/chat/avatar" && ["POST", "DELETE"].includes(method)) {
    human(who);
    let avatar: string | null = null;
    if (method === "POST") {
      const data = await bytes(request, 2 * 1024 * 1024);
      const type = request.headers.get("Content-Type");
      const png =
        data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71;
      const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
      const webp =
        new TextDecoder().decode(data.slice(0, 4)) === "RIFF" &&
        new TextDecoder().decode(data.slice(8, 12)) === "WEBP";
      if (!(
        (type === "image/png" && png) ||
        (type === "image/jpeg" && jpeg) ||
        (type === "image/webp" && webp)
      ))
        throw new ChatError(
          400,
          "Choose a PNG, JPEG or WebP image, up to 2 MB.",
        );
      avatar = crypto.randomUUID();
      await env.FILES.put("avatars/" + who.id + "/" + avatar, data, {
        httpMetadata: { contentType: type! },
      });
    }
    await env.DB.prepare("UPDATE people SET avatar_key=? WHERE id=?")
      .bind(avatar, who.id)
      .run();
    if (who.avatar_key)
      waitUntil(env.FILES.delete("avatars/" + who.id + "/" + who.avatar_key));
    return json({ avatar_key: avatar });
  }
  const avatar = path.match(/^\/api\/chat\/avatars\/([^/]+)\/([a-f0-9-]+)$/);
  if (avatar && method === "GET") {
    human(who);
    const person = await env.DB.prepare(
      "SELECT avatar_key FROM people WHERE id=?",
    )
      .bind(avatar[1])
      .first<{ avatar_key: string }>();
    if (person?.avatar_key !== avatar[2])
      throw new ChatError(404, "Image not found.");
    const file = await env.FILES.get("avatars/" + avatar[1] + "/" + avatar[2]);
    if (!file) throw new ChatError(404, "Image not found.");
    return new Response(file.body, {
      headers: {
        "Content-Type": file.httpMetadata?.contentType || "image/png",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  const thread = path.match(/^\/api\/chat\/threads\/([^/]+)\/preferences$/);
  if (thread) {
    const root = await env.DB.prepare(
      "SELECT room_id,parent_id,deleted_at FROM chat_messages WHERE id=?",
    )
      .bind(thread[1])
      .first<{
        room_id: string;
        parent_id: string | null;
        deleted_at: number | null;
      }>();
    if (!root || root.parent_id) throw new ChatError(404, "Thread not found.");
    await requireRoom(root.room_id, who, method !== "GET");
    if (method === "GET")
      return json(
        (await env.DB.prepare(
          "SELECT bot_id FROM thread_preferences WHERE root_id=?",
        )
          .bind(thread[1])
          .first()) || { bot_id: null },
      );
    if (method === "PUT") {
      human(who);
      const input = z
        .object({ botId: z.string().nullable() })
        .parse(await body(request));
      if (
        input.botId &&
        !(await env.DB.prepare(
          "SELECT 1 FROM people p JOIN room_members m ON m.person_id=p.id WHERE p.id=? AND p.kind='bot' AND (p.server_id IS NOT NULL OR p.cloud_agent=1) AND p.active=1 AND m.room_id=?",
        )
          .bind(input.botId, root.room_id)
          .first())
      )
        throw new ChatError(
          400,
          "Choose a connected agent in this conversation.",
        );
      await env.DB.prepare(
        "INSERT INTO thread_preferences VALUES (?,?,?,?) ON CONFLICT(root_id) DO UPDATE SET bot_id=excluded.bot_id,changed_by=excluded.changed_by,updated_at=excluded.updated_at",
      )
        .bind(thread[1], input.botId, who.id, Date.now())
        .run();
      waitUntil(publish(root.room_id));
      return json({ bot_id: input.botId });
    }
  }
  if (path === "/api/chat/usage" && method === "GET") {
    human(who);
    const room = url.searchParams.get("room"),
      root = url.searchParams.get("thread"),
      server = url.searchParams.get("server");
    if (room) await requireRoom(room, who);
    else admin(who);
    const where = [
      room ? "u.room_id=?" : "1=1",
      root ? "u.root_id=?" : "1=1",
      server ? "u.server_id=?" : "1=1",
    ].join(" AND ");
    const args = [
      ...(room ? [room] : []),
      ...(root ? [root] : []),
      ...(server ? [server] : []),
    ];
    const rows = await env.DB.prepare(
      `SELECT u.server_id,s.name AS server_name,u.room_id,r.name AS room_name,u.root_id,u.thread_id,u.runtime,u.model,COUNT(*) AS runs,SUM(u.input_tokens) AS input_tokens,SUM(u.output_tokens) AS output_tokens,SUM(u.cached_tokens) AS cached_tokens,SUM(u.cache_write_tokens) AS cache_write_tokens,SUM(u.cost_usd) AS cost_usd FROM agent_usage u LEFT JOIN servers s ON s.id=u.server_id LEFT JOIN rooms r ON r.id=u.room_id WHERE ${where} GROUP BY u.server_id,u.room_id,u.root_id,u.thread_id,u.runtime,u.model ORDER BY MAX(u.reported_at) DESC LIMIT 500`,
    )
      .bind(...args)
      .all();
    const totals = await env.DB.prepare(
      `SELECT COUNT(*) AS runs,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(cached_tokens),0) AS cached_tokens FROM agent_usage u WHERE ${where}`,
    )
      .bind(...args)
      .first();
    return json({
      rows: rows.results,
      totals,
      limited: rows.results.length === 500,
    });
  }
  if (path === "/api/chat/connections") {
    admin(who);
    if (method === "GET")
      return json({
        connections: [
          ...(
            await env.DB.prepare(
              "SELECT id,provider,name,identity,account_id,created_at FROM integrations ORDER BY created_at",
            ).all()
          ).results,
          ...(
            await env.DB.prepare(
              `SELECT ${credentialColumns} FROM credentials ORDER BY created_at`,
            ).all()
          ).results,
        ],
      });
    if (method === "POST") {
      const data = z
        .object({ provider: z.string() })
        .passthrough()
        .parse(await body(request));
      if (credentialProviders.some((p) => p === data.provider))
        return json(await saveCredential(data, who.id), 201);
      const input = z
        .object({
          provider: z.enum(["github", "cloudflare"]),
          name: z.string().trim().min(1).max(60),
          token: z.string().trim().min(10).max(4096),
          accountId: z
            .string()
            .regex(/^[a-f0-9]{32}$/)
            .optional(),
        })
        .parse(data);
      let identity: string;
      if (input.provider === "github") {
        const user = (await providerRequest(
          "github",
          input.token,
          "/user",
        )) as { login: string };
        identity = user.login;
      } else {
        const check = (await providerRequest(
          "cloudflare",
          input.token,
          "/user/tokens/verify",
        )) as { success: boolean; result: { status: string } };
        if (!check.success || check.result.status !== "active")
          throw new ChatError(400, "This Cloudflare token is not active.");
        identity = input.accountId || "API token";
      }
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO integrations VALUES (?,?,?,?,?,?,?,?)")
        .bind(
          id,
          input.provider,
          input.name,
          identity,
          await seal(input.token, id),
          input.accountId || null,
          who.id,
          Date.now(),
        )
        .run();
      return json(
        { id, provider: input.provider, name: input.name, identity },
        201,
      );
    }
  }
  const conn = path.match(/^\/api\/chat\/connections\/([^/]+)$/);
  if (conn && method === "PUT") {
    admin(who);
    const data = z
      .object({ provider: z.string() })
      .passthrough()
      .parse(await body(request));
    if (credentialProviders.some((p) => p === data.provider))
      return json(await saveCredential(data, who.id, conn[1]));
    const current = await connection(conn[1]);
    const input = z
      .object({
        name: z.string().trim().min(1).max(60),
        token: z.string().trim().min(10).max(4096),
        accountId: z
          .string()
          .regex(/^[a-f0-9]{32}$/)
          .optional(),
      })
      .parse(data);
    if (data.provider !== current.provider)
      throw new ChatError(
        400,
        "Keep the same provider when replacing a credential.",
      );
    let identity = current.identity;
    if (current.provider === "github")
      identity = (
        (await providerRequest("github", input.token, "/user")) as {
          login: string;
        }
      ).login;
    else {
      const result = (await providerRequest(
        "cloudflare",
        input.token,
        "/user/tokens/verify",
      )) as { success: boolean; result: { status: string } };
      if (!result.success || result.result.status !== "active")
        throw new ChatError(400, "This Cloudflare token is not active.");
      identity = input.accountId || "API token";
    }
    await env.DB.prepare(
      "UPDATE integrations SET name=?,identity=?,secret=?,account_id=? WHERE id=?",
    )
      .bind(
        input.name,
        identity,
        await seal(input.token, conn[1]),
        input.accountId || null,
        conn[1],
      )
      .run();
    return json({
      id: conn[1],
      name: input.name,
      provider: current.provider,
      identity,
    });
  }
  if (conn && method === "DELETE") {
    admin(who);
    await env.DB.prepare("DELETE FROM credentials WHERE id=?")
      .bind(conn[1])
      .run();
    await env.DB.prepare("DELETE FROM integrations WHERE id=?")
      .bind(conn[1])
      .run();
    return json({ ok: true });
  }
  const ri = path.match(
    /^\/api\/chat\/rooms\/([^/]+)\/connections(?:\/([^/]+))?$/,
  );
  if (ri) {
    await requireRoom(ri[1], who);
    if (method === "GET") {
      if (!who.taskRunId) human(who);
      return json({
        connections: (
          await env.DB.prepare(
            "SELECT i.id,i.name,i.provider,i.identity,r.agent_enabled,NULL AS env_keys FROM integrations i JOIN room_integrations r ON r.integration_id=i.id WHERE r.room_id=? UNION ALL SELECT c.id,c.name,c.provider,c.identity,r.agent_enabled,c.env_keys FROM credentials c JOIN room_credentials r ON r.credential_id=c.id WHERE r.room_id=?",
          )
            .bind(ri[1], ri[1])
            .all()
        ).results,
      });
    }
    admin(who);
    await requireRoom(ri[1], who, true);
    if (method === "PUT" && ri[2]) {
      const input = z
        .object({ agentEnabled: z.boolean() })
        .parse(await body(request));
      if (await grantCredential(ri[1], ri[2], input.agentEnabled))
        return json({ ok: true });
      const c = await connection(ri[2]);
      await env.DB.batch([
        ...(input.agentEnabled
          ? [
              env.DB.prepare(
                "UPDATE room_integrations SET agent_enabled=0 WHERE room_id=? AND integration_id IN (SELECT id FROM integrations WHERE provider=?)",
              ).bind(ri[1], c.provider),
            ]
          : []),
        env.DB.prepare(
          "INSERT INTO room_integrations VALUES (?,?,?) ON CONFLICT(room_id,integration_id) DO UPDATE SET agent_enabled=excluded.agent_enabled",
        ).bind(ri[1], ri[2], Number(input.agentEnabled)),
      ]);
      return json({ ok: true });
    }
    if (method === "DELETE" && ri[2]) {
      await env.DB.prepare(
        "DELETE FROM room_credentials WHERE room_id=? AND credential_id=?",
      )
        .bind(ri[1], ri[2])
        .run();
      await env.DB.prepare(
        "DELETE FROM room_integrations WHERE room_id=? AND integration_id=?",
      )
        .bind(ri[1], ri[2])
        .run();
      return json({ ok: true });
    }
  }
  const repos = path.match(
    /^\/api\/chat\/rooms\/([^/]+)\/repositories(?:\/([^/]+))?$/,
  );
  if (repos) {
    await requireRoom(repos[1], who, method !== "GET");
    if (method === "GET")
      return json({
        repositories: (
          await env.DB.prepare(
            "SELECT id,room_id,integration_id,full_name,url,approved,proposed_by FROM room_repositories WHERE room_id=? AND (approved=1 OR ?=1 OR proposed_by=?)",
          )
            .bind(repos[1], Number(who.role === "owner"), who.id)
            .all()
        ).results,
      });
    if (method === "POST") {
      const input = z
        .object({ fullName: z.string().max(160), connectionId: z.string() })
        .parse(await body(request));
      const name = repositoryName(input.fullName);
      const c = await connection(input.connectionId);
      if (c.provider !== "github")
        throw new ChatError(400, "Choose a GitHub connection.");
      if (
        await env.DB.prepare(
          "SELECT 1 FROM room_repositories WHERE room_id=? AND full_name=?",
        )
          .bind(repos[1], name)
          .first()
      )
        throw new ChatError(
          409,
          "Repository is already linked or awaiting approval.",
        );
      if (who.kind === "bot") {
        if (
          !(await env.DB.prepare(
            "SELECT 1 FROM room_integrations WHERE room_id=? AND integration_id=?",
          )
            .bind(repos[1], input.connectionId)
            .first())
        )
          throw new ChatError(
            403,
            "The owner must first connect GitHub to this channel.",
          );
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO room_repositories VALUES (?,?,?,?,?,0,?,?)",
        )
          .bind(
            id,
            repos[1],
            input.connectionId,
            name,
            "https://github.com/" + name,
            who.id,
            Date.now(),
          )
          .run();
        waitUntil(publish(repos[1]));
        return json({ id, approved: false }, 202);
      }
      admin(who);
      const repo = await github<{ full_name: string; html_url: string }>(
        input.connectionId,
        "/repos/" + name,
      );
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO room_repositories VALUES (?,?,?,?,?,1,?,?)",
        ).bind(
          id,
          repos[1],
          input.connectionId,
          repo.full_name,
          repo.html_url,
          who.id,
          Date.now(),
        ),
        env.DB.prepare(
          "INSERT OR IGNORE INTO room_integrations VALUES (?,?,0)",
        ).bind(repos[1], input.connectionId),
      ]);
      return json({ id, approved: true }, 201);
    }
    if (repos[2]) {
      admin(who);
      const repo = await env.DB.prepare(
        "SELECT * FROM room_repositories WHERE id=? AND room_id=?",
      )
        .bind(repos[2], repos[1])
        .first<Repo>();
      if (!repo) throw new ChatError(404, "Repository not found.");
      if (method === "PUT") {
        const result = await github<{ full_name: string; html_url: string }>(
          repo.integration_id,
          "/repos/" + repositoryName(repo.full_name),
        );
        await env.DB.prepare(
          "UPDATE room_repositories SET approved=1,full_name=?,url=? WHERE id=?",
        )
          .bind(result.full_name, result.html_url, repo.id)
          .run();
        return json({ ok: true });
      }
      if (method === "DELETE") {
        await env.DB.prepare("DELETE FROM room_repositories WHERE id=?")
          .bind(repo.id)
          .run();
        return json({ ok: true });
      }
    }
  }
  const issue = path.match(
    /^\/api\/chat\/repositories\/([^/]+)\/(issues|labels|assignees)(?:\/(\d+)(?:\/(comments|threads))?)?$/,
  );
  if (issue) {
    const repo = await env.DB.prepare(
      "SELECT * FROM room_repositories WHERE id=? AND approved=1",
    )
      .bind(issue[1])
      .first<Repo>();
    if (!repo) throw new ChatError(404, "Repository not found.");
    await requireRoom(repo.room_id, who, method !== "GET");
    const base = "/repos/" + repositoryName(repo.full_name),
      number = issue[3],
      sub = issue[4];
    if (method === "GET") {
      if (issue[2] === "labels" || issue[2] === "assignees")
        return json(
          await github(
            repo.integration_id,
            base + "/" + issue[2] + "?per_page=100",
          ),
        );
      if (number)
        return json(
          await github(
            repo.integration_id,
            base +
              "/issues/" +
              number +
              (sub === "comments" ? "/comments?per_page=100" : ""),
          ),
        );
      const state = z
        .enum(["open", "closed", "all"])
        .parse(url.searchParams.get("state") || "open");
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .parse(url.searchParams.get("page") || 1);
      const data = await github<{ pull_request?: unknown }[]>(
        repo.integration_id,
        base +
          "/issues?per_page=30&sort=updated&state=" +
          state +
          "&page=" +
          page,
      );
      return json({
        issues: data.filter((i) => !i.pull_request),
        hasMore: data.length === 30,
      });
    }
    human(who);
    if (sub === "threads" && method === "POST") {
      const input = z
        .object({ rootId: z.string().uuid() })
        .parse(await body(request));
      const root = await env.DB.prepare(
        "SELECT 1 FROM chat_messages WHERE id=? AND room_id=? AND parent_id IS NULL AND author_id=?",
      )
        .bind(input.rootId, repo.room_id, who.id)
        .first();
      if (!root) throw new ChatError(404, "Thread not found.");
      const data = await github<{ html_url: string }>(
        repo.integration_id,
        base + "/issues/" + number,
      );
      await env.DB.prepare(
        "INSERT INTO issue_threads VALUES (?,?,?,?) ON CONFLICT(root_id) DO UPDATE SET repository_id=excluded.repository_id,number=excluded.number,url=excluded.url",
      )
        .bind(input.rootId, repo.id, Number(number), data.html_url)
        .run();
      return json({ ok: true });
    }
    if (sub === "comments" && method === "POST") {
      const input = z
        .object({ body: z.string().trim().min(1).max(65000) })
        .parse(await body(request));
      return json(
        await github(
          repo.integration_id,
          base + "/issues/" + number + "/comments",
          "POST",
          input,
        ),
        201,
      );
    }
    if (
      issue[2] === "issues" &&
      ((method === "POST" && !number) || (method === "PATCH" && number))
    ) {
      const input = z
        .object({
          title: z.string().trim().min(1).max(256).optional(),
          body: z.string().max(65000).optional(),
          state: z.enum(["open", "closed"]).optional(),
          labels: z.array(z.string().max(100)).max(30).optional(),
          assignees: z.array(z.string().max(100)).max(10).optional(),
        })
        .parse(await body(request));
      if (method === "POST" && !input.title)
        throw new ChatError(400, "Enter an issue title.");
      return json(
        await github(
          repo.integration_id,
          base + "/issues" + (number ? "/" + number : ""),
          method,
          input,
        ),
        method === "POST" ? 201 : 200,
      );
    }
  }
  return null;
}
