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
