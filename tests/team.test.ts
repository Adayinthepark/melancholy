import { beforeAll, describe, it, expect } from "vitest";
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
describe("workspace membership and conversation access", () => {
  it("redeems invitations once, supports password login, and never exposes password hashes", async () => {
    const owner = await login(),
      m = await member(owner);
    expect((await request("/api/join", "", "POST", m.data)).status).toBe(401);
    const signed = await request("/api/login", "", "POST", {
      handle: m.data.handle,
      password: m.data.password,
    });
    expect(signed.status).toBe(200);
    expect(
      (
        await request("/api/login", "", "POST", {
          handle: m.data.handle,
          password: "wrong",
        })
      ).status,
    ).toBe(401);
    expect(JSON.stringify(await workspace(m.cookie))).not.toContain(
      "password_hash",
    );
    expect(
      (
        await request("/api/servers", m.cookie, "POST", {
          name: "forbidden",
          runtime: "codex",
        })
      ).status,
    ).toBe(403);
  });
  it("hides private channels, messages, replies, search and files from non-members", async () => {
    const owner = await login(),
      alice = await member(owner),
      bob = await member(owner),
      id = await create(owner, { private: true, members: [alice.person.id] });
    const form = new FormData();
    form.append(
      "file",
      new File(["classified attachment"], "secret.txt", { type: "text/plain" }),
    );
    const upload = await request(
      "/api/chat/files?room=" + id,
      owner,
      "POST",
      form,
    );
    expect(upload.status).toBe(201);
    const file = (await upload.json()) as { id: string };
    const root = await send(owner, id, "private needle vault", undefined, {
      attachments: [file.id],
    });
    await send(alice.cookie, id, "private reply", root.id);
    expect((await workspace(bob.cookie)).rooms.some((r) => r.id === id)).toBe(
      false,
    );
    for (const path of [
      "/api/chat/rooms/" + id + "/messages",
      "/api/chat/messages/" + root.id,
      "/api/chat/rooms/" + id + "/export",
      "/api/files/" + file.id,
    ])
      expect((await request(path, bob.cookie)).status).toBe(404);
    const search = (await (
      await request("/api/chat/search?q=needle", bob.cookie)
    ).json()) as { results: unknown[] };
    expect(search.results).toEqual([]);
    expect((await request("/api/files/" + file.id, alice.cookie)).status).toBe(
      200,
    );
    expect((await messages(alice.cookie, id, root.id)).messages[0].text).toBe(
      "private reply",
    );
    await request(
      "/api/chat/rooms/" + id + "/members/" + alice.person.id,
      owner,
      "DELETE",
    );
    expect((await request("/api/files/" + file.id, alice.cookie)).status).toBe(
      404,
    );
  });
  it("allows discovery and joining public channels before posting", async () => {
    const owner = await login(),
      m = await member(owner),
      id = await create(owner);
    expect(
      (await workspace(m.cookie)).rooms.find((r) => r.id === id)?.joined,
    ).toBe(0);
    expect(
      (
        await request("/api/chat/rooms/" + id + "/messages", m.cookie, "POST", {
          text: "before joining",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/chat/rooms/" + id + "/join", m.cookie, "POST"))
        .status,
    ).toBe(200);
    await send(m.cookie, id, "after joining");
    expect((await messages(owner, id)).messages[0].author.id).toBe(m.person.id);
  });
  it("closes a deactivated member's socket and rejects their existing session", async () => {
    const owner = await login(),
      m = await member(owner);
    const response = await handleApi(
      new Request(origin + "/api/chat/socket", {
        headers: { Cookie: m.cookie, Origin: origin, Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (e) => resolve(e.code), { once: true }),
    );
    expect(
      (await request("/api/chat/people/" + m.person.id, owner, "DELETE"))
        .status,
    ).toBe(200);
    expect(await closed).toBe(1008);
    expect((await request("/api/chat/workspace", m.cookie)).status).toBe(401);
  });
  it("deduplicates DMs and isolates direct and group conversation participants", async () => {
    const owner = await login(),
      alice = await member(owner),
      bob = await member(owner),
      eve = await member(owner);
    const id = await create(alice.cookie, {
      kind: "dm",
      members: [bob.person.id],
      name: "",
    });
    const again = await request("/api/chat/rooms", bob.cookie, "POST", {
      kind: "dm",
      members: [alice.person.id],
    });
    expect(((await again.json()) as { id: string }).id).toBe(id);
    await send(alice.cookie, id, "dm secret");
    expect(
      (await request("/api/chat/rooms/" + id + "/messages", owner)).status,
    ).toBe(404);
    const group = await create(alice.cookie, {
      kind: "group",
      members: [bob.person.id, eve.person.id],
      name: "Three people",
    });
    await send(bob.cookie, group, "group message");
    expect((await messages(eve.cookie, group)).messages[0].text).toBe(
      "group message",
    );
    expect(
      (await request("/api/chat/rooms/" + group + "/messages", owner)).status,
    ).toBe(404);
  });
});
describe("messages, mentions and history", () => {
  it("deduplicates retries, keeps replies separate and enforces author editing", async () => {
    const owner = await login(),
      m = await member(owner),
      id = await create(owner, { members: [m.person.id] });
    const messageId = crypto.randomUUID();
    const root = await send(owner, id, "initial", undefined, { id: messageId });
    const duplicate = await request(
      "/api/chat/rooms/" + id + "/messages",
      owner,
      "POST",
      { id: messageId, text: "initial" },
    );
    expect(duplicate.status).toBe(200);
    await send(m.cookie, id, "thread reply", root.id);
    expect((await messages(owner, id)).messages).toHaveLength(1);
    expect((await messages(owner, id)).messages[0].reply_count).toBe(1);
    expect(
      (
        await request("/api/chat/messages/" + root.id, m.cookie, "PATCH", {
          text: "spoof",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/chat/messages/" + root.id, owner, "PATCH", {
          text: "edited needle",
        })
      ).status,
    ).toBe(200);
    expect((await messages(owner, id)).messages[0].edited_at).not.toBeNull();
    const search = (await (
      await request("/api/chat/search?q=edited%20needle", m.cookie)
    ).json()) as { results: TeamMessage[] };
    expect(search.results.some((x) => x.id === root.id)).toBe(true);
    await request("/api/chat/messages/" + root.id, owner, "DELETE");
    const deleted = (await messages(owner, id)).messages[0];
    expect(deleted.text).toBe("");
    expect(deleted.deleted_at).not.toBeNull();
    expect(deleted.reply_count).toBe(1);
    const removedSearch = (await (
      await request("/api/chat/search?q=edited%20needle", m.cookie)
    ).json()) as { results: TeamMessage[] };
    expect(removedSearch.results.some((x) => x.id === root.id)).toBe(false);
  });
  it("records mentions, unread counts, read cursors and idempotent reactions", async () => {
    const owner = await login(),
      m = await member(owner),
      id = await create(owner, { members: [m.person.id] });
    const root = await send(
      owner,
      id,
      "Hello @" + m.person.handle + " @" + m.person.handle,
    );
    const room = (await workspace(m.cookie)).rooms.find((r) => r.id === id)!;
    expect(room.unread).toBe(1);
    expect(room.mentions).toBe(1);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await request(
            "/api/chat/messages/" + root.id + "/reactions",
            m.cookie,
            "PUT",
            { emoji: "👍" },
          )
        ).status,
      ).toBe(200);
    expect((await messages(m.cookie, id)).messages[0].reactions).toMatchObject([
      { emoji: "👍", count: 1, mine: true },
    ]);
    await request(
      "/api/chat/messages/" + root.id + "/reactions",
      m.cookie,
      "DELETE",
      { emoji: "👍" },
    );
    expect((await messages(m.cookie, id)).messages[0].reactions).toEqual([]);
    await request("/api/chat/rooms/" + id + "/read", m.cookie, "POST", {
      seq: root.seq,
    });
    expect(
      (await workspace(m.cookie)).rooms.find((r) => r.id === id)?.unread,
    ).toBe(0);
    await request("/api/chat/rooms/" + id + "/read", m.cookie, "POST", {
      seq: 0,
    });
    expect(
      (await workspace(m.cookie)).rooms.find((r) => r.id === id)?.unread,
    ).toBe(0);
  });
  it("paginates and exports an exact multiple of the page size without malformed JSON", async () => {
    const owner = await login(),
      id = await create(owner),
      now = Date.now();
    await env.DB.batch(
      Array.from({ length: 100 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO chat_messages(id,room_id,author_id,text,created_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), id, "owner", "history " + i, now + i),
      ),
    );
    const exported = await request("/api/chat/rooms/" + id + "/export", owner);
    expect(((await exported.json()) as unknown[]).length).toBe(100);
    await send(owner, id, "latest");
    const latest = await messages(owner, id);
    expect(latest.hasMore).toBe(true);
    const earlier = (await (
      await request(
        "/api/chat/rooms/" + id + "/messages?before=" + latest.messages[0].seq,
        owner,
      )
    ).json()) as MessagePage;
    expect(earlier.messages).toHaveLength(1);
    expect(earlier.hasMore).toBe(false);
  });
});
describe("bots and connected agents", () => {
  it("scopes bot API tokens and webhooks, prevents impersonation and supports revocation", async () => {
    const owner = await login(),
      id = await create(owner, { private: true }),
      other = await create(owner, { private: true });
    const handle = "bot" + crypto.randomUUID().slice(0, 8);
    const bot = (await (
      await request("/api/chat/bots", owner, "POST", {
        name: "Build bot",
        handle,
      })
    ).json()) as { id: string };
    await request("/api/chat/rooms/" + id + "/members", owner, "POST", {
      personId: bot.id,
    });
    const credential = (await (
      await request("/api/chat/tokens", owner, "POST", {
        botId: bot.id,
        kind: "api",
        roomId: id,
      })
    ).json()) as { id: string; token: string };
    const posted = await request(
      "/api/v1/rooms/" + id + "/messages",
      "",
      "POST",
      { text: "build complete", author_id: "owner" },
      credential.token,
    );
    expect(posted.status).toBe(201);
    const m = ((await posted.json()) as { message: TeamMessage }).message;
    expect(m.author_id).toBe(bot.id);
    expect(
      (
        await request(
          "/api/v1/rooms/" + other + "/messages",
          "",
          "GET",
          undefined,
          credential.token,
        )
      ).status,
    ).toBe(404);
    const events = (await (
      await request("/api/v1/events", "", "GET", undefined, credential.token)
    ).json()) as { events: { message_id: string }[] };
    expect(events.events.some((e) => e.message_id === m.id)).toBe(true);
    const hook = (await (
      await request("/api/chat/tokens", owner, "POST", {
        botId: bot.id,
        kind: "webhook",
        roomId: id,
      })
    ).json()) as { url: string };
    expect(
      (
        await request(new URL(hook.url).pathname, "", "POST", {
          text: "webhook delivery",
        })
      ).status,
    ).toBe(201);
    await request("/api/chat/tokens/" + credential.id, owner, "DELETE");
    expect(
      (await request("/api/v1/rooms", "", "GET", undefined, credential.token))
        .status,
    ).toBe(401);
    await request(
      "/api/chat/rooms/" + id + "/members/" + bot.id,
      owner,
      "DELETE",
    );
    expect(
      (
        await request(new URL(hook.url).pathname, "", "POST", {
          text: "revoked membership",
        })
      ).status,
    ).toBe(404);
  });
  it("routes bot DMs to a resumable CLI session and projects replies into chat", async () => {
    const owner = await login();
    const server = (await (
      await request("/api/servers", owner, "POST", {
        name: "Codex test",
        runtime: "codex",
      })
    ).json()) as { id: string };
    const id = await create(owner, {
      kind: "dm",
      members: [server.id],
      name: "",
    });
    await send(owner, id, "first agent turn");
    const mapping = await env.DB.prepare(
      "SELECT thread_id FROM agent_threads WHERE room_id=?",
    )
      .bind(id)
      .first<{ thread_id: string }>();
    expect(mapping).not.toBeNull();
    const agent = env.CONVERSATIONS.getByName(mapping!.thread_id),
      run = (await agent.snapshot()).runs[0];
    await agent.receive(run.id, 1, {
      type: "started",
      sessionId: "same-session",
    });
    await agent.receive(run.id, 2, { type: "text", text: "agent reply" });
    await agent.receive(run.id, 3, { type: "completed" });
    const page = await messages(owner, id);
    expect(page.messages[1]).toMatchObject({
      text: "agent reply",
      author_id: server.id,
      parent_id: null,
      run_status: "completed",
    });
    await send(owner, id, "second agent turn");
    const job = await runInDurableObject(
      agent,
      (_instance, state) =>
        state.storage.sql
          .exec<{ job: string }>(
            "SELECT job FROM runs ORDER BY created_at DESC LIMIT 1",
          )
          .one().job,
    );
    expect(JSON.parse(job).sessionId).toBe("same-session");
    await agent.cancel();
    expect((await messages(owner, id)).messages.at(-1)?.run_status).toBe(
      "cancelled",
    );
    // Simulate a committed message whose Worker died before notifying the DO.
    const recoveredId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO chat_messages(id,room_id,author_id,text,created_at) VALUES (?,?,'owner','recover my task',?)",
      ).bind(recoveredId, id, Date.now()),
      env.DB.prepare(
        "INSERT INTO agent_requests(message_id,bot_id,thread_id) VALUES (?,?,?)",
      ).bind(recoveredId, server.id, mapping!.thread_id),
    ]);
    await recoverAgentRequests(env);
    expect(
      (await agent.snapshot()).messages.some((m) => m.id === recoveredId),
    ).toBe(true);
    await recoverAgentRequests(env);
    expect(
      (await agent.snapshot()).messages.filter((m) => m.id === recoveredId),
    ).toHaveLength(1);
    await agent.cancel();
  });
});
