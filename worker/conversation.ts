import { DurableObject } from "cloudflare:workers";
import { publish } from "./team-store";
import type {
  Activity,
  AgentEvent,
  Attachment,
  ChatMessage,
  Job,
  Run,
  Runtime,
  TokenUsage,
} from "../lib/protocol";

type StoredMessage = Omit<ChatMessage, "attachments"> & { attachments: string };
type StoredRun = Run & { job: string; dispatched: number; event_seq: number };
const terminal = new Set(["completed", "failed", "cancelled"]);

export class Conversation extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, runtime TEXT, run_id TEXT, attachments TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, server_id TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, error TEXT, created_at INTEGER NOT NULL, job TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, event_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      DROP TABLE IF EXISTS dirty;
      CREATE TABLE IF NOT EXISTS chat_dirty (run_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS usage (run_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_dirty (run_id TEXT PRIMARY KEY);
    `);
    for (const ws of ctx.getWebSockets()) ws.close(1001, "Endpoint removed");
  }

  private getMeta(key: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM metadata WHERE key=?", key)
        .toArray()[0]?.value ?? null
    );
  }
  private setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
  }
  canExecute(runId: string, serverId: string) {
    return !!this.ctx.storage.sql
      .exec(
        "SELECT 1 FROM runs WHERE id=? AND server_id=? AND status IN ('queued','running')",
        runId,
        serverId,
      )
      .toArray().length;
  }
  async send(input: {
    threadId: string;
    serverId: string;
    runtime: Runtime;
    text: string;
    id: string;
    attachments: Attachment[];
    context?: string;
    chat: { roomId: string; botId: string; parentId: string | null };
  }): Promise<{ id: string; duplicate: boolean; error?: string }> {
    if (
      !input.chat ||
      !(await this.env.DB.prepare(
        "SELECT 1 FROM agent_threads WHERE thread_id=? AND room_id=? AND bot_id=?",
      )
        .bind(input.threadId, input.chat.roomId, input.chat.botId)
        .first())
    )
      return {
        id: "",
        duplicate: false,
        error: "Agent conversation not found.",
      };
    const existing = this.ctx.storage.sql
      .exec<{ run_id: string }>(
        "SELECT run_id FROM messages WHERE id=?",
        input.id,
      )
      .toArray()[0];
    if (existing) return { id: existing.run_id, duplicate: true };
    if (
      this.ctx.storage.sql
        .exec(
          "SELECT id FROM runs WHERE status IN ('queued','running') LIMIT 1",
        )
        .toArray().length
    )
      return {
        id: "",
        duplicate: false,
        error: "A turn is already running. Stop it before sending another.",
      };
    const last =
      this.ctx.storage.sql
        .exec<{ created_at: number }>(
          "SELECT MAX(created_at) AS created_at FROM messages",
        )
        .toArray()[0]?.created_at ?? 0;
    const now = Math.max(Date.now(), last + 1);
    const runId = crypto.randomUUID();
    const prior = this.ctx.storage.sql
      .exec<{ session_id: string }>(
        "SELECT session_id FROM runs WHERE server_id=? AND runtime=? AND session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        input.serverId,
        input.runtime,
      )
      .toArray()[0];
    const job: Job = {
      id: runId,
      threadId: input.threadId,
      prompt: input.text + (input.context || ""),
      runtime: input.runtime,
      sessionId: prior?.session_id ?? null,
      attachments: input.attachments,
    };
    this.ctx.storage.transactionSync(() => {
      this.setMeta("threadId", input.threadId);
      if (input.chat) {
        this.setMeta("chat", JSON.stringify(input.chat));
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO chat_dirty VALUES (?)",
          runId,
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?)",
        input.id,
        "user",
        input.text,
        now,
        null,
        runId,
        JSON.stringify(input.attachments),
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?)",
        crypto.randomUUID(),
        "assistant",
        "",
        now + 1,
        input.runtime,
        runId,
        "[]",
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO runs (id,server_id,runtime,status,session_id,error,created_at,job) VALUES (?,?,?,'queued',NULL,NULL,?,?)",
        runId,
        input.serverId,
        input.runtime,
        now,
        JSON.stringify(job),
      );
    });
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    if (input.chat) {
      try {
        await this.syncChat(runId);
      } catch {
        /* Alarm retries the projection. */
      }
    }
    // An alarm retries dispatch if the process stops between commit and delivery.
    try {
      await this.dispatch();
    } catch {
      /* The durable outbox owns the retry. */
    }
    return { id: runId, duplicate: false };
  }
  private async dispatch() {
    const pending = this.ctx.storage.sql
      .exec<StoredRun>(
        "SELECT * FROM runs WHERE dispatched=0 AND status='queued'",
      )
      .toArray();
    for (const run of pending) {
      await this.env.CONNECTORS.getByName(run.server_id).submit(
        JSON.parse(run.job) as Job,
      );
      this.ctx.storage.sql.exec(
        "UPDATE runs SET dispatched=1 WHERE id=?",
        run.id,
      );
    }
  }
  async receive(runId: string, seq: number, event: AgentEvent) {
    const run = this.ctx.storage.sql
      .exec<StoredRun>("SELECT * FROM runs WHERE id=?", runId)
      .toArray()[0];
    if (!run || seq <= run.event_seq || terminal.has(run.status)) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE runs SET event_seq=? WHERE id=?",
        seq,
        runId,
      );
      if (event.type === "usage") {
        this.ctx.storage.sql.exec(
          "INSERT INTO usage VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data",
          runId,
          JSON.stringify(event.usage),
        );
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO usage_dirty VALUES (?)",
          runId,
        );
      }
      if (event.type === "started")
        this.ctx.storage.sql.exec(
          "UPDATE runs SET status='running',session_id=COALESCE(?,session_id) WHERE id=?",
          event.sessionId ?? null,
          runId,
        );
      if (event.type === "text")
        this.ctx.storage.sql.exec(
          "UPDATE messages SET text=? WHERE run_id=? AND role='assistant'",
          event.text.slice(0, 500000),
          runId,
        );
      if (event.type === "activity")
        this.ctx.storage.sql.exec(
          "INSERT INTO activity VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,detail=excluded.detail,status=excluded.status",
          `${runId}:${event.id}`,
          runId,
          "tool",
          event.title.slice(0, 300),
          (event.detail ?? "").slice(0, 20000),
          event.status ?? "running",
          Date.now(),
        );
      if (event.type === "completed")
        this.ctx.storage.sql.exec(
          "UPDATE runs SET status='completed',session_id=COALESCE(?,session_id) WHERE id=?",
          event.sessionId ?? null,
          runId,
        );
      if (event.type === "failed")
        this.ctx.storage.sql.exec(
          "UPDATE runs SET status='failed',error=? WHERE id=?",
          event.error.slice(0, 2000),
          runId,
        );
      if (event.type === "cancelled")
        this.ctx.storage.sql.exec(
          "UPDATE runs SET status='cancelled' WHERE id=?",
          runId,
        );
      if (this.getMeta("chat"))
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO chat_dirty VALUES (?)",
          runId,
        );
    });
    if (
      terminal.has(event.type) ||
      event.type === "usage" ||
      this.getMeta("chat")
    )
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    if (event.type === "usage") {
      try {
        await this.syncUsage(runId);
      } catch {
        /* Durable alarm retries. */
      }
    }
    if (this.getMeta("chat")) {
      try {
        await this.syncChat(runId);
      } catch {
        /* Alarm retries the projection. */
      }
    }
  }
  private async syncUsage(runId: string) {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM usage WHERE run_id=?", runId)
      .toArray()[0];
    const run = this.ctx.storage.sql
      .exec<StoredRun>("SELECT * FROM runs WHERE id=?", runId)
      .toArray()[0];
    if (!row || !run) return;
    const usage = JSON.parse(row.data) as TokenUsage;
    const chat = this.getMeta("chat")
      ? (JSON.parse(this.getMeta("chat")!) as {
          roomId: string;
          parentId: string | null;
        })
      : null;
    await this.env.DB.prepare(
      `INSERT INTO agent_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,cache_write_tokens=excluded.cache_write_tokens,cost_usd=excluded.cost_usd,model=excluded.model,reported_at=excluded.reported_at,event_seq=excluded.event_seq WHERE excluded.event_seq>agent_usage.event_seq`,
    )
      .bind(
        runId,
        run.server_id,
        chat?.roomId || null,
        chat?.parentId || chat?.roomId || null,
        this.getMeta("threadId"),
        run.runtime,
        usage.model || null,
        usage.inputTokens,
        usage.outputTokens,
        usage.cachedTokens,
        usage.cacheWriteTokens,
        usage.costUsd ?? null,
        Date.now(),
        run.event_seq,
      )
      .run();
    this.ctx.storage.sql.exec(
      "DELETE FROM usage_dirty WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND event_seq=?)",
      runId,
      runId,
      run.event_seq,
    );
  }
  private async syncChat(runId: string) {
    const meta = this.getMeta("chat");
    if (!meta) return;
    const chat = JSON.parse(meta) as {
      roomId: string;
      botId: string;
      parentId: string | null;
    };
    const run = this.ctx.storage.sql
      .exec<StoredRun>("SELECT * FROM runs WHERE id=?", runId)
      .toArray()[0];
    const message = this.ctx.storage.sql
      .exec<StoredMessage>(
        "SELECT * FROM messages WHERE run_id=? AND role='assistant'",
        runId,
      )
      .toArray()[0];
    if (!run || !message) return;
    const activity = this.ctx.storage.sql
      .exec<Activity>(
        "SELECT * FROM activity WHERE run_id=? ORDER BY created_at LIMIT 100",
        runId,
      )
      .toArray();
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO chat_events(room_id,message_id,type,created_at) SELECT ?,?,'message.updated',? WHERE NOT EXISTS(SELECT 1 FROM chat_messages WHERE id=? AND event_seq>=?)",
      ).bind(chat.roomId, message.id, Date.now(), message.id, run.event_seq),
      this.env.DB.prepare(
        `INSERT INTO chat_messages(id,room_id,parent_id,author_id,text,created_at,run_id,run_status,run_error,event_seq,activity) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,run_status=excluded.run_status,run_error=excluded.run_error,event_seq=excluded.event_seq,activity=excluded.activity WHERE chat_messages.event_seq<excluded.event_seq AND chat_messages.deleted_at IS NULL`,
      ).bind(
        message.id,
        chat.roomId,
        chat.parentId,
        chat.botId,
        message.text,
        message.created_at,
        runId,
        run.status,
        run.error,
        run.event_seq,
        JSON.stringify(activity),
      ),
    ]);
    this.ctx.storage.sql.exec(
      "DELETE FROM chat_dirty WHERE run_id=? AND EXISTS(SELECT 1 FROM runs WHERE id=? AND event_seq=?)",
      runId,
      runId,
      run.event_seq,
    );
    await publish(chat.roomId);
  }
  async cancel() {
    const run = this.ctx.storage.sql
      .exec<StoredRun>(
        "SELECT * FROM runs WHERE status IN ('queued','running') LIMIT 1",
      )
      .toArray()[0];
    if (!run) return;
    // Cancel in the relay even when the initial room-to-relay dispatch is still in flight.
    await this.env.CONNECTORS.getByName(run.server_id).cancel(
      run.id,
      JSON.parse(run.job) as Job,
    );
    await this.receive(run.id, run.event_seq + 1, { type: "cancelled" });
  }
  async alarm() {
    try {
      await this.dispatch();
      for (const row of this.ctx.storage.sql
        .exec<{ run_id: string }>("SELECT run_id FROM usage_dirty")
        .toArray())
        await this.syncUsage(row.run_id);
      for (const row of this.ctx.storage.sql
        .exec<{ run_id: string }>("SELECT run_id FROM chat_dirty")
        .toArray())
        await this.syncChat(row.run_id);
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 10000);
    }
  }
}
