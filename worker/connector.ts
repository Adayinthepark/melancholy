import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { AgentEvent, Job } from "../lib/protocol";

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    sessionId: z.string().max(200).optional(),
  }),
  z.object({ type: z.literal("text"), text: z.string().max(500000) }),
  z.object({
    type: z.literal("activity"),
    id: z.string().max(200),
    title: z.string().max(300),
    detail: z.string().max(20000).optional(),
    status: z.string().max(30).optional(),
  }),
  z.object({
    type: z.literal("completed"),
    sessionId: z.string().max(200).optional(),
  }),
  z.object({ type: z.literal("failed"), error: z.string().max(2000) }),
  z.object({ type: z.literal("cancelled") }),
]);
const packetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    hostname: z.string().max(200),
    cwd: z.string().max(1000),
    active: z.array(z.string().uuid()).max(100),
  }),
  z.object({
    type: z.literal("event"),
    jobId: z.string().uuid(),
    seq: z.number().int().positive(),
    event: eventSchema,
  }),
]);
type StoredJob = { id: string; body: string; status: string; seq: number };

export class Connector extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL,seq INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);",
    );
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Upgrade required", { status: 426 });
    const id = request.headers.get("x-connector-id");
    if (!id) return new Response("Unauthorized", { status: 401 });
    if (this.revoked()) return new Response("Server removed", { status: 401 });
    const epoch = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO meta VALUES ('epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      epoch,
    );
    for (const ws of this.ctx.getWebSockets())
      ws.close(4001, "Connection replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ id, epoch, ready: false });
    pair[1].send(JSON.stringify({ type: "connected", protocol: 1 }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async online(): Promise<boolean> {
    if (this.revoked()) return false;
    return this.ctx
      .getWebSockets()
      .some(
        (ws) =>
          ws.readyState === WebSocket.OPEN &&
          (ws.deserializeAttachment() as { ready?: boolean })?.ready,
      );
  }
  private revoked(): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM meta WHERE key='revoked'")
        .toArray().length > 0
    );
  }
  private current(ws: WebSocket, epoch: string): boolean {
    if (this.revoked()) {
      ws.close(4003, "Server removed");
      return false;
    }
    const latest = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key='epoch'")
      .toArray()[0]?.value;
    if (epoch !== latest) {
      ws.close(4001, "Connection replaced");
      return false;
    }
    return true;
  }
  private send(data: unknown) {
    for (const ws of this.ctx.getWebSockets()) {
      if (!(ws.deserializeAttachment() as { ready?: boolean })?.ready) continue;
      try {
        ws.send(JSON.stringify(data));
      } catch {
        ws.close(1011, "Reconnect");
      }
    }
  }
  async submit(job: Job) {
    if (this.revoked()) {
      await this.env.CONVERSATIONS.getByName(job.threadId).receive(job.id, 1, {
        type: "failed",
        error: "Server removed.",
      });
      return;
    }
    const existing = this.ctx.storage.sql
      .exec<StoredJob>("SELECT * FROM jobs WHERE id=?", job.id)
      .toArray()[0];
    if (existing) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO jobs VALUES (?,?,'queued',0)",
      job.id,
      JSON.stringify(job),
    );
    this.send({ type: "run", job });
  }
  async cancel(id: string, job: Job) {
    this.ctx.storage.sql.exec(
      "INSERT INTO jobs VALUES (?,?,'cancelled',0) ON CONFLICT(id) DO UPDATE SET status='cancelled'",
      id,
      JSON.stringify(job),
    );
    this.send({ type: "cancel", jobId: id });
  }
  async revoke() {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO meta VALUES ('revoked','1')",
    );
    for (const ws of this.ctx.getWebSockets()) ws.close(4003, "Server removed");
    const jobs = this.ctx.storage.sql
      .exec<StoredJob>(
        "SELECT * FROM jobs WHERE status IN ('queued','running')",
      )
      .toArray();
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status='failed' WHERE status IN ('queued','running')",
    );
    for (const row of jobs) {
      const job = JSON.parse(row.body) as Job;
      await this.env.CONVERSATIONS.getByName(job.threadId).receive(
        job.id,
        row.seq + 1,
        { type: "failed", error: "Server removed." },
      );
    }
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > 550000) {
      ws.close(1009, "Message too large");
      return;
    }
    const attachment = ws.deserializeAttachment() as {
      id: string;
      epoch: string;
      ready: boolean;
    };
    if (!this.current(ws, attachment.epoch)) return;
    let packet: z.infer<typeof packetSchema>;
    try {
      packet = packetSchema.parse(JSON.parse(raw));
    } catch {
      ws.close(1008, "Invalid protocol message");
      return;
    }
    if (packet.type === "hello") {
      if (attachment.ready) {
        ws.close(1008, "Already connected");
        return;
      }
      const updated = await this.env.DB.prepare(
        "UPDATE servers SET hostname=?,cwd=? WHERE id=?",
      )
        .bind(packet.hostname, packet.cwd, attachment.id)
        .run();
      if (!this.current(ws, attachment.epoch)) return;
      if (!updated.meta.changes) {
        await this.revoke();
        return;
      }
      attachment.ready = true;
      ws.serializeAttachment(attachment);
      const jobs = this.ctx.storage.sql
        .exec<StoredJob>(
          "SELECT * FROM jobs WHERE status IN ('queued','running','cancelled')",
        )
        .toArray();
      for (const row of jobs) {
        if (!this.current(ws, attachment.epoch)) return;
        const job = JSON.parse(row.body) as Job;
        if (row.status === "queued")
          ws.send(JSON.stringify({ type: "run", job }));
        else if (row.status === "cancelled" && packet.active.includes(job.id))
          ws.send(JSON.stringify({ type: "cancel", jobId: job.id }));
        else if (row.status === "running" && !packet.active.includes(job.id)) {
          await this.env.CONVERSATIONS.getByName(job.threadId).receive(
            job.id,
            row.seq + 1,
            {
              type: "failed",
              error:
                "Connector restarted during this turn. Send a new message to continue.",
            },
          );
          this.ctx.storage.sql.exec(
            "UPDATE jobs SET status='failed' WHERE id=? AND status='running'",
            job.id,
          );
        }
      }
      if (!this.current(ws, attachment.epoch)) return;
      ws.send(JSON.stringify({ type: "ready" }));
      return;
    }
    if (!attachment.ready) {
      ws.close(1008, "Send hello first");
      return;
    }
    const row = this.ctx.storage.sql
      .exec<StoredJob>("SELECT * FROM jobs WHERE id=?", packet.jobId)
      .toArray()[0];
    if (!row) {
      ws.close(1008, "Unknown job");
      return;
    }
    if (packet.seq > row.seq && ["queued", "running"].includes(row.status)) {
      const job = JSON.parse(row.body) as Job;
      await this.env.CONVERSATIONS.getByName(job.threadId).receive(
        job.id,
        packet.seq,
        packet.event as AgentEvent,
      );
      if (!this.current(ws, attachment.epoch)) return;
      const status =
        packet.event.type === "started"
          ? "running"
          : ["completed", "failed", "cancelled"].includes(packet.event.type)
            ? packet.event.type
            : row.status;
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET seq=MAX(seq,?),status=? WHERE id=? AND status IN ('queued','running')",
        packet.seq,
        status,
        job.id,
      );
    }
    ws.send(
      JSON.stringify({ type: "ack", jobId: packet.jobId, seq: packet.seq }),
    );
  }
  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code);
  }
}
