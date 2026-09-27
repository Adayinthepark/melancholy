#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir, hostname } from "node:os";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { commandFor, OutputParser } from "./adapters.mjs";
import { killTree } from "./process.mjs";

const { values: flags } = parseArgs({
  options: {
    url: { type: "string" },
    runtime: { type: "string" },
    cwd: { type: "string" },
    config: { type: "string" },
    permission: { type: "string" },
    "state-dir": { type: "string" },
    timeout: { type: "string", default: "900" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (flags.help) {
  console.log(
    `melancholy connector\n\n  node packages/connector/bin.mjs --url https://async.love --runtime codex --cwd /path/to/project\n\n  MELANCHOLY_TOKEN     Server token from workspace settings\n  --config <file>     JSON with url, token, runtime, cwd and optional permission\n  --permission       read-only (default), workspace-write, or inherit\n  --timeout          Maximum turn duration in seconds (default 900)\n  --state-dir        Directory for the durable delivery journal\n\nExisting CLI authentication and model settings are used. No inbound port is opened.`,
  );
  process.exit(0);
}
let config = {};
if (flags.config)
  config = JSON.parse(readFileSync(resolve(flags.config), "utf8"));
const base = new URL(flags.url || config.url || "https://async.love");
if (
  base.protocol !== "https:" &&
  !(
    base.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
)
  throw new Error("Use HTTPS for remote workspaces.");
const token = process.env.MELANCHOLY_TOKEN || config.token;
if (!token || !/^[a-f0-9]{64}$/.test(token))
  throw new Error(
    "Set MELANCHOLY_TOKEN to the server token from workspace settings.",
  );
const runtime = flags.runtime || config.runtime || "codex";
const permission = flags.permission || config.permission || "read-only";
commandFor(runtime, null, permission);
const cwd = realpathSync(resolve(flags.cwd || config.cwd || process.cwd()));
const timeout = Number(flags.timeout);
if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86400)
  throw new Error("Timeout must be between 1 and 86400 seconds.");
const namespace = createHash("sha256")
  .update(base.origin + token)
  .digest("hex")
  .slice(0, 20);
const stateDir = resolve(
  flags["state-dir"] ||
    join(homedir(), ".local", "state", "melancholy", namespace),
);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700);
const journal = join(stateDir, "delivery.json");
const state = existsSync(journal)
  ? JSON.parse(readFileSync(journal, "utf8"))
  : { jobs: {}, outbox: [] };
const save = () => {
  writeFileSync(journal + ".tmp", JSON.stringify(state), { mode: 0o600 });
  renameSync(journal + ".tmp", journal);
};
let ws = null,
  ready = false,
  stopping = false,
  sending = null,
  reconnectTimer = null;
const processes = new Map();
const waiting = [];
let workerBusy = false;
const ackWaiters = new Map();
function pump() {
  if (
    !ready ||
    !ws ||
    ws.readyState !== WebSocket.OPEN ||
    sending ||
    !state.outbox.length
  )
    return;
  sending = state.outbox[0];
  ws.send(JSON.stringify(sending));
}
function emit(jobId, event) {
  const job = state.jobs[jobId];
  job.seq = (job.seq || 0) + 1;
  const packet = { type: "event", jobId, seq: job.seq, event };
  state.outbox.push(packet);
  save();
  pump();
  return new Promise((resolve) =>
    ackWaiters.set(`${jobId}:${packet.seq}`, resolve),
  );
}
// A restarted process cannot prove whether a previous CLI turn finished.
// Fail it explicitly; never execute a persisted job a second time.
for (const job of Object.values(state.jobs))
  if (["running", "accepted"].includes(job.status)) {
    job.status = "failed";
    job.seq = (job.seq || 0) + 1;
    state.outbox.push({
      type: "event",
      jobId: job.id,
      seq: job.seq,
      event: {
        type: "failed",
        error:
          "Connector restarted during this turn. Send a new message to continue.",
      },
    });
  }
save();

async function download(job) {
  const dir = join(stateDir, "attachments", job.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = [];
  for (const file of job.attachments || []) {
    if (!/^[a-f0-9-]{36}$/.test(file.id))
      throw new Error("Invalid attachment ID.");
    const response = await fetch(new URL(`/api/files/${file.id}`, base), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`Attachment download failed (${response.status}).`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > 10 * 1024 * 1024)
      throw new Error("Attachment exceeds 10 MB.");
    const name =
      file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "attachment";
    const path = join(dir, `${file.id}-${name}`);
    writeFileSync(path, data, { mode: 0o600 });
    paths.push(path);
  }
  return paths;
}
async function run(job) {
  const record = state.jobs[job.id];
  if (record.status === "cancelled") return;
  record.status = "running";
  save();
  try {
    await emit(job.id, { type: "started" });
    if (record.status === "cancelled") return;
    const files = await download(job);
    if (record.status === "cancelled" || stopping) return;
    const { command, args } = commandFor(runtime, job.sessionId, permission);
    // Connector credentials never enter the agent's environment.
    const childEnv = { ...process.env };
    delete childEnv.MELANCHOLY_TOKEN;
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    processes.set(job.id, child);
    let stderr = "",
      latestText = null,
      flushTimer = null;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (latestText !== null) {
        const text = latestText;
        latestText = null;
        void emit(job.id, { type: "text", text: text.slice(0, 500000) });
      }
    };
    const parser = new OutputParser(runtime, (event) => {
      if (event.type === "text") {
        latestText = event.text;
        if (!flushTimer) flushTimer = setTimeout(flush, 250);
      } else {
        flush();
        void emit(job.id, event);
      }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        parser.accept(JSON.parse(line));
      } catch {
        /* Non-protocol CLI output is ignored. */
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout * 1000);
    const result = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    const prompt =
      job.prompt +
      (files.length
        ? `\n\nAttached files (local paths):\n${files.join("\n")}`
        : "");
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    let code;
    try {
      code = await result;
    } finally {
      clearTimeout(timer);
      flush();
      processes.delete(job.id);
      lines.close();
    }
    if (record.status === "cancelled")
      await emit(job.id, { type: "cancelled" });
    else if (timedOut) {
      record.status = "failed";
      await emit(job.id, {
        type: "failed",
        error: `Turn exceeded ${timeout} seconds.`,
      });
    } else if (code !== 0 || parser.error) {
      record.status = "failed";
      await emit(job.id, {
        type: "failed",
        error: (
          parser.error ||
          stderr ||
          `${runtime} exited with code ${code}.`
        ).slice(-2000),
      });
    } else {
      record.status = "completed";
      await emit(job.id, {
        type: "completed",
        ...(parser.sessionId ? { sessionId: parser.sessionId } : {}),
      });
    }
    save();
    console.log(`${job.id} ${record.status}`);
  } catch (error) {
    record.status = "failed";
    save();
    await emit(job.id, {
      type: "failed",
      error: String(error.message || error).slice(0, 2000),
    });
  }
}
async function schedule() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    while (waiting.length && !stopping) await run(waiting.shift());
  } finally {
    workerBusy = false;
  }
}
function connect() {
  const endpoint = new URL("/api/connector", base);
  endpoint.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    maxPayload: 1024 * 1024,
  });
  ws.on("open", () => {
    const active = Object.values(state.jobs)
      .filter(
        (j) =>
          ["running", "accepted"].includes(j.status) ||
          state.outbox.some((e) => e.jobId === j.id),
      )
      .map((j) => j.id);
    ws.send(
      JSON.stringify({ type: "hello", hostname: hostname(), cwd, active }),
    );
  });
  ws.on("message", (raw) => {
    if (raw.toString() === "pong") return;
    let packet;
    try {
      packet = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (packet.type === "ready") {
      ready = true;
      console.log(`Connected to ${base.origin} (${runtime}, ${cwd})`);
      pump();
    }
    if (packet.type === "ack") {
      const first = state.outbox[0];
      if (first?.jobId === packet.jobId && first.seq === packet.seq) {
        state.outbox.shift();
        sending = null;
        save();
        ackWaiters.get(`${packet.jobId}:${packet.seq}`)?.();
        ackWaiters.delete(`${packet.jobId}:${packet.seq}`);
        pump();
      }
    }
    if (packet.type === "run") {
      const job = packet.job;
      if (
        !job ||
        typeof job.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(job.id) ||
        state.jobs[job.id]
      )
        return;
      state.jobs[job.id] = { id: job.id, status: "accepted", seq: 0 };
      save();
      if (job.runtime !== runtime) {
        state.jobs[job.id].status = "failed";
        void emit(job.id, {
          type: "failed",
          error: `Server is configured for ${runtime}, not ${job.runtime}.`,
        });
        return;
      }
      waiting.push(job);
      void schedule();
    }
    if (packet.type === "cancel") {
      const record = state.jobs[packet.jobId];
      if (record) {
        record.status = "cancelled";
        save();
        const child = processes.get(packet.jobId);
        if (child) killTree(child);
        else void emit(packet.jobId, { type: "cancelled" });
      }
    }
  });
  ws.on("error", () => {
    console.error("Connection unavailable. Retrying.");
  });
  ws.on("close", (code) => {
    ready = false;
    sending = null;
    if ([4001, 4003].includes(code)) {
      console.error(
        code === 4003
          ? "Server token revoked."
          : "Another connector replaced this connection.",
      );
      shutdown();
      return;
    }
    if (!stopping) reconnectTimer = setTimeout(connect, 3000);
  });
}
const heartbeat = setInterval(() => {
  if (ready && ws?.readyState === WebSocket.OPEN) ws.send("ping");
}, 25000);
function shutdown() {
  if (stopping) return;
  stopping = true;
  ready = false;
  clearInterval(heartbeat);
  clearTimeout(reconnectTimer);
  for (const child of processes.values()) killTree(child);
  save();
  ws?.close();
  setTimeout(() => process.exit(0), 6000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
connect();
