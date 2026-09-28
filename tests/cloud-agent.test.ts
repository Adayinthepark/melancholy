import { beforeAll, afterEach, vi, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
  runInDurableObject,
  evictDurableObject,
} from "cloudflare:test";
import { handleApi } from "../worker/api";
import { getWorkspace, type WorkspaceClient } from "@cloudflare/computer";
import { workspacePath, cloudTools } from "../worker/cloud-tools";
import { cloudAccess } from "../worker/cloud-config";
import type { TeamWorkspace } from "../lib/chat";
import type { Job } from "../lib/protocol";

beforeAll(async () => {
  await applyD1Migrations(
    env.DB,
    (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] })
      .TEST_MIGRATIONS,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});
const origin = "https://cloud.test";
async function request(
  path: string,
  cookie = "",
  method = "GET",
  body?: unknown,
) {
  return handleApi(
    new Request(origin + "/api" + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function setup() {
  const login = await request("/login", "", "POST", { key: env.WORKSPACE_KEY });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const key = await request("/chat/connections", cookie, "POST", {
    provider: "deepseek",
    name: "Test model",
    fields: [
      { name: "DEEPSEEK_API_KEY", value: "test-key-cloud-agent" },
      { name: "DEEPSEEK_BASE_URL", value: "https://models.test/v1" },
    ],
  });
  expect(key.status).toBe(201);
  const credential = (await key.json()) as { id: string };
  const response = await request("/chat/bots", cookie, "POST", {
    name: "Cloud Pi",
    handle: "pi-" + crypto.randomUUID().slice(0, 8),
    execution: "cloudflare",
    cloud: { credentialId: credential.id, model: "test-model" },
  });
  expect(response.status).toBe(201);
  const bot = (await response.json()) as {
    id: string;
    cloud_agent: number;
    server_id: null;
  };
  const workspace = (await (
    await request("/chat/workspace", cookie)
  ).json()) as TeamWorkspace;
  const roomId = crypto.randomUUID(),
    threadId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO rooms(id,kind,name,topic,private,created_by,created_at) VALUES (?,'dm','','',1,?,?)",
    ).bind(roomId, workspace.me.id, Date.now()),
    env.DB.prepare(
      "INSERT INTO room_members(room_id,person_id,joined_at) VALUES (?,?,?),(?,?,?)",
    ).bind(roomId, workspace.me.id, Date.now(), roomId, bot.id, Date.now()),
    env.DB.prepare("INSERT INTO agent_threads VALUES (?,?,?,?)").bind(
      threadId,
      roomId,
      roomId,
      bot.id,
    ),
  ]);
  return {
    cookie,
    bot,
    roomId,
    threadId,
    credential,
    ownerId: workspace.me.id,
  };
}
function sse(
  content: string,
  tools?: { id: string; name: string; arguments: unknown }[],
  usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
) {
  const delta = tools
    ? {
        tool_calls: tools.map((t, index) => ({
          index,
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        })),
      }
    : { content };
  return (
    [
      {
        id: "test",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", ...delta },
            finish_reason: null,
          },
        ],
      },
      {
        id: "test",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" },
        ],
        usage,
      },
    ]
      .map((data) => "data: " + JSON.stringify(data) + "\n\n")
      .join("") + "data: [DONE]\n\n"
  );
}
const responses: string[] = [];
function respond(body: string) {
  responses.push(body);
}
async function inWorkspace<T>(
  threadId: string,
  fn: (workspace: WorkspaceClient) => Promise<T>,
) {
  return runInDurableObject(
    env.CLOUD_AGENTS.getByName(threadId),
    async (instance) => {
      const workspace = await getWorkspace(instance);
      try {
        return await fn(workspace);
      } finally {
        workspace[Symbol.dispose]();
      }
    },
  );
}
async function completed(runId: string) {
  await expect
    .poll(
      async () =>
        (
          await env.DB.prepare(
            "SELECT run_status FROM chat_messages WHERE run_id=?",
          )
            .bind(runId)
            .first<{ run_status: string }>()
        )?.run_status,
      { timeout: 20000 },
    )
    .toBe("completed");
}

