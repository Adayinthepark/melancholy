import { test } from "node:test";
import assert from "node:assert/strict";
import { commandFor, OutputParser } from "../packages/connector/adapters.mjs";
import { killTree } from "../packages/connector/process.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
test("prompts use stdin, and resumed sessions stay explicit", () => {
  const fresh = commandFor("codex", null);
  assert.equal(fresh.command, "codex");
  assert.equal(fresh.args.at(-1), "-");
  assert.ok(fresh.args.includes('sandbox_mode="read-only"'));
  const resumed = commandFor("codex", "session-1", "workspace-write");
  assert.deepEqual(resumed.args.slice(-3), ["resume", "session-1", "-"]);
  assert.ok(commandFor("claude", "session-2").args.includes("--resume"));
  assert.throws(() => commandFor("shell", null));
  assert.throws(() => commandFor("codex", null, "invalid"));
  assert.ok(!commandFor("codex", null, "inherit").args.includes("-c"));
  assert.ok(
    !commandFor("claude", null, "inherit").args.includes("--permission-mode"),
  );
});
test("Codex message snapshots do not duplicate completed items", () => {
  const events = [];
  const parser = new OutputParser("codex", (e) => events.push(e));
  parser.accept({ type: "thread.started", thread_id: "abc" });
  parser.accept({
    type: "item.updated",
    item: { id: "a", type: "agent_message", text: "hel" },
  });
  parser.accept({
    type: "item.completed",
    item: { id: "a", type: "agent_message", text: "hello" },
  });
  parser.accept({
    type: "item.completed",
    item: { id: "b", type: "agent_message", text: "world" },
  });
  assert.equal(parser.text, "hello\n\nworld");
  assert.equal(parser.sessionId, "abc");
  assert.equal(events.at(-1).text, "hello\n\nworld");
});
test("Claude token streaming and final output converge", () => {
  const events = [];
  const parser = new OutputParser("claude", (e) => events.push(e));
  parser.accept({ type: "system", subtype: "init", session_id: "abc" });
  parser.accept({
    type: "stream_event",
    event: { delta: { type: "text_delta", text: "hello" } },
  });
  parser.accept({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }] },
  });
  parser.accept({ type: "result", result: "hello", is_error: false });
  assert.equal(parser.text, "hello");
  assert.equal(parser.sessionId, "abc");
});
test("tool failures and CLI failures remain visible", () => {
  const events = [];
  const parser = new OutputParser("codex", (e) => events.push(e));
  parser.accept({
    type: "item.completed",
    item: {
      id: "t",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "failed",
      status: "failed",
    },
  });
  parser.accept({ type: "turn.failed", error: { message: "rate limited" } });
  assert.equal(events[0].status, "failed");
  assert.equal(parser.error, "rate limited");
});
test(
  "stopping a CLI escalates when it ignores termination",
  { skip: process.platform === "win32", timeout: 5000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    try {
      await once(child.stdout, "data");
      const closed = once(child, "close");
      killTree(child, 50);
      const [, signal] = await closed;
      assert.equal(signal, "SIGKILL");
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  },
);

test("Codex reports total input with cached input as a subset", () => {
  const events = [];
  const parser = new OutputParser("codex", (e) => events.push(e));
  parser.accept({
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: 12, cached_input_tokens: 60 },
  });
  assert.deepEqual(events.at(-1), {
    type: "usage",
    usage: {
      inputTokens: 100,
      outputTokens: 12,
      cachedTokens: 60,
      cacheWriteTokens: 0,
    },
  });
});
test("Claude usage includes cache reads and writes without summing modelUsage twice", () => {
  const events = [];
  const parser = new OutputParser("claude", (e) => events.push(e));
  parser.accept({
    type: "result",
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
    modelUsage: { first: {}, second: {} },
    total_cost_usd: 0.04,
  });
  assert.deepEqual(events.at(-1), {
    type: "usage",
    usage: {
      inputTokens: 80,
      outputTokens: 20,
      cachedTokens: 30,
      cacheWriteTokens: 40,
      costUsd: 0.04,
    },
  });
});
import {
  agentEnvironment,
  redactor,
} from "../packages/connector/environment.mjs";
test("task environments drop inherited provider credentials and reject arbitrary overrides", () => {
  const result = agentEnvironment(
    {
      PATH: "/usr/bin",
      GH_TOKEN: "old",
      MELANCHOLY_TOKEN: "connector",
      CF_API_KEY: "global-key",
      OPENAI_API_KEY: "cli-auth",
    },
    {
      GH_TOKEN: "approved",
      NODE_OPTIONS: "--import=bad",
      MELANCHOLY_TOKEN: "spoof",
      MELANCHOLY_API_TOKEN: "task-token",
    },
  );
  assert.deepEqual(result, {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "cli-auth",
    GH_TOKEN: "approved",
    MELANCHOLY_API_TOKEN: "task-token",
  });
});
test("redaction covers tool events and failure details recursively", () => {
  const redact = redactor({
    GH_TOKEN: "test-provider-secret",
    MELANCHOLY_API_TOKEN: "test-task-secret",
    CLOUDFLARE_ACCOUNT_ID: "public-account",
  });
  assert.deepEqual(
    redact({
      error: "bad test-provider-secret",
      events: [{ detail: "test-task-secret public-account" }],
    }),
    {
      error: "bad [redacted]",
      events: [{ detail: "[redacted] public-account" }],
    },
  );
});
test("approved LLM and multiline signing keys reach only the task child and are redacted", () => {
  const inherited = { PATH: "/usr/bin", OPENAI_API_KEY: "operator-cli-auth" };
  const approved = {
    OPENAI_API_KEY: "new-llm-key",
    OPENAI_BASE_URL: "https://llm.test/v1",
    ASC_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRIVATE KEY-----",
    ASC_KEY_ID: "key123",
    NODE_OPTIONS: "--import=bad",
    GIT_CONFIG_KEY: "evil",
    MELANCHOLY_TOKEN: "connector-spoof",
  };
  const result = agentEnvironment(inherited, approved);
  assert.equal(result.OPENAI_API_KEY, "new-llm-key");
  assert.equal(result.ASC_PRIVATE_KEY, approved.ASC_PRIVATE_KEY);
  assert.equal(result.ASC_KEY_ID, "key123");
  assert.equal(result.NODE_OPTIONS, undefined);
  assert.equal(result.GIT_CONFIG_KEY, undefined);
  assert.equal(result.MELANCHOLY_TOKEN, undefined);
  assert.equal(inherited.OPENAI_API_KEY, "operator-cli-auth");
  const redact = redactor(approved);
  assert.equal(
    redact("output new-llm-key " + approved.ASC_PRIVATE_KEY + " key123"),
    "output [redacted] [redacted] [redacted]",
  );
});

