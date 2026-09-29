import { inspectAgent } from "./inspect-agent";
import { jobEnvironment } from "../worker/integrations";
import { integrationHealth } from "../worker/integration-health";
import { beforeAll, afterEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { handleApi } from "../worker/api";
import { hash, secret } from "../worker/auth";
import {
  casualPrincipal,
  suggestChannel,
  workspaceOverview,
  readChannel,
} from "../worker/casual";
import {
  runChannelTimers,
  scheduledMessageAllowed,
} from "../worker/channel-timers";
import { seal } from "../worker/integrations";
import type { Person, TeamWorkspace } from "../lib/chat";
beforeAll(async () => {
  await applyD1Migrations(
    env.DB,
    (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] })
      .TEST_MIGRATIONS,
  );
});
afterEach(() => vi.restoreAllMocks());
const origin = "https://projects.test";
async function request(
  path: string,
  cookie: string,
  method = "GET",
  data?: unknown,
  token?: string,
) {
  return handleApi(
    new Request(origin + "/api" + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(data instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(data === undefined
        ? {}
        : { body: data instanceof FormData ? data : JSON.stringify(data) }),
    }),
  );
}
async function identity(owner = false) {
  const id = owner ? "owner" : crypto.randomUUID();
  if (!owner)
    await env.DB.prepare(
      "INSERT INTO people(id,handle,name,kind,created_at) VALUES (?,?,?,'human',?)",
    )
      .bind(id, "u" + id.slice(0, 8), "Member", Date.now())
      .run();
  const token = secret();
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,expires_at,person_id) VALUES (?,?,?)",
  )
    .bind(await hash(token), Date.now() + 86400000, id)
    .run();
  const cookie = "melancholy_session=" + token;
  const who = (
    (await (await request("/chat/workspace", cookie)).json()) as TeamWorkspace
  ).me;
  return { id, cookie, who };
}
async function room(cookie: string, members: string[] = [], priv = true) {
  const r = await request("/chat/rooms", cookie, "POST", {
    name: "project-" + crypto.randomUUID().slice(0, 8),
    private: priv,
    members,
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
async function server(cookie: string) {
  const r = await request("/servers", cookie, "POST", {
    name: "Projects server",
    runtime: "codex",
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; token: string };
}
async function configure(cookie: string, botId: string, enabled = true) {
  return request("/chat/casual/settings", cookie, "PUT", { enabled, botId });
}
async function open(cookie: string) {
  const r = await request("/chat/casual/open", cookie, "POST");
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
}
async function dbCount(table: string, where: string, value: string) {
  return (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}=?`,
  )
    .bind(value)
    .first<{ n: number }>())!.n;
}
async function timer(
  cookie: string,
  roomId: string,
  botId: string,
  intervalMinutes = 60,
) {
  const nextAt = Date.now() - 1000;
  const r = await request("/chat/rooms/" + roomId + "/timers", cookie, "POST", {
    name: "Review project",
    prompt: "Review Notes and open issues.",
    botId,
    nextAt,
    intervalMinutes,
  });
  expect(r.status).toBe(201);
  return { id: ((await r.json()) as { id: string }).id, nextAt };
}
async function integration(
  owner: string,
  provider: "github" | "cloudflare",
  token = "provider-secret-do-not-expose",
) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO integrations VALUES (?,?,?,?,?,?,?,?)")
    .bind(
      id,
      provider,
      provider + " test",
      "account",
      await seal(token, id),
      provider === "cloudflare" ? "12345678901234567890123456789012" : null,
      owner,
      Date.now(),
    )
    .run();
  return id;
}
describe("workspace steward and project data", () => {
  it("creates idempotent private Casual chats per member and protects their participants", async () => {
    const a = await identity(true),
      b = await identity(),
      bot = await server(a.cookie);
    expect((await configure(b.cookie, bot.id)).status).toBe(403);
    expect((await configure(a.cookie, bot.id)).status).toBe(200);
    const first = await open(a.cookie),
      other = await open(b.cookie);
    expect(await open(a.cookie)).toBe(first);
    expect(other).not.toBe(first);
    expect(
      (await request("/chat/rooms/" + other + "/messages", a.cookie)).status,
    ).toBe(404);
    expect(
      (
        await request("/chat/rooms/" + first + "/members", a.cookie, "POST", {
          personId: b.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/chat/rooms/" + first, a.cookie, "PATCH", {
          name: "Shared",
          topic: "",
          private: false,
        })
      ).status,
    ).toBe(403);
    expect((await casualPrincipal(other, bot.id)).id).toBe(b.id);
    await configure(a.cookie, bot.id, false);
    await expect(casualPrincipal(other, bot.id)).rejects.toThrow("disabled");
    expect((await request("/chat/casual/open", b.cookie, "POST")).status).toBe(
      400,
    );
    expect(
      (
        await request("/chat/rooms/" + other + "/messages", b.cookie, "POST", {
          text: "hello",
        })
      ).status,
    ).toBe(403);
  });
  it("reads only accessible channels and integration metadata, never secrets or private conversations", async () => {
    const a = await identity(true),
      b = await identity(),
      privateId = await room(a.cookie),
      publicId = await room(a.cookie, [], false),
      shared = await room(a.cookie, [b.id]);
    const linked = await integration(a.id, "github"),
      hidden = await integration(a.id, "cloudflare");
    await env.DB.prepare("INSERT INTO room_integrations VALUES (?,?,0)")
      .bind(shared, linked)
      .run();
    const r = await workspaceOverview(b.who);
    expect(r.channels.map((c) => c.id)).toContain(publicId);
    expect(r.channels.map((c) => c.id)).not.toContain(privateId);
    expect(r.integrations.map((c) => c.id)).toContain(linked);
    expect(r.integrations.map((c) => c.id)).not.toContain(hidden);
    expect(JSON.stringify(r)).not.toContain("provider-secret");
    expect(JSON.stringify(r)).not.toContain("ciphertext");
    await expect(readChannel(b.who, privateId)).rejects.toThrow("not found");
    expect(
      (await workspaceOverview(a.who)).integrations.map((c) => c.id),
    ).toContain(hidden);
  });
  it("proposes a channel without creating it and revokes access when agent assignment changes", async () => {
    const a = await identity(true),
      bot = await server(a.cookie);
    await configure(a.cookie, bot.id);
    const id = await open(a.cookie);
    const proposal = {
      name: "idea-" + crypto.randomUUID().slice(0, 8),
      topic: "Explore an idea",
      brief: "Goal and acceptance criteria.",
    };
    const result = await suggestChannel(id, bot.id, proposal);
    expect(await dbCount("rooms", "name", proposal.name)).toBe(0);
    expect((await suggestChannel(id, bot.id, proposal)).id).toBe(result.id);
    const r = await request("/chat/rooms/" + id + "/suggestions", a.cookie);
    expect(
      ((await r.json()) as { suggestions: unknown[] }).suggestions,
    ).toHaveLength(1);
    expect(
      (await request("/v1/casual/suggestions", "", "POST", proposal, bot.token))
        .status,
    ).toBe(401);
    const newBot = await server(a.cookie);
    await configure(a.cookie, newBot.id);
    await expect(suggestChannel(id, bot.id, proposal)).rejects.toThrow(
      "changed",
    );
    expect(await open(a.cookie)).not.toBe(id);
  });
  it("keeps note versions, rejects stale writes and blocks writes outside channel membership", async () => {
    const a = await identity(true),
      b = await identity(),
      id = await room(a.cookie),
      publicId = await room(a.cookie, [], false);
    const create = await request(
      "/chat/rooms/" + id + "/notes",
      a.cookie,
      "POST",
      { title: "Decision", content: "Use D1." },
    );
    expect(create.status).toBe(201);
    const n = (await create.json()) as { id: string; version: number };
    expect(
      (await request("/chat/rooms/" + id + "/notes", b.cookie)).status,
    ).toBe(404);
    expect(
      (
        await request("/chat/rooms/" + publicId + "/notes", b.cookie, "POST", {
          title: "x",
          content: "x",
        })
      ).status,
    ).toBe(403);
    const path = "/chat/rooms/" + id + "/notes/" + n.id;
    expect(
      (
        await request(path, a.cookie, "PUT", {
          title: "Decision",
          content: "Keep sources.",
          version: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(path, a.cookie, "PUT", {
          title: "Stale",
          content: "Lost update",
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (await request(path + "?version=1", a.cookie, "DELETE")).status,
    ).toBe(409);
    expect(
      (await request(path + "?version=2", a.cookie, "DELETE")).status,
    ).toBe(200);
  });
  it("indexes posted R2 files and excludes drafts, deleted messages and inaccessible channels", async () => {
    const a = await identity(true),
      b = await identity(),
      id = await room(a.cookie);
    const form = new FormData();
    form.set(
      "file",
      new File(["report"], "report.txt", { type: "text/plain" }),
    );
    const upload = await request(
      "/chat/files?room=" + id,
      a.cookie,
      "POST",
      form,
    );
    expect(upload.status).toBe(201);
    const f = (await upload.json()) as { id: string };
    const list = async () =>
      (await (
        await request("/chat/rooms/" + id + "/files", a.cookie)
      ).json()) as { files: unknown[] };
    expect((await list()).files).toHaveLength(0);
    const sent = await request(
      "/chat/rooms/" + id + "/messages",
      a.cookie,
      "POST",
      { text: "Report", attachments: [f.id] },
    );
    const m = (await sent.json()) as { message: { id: string } };
    expect((await list()).files).toHaveLength(1);
    expect(
      (await request("/chat/rooms/" + id + "/files", b.cookie)).status,
    ).toBe(404);
    await request("/chat/messages/" + m.message.id, a.cookie, "DELETE");
    expect((await list()).files).toHaveLength(0);
  });
  it("creates or reuses a GitHub repo and associates multiple Workers without granting credentials", async () => {
    const a = await identity(true),
      b = await identity(),
      id = await room(a.cookie, [b.id]),
      gh = await integration(a.id, "github"),
      cf = await integration(a.id, "cloudflare");
    let exists = false,
      creates = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ login: "tester" });
      if (url.endsWith("/repos/tester/project"))
        return exists
          ? Response.json({
              full_name: "tester/project",
              html_url: "https://github.com/tester/project",
            })
          : new Response("", { status: 404 });
      if (url.endsWith("/user/repos")) {
        creates++;
        exists = true;
        expect(JSON.parse(String(init?.body)).private).toBe(true);
        return Response.json({
          full_name: "tester/project",
          html_url: "https://github.com/tester/project",
        });
      }
      if (url.endsWith("/settings"))
        return Response.json({ success: true, result: {} });
      if (url.endsWith("/workers/scripts"))
        return Response.json({
          success: true,
          result: [{ id: "one" }, { id: "two" }],
        });
      throw new Error(url);
    });
    const path = "/chat/rooms/" + id + "/create-repository",
      data = { connectionId: gh, name: "project" };
    expect((await request(path, b.cookie, "POST", data)).status).toBe(403);
    expect((await request(path, a.cookie, "POST", data)).status).toBe(201);
    expect((await request(path, a.cookie, "POST", data)).status).toBe(200);
    expect(creates).toBe(1);
    for (const scriptName of ["one", "two", "one"])
      expect(
        (
          await request("/chat/rooms/" + id + "/workers", a.cookie, "POST", {
            connectionId: cf,
            scriptName,
          })
        ).status,
      ).toBe(200);
    expect(await dbCount("room_workers", "room_id", id)).toBe(2);
    const grants = (
      await env.DB.prepare(
        "SELECT agent_enabled FROM room_integrations WHERE room_id=?",
      )
        .bind(id)
        .all<{ agent_enabled: number }>()
    ).results;
    expect(grants.every((g) => g.agent_enabled === 0)).toBe(true);
    expect(
      (await request("/chat/connections/" + cf + "/workers", b.cookie)).status,
    ).toBe(403);
  });
  it("deduplicates concurrent scheduler invocations, skips missed intervals and prevents overlapping runs", async () => {
    const a = await identity(true),
      bot = await server(a.cookie),
      id = await room(a.cookie, [bot.id]),
      t = await timer(a.cookie, id, bot.id);
    const now = Date.now();
    await Promise.all([
      runChannelTimers(now, false),
      runChannelTimers(now, false),
    ]);
    expect(await dbCount("timer_runs", "timer_id", t.id)).toBe(1);
    let next = await env.DB.prepare(
      "SELECT next_at FROM channel_timers WHERE id=?",
    )
      .bind(t.id)
      .first<{ next_at: number }>();
    expect(next!.next_at).toBeGreaterThan(now);
    await runChannelTimers(now + 5 * 3600000, false);
    expect(await dbCount("timer_runs", "timer_id", t.id)).toBe(1);
    const run = await env.DB.prepare(
      "SELECT message_id FROM timer_runs WHERE timer_id=?",
    )
      .bind(t.id)
      .first<{ message_id: string }>();
    await env.DB.prepare(
      "UPDATE agent_requests SET dispatched=1,error=? WHERE message_id=?",
    )
      .bind("Task failed", run!.message_id)
      .run();
    await runChannelTimers(now + 5 * 3600000, false);
    expect(await dbCount("timer_runs", "timer_id", t.id)).toBe(2);
    next = await env.DB.prepare("SELECT next_at FROM channel_timers WHERE id=?")
      .bind(t.id)
      .first();
    expect(next!.next_at).toBeGreaterThan(now + 5 * 3600000);
    expect(await dbCount("agent_threads", "room_id", id)).toBe(2);
  });
  it("pauses timers and re-arms a one-off timer with a fresh occurrence id", async () => {
    const a = await identity(true),
      bot = await server(a.cookie),
      id = await room(a.cookie, [bot.id]),
      t = await timer(a.cookie, id, bot.id, 0),
      path = "/chat/rooms/" + id + "/timers/" + t.id;
    expect(
      (await request(path, a.cookie, "PATCH", { enabled: false, version: 1 }))
        .status,
    ).toBe(200);
    await runChannelTimers(Date.now(), false);
    expect(await dbCount("timer_runs", "timer_id", t.id)).toBe(0);
    expect(
      (await request(path, a.cookie, "PATCH", { enabled: true, version: 2 }))
        .status,
    ).toBe(200);
    await runChannelTimers(Date.now() + 61000, false);
    expect(await dbCount("timer_runs", "timer_id", t.id)).toBe(1);
    expect(
      (await request(path, a.cookie, "PATCH", { enabled: true, version: 2 }))
        .status,
    ).toBe(409);
    expect((await request(path, a.cookie, "DELETE")).status).toBe(200);
    await runChannelTimers(Date.now() + 120000, false);
    expect(await dbCount("timer_runs", "timer_id", t.id)).toBe(1);
  });
  it("stops scheduling when a creator loses membership and rejects already queued dispatch", async () => {
    const a = await identity(true),
      b = await identity(),
      bot = await server(a.cookie),
      id = await room(a.cookie, [bot.id, b.id]);
    const t = await timer(b.cookie, id, bot.id);
    await runChannelTimers(Date.now(), false);
    const run = await env.DB.prepare(
      "SELECT message_id FROM timer_runs WHERE timer_id=?",
    )
      .bind(t.id)
      .first<{ message_id: string }>();
    expect(await scheduledMessageAllowed(run!.message_id)).toBe(true);
    await env.DB.prepare(
      "DELETE FROM room_members WHERE room_id=? AND person_id=?",
    )
      .bind(id, b.id)
      .run();
    expect(await scheduledMessageAllowed(run!.message_id)).toBe(false);
    await runChannelTimers(Date.now() + 3600000, false);
    const state = await env.DB.prepare(
      "SELECT enabled,last_error FROM channel_timers WHERE id=?",
    )
      .bind(t.id)
      .first<{ enabled: number; last_error: string }>();
    expect(state!.enabled).toBe(0);
    expect(state!.last_error).toContain("access");
  });
});

it("gives only the active Casual task the human read scope, and shares a stable agent session across turns", async () => {
  const a = await identity(true),
    b = await identity(),
    bot = await server(a.cookie),
    accessible = await room(a.cookie, [b.id]),
    hidden = await room(a.cookie);
  await configure(a.cookie, bot.id);
  const id = await open(b.cookie);
  const sent = await request(
    "/chat/rooms/" + id + "/messages",
    b.cookie,
    "POST",
    { text: "What are we working on?" },
  );
  expect(sent.status).toBe(201);
  const message = ((await sent.json()) as { message: { id: string } }).message;
  await env.CHAT_DISPATCHERS.getByName(id).kick(id);
  const mapping = await env.DB.prepare(
    "SELECT thread_id FROM agent_requests WHERE message_id=?",
  )
    .bind(message.id)
    .first<{ thread_id: string }>();
  const agent = env.CONVERSATIONS.getByName(mapping!.thread_id);
  await expect
    .poll(async () => {
      await env.CHAT_DISPATCHERS.getByName(id).kick(id);
      return (await inspectAgent(agent)).runs.length;
    })
    .toBe(1);
  const run = (await inspectAgent(agent)).runs[0];
  expect(run.job).toContain("workspace steward");
  expect(run.job).toContain(accessible);
  expect(run.job).not.toContain(hidden);
  const vars = await jobEnvironment(bot.id, mapping!.thread_id, run.id, origin);
  expect(vars.GH_TOKEN).toBeUndefined();
  const token = vars.MELANCHOLY_API_TOKEN;
  expect(
    (
      await request(
        "/v1/casual/context?channelId=" + accessible,
        "",
        "GET",
        undefined,
        token,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        "/v1/casual/context?channelId=" + hidden,
        "",
        "GET",
        undefined,
        token,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(
        "/v1/rooms/" + accessible + "/notes",
        "",
        "POST",
        { title: "Cross room write", content: "Not permitted" },
        token,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(
        "/v1/casual/suggestions",
        "",
        "POST",
        {
          name: "suggest-" + crypto.randomUUID().slice(0, 8),
          topic: "Idea",
          brief: "A useful brief",
        },
        token,
      )
    ).status,
  ).toBe(201);
  const second = await request(
    "/chat/rooms/" + id + "/messages",
    b.cookie,
    "POST",
    { text: "Continue" },
  );
  expect(second.status).toBe(201);
  expect(await dbCount("agent_threads", "room_id", id)).toBe(1);
  await configure(a.cookie, bot.id, false);
  expect(
    (await request("/v1/casual/context", "", "GET", undefined, token)).status,
  ).toBe(403);
  await agent.cancel();
});
it("retries create operations with stable identifiers without duplicating projects, notes or timers", async () => {
  const a = await identity(true),
    bot = await server(a.cookie),
    roomId = crypto.randomUUID(),
    data = {
      id: roomId,
      name: "retry-" + crypto.randomUUID().slice(0, 8),
      private: true,
      members: [bot.id],
    };
  expect((await request("/chat/rooms", a.cookie, "POST", data)).status).toBe(
    201,
  );
  expect((await request("/chat/rooms", a.cookie, "POST", data)).status).toBe(
    200,
  );
  const note = {
    requestId: crypto.randomUUID(),
    title: "Brief",
    content: "Plan",
  };
  for (let i = 0; i < 2; i++)
    expect(
      (
        await request(
          "/chat/rooms/" + roomId + "/notes",
          a.cookie,
          "POST",
          note,
        )
      ).status,
    ).toBe(201);
  expect(await dbCount("channel_notes", "room_id", roomId)).toBe(1);
  const timer = {
    id: crypto.randomUUID(),
    name: "Once",
    prompt: "Review",
    botId: bot.id,
    nextAt: Date.now() + 3600000,
    intervalMinutes: 0,
  };
  expect(
    (
      await request(
        "/chat/rooms/" + roomId + "/timers",
        a.cookie,
        "POST",
        timer,
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await request(
        "/chat/rooms/" + roomId + "/timers",
        a.cookie,
        "POST",
        timer,
      )
    ).status,
  ).toBe(200);
  expect(await dbCount("channel_timers", "room_id", roomId)).toBe(1);
});
it("checks live integration authentication without exposing tokens or widening access", async () => {
  const a = await identity(true),
    b = await identity(),
    id = await integration(a.id, "github");
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ login: "tester" }));
  expect((await integrationHealth(a.who, id)).status).toBe("reachable");
  await expect(integrationHealth(b.who, id)).rejects.toThrow("not found");
  expect(mock).toHaveBeenCalledTimes(1);
  mock.mockImplementation(async () => new Response("", { status: 403 }));
  expect((await integrationHealth(a.who, id)).status).toBe("unavailable");
});
