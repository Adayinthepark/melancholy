import { beforeAll, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
  type D1Migration,
} from "cloudflare:test";
import { handleApi } from "../worker/api";
import { hash } from "../worker/auth";
import {
  updateParts,
  type AgentPart,
  type AgentArtifact,
} from "../lib/agent-parts";
import { notes, channelFiles } from "../worker/channel-data";
const origin = "https://deliveries.test";
beforeAll(async () => {
  await applyD1Migrations(
    env.DB,
    (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] })
      .TEST_MIGRATIONS,
  );
});
async function fixture() {
  const serverId = crypto.randomUUID(),
    threadId = crypto.randomUUID(),
    rootId = crypto.randomUUID(),
    roomId = crypto.randomUUID(),
    token = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO servers(id,name,runtime,token_hash,created_at) VALUES (?,'Deliveries','codex',?,?)",
    ).bind(serverId, await hash(token), Date.now()),
    env.DB.prepare(
      "INSERT INTO people(id,handle,name,kind,server_id,created_at) VALUES (?,?,'Agent','bot',?,?)",
    ).bind(serverId, serverId, serverId, Date.now()),
    env.DB.prepare(
      "INSERT INTO rooms(id,kind,name,private,created_by,created_at) VALUES (?,'channel',?,1,'owner',?)",
    ).bind(roomId, roomId, Date.now()),
    env.DB.prepare("INSERT INTO room_members VALUES (?,'owner',?)").bind(
      roomId,
      Date.now(),
    ),
    env.DB.prepare("INSERT INTO room_members VALUES (?,?,?)").bind(
      roomId,
      serverId,
      Date.now(),
    ),
    env.DB.prepare(
      "INSERT INTO chat_messages(id,room_id,author_id,text,created_at) VALUES (?,?,'owner','Please make a report',?)",
    ).bind(rootId, roomId, Date.now()),
    env.DB.prepare("INSERT INTO agent_threads VALUES (?,?,?,?)").bind(
      threadId,
      roomId,
      rootId,
      serverId,
    ),
  ]);
  const agent = env.CONVERSATIONS.getByName(threadId);
  const run = await agent.send({
    threadId,
    serverId,
    runtime: "codex",
    text: "Please make a report",
    id: rootId,
    attachments: [],
    chat: { roomId, botId: serverId, parentId: rootId },
  });
  await agent.receive(run.id, 1, { type: "started", sessionId: "session-one" });
  const message = await env.DB.prepare(
    "SELECT id FROM chat_messages WHERE run_id=?",
  )
    .bind(run.id)
    .first<{ id: string }>();
  const login = await handleApi(
    new Request(origin + "/api/login", {
      method: "POST",
      headers: { Origin: origin },
      body: JSON.stringify({ key: env.WORKSPACE_KEY }),
    }),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  return {
    serverId,
    threadId,
    rootId,
    roomId,
    token,
    agent,
    runId: run.id,
    messageId: message!.id,
    cookie,
  };
}
async function projected(runId: string) {
  const row = await env.DB.prepare(
    "SELECT text,parts,run_status,event_seq FROM chat_messages WHERE run_id=?",
  )
    .bind(runId)
    .first<{
      text: string;
      parts: string;
      run_status: string;
      event_seq: number;
    }>();
  return { ...row!, parts: JSON.parse(row!.parts) as AgentPart[] };
}
it("preserves interleaved item order across duplicate delivery, eviction, and final snapshots", async () => {
  const f = await fixture();
  await f.agent.receive(f.runId, 2, {
    type: "text",
    id: "intro",
    text: "I will inspect the files.",
  });
  await f.agent.receive(f.runId, 3, {
    type: "activity",
    id: "read",
    title: "Read files",
    status: "running",
  });
  await f.agent.receive(f.runId, 4, {
    type: "text",
    id: "answer",
    text: "The result",
  });
  await f.agent.receive(f.runId, 5, {
    type: "activity",
    id: "read",
    title: "Read files",
    status: "completed",
    detail: "ok",
  });
  await evictDurableObject(f.agent);
  await f.agent.receive(f.runId, 5, {
    type: "text",
    id: "intro",
    text: "duplicate",
  });
  await f.agent.receive(f.runId, 6, {
    type: "text",
    id: "answer",
    text: "The result is ready.",
  });
  await f.agent.receive(f.runId, 7, { type: "completed" });
  const m = await projected(f.runId);
  expect(m.parts.map((p) => p.type)).toEqual(["text", "activity", "text"]);
  expect(m.text).toBe("I will inspect the files.\n\nThe result is ready.");
  expect(m.parts[1]).toMatchObject({ status: "completed" });
  expect(m.run_status).toBe("completed");
});
it("legacy cumulative text trimming does not duplicate earlier commentary", () => {
  let p: AgentPart[] = [];
  p = updateParts(p, { type: "text", text: "Checking.\n\n" }, 1, "");
  p = updateParts(
    p,
    { type: "activity", id: "t", title: "Read" },
    2,
    "Checking.\n\n",
  );
  p = updateParts(
    p,
    { type: "text", text: "Checking.\n\nDone.\n\n" },
    3,
    "Checking.\n\n",
  );
  p = updateParts(
    p,
    { type: "text", text: "Checking.\n\nDone." },
    4,
    "Checking.\n\nDone.\n\n",
  );
  expect(
    p
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(""),
  ).toBe("Checking.\n\nDone.");
  expect(p.map((p) => p.type)).toEqual(["text", "activity", "text"]);
});
it("answers are authorized, single-use, durable during reconnect and independent of output sequence", async () => {
  const f = await fixture();
  await f.agent.receive(f.runId, 2, {
    type: "interaction",
    interaction: {
      id: "codex:42",
      kind: "approval",
      title: "Run tests?",
      detail: "npm test",
      questions: [],
      state: "pending",
    },
  });
  expect(
    (
      await f.agent.answer(
        f.runId,
        "codex:42",
        { decision: "accept" },
        "outsider",
        false,
      )
    ).status,
  ).toBe(403);
  const path = `/api/chat/messages/${f.messageId}/interactions/codex%3A42`;
  const answer = () =>
    handleApi(
      new Request(origin + path, {
        method: "POST",
        headers: { Origin: origin, Cookie: f.cookie },
        body: JSON.stringify({ decision: "accept" }),
      }),
    );
  expect((await answer()).status).toBe(200);
  expect((await answer()).status).toBe(409);
  await evictDurableObject(f.agent);
  await runDurableObjectAlarm(f.agent);
  expect((await projected(f.runId)).parts[0]).toMatchObject({
    interaction: {
      state: "sending",
      answeredBy: "owner",
      response: { decision: "accept" },
    },
  });
  // Browser response changed projection revision, but must not consume connector event sequence 3.
  await f.agent.receive(f.runId, 3, {
    type: "interaction_resolved",
    id: "codex:42",
  });
  await f.agent.receive(f.runId, 4, {
    type: "text",
    id: "final",
    text: "Tests passed.",
  });
  expect((await projected(f.runId)).parts[0]).toMatchObject({
    interaction: { state: "answered" },
  });
  expect((await projected(f.runId)).text).toBe("Tests passed.");
  await f.agent.receive(f.runId, 5, {
    type: "interaction",
    interaction: {
      id: "stale",
      kind: "question",
      title: "Next?",
      detail: "",
      questions: [{ id: "q", title: "Choose", options: [], freeform: true }],
      state: "pending",
    },
  });
  await f.agent.cancel();
  expect(
    (
      await f.agent.answer(
        f.runId,
        "stale",
        { answers: { q: ["go"] } },
        "owner",
        true,
      )
    ).status,
  ).toBe(409);
  expect((await projected(f.runId)).parts.at(-1)).toMatchObject({
    interaction: { state: "expired" },
  });
});
it("validates question answers and keeps ownership outside connector-supplied content", async () => {
  const f = await fixture();
  await f.agent.receive(f.runId, 2, {
    type: "interaction",
    interaction: {
      id: "q",
      kind: "question",
      title: "Choice",
      detail: "",
      requestedBy: "outsider",
      questions: [
        {
          id: "one",
          title: "Choose one",
          options: [{ label: "A" }, { label: "B" }],
          freeform: false,
        },
      ],
      state: "pending",
    },
  });
  expect((await projected(f.runId)).parts[0]).toMatchObject({
    interaction: { requestedBy: "owner" },
  });
  for (const answers of [
    { one: ["C"] },
    { one: ["A", "B"] },
    { wrong: ["A"] },
  ] as Record<string, string[]>[])
    expect(
      (await f.agent.answer(f.runId, "q", { answers }, "owner", true)).status,
    ).toBe(400);
  expect(
    await f.agent.answer(
      f.runId,
      "q",
      { answers: { one: ["A"] } },
      "owner",
      true,
    ),
  ).toEqual({ ok: true });
  await f.agent.cancel();
});
it("Markdown becomes a Note; binary files enter private R2 and Files with retry deduplication", async () => {
  const f = await fixture();
  const upload = (name: string, body: string, token = f.token) =>
    handleApi(
      new Request(
        origin +
          "/api/connector/artifacts?" +
          new URLSearchParams({ threadId: f.threadId, runId: f.runId, name }),
        { method: "POST", headers: { Authorization: "Bearer " + token }, body },
      ),
    );
  const md = await upload("report.md", "# Findings\n\nUseful result.");
  expect(md.status).toBe(200);
  const doc = (await md.json()) as AgentArtifact;
  expect(doc.noteId).toBeTruthy();
  expect(
    await (await upload("report.md", "# Findings\n\nUseful result.")).json(),
  ).toEqual(doc);
  const saved = await notes(f.roomId);
  expect(saved).toHaveLength(1);
  expect(saved[0].content).toContain("Source conversation");
  const raw = "%PDF-1.4\nExample PDF";
  const pdf = (await (await upload("report.pdf", raw)).json()) as AgentArtifact;
  expect(pdf.file?.type).toBe("application/pdf");
  expect(await (await upload("report.pdf", raw)).json()).toEqual(pdf);
  expect((await channelFiles(f.roomId)).files).toHaveLength(1);
  expect(
    (await handleApi(new Request(origin + "/api/files/" + pdf.id))).status,
  ).toBe(401);
  const read = await handleApi(
    new Request(origin + "/api/files/" + pdf.id, {
      headers: { Cookie: f.cookie },
    }),
  );
  expect(read.status).toBe(200);
  expect(await read.text()).toBe(raw);
  await f.agent.receive(f.runId, 2, {
    type: "artifact",
    artifact: { ...doc, name: "forged" },
  });
  expect((await projected(f.runId)).parts[0]).toMatchObject({
    artifact: { name: "report.md" },
  });
  await f.agent.receive(f.runId, 3, { type: "artifact", artifact: pdf });
  await f.agent.receive(f.runId, 4, { type: "completed" });
  expect((await upload("late.txt", "late")).status).toBe(403);
  expect((await upload("../secret.txt", "secret")).status).toBe(400);
  expect((await upload("bad.txt", "bad", "f".repeat(64))).status).toBe(401);
});
it("deleting a reply removes ordered content and prevents projection resurrection", async () => {
  const f = await fixture();
  await f.agent.receive(f.runId, 2, {
    type: "text",
    id: "t",
    text: "private text",
  });
  await f.agent.receive(f.runId, 3, { type: "completed" });
  const res = await handleApi(
    new Request(origin + "/api/chat/messages/" + f.messageId, {
      method: "DELETE",
      headers: { Origin: origin, Cookie: f.cookie },
    }),
  );
  expect(res.status).toBe(200);
  await f.agent.receive(f.runId, 4, {
    type: "text",
    id: "t",
    text: "late private text",
  });
  const row = await env.DB.prepare(
    "SELECT parts,text FROM chat_messages WHERE id=?",
  )
    .bind(f.messageId)
    .first();
  expect(row).toMatchObject({ parts: "[]", text: "" });
  await f.agent.cancel();
});

it("recovers a saved document card if the connector dies before emitting its artifact event", async () => {
  const f = await fixture();
  const response = await handleApi(
    new Request(
      origin +
        "/api/connector/artifacts?" +
        new URLSearchParams({
          threadId: f.threadId,
          runId: f.runId,
          name: "recovered.md",
        }),
      {
        method: "POST",
        headers: { Authorization: "Bearer " + f.token },
        body: "# Recovered\n\nSaved before the disconnect.",
      },
    ),
  );
  expect(response.status).toBe(200);
  const artifact = (await response.json()) as AgentArtifact;
  await f.agent.receive(f.runId, 2, {
    type: "failed",
    error: "Connector restarted during this turn.",
  });
  expect((await projected(f.runId)).parts).toContainEqual({
    type: "artifact",
    id: "artifact:" + artifact.id,
    artifact,
  });
});