describe("Cloudflare Pi agents", () => {
  it("compacts earlier turns through Pi and preserves the current request within the step budget", async () => {
    const { bot, roomId, threadId } = await setup();
    await env.DB.prepare(
      "UPDATE cloud_bots SET context_window=16000,max_steps=3 WHERE bot_id=?",
    )
      .bind(bot.id)
      .run();
    const requests: { messages: { content: unknown }[] }[] = [];
    const outputs = [
      "Prior task details ".repeat(1000),
      "Earlier work: report.md was verified.",
      "Read the saved report",
      "Continued from the saved summary.",
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(
        (await new Request(input, init).json()) as {
          messages: { content: unknown }[];
        },
      );
      const content = outputs.shift();
      if (!content) throw new Error("Unexpected model request");
      return new Response(
        sse(
          content,
          requests.length === 3
            ? [
                {
                  id: "read-after-compaction",
                  name: "write",
                  arguments: { path: "continued.txt", content: "ok" },
                },
              ]
            : undefined,
          requests.length === 1
            ? {
                prompt_tokens: 7000,
                completion_tokens: 6000,
                total_tokens: 13000,
              }
            : undefined,
        ),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    });
    const send = (text: string) =>
      env.CONVERSATIONS.getByName(threadId).send({
        id: crypto.randomUUID(),
        threadId,
        serverId: "cloud:" + bot.id,
        runtime: "pi",
        text,
        attachments: [],
        chat: { roomId, botId: bot.id, parentId: null },
      });
    await completed((await send("Read the earlier task")).id);
    await completed((await send("Continue with the next task")).id);
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[2])).toContain("report.md was verified");
    expect(JSON.stringify(requests[2])).toContain(
      "Continue with the next task",
    );
    expect(JSON.stringify(requests[2])).not.toContain("Prior task details");
    expect(JSON.stringify(requests[3])).not.toContain("Prior task details");
    expect(JSON.stringify(requests[3])).toContain("report.md was verified");
    expect(JSON.stringify(requests[3])).toContain("capable project agent");
  }, 30000);
  it("reports a full context before sending an oversized task to the provider", async () => {
    const { bot, roomId, threadId } = await setup();
    await env.DB.prepare(
      "UPDATE cloud_bots SET context_window=16000 WHERE bot_id=?",
    )
      .bind(bot.id)
      .run();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw new Error("Oversized context must not reach the provider");
      });
    const run = await env.CONVERSATIONS.getByName(threadId).send({
      id: crypto.randomUUID(),
      threadId,
      serverId: "cloud:" + bot.id,
      runtime: "pi",
      text: "Large input ".repeat(10000),
      attachments: [],
      chat: { roomId, botId: bot.id, parentId: null },
    });
    await expect
      .poll(
        async () =>
          (
            await env.DB.prepare(
              "SELECT run_error FROM chat_messages WHERE run_id=?",
            )
              .bind(run.id)
              .first<{ run_error: string }>()
          )?.run_error,
      )
      .toContain("filled the model context");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("enforces the model step limit with an actionable error", async () => {
    const { bot, roomId, threadId } = await setup();
    await env.DB.prepare("UPDATE cloud_bots SET max_steps=1 WHERE bot_id=?")
      .bind(bot.id)
      .run();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          sse("", [
            {
              id: "bounded-tool",
              name: "write",
              arguments: { path: "bounded.txt", content: "done" },
            },
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const run = await env.CONVERSATIONS.getByName(threadId).send({
      id: crypto.randomUUID(),
      threadId,
      serverId: "cloud:" + bot.id,
      runtime: "pi",
      text: "Write and inspect",
      attachments: [],
      chat: { roomId, botId: bot.id, parentId: null },
    });
    await expect
      .poll(
        async () =>
          (
            await env.DB.prepare(
              "SELECT run_error FROM chat_messages WHERE run_id=?",
            )
              .bind(run.id)
              .first<{ run_error: string }>()
          )?.run_error,
      )
      .toContain("model step limit");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not expose a provider error body or credentials", async () => {
    const { bot, roomId, threadId } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { error: { message: "Rejected secret test-key-cloud-agent" } },
        { status: 401 },
      ),
    );
    const run = await env.CONVERSATIONS.getByName(threadId).send({
      id: crypto.randomUUID(),
      threadId,
      serverId: "cloud:" + bot.id,
      runtime: "pi",
      text: "Hello",
      attachments: [],
      chat: { roomId, botId: bot.id, parentId: null },
    });
    await expect
      .poll(
        async () =>
          (
            await env.DB.prepare(
              "SELECT run_status FROM chat_messages WHERE run_id=?",
            )
              .bind(run.id)
              .first<{ run_status: string }>()
          )?.run_status,
      )
      .toBe("failed");
    const record = await env.DB.prepare(
      "SELECT text,run_error,activity FROM chat_messages WHERE run_id=?",
    )
      .bind(run.id)
      .first();
    expect(JSON.stringify(record)).not.toContain("test-key-cloud-agent");
    expect(record?.run_error).toContain("Model request failed");
  });
  it("requires an LLM credential, creates a serverless bot, and keeps credentials private", async () => {
    const { cookie, bot } = await setup();
    expect(bot.cloud_agent).toBe(1);
    expect(bot.server_id).toBeNull();
    const response = await request("/chat/bots", cookie, "POST", {
      name: "Broken",
      handle: "broken-" + crypto.randomUUID().slice(0, 8),
      execution: "cloudflare",
    });
    expect(response.status).toBe(400);
    const config = await request("/chat/cloud-bots", cookie);
    expect(await config.text()).not.toContain("test-key-cloud-agent");
    expect((await request("/chat/cloud-bots")).status).toBe(401);
  });
  it("runs the real Pi loop across tools, persists files and context, and projects tokens once", async () => {
    const { bot, roomId, threadId } = await setup();
    responses.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      expect(req.url).toBe("https://models.test/v1/chat/completions");
      expect(req.headers.get("Authorization")).toBe(
        "Bearer test-key-cloud-agent",
      );
      const body = responses.shift();
      if (!body) throw new Error("Unexpected model request");
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    respond(
      sse("", [
        {
          id: "plan-test",
          name: "update_plan",
          arguments: {
            steps: [
              { title: "Write and verify the file", status: "in_progress" },
            ],
          },
        },
      ]),
    );
    respond(
      sse("", [
        {
          id: "write-test",
          name: "write",
          arguments: { path: "result.txt", content: "persisted result" },
        },
      ]),
    );
    respond(sse("Saved result.txt"));
    const input = {
      id: crypto.randomUUID(),
      threadId,
      serverId: "cloud:" + bot.id,
      runtime: "pi" as const,
      text: "Write result.txt",
      attachments: [],
      chat: { roomId, botId: bot.id, parentId: null },
    };
    const run = await env.CONVERSATIONS.getByName(threadId).send(input);
    await completed(run.id);
    const duplicate = await env.CONVERSATIONS.getByName(threadId).send(input);
    expect(duplicate).toEqual({ id: run.id, duplicate: true });
    expect(
      await inWorkspace(threadId, (workspace) =>
        workspace.fs.readFile("/workspace/result.txt", "utf8"),
      ),
    ).toBe("persisted result");
    const row = await env.DB.prepare(
      "SELECT input_tokens,output_tokens FROM agent_usage WHERE run_id=?",
    )
      .bind(run.id)
      .first();
    expect(row).toMatchObject({ input_tokens: 60, output_tokens: 30 });
    await evictDurableObject(env.CLOUD_AGENTS.getByName(threadId));
    respond(
      sse("", [
        { id: "read-test", name: "read", arguments: { path: "result.txt" } },
      ]),
    );
    respond(sse("The file still contains persisted result."));
    const followup = await env.CONVERSATIONS.getByName(threadId).send({
      ...input,
      id: crypto.randomUUID(),
      text: "Read the file again",
    });
    await completed(followup.id);
    expect(responses).toHaveLength(0);
  }, 30000);
  it("executes isolated JavaScript and shell against the same persistent files", async () => {
    const { threadId } = await setup();
    await inWorkspace(threadId, async (workspace) => {
      await workspace.fs.mkdir("/workspace", { recursive: true });
      await workspace.fs.writeFile("/workspace/data.txt", "4\n7\n");
      const js = await workspace.runtime.exec(
        'import fs from "node:fs/promises"; export default async function() { const input = await fs.readFile("/workspace/data.txt", "utf8"); const sum = input.trim().split("\\n").map(Number).reduce((a,b) => a+b,0); await fs.writeFile("/workspace/sum.txt",String(sum)); return sum; }',
        { backend: "javascript", encoding: "utf8" },
      );
      expect((await js.result()).exitCode).toBe(0);
      js[Symbol.dispose]();
      expect(await workspace.fs.readFile("/workspace/sum.txt", "utf8")).toBe(
        "11",
      );
      const shell = await workspace.runtime.exec("cat /workspace/sum.txt", {
        backend: "shell",
        encoding: "utf8",
      });
      const output = await shell.result();
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toBe("11");
      shell[Symbol.dispose]();
    });
  }, 30000);
  it("publishes a private downloadable file and rejects cross-thread attachment imports", async () => {
    const { cookie, bot, roomId, threadId } = await setup();
    await inWorkspace(threadId, async (workspace) => {
      await workspace.fs.mkdir("/workspace", { recursive: true });
      await workspace.fs.writeFile("/workspace/report.md", "# Result");
      const job: Job = {
        id: crypto.randomUUID(),
        threadId,
        runtime: "pi",
        prompt: "Report",
        sessionId: null,
        attachments: [],
      };
      const messageId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO chat_messages(id,room_id,author_id,text,created_at,run_id) VALUES (?,?,?,'',?,?)",
      )
        .bind(messageId, roomId, bot.id, Date.now(), job.id)
        .run();
      const tools = cloudTools({
        workspace,
        env,
        config: await cloudAccess(threadId),
        job,
        plan: () => {},
      });
      const publish = tools.find((t) => t.name === "publish_file")!;
      const output = await publish.execute("publish-test", {
        path: "report.md",
      });
      const file = JSON.parse(
        output.content[0].type === "text" ? output.content[0].text : "{}",
      );
      const download = await request("/chat/files/" + file.id, cookie);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe("# Result");
      expect((await request("/chat/files/" + file.id)).status).toBe(401);
      const importer = tools.find((t) => t.name === "import_attachment")!;
      await expect(
        importer.execute("import-test", {
          id: crypto.randomUUID(),
          path: "secret.txt",
        }),
      ).rejects.toThrow("unavailable");
    });
  });
  it("isolates files and denies a revoked bot access", async () => {
    const { bot, roomId, threadId } = await setup();
    await inWorkspace(threadId, async (ws) => {
      await ws.fs.mkdir("/workspace", { recursive: true });
      await ws.fs.writeFile("/workspace/private.txt", "private");
    });
    await expect(
      inWorkspace(crypto.randomUUID(), (ws) =>
        ws.fs.stat("/workspace/private.txt"),
      ),
    ).rejects.toThrow();
    await env.DB.prepare(
      "DELETE FROM room_members WHERE room_id=? AND person_id=?",
    )
      .bind(roomId, bot.id)
      .run();
    await expect(cloudAccess(threadId)).rejects.toThrow("no longer has access");
    expect(() => workspacePath("../../secrets")).toThrow("inside /workspace");
  });
  it("cancels an in-flight model request and does not restart a cancelled job", async () => {
    const { bot, roomId, threadId } = await setup();
    let started = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      started = true;
      const request = new Request(input, init);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Cancelled", "AbortError"));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      });
    });
    const run = await env.CONVERSATIONS.getByName(threadId).send({
      id: crypto.randomUUID(),
      threadId,
      serverId: "cloud:" + bot.id,
      runtime: "pi",
      text: "Start a task",
      attachments: [],
      chat: { roomId, botId: bot.id, parentId: null },
    });
    await expect.poll(() => started).toBe(true);
    await env.CONVERSATIONS.getByName(threadId).cancel();
    await expect
      .poll(
        async () =>
          (
            await env.DB.prepare(
              "SELECT run_status FROM chat_messages WHERE run_id=?",
            )
              .bind(run.id)
              .first<{ run_status: string }>()
          )?.run_status,
      )
      .toBe("cancelled");
    expect(await env.CONVERSATIONS.getByName(threadId).hasActiveRun()).toBe(
      false,
    );
  }, 15000);
  it("dispatches a human DM to a cloud bot without a server", async () => {
    const { cookie, bot, roomId } = await setup();
    await env.DB.prepare("DELETE FROM agent_threads WHERE bot_id=?")
      .bind(bot.id)
      .run();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(sse("Hello from the cloud"), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const response = await request(
      "/chat/rooms/" + roomId + "/messages",
      cookie,
      "POST",
      { text: "Hello" },
    );
    expect(response.status).toBe(201);
    await env.CHAT_DISPATCHERS.getByName(roomId).kick(roomId);
    await expect
      .poll(
        async () =>
          await env.DB.prepare(
            "SELECT run_status,run_error FROM chat_messages WHERE room_id=? AND author_id=? AND run_id IS NOT NULL ORDER BY seq DESC LIMIT 1",
          )
            .bind(roomId, bot.id)
            .first(),
        { timeout: 10000 },
      )
      .toMatchObject({ run_status: "completed" });
  }, 15000);
});
