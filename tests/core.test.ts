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
  await env.DB.prepare(
    "INSERT INTO threads VALUES (?,'general','Test',?,?,?,0)",
  )
    .bind(threadId, serverId, Date.now(), Date.now())
    .run();
  return {
    room: env.CONVERSATIONS.getByName(threadId),
    input: {
      threadId,
      serverId,
      runtime: "codex" as const,
      text: "hello searchable世界",
      id: crypto.randomUUID(),
      attachments: [],
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
});
describe("durable conversation", () => {
  it("persists across eviction and isolates separate rooms", async () => {
    const { room, input } = await createRoom();
    await room.send(input);
    await evictDurableObject(room);
    expect((await room.snapshot()).messages[0].text).toBe(input.text);
    expect(
      (await env.CONVERSATIONS.getByName(crypto.randomUUID()).snapshot())
        .messages,
    ).toEqual([]);
  });
  it("deduplicates retries and rejects concurrent turns", async () => {
    const { room, input } = await createRoom();
    const first = await room.send(input);
    const again = await room.send(input);
    expect(again).toEqual({ id: first.id, duplicate: true });
    expect((await room.snapshot()).messages).toHaveLength(2);
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
    const snapshot = await room.snapshot();
    expect(snapshot.messages[1].text).toBe("correct");
    expect(snapshot.runs[0].session_id).toBe("session-123");
    await room.send({ ...input, id: crypto.randomUUID(), text: "follow-up" });
    expect((await room.snapshot()).runs).toHaveLength(2);
  });
  it("cancels an offline queued task and leaves the room usable", async () => {
    const { room, input } = await createRoom();
    await room.send(input);
    await room.cancel();
    expect((await room.snapshot()).runs[0].status).toBe("cancelled");
    await room.send({ ...input, id: crypto.randomUUID() });
    expect((await room.snapshot()).runs).toHaveLength(2);
  });
  it("indexes persisted messages for substring search", async () => {
    const { room, input } = await createRoom();
    await room.send(input);
    await runDurableObjectAlarm(room);
    const result = await env.DB.prepare(
      "SELECT text FROM search WHERE search MATCH ?",
    )
      .bind('"searchable"')
      .all();
    expect(result.results.some((r) => r.text === input.text)).toBe(true);
  });
});