test("multiline private key body lines are redacted in separate output events", () => {
  const redact = redactor({
    ASC_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\nbase64SigningMaterialLine\n-----END PRIVATE KEY-----",
  });
  assert.equal(
    redact({ detail: "base64SigningMaterialLine" }).detail,
    "[redacted]",
  );
});

test("short credential values do not alter event protocol fields", () => {
  const redact = redactor({ ASC_KEY_ID: "t" });
  assert.deepEqual(redact({ type: "text", status: "started", text: "t" }), {
    type: "text",
    status: "started",
    text: "[redacted]",
  });
});

import {
  InteractiveSession,
  interactiveCommand,
} from "../packages/connector/interactive.mjs";
import {
  outputDirectory,
  collectArtifacts,
} from "../packages/connector/artifacts.mjs";
import { mkdtemp, writeFile, symlink, link, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
function interactive(runtime, sessionId = null) {
  const sent = [],
    events = [];
  let done = false;
  const session = new InteractiveSession(runtime, {
    sessionId,
    cwd: "/project",
    permission: "workspace-write",
    prompt: "the task",
    send: (v) => sent.push(v),
    emit: (v) => events.push(v),
    done: () => {
      done = true;
    },
  });
  return { session, sent, events, done: () => done };
}
test("interactive adapters preserve sandbox policy and explicit resume", () => {
  assert.deepEqual(interactiveCommand("codex", "prior", "inherit").args, [
    "app-server",
  ]);
  assert.ok(
    interactiveCommand("codex", "prior", "read-only").args.includes(
      'sandbox_mode="read-only"',
    ),
  );
  const claude = interactiveCommand("claude", "prior", "workspace-write");
  assert.ok(claude.args.includes("prior"));
  assert.ok(claude.args.includes("stdio"));
  assert.ok(claude.args.includes("acceptEdits"));
  const { session, sent, events } = interactive("codex", "prior");
  session.start();
  session.accept({ id: "init", result: {} });
  assert.equal(sent.at(-1).method, "thread/resume");
  assert.equal(sent.at(-1).params.threadId, "prior");
  session.accept({ id: "thread", result: { thread: { id: "prior" } } });
  assert.equal(events[0].sessionId, "prior");
  assert.equal(sent.at(-1).params.input[0].text, "the task");
});
test("Codex text, tools, approval and final response retain distinct IDs", () => {
  const { session, sent, events, done } = interactive("codex", "thread");
  session.accept({
    method: "item/started",
    params: {
      threadId: "thread",
      item: { id: "intro", type: "agentMessage", text: "Checking" },
    },
  });
  session.accept({
    method: "item/started",
    params: {
      threadId: "thread",
      item: {
        id: "tool",
        type: "commandExecution",
        command: "npm test",
        status: "inProgress",
      },
    },
  });
  session.accept({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", itemId: "tool", command: "npm test" },
  });
  assert.equal(events.at(-1).interaction.state, "pending");
  assert.equal(sent.length, 0);
  session.respond("codex:42", { decision: "accept", command: "rm -rf /" });
  assert.deepEqual(sent.at(-1), { id: 42, result: { decision: "accept" } });
  session.respond("codex:42", { decision: "decline" });
  assert.equal(sent.length, 1);
  session.accept({
    method: "item/completed",
    params: {
      item: {
        id: "tool",
        type: "commandExecution",
        command: "npm test",
        aggregatedOutput: "passed",
        status: "completed",
      },
    },
  });
  session.accept({
    method: "item/agentMessage/delta",
    params: { itemId: "final", delta: "Done" },
  });
  session.accept({
    method: "item/completed",
    params: { item: { id: "final", type: "agentMessage", text: "Done." } },
  });
  assert.deepEqual(
    events.filter((e) => e.type === "text").map((e) => [e.id, e.text]),
    [
      ["intro", "Checking"],
      ["final", "Done"],
      ["final", "Done."],
    ],
  );
  session.accept({
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  assert.ok(done());
});
test("Codex questions return the native schema and reject foreign threads", () => {
  const { session, sent, events } = interactive("codex", "thread");
  const p = {
    threadId: "thread",
    questions: [
      {
        id: "choice",
        question: "Which one?",
        options: [{ label: "A", description: "First" }],
        isOther: true,
      },
    ],
  };
  session.accept({ id: "q", method: "item/tool/requestUserInput", params: p });
  assert.ok(events.at(-1).interaction.questions[0].freeform);
  session.respond("codex:q", { answers: { choice: ["Custom answer"] } });
  assert.deepEqual(sent.at(-1).result, {
    answers: { choice: { answers: ["Custom answer"] } },
  });
  session.accept({
    id: "foreign",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "elsewhere" },
  });
  assert.ok(sent.at(-1).error);
  session.accept({
    id: "secret",
    method: "item/tool/requestUserInput",
    params: { ...p, questions: [{ ...p.questions[0], isSecret: true }] },
  });
  assert.ok(sent.at(-1).error);
});
test("Claude streaming blocks reconcile snapshots without replacing commentary", () => {
  const { session, events } = interactive("claude");
  session.accept({
    type: "stream_event",
    event: { type: "message_start", message: { id: "m1" } },
  });
  session.accept({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  session.accept({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Checking." },
    },
  });
  session.accept({
    type: "assistant",
    message: {
      id: "m1",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "README" } },
      ],
    },
  });
  session.accept({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }],
    },
  });
  session.accept({
    type: "assistant",
    message: { id: "m2", content: [{ type: "text", text: "Done." }] },
  });
  session.accept({ type: "result", result: "Done.", is_error: false });
  assert.deepEqual([...session.texts.values()], ["Checking.", "Done."]);
  assert.equal(
    events.filter((e) => e.type === "activity").at(-1).title,
    "Read",
  );
});
test("Claude AskUserQuestion and tool decisions use real control responses", () => {
  const { session, sent, events } = interactive("claude", "existing");
  session.start();
  session.accept({
    type: "control_response",
    response: { request_id: "melancholy-init", subtype: "success" },
  });
  assert.equal(sent.at(-1).session_id, "existing");
  const questions = [
    {
      question: "Which colors?",
      multiSelect: true,
      options: [{ label: "A" }, { label: "B" }],
    },
  ];
  session.accept({
    type: "control_request",
    request_id: "q",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions },
    },
  });
  assert.equal(events.at(-1).interaction.questions[0].multiple, true);
  session.respond("claude:q", { answers: { q0: ["A", "B"] } });
  assert.deepEqual(sent.at(-1).response.response, {
    behavior: "allow",
    updatedInput: { questions, answers: { "Which colors?": "A, B" } },
  });
  session.accept({
    type: "control_request",
    request_id: "t",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "npm test" },
    },
  });
  session.respond("claude:t", { decision: "decline" });
  assert.equal(sent.at(-1).response.response.behavior, "deny");
  session.accept({
    type: "control_request",
    request_id: "stale",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "sleep 1" },
    },
  });
  session.accept({ type: "control_cancel_request", request_id: "stale" });
  const before = sent.length;
  session.respond("claude:stale", { decision: "accept" });
  assert.equal(sent.length, before);
});
test("delivery collection includes explicit files and refuses symlinks, hardlinks and oversized data", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "melancholy-delivery-"));
  try {
    const root = await outputDirectory(
      cwd,
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    );
    await writeFile(join(cwd, "not-a-delivery.txt"), "private");
    await writeFile(join(root, "report.md"), "# Report");
    await writeFile(join(root, "draft.tmp"), "partial");
    assert.deepEqual(
      (await collectArtifacts(root)).map((f) => f.name),
      ["report.md"],
    );
    await symlink(join(cwd, "not-a-delivery.txt"), join(root, "linked.txt"));
    await assert.rejects(collectArtifacts(root), /Symbolic/);
    await rm(join(root, "linked.txt"));
    await link(join(cwd, "not-a-delivery.txt"), join(root, "linked.txt"));
    await assert.rejects(collectArtifacts(root), /Linked/);
    await rm(join(root, "linked.txt"));
    await writeFile(
      join(root, "large.bin"),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    );
    await assert.rejects(collectArtifacts(root), /10 MB/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interaction protocol fields survive credential redaction", () => {
  const redact = redactor({ CUSTOM_API_KEY: "a" });
  const event = redact({
    type: "interaction",
    interaction: {
      id: "q",
      kind: "approval",
      state: "pending",
      title: "a secret",
    },
  });
  assert.equal(event.interaction.kind, "approval");
  assert.equal(event.interaction.state, "pending");
  assert.equal(event.interaction.title, "[redacted] secret");
  assert.equal(
    redact({ type: "interaction_resolved", id: "q", outcome: "answered" })
      .outcome,
    "answered",
  );
});

test("Codex resume usage replay becomes a baseline, not another billable turn", () => {
  const { session, events } = interactive("codex", "thread");
  const prior = {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 5,
  };
  session.accept({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread",
      turnId: "previous",
      tokenUsage: { total: prior, last: prior },
    },
  });
  assert.equal(events.filter((e) => e.type === "usage").length, 0);
  session.accept({
    method: "turn/started",
    params: { turn: { id: "current" } },
  });
  const current = {
    inputTokens: 140,
    outputTokens: 30,
    cachedInputTokens: 110,
    cacheWriteInputTokens: 10,
  };
  const last = {
    inputTokens: 40,
    outputTokens: 10,
    cachedInputTokens: 30,
    cacheWriteInputTokens: 5,
  };
  session.accept({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread",
      turnId: "current",
      tokenUsage: { total: current, last },
    },
  });
  assert.deepEqual(events.at(-1), {
    type: "usage",
    usage: {
      inputTokens: 40,
      outputTokens: 10,
      cachedTokens: 30,
      cacheWriteTokens: 5,
    },
  });
});
