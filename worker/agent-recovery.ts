// Recover committed requests if a Worker stopped before notifying its dispatcher.
export async function recoverAgentRequests(env: Cloudflare.Env) {
  const pending = await env.DB.prepare(
    "SELECT DISTINCT t.room_id FROM agent_requests a JOIN agent_threads t ON t.thread_id=a.thread_id WHERE a.dispatched=0 LIMIT 100",
  ).all<{ room_id: string }>();
  const results = await Promise.allSettled(
    pending.results.map(({ room_id }) =>
      env.CHAT_DISPATCHERS.getByName(room_id).kick(room_id),
    ),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed)
    throw new Error(
      `Agent dispatch recovery failed for ${failed} conversations`,
    );
}
