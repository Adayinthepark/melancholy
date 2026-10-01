import { inspectAgent } from "./inspect-agent";
import { beforeAll, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  runDurableObjectAlarm,
  evictDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { handleApi } from "../worker/api";
import { hash } from "../worker/auth";
import { jobEnvironment, repositoryContext } from "../worker/integrations";

const base = "https://workspace.test";
beforeAll(async () => {
  await applyD1Migrations(
    env.DB,
    (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] })
      .TEST_MIGRATIONS,
  );
});
async function login() {
  const r = await handleApi(
    new Request(base + "/api/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ key: env.WORKSPACE_KEY }),
    }),
  );
  return r.headers.get("Set-Cookie")!.split(";")[0];
}
async function createRoom() {
  const threadId = crypto.randomUUID(),
    serverId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO servers (id,name,runtime,token_hash,created_at) VALUES (?,'test','codex',?,?)",
  )
    .bind(serverId, crypto.randomUUID(), Date.now())
    .run();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO people(id,handle,name,kind,server_id,created_at) VALUES (?,?,'test','bot',?,?)",
    ).bind(serverId, serverId, serverId, Date.now()),
    env.DB.prepare("INSERT INTO agent_threads VALUES (?,'general',?,?)").bind(
      threadId,
      threadId,
      serverId,
    ),
  ]);
  return {
    room: env.CONVERSATIONS.getByName(threadId),
    input: {
      threadId,
      serverId,
      runtime: "codex" as const,
      text: "hello searchable世界",
      id: crypto.randomUUID(),
      attachments: [],
      chat: { roomId: "general", botId: serverId, parentId: null },
    },
  };
}
describe("workspace access", () => {
  it("keeps history private and rejects cross-origin sign-in", async () => {
    expect((await handleApi(new Request(base + "/api/workspace"))).status).toBe(
      401,
    );
    expect(
      (
        await handleApi(
          new Request(base + "/api/login", {
            method: "POST",
            headers: { Origin: "https://elsewhere.test" },
            body: JSON.stringify({ key: env.WORKSPACE_KEY }),
          }),
        )
      ).status,
    ).toBe(403);
  });
  it("sets a secure cookie and invalidates it on logout", async () => {
    const cookie = await login();
    expect(cookie).toMatch(/^melancholy_session=/);
    expect(
      (
        await handleApi(
          new Request(base + "/api/workspace", { headers: { Cookie: cookie } }),
        )
      ).status,
    ).toBe(200);
    await handleApi(
      new Request(base + "/api/logout", {
        method: "POST",
        headers: { Cookie: cookie, Origin: base },
      }),
    );
    expect(
      (
        await handleApi(
          new Request(base + "/api/workspace", { headers: { Cookie: cookie } }),
        )
      ).status,
    ).toBe(401);
  });
  it("never exposes connector tokens in workspace metadata", async () => {
    const cookie = await login();
    const token = "b".repeat(64);
    await env.DB.prepare(
      "INSERT INTO servers (id,name,runtime,token_hash,created_at) VALUES (?,'private','codex',?,?)",
    )
      .bind(crypto.randomUUID(), await hash(token), Date.now())
      .run();
    const text = await (
      await handleApi(
        new Request(base + "/api/workspace", { headers: { Cookie: cookie } }),
      )
    ).text();
    expect(text).not.toContain(token);
    expect(text).not.toContain("token_hash");
  });
  it("removes standalone endpoints and metadata", async () => {
    const cookie = await login();
    for (const [path, method] of [
      ["/api/channels", "POST"],
      ["/api/threads", "POST"],
      ["/api/files", "POST"],
      ["/api/search?q=hello", "GET"],
      ["/api/threads/00000000-0000-4000-8000-000000000000/messages", "GET"],
    ]) {
      const response = await handleApi(
        new Request(base + path, {
          method,
          headers: { Cookie: cookie, Origin: base },
        }),
      );
      expect(response.status).toBe(404);
    }
    const response = await handleApi(
      new Request(base + "/api/workspace", { headers: { Cookie: cookie } }),
    );
    const metadata = await response.json();
    expect(metadata).not.toHaveProperty("channels");
    expect(metadata).not.toHaveProperty("threads");
  });
  it("redeems a sign-in ticket once and rejects expired tickets", async () => {
    const cookie = await login();
    const create = () =>
      handleApi(
        new Request(base + "/api/login-links", {
          method: "POST",
          headers: { Cookie: cookie, Origin: base },
        }),
      );
    const redeem = (ticket: string) =>
      handleApi(
        new Request(base + "/api/redeem", {
          method: "POST",
          headers: { Origin: base },
          body: JSON.stringify({ ticket }),
        }),
      );
    const response = await create();
    expect(response.status).toBe(201);
    const { url } = (await response.json()) as { url: string };
    const ticket = new URLSearchParams(new URL(url).hash.slice(1)).get(
      "ticket",
    )!;
    const attempts = await Promise.all([redeem(ticket), redeem(ticket)]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 401]);
    const signedIn = attempts.find((r) => r.status === 200)!;
    expect(signedIn.headers.get("Set-Cookie")).toContain("HttpOnly");
    const expired = "c".repeat(64);
    await env.DB.prepare(
      "INSERT INTO login_tickets(token_hash,expires_at) VALUES (?,?)",
    )
      .bind(await hash(expired), Date.now() - 1)
      .run();
    expect((await redeem(expired)).status).toBe(401);
  });
  it("keeps attachments private and scopes connector downloads to their server", async () => {
    const cookie = await login();
    const { input, room } = await createRoom();
    const token = "d".repeat(64);
    await env.DB.prepare("UPDATE servers SET token_hash=? WHERE id=?")
      .bind(await hash(token), input.serverId)
      .run();
    const form = new FormData();
    form.append(
      "file",
      new File(["private attachment"], "notes.txt", { type: "text/plain" }),
    );
    const uploaded = await handleApi(
      new Request(base + "/api/chat/files?room=general", {
        method: "POST",
        headers: { Cookie: cookie, Origin: base },
        body: form,
      }),
    );
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };
    const messageId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO chat_messages(id,room_id,author_id,text,created_at,attachments) VALUES (?,'general','owner','attachment',?,?)",
      ).bind(
        messageId,
        Date.now(),
        JSON.stringify([
          { id, name: "notes.txt", size: 18, type: "text/plain" },
        ]),
      ),
      env.DB.prepare("UPDATE chat_files SET message_id=? WHERE id=?").bind(
        messageId,
        id,
      ),
      env.DB.prepare("INSERT INTO room_members VALUES ('general',?,?)").bind(
        input.serverId,
        Date.now(),
      ),
    ]);
    const file = base + "/api/files/" + id;
    expect((await handleApi(new Request(file))).status).toBe(401);
    expect(
      await (
        await handleApi(new Request(file, { headers: { Cookie: cookie } }))
      ).text(),
    ).toBe("private attachment");
    expect(
      (
        await handleApi(
          new Request(file, { headers: { Authorization: `Bearer ${token}` } }),
        )
      ).status,
    ).toBe(200);
    const other = await createRoom();
    const otherToken = "e".repeat(64);
    await env.DB.prepare("UPDATE servers SET token_hash=? WHERE id=?")
      .bind(await hash(otherToken), other.input.serverId)
      .run();
    expect(
      (
        await handleApi(
          new Request(file, {
            headers: { Authorization: `Bearer ${otherToken}` },
          }),
        )
      ).status,
    ).toBe(404);
    // The CLI's short-lived task identity can fetch earlier attachments too.
    const run = await room.send(input);
    const variables = await jobEnvironment(
      input.serverId,
      input.threadId,
      run.id,
      base,
    );
    const taskFile = () =>
      handleApi(
        new Request(file, {
          headers: {
            Authorization: `Bearer ${variables.MELANCHOLY_API_TOKEN}`,
          },
        }),
      );
    expect(await (await taskFile()).text()).toBe("private attachment");
    const context = await repositoryContext("general", messageId);
    expect(context).toContain(id);
    expect(context).toContain("/api/files/FILE_ID");
    await env.DB.prepare("UPDATE chat_messages SET deleted_at=? WHERE id=?")
      .bind(Date.now(), messageId)
      .run();
    expect((await taskFile()).status).toBe(404);
    await room.cancel(run.id);
    expect((await taskFile()).status).toBe(401);
  });
});
describe("durable conversation", () => {
  it("persists across eviction and isolates separate rooms", async () => {
    const { room, input } = await createRoom();
    await room.send(input);
    await evictDurableObject(room);
    expect((await inspectAgent(room)).messages[0].text).toBe(input.text);
    expect(
      (await inspectAgent(env.CONVERSATIONS.getByName(crypto.randomUUID())))
        .messages,
    ).toEqual([]);
  });
  it("deduplicates retries and rejects concurrent turns", async () => {
    const { room, input } = await createRoom();
    const first = await room.send(input);
    const again = await room.send(input);
    expect(again).toEqual({ id: first.id, duplicate: true });
    expect((await inspectAgent(room)).messages).toHaveLength(2);
    expect(
      (await room.send({ ...input, id: crypto.randomUUID() })).error,
    ).toContain("already running");
  });
  it("ignores duplicate and late events and resumes the saved CLI session", async () => {
    const { room, input } = await createRoom();
    const { id } = await room.send(input);
    await room.receive(id, 1, { type: "started", sessionId: "session-123" });
    await room.receive(id, 2, { type: "text", text: "correct" });
    await room.receive(id, 2, { type: "text", text: "duplicate" });
    await room.receive(id, 3, { type: "completed" });
    await room.receive(id, 4, { type: "text", text: "late" });
    const snapshot = await inspectAgent(room);
    expect(snapshot.messages[1].text).toBe("correct");
    expect(snapshot.runs[0].session_id).toBe("session-123");
    await room.send({ ...input, id: crypto.randomUUID(), text: "follow-up" });
    const resumed = await inspectAgent(room);
    expect(resumed.runs).toHaveLength(2);
    expect(JSON.parse(resumed.runs[0].job).sessionId).toBe("session-123");
  });
  it("cancels an offline queued task and leaves the room usable", async () => {
    const { room, input } = await createRoom();
    await room.send(input);
    await room.cancel();
    expect((await inspectAgent(room)).runs[0].status).toBe("cancelled");
    await room.send({ ...input, id: crypto.randomUUID() });
    expect((await inspectAgent(room)).runs).toHaveLength(2);
  });
  it("projects agent output into current chat search", async () => {
    const { room, input } = await createRoom();
    const run = await room.send(input);
    await room.receive(run.id, 1, {
      type: "text",
      text: "searchable agent output",
    });
    await runDurableObjectAlarm(room);
    const result = await env.DB.prepare(
      "SELECT text FROM chat_search WHERE chat_search MATCH ?",
    )
      .bind('"searchable"')
      .all();
    expect(
      result.results.some((r) => r.text === "searchable agent output"),
    ).toBe(true);
  });
  it("rejects standalone tasks without a current channel mapping", async () => {
    const { room, input } = await createRoom();
    expect(
      (await room.send({ ...input, threadId: crypto.randomUUID() })).error,
    ).toBe("Agent conversation not found.");
    expect((await inspectAgent(room)).runs).toHaveLength(0);
  });
  it("persists connector revocation and rejects a previously authorized upgrade", async () => {
    const { room, input } = await createRoom();
    await room.send(input);
    await runDurableObjectAlarm(room);
    const connector = env.CONNECTORS.getByName(input.serverId);
    await connector.revoke();
    expect((await inspectAgent(room)).runs[0].status).toBe("failed");
    await evictDurableObject(connector);
    const staleUpgrade = await connector.fetch(
      new Request(base + "/api/connector", {
        headers: { Upgrade: "websocket", "x-connector-id": input.serverId },
      }),
    );
    expect(staleUpgrade.status).toBe(401);
    expect(await connector.online()).toBe(false);
    await room.send({ ...input, id: crypto.randomUUID() });
    await runDurableObjectAlarm(room);
    expect(
      (await inspectAgent(room)).runs.every((run) => run.status === "failed"),
    ).toBe(true);
  });
});
