import { DurableObject } from "cloudflare:workers";
import type { Runtime, Attachment } from "../lib/protocol";
import { publish } from "./team-store";
export class ChatDispatcher extends DurableObject<Cloudflare.Env> {
  private flushing = false;
  async kick(roomId: string) {
    await this.ctx.storage.put("roomId", roomId);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    await this.flush(roomId);
  }
  private async flush(roomId: string) {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const rows = await this.env.DB.prepare(
        `SELECT a.message_id,a.bot_id,a.thread_id,m.text,m.parent_id,m.attachments,m.deleted_at,p.server_id,s.runtime,t.root_id FROM agent_requests a JOIN chat_messages m ON m.id=a.message_id JOIN people p ON p.id=a.bot_id LEFT JOIN servers s ON s.id=p.server_id JOIN agent_threads t ON t.thread_id=a.thread_id WHERE t.room_id=? AND a.dispatched=0 ORDER BY m.seq LIMIT 20`,
      )
        .bind(roomId)
        .all<{
          message_id: string;
          bot_id: string;
          thread_id: string;
          text: string;
          parent_id: string | null;
          attachments: string;
          deleted_at: number | null;
          server_id: string | null;
          runtime: Runtime;
          root_id: string;
        }>();
      for (const row of rows.results) {
        const allowed = await this.env.DB.prepare(
          "SELECT 1 FROM room_members m JOIN people p ON p.id=m.person_id WHERE m.room_id=? AND p.id=? AND p.active=1",
        )
          .bind(roomId, row.bot_id)
          .first();
        if (!row.server_id || !allowed || row.deleted_at) {
          await this.finish(row, "Bot is unavailable.");
          continue;
        }
        const room = await this.env.DB.prepare(
          "SELECT kind FROM rooms WHERE id=?",
        )
          .bind(roomId)
          .first<{ kind: string }>();
        const result = await this.env.CONVERSATIONS.getByName(
          row.thread_id,
        ).send({
          threadId: row.thread_id,
          serverId: row.server_id,
          runtime: row.runtime,
          text: row.text,
          id: row.message_id,
          attachments: JSON.parse(row.attachments) as Attachment[],
          chat: {
            roomId,
            botId: row.bot_id,
            parentId: room?.kind === "dm" ? null : row.root_id,
          },
        });
        if (result.error) continue;
        await this.finish(row, null);
      }
    } finally {
      this.flushing = false;
    }
  }
  private async finish(
    row: { message_id: string; bot_id: string },
    error: string | null,
  ) {
    await this.env.DB.prepare(
      "UPDATE agent_requests SET dispatched=1,error=? WHERE message_id=? AND bot_id=?",
    )
      .bind(error, row.message_id, row.bot_id)
      .run();
  }
  async alarm() {
    const roomId = await this.ctx.storage.get<string>("roomId");
    if (!roomId) return;
    try {
      await this.flush(roomId);
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }
    const pending = await this.env.DB.prepare(
      "SELECT 1 FROM agent_requests a JOIN agent_threads t ON t.thread_id=a.thread_id WHERE t.room_id=? AND a.dispatched=0 LIMIT 1",
    )
      .bind(roomId)
      .first();
    if (pending) await this.ctx.storage.setAlarm(Date.now() + 3000);
    await publish(roomId);
  }
}
