import { env } from "cloudflare:workers";
import { hash } from "./auth";
import { publish } from "./team-store";
export type Timer = {
  id: string;
  room_id: string;
  name: string;
  prompt: string;
  bot_id: string;
  created_by: string;
  interval_minutes: number;
  next_at: number;
  version: number;
};
export async function timerAuthorized(
  timer: Pick<Timer, "room_id" | "bot_id" | "created_by">,
) {
  return !!(await env.DB.prepare(
    "SELECT 1 FROM room_members h JOIN people p ON p.id=h.person_id JOIN room_members b ON b.room_id=h.room_id JOIN people bot ON bot.id=b.person_id WHERE h.room_id=? AND h.person_id=? AND p.active=1 AND p.kind='human' AND b.person_id=? AND bot.active=1 AND (bot.server_id IS NOT NULL OR bot.cloud_agent=1)",
  )
    .bind(timer.room_id, timer.created_by, timer.bot_id)
    .first());
}
export async function scheduledMessageAllowed(messageId: string) {
  const t = await env.DB.prepare(
    "SELECT t.room_id,t.bot_id,t.created_by FROM timer_runs r JOIN channel_timers t ON t.id=r.timer_id WHERE r.message_id=?",
  )
    .bind(messageId)
    .first<Timer>();
  return !t || timerAuthorized(t);
}
export async function runChannelTimers(now = Date.now(), dispatch = true) {
  const due = (
    await env.DB.prepare(
      "SELECT * FROM channel_timers WHERE enabled=1 AND deleted_at IS NULL AND next_at<=? ORDER BY next_at LIMIT 50",
    )
      .bind(now)
      .all<Timer>()
  ).results;
  for (const timer of due) {
    if (!(await timerAuthorized(timer))) {
      await env.DB.prepare(
        "UPDATE channel_timers SET enabled=0,last_error='The creator or agent no longer has channel access.',version=version+1 WHERE id=? AND version=?",
      )
        .bind(timer.id, timer.version)
        .run();
      continue;
    }
    const digest = await hash("timer:" + timer.id + ":" + timer.next_at);
    const messageId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const threadId = messageId; // Unique timer occurrence; no session shared between runs.
    const next = timer.interval_minutes
      ? timer.next_at +
        (Math.floor((now - timer.next_at) / (timer.interval_minutes * 60000)) +
          1) *
          timer.interval_minutes *
          60000
      : timer.next_at;
    const gate = `SELECT 1 FROM channel_timers t WHERE t.id=? AND t.version=? AND t.next_at=? AND t.enabled=1 AND t.deleted_at IS NULL`;
    // D1 batch is transactional: only the winner can observe this version/due time.
    const eligible =
      gate +
      ` AND NOT EXISTS(SELECT 1 FROM timer_runs prev JOIN agent_requests a ON a.message_id=prev.message_id WHERE prev.timer_id=t.id AND a.error IS NULL AND NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.parent_id=prev.message_id AND m.author_id=t.bot_id AND m.run_status IN ('completed','failed','cancelled'))) AND EXISTS(SELECT 1 FROM room_members rm JOIN people p ON p.id=rm.person_id WHERE rm.room_id=t.room_id AND p.id=t.created_by AND p.active=1) AND EXISTS(SELECT 1 FROM room_members rm JOIN people p ON p.id=rm.person_id WHERE rm.room_id=t.room_id AND p.id=t.bot_id AND p.active=1)`;
    const guard = `EXISTS(${gate}) AND EXISTS(SELECT 1 FROM timer_runs WHERE id=?)`;
    const g = [timer.id, timer.version, timer.next_at, messageId];
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO timer_runs(id,timer_id,scheduled_at,message_id,created_at) SELECT ?,?,?,?,? WHERE EXISTS(${eligible})`,
      ).bind(
        messageId,
        timer.id,
        timer.next_at,
        messageId,
        now,
        timer.id,
        timer.version,
        timer.next_at,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO chat_messages(id,room_id,author_id,text,created_at) SELECT ?,?,?,?,? WHERE ${guard}`,
      ).bind(
        messageId,
        timer.room_id,
        timer.created_by,
        `Scheduled task: ${timer.name}\n\n${timer.prompt}`,
        now,
        ...g,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO agent_threads(thread_id,room_id,root_id,bot_id) SELECT ?,?,?,? WHERE ${guard}`,
      ).bind(threadId, timer.room_id, messageId, timer.bot_id, ...g),
      env.DB.prepare(
        `INSERT OR IGNORE INTO agent_requests(message_id,bot_id,thread_id) SELECT ?,?,? WHERE ${guard}`,
      ).bind(messageId, timer.bot_id, threadId, ...g),
      env.DB.prepare(
        `INSERT OR IGNORE INTO thread_preferences(root_id,bot_id,changed_by,updated_at) SELECT ?,?,?,? WHERE ${guard}`,
      ).bind(messageId, timer.bot_id, timer.created_by, now, ...g),
      env.DB.prepare(
        `INSERT INTO chat_events(room_id,message_id,type,created_at) SELECT ?,?,'message.created',? WHERE ${guard}`,
      ).bind(timer.room_id, messageId, now, ...g),
      env.DB.prepare(
        `UPDATE channel_timers SET next_at=?,enabled=?,version=version+1,last_error=NULL WHERE id=? AND version=? AND next_at=? AND enabled=1 AND EXISTS(SELECT 1 FROM timer_runs WHERE id=?)`,
      ).bind(next, Number(timer.interval_minutes > 0), ...g),
    ]);
    if (results[0].meta.changes && dispatch) {
      await env.CHAT_DISPATCHERS.getByName(timer.room_id).kick(timer.room_id);
      await publish(timer.room_id);
    }
  }
}
