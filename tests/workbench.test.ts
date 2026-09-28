import { inspectAgent } from "./inspect-agent";
import { beforeAll, afterEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { handleApi } from "../worker/api";
import { recoverAgentRequests } from "../worker/agent-recovery";
import type { TeamWorkspace, MessagePage, TeamMessage } from "../lib/chat";
const origin = "https://team.test";
beforeAll(async () => {
  await applyD1Migrations(
    env.DB,
    (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] })
      .TEST_MIGRATIONS,
  );
});
async function request(
  path: string,
  cookie = "",
  method = "GET",
  data?: unknown,
  token?: string,
) {
  return handleApi(
    new Request(origin + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(data instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(data === undefined
        ? {}
        : { body: data instanceof FormData ? data : JSON.stringify(data) }),
    }),
  );
}
async function login() {
  const r = await request("/api/login", "", "POST", { key: env.WORKSPACE_KEY });
  expect(r.status).toBe(200);
  return r.headers.get("Set-Cookie")!.split(";")[0];
}
async function member(owner: string) {
  const created = (await (
    await request("/api/chat/invitations", owner, "POST")
  ).json()) as { url: string };
  const ticket = new URLSearchParams(new URL(created.url).hash.slice(1)).get(
    "invite",
  );
  const handle = "m" + crypto.randomUUID().slice(0, 8);
  const data = {
    ticket,
    name: handle,
    handle,
    password: "a long member password",
  };
  const r = await request("/api/join", "", "POST", data);
  expect(r.status).toBe(201);
  const cookie = r.headers.get("Set-Cookie")!.split(";")[0];
  const w = await workspace(cookie);
  return { cookie, person: w.me, data };
}
async function workspace(cookie: string) {
  const r = await request("/api/chat/workspace", cookie);
  expect(r.status).toBe(200);
  return r.json() as Promise<TeamWorkspace>;
}
async function create(owner: string, params: Record<string, unknown> = {}) {
  const r = await request("/api/chat/rooms", owner, "POST", {
    name: "test-" + crypto.randomUUID().slice(0, 8),
    ...params,
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}
async function send(
  cookie: string,
  roomId: string,
  text: string,
  parentId?: string,
  extra: Record<string, unknown> = {},
) {
  const r = await request(
    "/api/chat/rooms/" + roomId + "/messages",
    cookie,
    "POST",
    { id: crypto.randomUUID(), text, parentId, ...extra },
  );
  expect(r.status).toBe(201);
  return ((await r.json()) as { message: TeamMessage }).message;
}
async function messages(cookie: string, roomId: string, parent?: string) {
  const r = await request(
    "/api/chat/rooms/" +
      roomId +
      "/messages" +
      (parent ? "?parent=" + parent : ""),
    cookie,
  );
  expect(r.status).toBe(200);
  return r.json() as Promise<MessagePage>;
}
import { seal, unseal, jobEnvironment } from "../worker/integrations";
import { encodeMentions, mentionText } from "../lib/mentions";
import { mentions } from "../worker/team-store";
afterEach(() => vi.restoreAllMocks());
async function agentSetup(owner: string, roomId?: string) {
  const server = (await (
    await request("/api/servers", owner, "POST", {
      name: "Workbench server",
      runtime: "codex",
    })
  ).json()) as { id: string; token: string };
  const id =
    roomId || (await create(owner, { private: true, members: [server.id] }));
  if (roomId)
    await request(`/api/chat/rooms/${id}/members`, owner, "POST", {
      personId: server.id,
    });
  return { server, id };
}
async function running(
  owner: string,
  roomId: string,
  botId: string,
  parent?: string,
) {
  const m = await send(owner, roomId, `<@${botId}> work`, parent);
  const mapping = await env.DB.prepare(
    "SELECT thread_id FROM agent_requests WHERE message_id=?",
  )
    .bind(m.id)
    .first<{ thread_id: string }>();
  const agent = env.CONVERSATIONS.getByName(mapping!.thread_id);
  await expect
    .poll(async () => {
      await env.CHAT_DISPATCHERS.getByName(roomId).kick(roomId);
      return (await inspectAgent(agent)).runs.length;
    })
    .toBe(1);
  const run = (await inspectAgent(agent)).runs[0];
  return { agent, run, m, threadId: mapping!.thread_id };
}
function providerMock() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://api.github.com/user")
        return Response.json({ login: "octo" });
      if (url.endsWith("/user/tokens/verify"))
        return Response.json({ success: true, result: { status: "active" } });
      if (
        url === "https://api.github.com/repos/test/project" ||
        url === "https://api.github.com/repos/test/second"
      ) {
        const full_name = url.split("/repos/")[1];
        return Response.json({
          full_name,
          html_url: "https://github.com/" + full_name,
        });
      }
      if (url.includes("/issues")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer github-test-token-secret",
        );
        const issue = {
          number: 7,
          title: "Fix scrolling",
          body: "Details",
          state: "open",
          html_url: "https://github.com/test/project/issues/7",
          labels: [],
          assignees: [],
        };
        if (url.includes("/comments"))
          return Response.json(
            init?.method === "POST"
              ? { id: 1, ...JSON.parse(String(init.body)) }
              : [],
          );
        if (init?.method === "POST" || init?.method === "PATCH")
          return Response.json({ ...issue, ...JSON.parse(String(init.body)) });
        return Response.json(
          url.includes("/issues?")
            ? [issue, { number: 8, pull_request: {} }]
            : issue,
        );
      }
      throw new Error("Unexpected provider URL: " + url);
    });
}
async function connection(owner: string, provider = "github") {
  const response = await request("/api/chat/connections", owner, "POST", {
    provider,
    name: "Test connection",
    token: provider + "-test-token-secret",
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
describe("workbench identity and mentions", () => {
  it("changes username without changing identity or breaking historical mentions", async () => {
    const owner = await login(),
      m = await member(owner),
      id = await create(owner, { members: [m.person.id] });
    const root = await send(owner, id, "Hello @" + m.person.handle);
    const next = "renamed" + crypto.randomUUID().slice(0, 8);
    expect(
      (
        await request("/api/chat/profile", m.cookie, "PATCH", {
          handle: next,
          name: "New name",
        })
      ).status,
    ).toBe(200);
    const current = await workspace(m.cookie);
    expect(current.me).toMatchObject({
      id: m.person.id,
      handle: next,
      name: "New name",
    });
    const message = (await messages(owner, id)).messages[0];
    expect(message.mention_refs?.[m.person.handle]).toBe(m.person.id);
    expect(
      mentionText(
        message.text,
        message.mentioned_people || [],
        message.mention_refs,
      ),
    ).toBe("Hello @New name");
    expect(
      (
        await request("/api/login", "", "POST", {
          handle: next,
          password: m.data.password,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/chat/profile", m.cookie, "PATCH", {
          handle: "owner",
          name: "New name",
        })
      ).status,
    ).toBe(409);
  });
  it("encodes multiple names, preserves code and avoids ambiguous display names", async () => {
    const owner = await login(),
      alice = await member(owner),
      bob = await member(owner),
      id = await create(owner, { members: [alice.person.id, bob.person.id] });
    const a = { ...alice.person, name: "Alice Smith" },
      b = { ...bob.person, name: "Bob" };
    expect(encodeMentions("@Alice Smith and @Bob", [a, b])).toBe(
      `<@${a.id}> and <@${b.id}>`,
    );
    expect(encodeMentions("`@Bob` @Bob", [a, b])).toBe(
      "`@Bob` <@" + b.id + ">",
    );
    expect(
      encodeMentions("@Same", [
        { ...a, name: "Same" },
        { ...b, name: "Same" },
      ]),
    ).toBe("@Same");
    expect(
      await mentions("`<@" + a.id + ">`\n```\n@" + b.handle + "\n```", id),
    ).toEqual([]);
  });
  it("stores avatars privately and rejects non-images", async () => {
    const owner = await login(),
      m = await member(owner);
    const upload = (type: string, data: Uint8Array<ArrayBuffer> | string) =>
      handleApi(
        new Request(origin + "/api/chat/avatar", {
          method: "POST",
          headers: { Cookie: m.cookie, Origin: origin, "Content-Type": type },
          body: data,
        }),
      );
    expect((await upload("image/svg+xml", "<svg/>")).status).toBe(400);
    const response = await upload(
      "image/png",
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(response.status).toBe(200);
    const { avatar_key } = (await response.json()) as { avatar_key: string };
    const path = `/api/chat/avatars/${m.person.id}/${avatar_key}`;
    expect((await request(path)).status).toBe(401);
    expect((await request(path, owner)).headers.get("Cache-Control")).toContain(
      "private",
    );
    await request("/api/chat/avatar", m.cookie, "DELETE");
    expect((await request(path, owner)).status).toBe(404);
  });
});
describe("connections, GitHub and task credentials", () => {
  it("encrypts tokens, binds ciphertext to its record and returns metadata only", async () => {
    providerMock();
    const owner = await login(),
      m = await member(owner),
      id = await connection(owner);
    const row = await env.DB.prepare("SELECT * FROM integrations WHERE id=?")
      .bind(id)
      .first<any>();
    expect(row.secret).not.toContain("github-test-token-secret");
    expect(await unseal(row)).toBe("github-test-token-secret");
    await expect(unseal({ ...row, id: "different" })).rejects.toThrow();
    expect(
      await (await request("/api/chat/connections", owner)).text(),
    ).not.toContain("secret");
    expect((await request("/api/chat/connections", m.cookie)).status).toBe(403);
    expect(await seal("same", "record")).not.toEqual(
      await seal("same", "record"),
    );
  });
  it("gates repository proposals and Issue access by approval and channel membership", async () => {
    const mock = providerMock(),
      owner = await login(),
      outsider = await member(owner),
      { server, id } = await agentSetup(owner),
      conn = await connection(owner);
    await request(`/api/chat/rooms/${id}/connections/${conn}`, owner, "PUT", {
      agentEnabled: false,
    });
    const job = await running(owner, id, server.id);
    const variables = await jobEnvironment(
      server.id,
      job.threadId,
      job.run.id,
      origin,
    );
    expect(variables.GH_TOKEN).toBeUndefined();
    const auth = variables.MELANCHOLY_API_TOKEN;
    const connections = await request(
      `/api/v1/rooms/${id}/connections`,
      "",
      "GET",
      undefined,
      auth,
    );
    expect(connections.status).toBe(200);
    const proposed = await request(
      `/api/v1/rooms/${id}/repositories`,
      "",
      "POST",
      { fullName: "test/project", connectionId: conn },
      auth,
    );
    expect(proposed.status).toBe(202);
    const repo = ((await proposed.json()) as { id: string }).id;
    expect(
      (
        await request(
          `/api/v1/rooms/${id}/repositories/${repo}`,
          "",
          "PUT",
          {},
          auth,
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(`/api/chat/repositories/${repo}/issues`, owner)).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/chat/rooms/${id}/repositories/${repo}`,
          owner,
          "PUT",
          {},
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(`/api/chat/repositories/${repo}/issues`, outsider.cookie))
        .status,
    ).toBe(404);
    const list = await request(`/api/chat/repositories/${repo}/issues`, owner);
    expect(((await list.json()) as { issues: unknown[] }).issues).toHaveLength(
      1,
    );
    expect(
      (
        await request(
          `/api/chat/repositories/${repo}/issues/7`,
          owner,
          "PATCH",
          { state: "closed", labels: ["bug"], assignees: ["octo"] },
        )
      ).status,
    ).toBe(200);
    const comment = await request(
      `/api/chat/repositories/${repo}/issues/7/comments`,
      owner,
      "POST",
      { body: "Ready for review" },
    );
    expect(comment.status).toBe(201);
    expect(
      (
        await request(
          `/api/v1/repositories/${repo}/issues/7`,
          "",
          "PATCH",
          { state: "closed" },
          auth,
        )
      ).status,
    ).toBe(403);
    await job.agent.cancel();
    expect(
      (
        await request(
          `/api/v1/rooms/${id}/repositories`,
          "",
          "GET",
          undefined,
          auth,
        )
      ).status,
    ).toBe(401);
    expect(mock).toHaveBeenCalled();
  });
  it("exports only enabled channel credentials to an active server task and revokes access", async () => {
    providerMock();
    const owner = await login(),
      { id, server } = await agentSetup(owner),
      other = await agentSetup(owner),
      gh = await connection(owner),
      cf = await connection(owner, "cloudflare");
    await request(`/api/chat/rooms/${id}/connections/${gh}`, owner, "PUT", {
      agentEnabled: true,
    });
    await request(`/api/chat/rooms/${id}/connections/${cf}`, owner, "PUT", {
      agentEnabled: false,
    });
    const job = await running(owner, id, server.id);
    const creds = await request(
      "/api/connector/environment",
      "",
      "POST",
      { threadId: job.threadId, runId: job.run.id },
      server.token,
    );
    expect(creds.status).toBe(200);
    const data = (await creds.json()) as {
      environment: Record<string, string>;
    };
    expect(data.environment.GH_TOKEN).toBe("github-test-token-secret");
    expect(data.environment.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(
      (
        await request(
          "/api/connector/environment",
          "",
          "POST",
          { threadId: job.threadId, runId: job.run.id },
          other.server.token,
        )
      ).status,
    ).toBe(403);
    await request(`/api/chat/rooms/${id}/connections/${gh}`, owner, "PUT", {
      agentEnabled: false,
    });
    expect(
      (await jobEnvironment(server.id, job.threadId, job.run.id)).GH_TOKEN,
    ).toBeUndefined();
    await request(
      `/api/chat/rooms/${id}/members/${server.id}`,
      owner,
      "DELETE",
    );
    await expect(
      jobEnvironment(server.id, job.threadId, job.run.id),
    ).rejects.toMatchObject({ status: 403 });
    await job.agent.cancel();
    await expect(
      jobEnvironment(server.id, job.threadId, job.run.id),
    ).rejects.toThrow("not active");
  });
});
describe("thread automation and accounting", () => {
  it("auto triggers human replies in one thread and never loops on bot messages", async () => {
    const owner = await login(),
      outsider = await member(owner),
      { id, server } = await agentSetup(owner);
    const root = await send(owner, id, "A task"),
      other = await send(owner, id, "Other task");
    const prefs = `/api/chat/threads/${root.id}/preferences`;
    expect(
      (await request(prefs, outsider.cookie, "PUT", { botId: server.id }))
        .status,
    ).toBe(404);
    expect(
      (await request(prefs, owner, "PUT", { botId: server.id })).status,
    ).toBe(200);
    const reply = await send(owner, id, "No manual mention", root.id);
    const rows = await env.DB.prepare(
      "SELECT * FROM agent_requests WHERE message_id=?",
    )
      .bind(reply.id)
      .all();
    expect(rows.results).toHaveLength(1);
    const sibling = await send(owner, id, "No manual mention", other.id);
    expect(
      (
        await env.DB.prepare("SELECT * FROM agent_requests WHERE message_id=?")
          .bind(sibling.id)
          .all()
      ).results,
    ).toHaveLength(0);
    const token = (await (
      await request("/api/chat/tokens", owner, "POST", {
        botId: server.id,
        roomId: id,
        kind: "api",
      })
    ).json()) as { token: string };
    const bot = await request(
      `/api/v1/rooms/${id}/messages`,
      "",
      "POST",
      { text: "bot reply", parentId: root.id },
      token.token,
    );
    expect(bot.status).toBe(201);
    const bm = (await bot.json()) as { message: TeamMessage };
    expect(
      (
        await env.DB.prepare("SELECT * FROM agent_requests WHERE message_id=?")
          .bind(bm.message.id)
          .all()
      ).results,
    ).toHaveLength(0);
    await request(
      `/api/chat/rooms/${id}/members/${server.id}`,
      owner,
      "DELETE",
    );
    const removed = await send(owner, id, "Bot removed", root.id);
    expect(
      (
        await env.DB.prepare("SELECT * FROM agent_requests WHERE message_id=?")
          .bind(removed.id)
          .all()
      ).results,
    ).toHaveLength(0);
  });
  it("counts usage once per run, separates threads and keeps server renames attached to history", async () => {
    const owner = await login(),
      outsider = await member(owner),
      { id, server } = await agentSetup(owner);
    const root = await send(owner, id, "Issue thread"),
      job = await running(owner, id, server.id, root.id);
    const usage = {
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 80,
      cacheWriteTokens: 0,
      model: "test-model",
    };
    await job.agent.receive(job.run.id, 1, { type: "usage", usage });
    await job.agent.receive(job.run.id, 1, {
      type: "usage",
      usage: { ...usage, inputTokens: 999 },
    });
    await job.agent.receive(job.run.id, 2, { type: "usage", usage });
    await job.agent.receive(job.run.id, 3, { type: "completed" });
    await job.agent.receive(job.run.id, 4, {
      type: "usage",
      usage: { ...usage, inputTokens: 999 },
    });
    expect(
      (
        await request(`/api/servers/${server.id}`, owner, "PATCH", {
          name: "Renamed server",
        })
      ).status,
    ).toBe(200);
    const report = await request(
      `/api/chat/usage?room=${id}&thread=${root.id}`,
      owner,
    );
    const data = (await report.json()) as { rows: any[] };
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({
      server_name: "Renamed server",
      runs: 1,
      input_tokens: 120,
      output_tokens: 30,
      cached_tokens: 80,
      root_id: root.id,
    });
    expect(
      (await request(`/api/chat/usage?room=${id}`, outsider.cookie)).status,
    ).toBe(404);
    expect((await request("/api/chat/usage", outsider.cookie)).status).toBe(
      403,
    );
    const empty = await request(
      `/api/chat/usage?room=${id}&thread=absent`,
      owner,
    );
    expect(((await empty.json()) as { rows: unknown[] }).rows).toEqual([]);
  });
});

describe("workspace administration and credential vault", () => {
  it("restricts workspace changes to the owner and keeps the workspace name across APIs", async () => {
    const owner = await login(),
      m = await member(owner),
      before = await workspace(owner);
    expect((await request("/api/chat/settings", m.cookie)).status).toBe(403);
    expect(
      (
        await request("/api/chat/settings", m.cookie, "PATCH", {
          name: "forbidden",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/chat/settings", owner, "PATCH", {
          name: "Project studio",
          description: "A private workspace",
        })
      ).status,
    ).toBe(200);
    expect(await workspace(owner)).toMatchObject({
      name: "Project studio",
      description: "A private workspace",
    });
    expect(await (await request("/api/workspace", owner)).json()).toMatchObject(
      { name: "Project studio" },
    );
    await request("/api/chat/settings", owner, "PATCH", {
      name: before.name,
      description: before.description || "",
    });
  });
  it("encrypts multiline credentials, exposes metadata only, and protects record replacement", async () => {
    const owner = await login(),
      m = await member(owner);
    const data = {
      provider: "custom",
      name: "App Store team",
      fields: [
        {
          name: "ASC_PRIVATE_KEY",
          value:
            "-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----",
        },
        { name: "ASC_KEY_ID", value: "team-key" },
      ],
    };
    expect(
      (await request("/api/chat/connections", m.cookie, "POST", data)).status,
    ).toBe(403);
    const created = await request("/api/chat/connections", owner, "POST", data);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const row = await env.DB.prepare("SELECT * FROM credentials WHERE id=?")
      .bind(id)
      .first<{ id: string; secret: string }>();
    expect(row!.secret).not.toContain("private-value");
    expect(JSON.parse(await unseal(row!))).toMatchObject({
      ASC_PRIVATE_KEY: data.fields[0].value,
    });
    await expect(unseal({ ...row!, id: "wrong-record" })).rejects.toThrow();
    const listing = await (
      await request("/api/chat/connections", owner)
    ).text();
    expect(listing).not.toContain("private-value");
    expect(listing).not.toContain("team-key");
    expect(
      (await request("/api/chat/connections/" + id, m.cookie, "PUT", data))
        .status,
    ).toBe(403);
    expect(
      (
        await request("/api/chat/connections/" + id, owner, "PUT", {
          ...data,
          fields: [{ name: "OTHER_SECRET", value: "new" }],
        })
      ).status,
    ).toBe(400);
    const updated = {
      ...data,
      fields: data.fields.map((f) => ({
        ...f,
        value: "replacement-" + f.name,
      })),
    };
    expect(
      (await request("/api/chat/connections/" + id, owner, "PUT", updated))
        .status,
    ).toBe(200);
    const next = await env.DB.prepare("SELECT * FROM credentials WHERE id=?")
      .bind(id)
      .first<{ id: string; secret: string }>();
    expect(JSON.parse(await unseal(next!))).toMatchObject({
      ASC_PRIVATE_KEY: "replacement-ASC_PRIVATE_KEY",
    });
    expect(
      (await request("/api/chat/connections/" + id, m.cookie, "DELETE")).status,
    ).toBe(403);
    await request("/api/chat/connections/" + id, owner, "DELETE");
    expect(
      await env.DB.prepare("SELECT 1 FROM credentials WHERE id=?")
        .bind(id)
        .first(),
    ).toBeNull();
  });
  it("validates provider endpoints and rejects process configuration masquerading as credentials", async () => {
    const owner = await login();
    for (const name of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "GITHUB_TOKEN",
      "MELANCHOLY_API_TOKEN",
      "HOME",
      "LARK_APP_SECRET",
    ]) {
      expect(
        (
          await request("/api/chat/connections", owner, "POST", {
            provider: "custom",
            name: "invalid",
            fields: [{ name, value: "secret" }],
          })
        ).status,
      ).toBe(400);
    }
    for (const base of [
      "http://example.test/v1",
      "https://user:password@example.test",
      "https://example.test?token=secret",
    ]) {
      expect(
        (
          await request("/api/chat/connections", owner, "POST", {
            provider: "openai",
            name: "endpoint",
            fields: [
              { name: "OPENAI_API_KEY", value: "private-key" },
              { name: "OPENAI_BASE_URL", value: base },
            ],
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request("/api/chat/connections", owner, "POST", {
          provider: "anthropic",
          name: "wrong fields",
          fields: [{ name: "OPENAI_API_KEY", value: "secret" }],
        })
      ).status,
    ).toBe(400);
  });
  it("injects only active channel grants, rejects conflicts and removes revoked credentials", async () => {
    const owner = await login(),
      outside = await member(owner),
      { id, server } = await agentSetup(owner);
    const data = {
      provider: "openai",
      name: "Model key",
      fields: [
        { name: "OPENAI_API_KEY", value: "approved-llm-key" },
        { name: "OPENAI_BASE_URL", value: "https://api.example.test/v1" },
      ],
    };
    const first = (await (
      await request("/api/chat/connections", owner, "POST", data)
    ).json()) as { id: string };
    const second = (await (
      await request("/api/chat/connections", owner, "POST", data)
    ).json()) as { id: string };
    const path = `/api/chat/rooms/${id}/connections/${first.id}`;
    expect(
      (await request(path, outside.cookie, "PUT", { agentEnabled: true }))
        .status,
    ).toBe(404);
    const job = await running(owner, id, server.id);
    expect(
      (await jobEnvironment(server.id, job.threadId, job.run.id))
        .OPENAI_API_KEY,
    ).toBeUndefined();
    expect(
      (await request(path, owner, "PUT", { agentEnabled: true })).status,
    ).toBe(200);
    expect(
      await jobEnvironment(server.id, job.threadId, job.run.id),
    ).toMatchObject({
      OPENAI_API_KEY: "approved-llm-key",
      OPENAI_BASE_URL: "https://api.example.test/v1",
    });
    expect(
      (
        await request(
          `/api/chat/rooms/${id}/connections/${second.id}`,
          owner,
          "PUT",
          { agentEnabled: true },
        )
      ).status,
    ).toBe(409);
    const list = await (
      await request(`/api/chat/rooms/${id}/connections`, owner)
    ).text();
    expect(list).not.toContain("approved-llm-key");
    await request("/api/chat/connections/" + first.id, owner, "PUT", {
      ...data,
      fields: data.fields.map((f) =>
        f.name === "OPENAI_API_KEY" ? { ...f, value: "rotated-key" } : f,
      ),
    });
    expect(
      (await jobEnvironment(server.id, job.threadId, job.run.id))
        .OPENAI_API_KEY,
    ).toBe("rotated-key");
    await request("/api/chat/connections/" + first.id, owner, "DELETE");
    expect(
      (await jobEnvironment(server.id, job.threadId, job.run.id))
        .OPENAI_API_KEY,
    ).toBeUndefined();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM room_credentials WHERE credential_id=?",
      )
        .bind(first.id)
        .first(),
    ).toBeNull();
    await job.agent.cancel();
    await expect(
      jobEnvironment(server.id, job.threadId, job.run.id),
    ).rejects.toThrow("not active");
  });
});
