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
