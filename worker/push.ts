import { buildPushPayload } from "@block65/webcrypto-web-push";
import { z } from "zod";
import { ChatError, type Identity } from "./team-auth";

const DAY = 86400000;
type Subscription = {
  id: string;
  person_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
export function pushConfigured(env: Cloudflare.Env) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}
export function allowedPushEndpoint(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      (u.hostname === "fcm.googleapis.com" ||
        // Chromium's non-stable channel endpoint (push_messaging_constants.cc).
        (u.hostname === "jmt17.google.com" &&
          u.pathname.startsWith("/fcm/send/")) ||
        /^[a-z0-9-]+\.push\.services\.mozilla\.com$/.test(u.hostname) ||
        /^[a-z0-9.-]+\.push\.apple\.com$/.test(u.hostname))
    );
  } catch {
    return false;
  }
}
export function decodeKey(value: string) {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}

// Appended to the message/projection transaction, after mentions are stored.
// Each subscription/message pair is retained for deduplication, including retries.
export function queuePush(db: D1Database, messageId: string) {
  const now = Date.now();
  return db
    .prepare(
      `INSERT OR IGNORE INTO push_deliveries(subscription_id,message_id,created_at)
    SELECT s.id,m.id,? FROM chat_messages m
    JOIN rooms r ON r.id=m.room_id
    JOIN room_members rm ON rm.room_id=m.room_id
    JOIN people p ON p.id=rm.person_id AND p.active=1 AND p.kind='human'
    JOIN push_subscriptions s ON s.person_id=p.id
    JOIN sessions login ON login.token_hash=s.session_hash AND login.person_id=p.id AND login.expires_at>?
    WHERE m.id=? AND m.deleted_at IS NULL AND m.author_id<>p.id AND m.created_at>?
    AND (m.run_id IS NULL OR m.run_status IN ('completed','failed','cancelled'))
    AND (r.kind IN ('dm','group')
      OR EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.person_id=p.id)
      OR (m.parent_id IS NOT NULL AND EXISTS(SELECT 1 FROM chat_messages prior
        WHERE prior.room_id=m.room_id AND (prior.id=m.parent_id OR prior.parent_id=m.parent_id)
        AND prior.author_id=p.id AND prior.deleted_at IS NULL)))`,
    )
    .bind(now, now, messageId, now - DAY);
}

async function transmit(
  env: Cloudflare.Env,
  subscription: Subscription,
  data: Record<string, string>,
) {
  if (!allowedPushEndpoint(subscription.endpoint)) return 400;
  const payload = await buildPushPayload(
    { data, options: { ttl: 3600, urgency: "normal", topic: data.tag } },
    {
      endpoint: subscription.endpoint,
      expirationTime: null,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
  );
  const response = await fetch(subscription.endpoint, {
    ...payload,
    // Workers supports manual/follow, not redirect:error. 3xx is permanent failure.
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    console.warn(
      JSON.stringify({
        event: "push_provider_rejected",
        status: response.status,
      }),
    );
  await response.body?.cancel();
  return response.status;
}

export async function drainPush(env: Cloudflare.Env) {
  if (!pushConfigured(env)) return;
  const now = Date.now(),
    lease = crypto.randomUUID();
  // Atomic claims allow requests, DO projections and Cron recovery to overlap.
  const claimed = await env.DB.prepare(
    `UPDATE push_deliveries SET lease=?,next_at=?,attempts=attempts+1
    WHERE id IN (SELECT id FROM push_deliveries WHERE state='pending' AND next_at<=? ORDER BY id LIMIT 10)
    RETURNING id,subscription_id,message_id,created_at,attempts`,
  )
    .bind(lease, now + 120000, now)
    .all<{
      id: number;
      subscription_id: string;
      message_id: string;
      created_at: number;
      attempts: number;
    }>();
  for (let offset = 0; offset < claimed.results.length; offset += 5) {
    await Promise.all(
      claimed.results.slice(offset, offset + 5).map(async (item) => {
        let state = "skipped",
          next = 0;
        try {
          // Recheck access, session, deletion and read position immediately before delivery.
          const target = await env.DB.prepare(
            `SELECT s.*,m.room_id,m.parent_id,m.run_status,m.run_id
          FROM push_subscriptions s JOIN sessions login ON login.token_hash=s.session_hash AND login.person_id=s.person_id
          JOIN people p ON p.id=s.person_id AND p.active=1
          JOIN chat_messages m ON m.id=? AND m.deleted_at IS NULL
          JOIN room_members rm ON rm.room_id=m.room_id AND rm.person_id=s.person_id
          WHERE s.id=? AND login.expires_at>? AND (m.run_id IS NOT NULL OR m.seq>COALESCE(
            (SELECT last_seq FROM room_reads WHERE room_id=m.room_id AND person_id=s.person_id),0))`,
          )
            .bind(item.message_id, item.subscription_id, now)
            .first<
              Subscription & {
                room_id: string;
                parent_id: string | null;
                run_status: string | null;
                run_id: string | null;
              }
            >();
          if (target && item.created_at > now - DAY && item.attempts <= 6) {
            const status = await transmit(env, target, {
              title: env.WORKSPACE_NAME || "melancholy",
              body: target.run_id
                ? target.run_status === "completed"
                  ? "Agent task completed."
                  : target.run_status === "cancelled"
                    ? "Agent task stopped."
                    : "Agent task failed."
                : "You have a new message.",
              url: target.parent_id
                ? "/thread/" + target.parent_id
                : "/?room=" + encodeURIComponent(target.room_id),
              tag: "message-" + item.id,
            });
            if (status === 404 || status === 410) {
              await env.DB.prepare("DELETE FROM push_subscriptions WHERE id=?")
                .bind(target.id)
                .run();
              return;
            }
            state =
              status >= 200 && status < 300
                ? "sent"
                : status === 408 || status === 429 || status >= 500
                  ? "pending"
                  : "dead";
          }
        } catch {
          // Never log subscription endpoints, keys, payloads or provider bodies.
          state = "pending";
        }
        if (state === "pending") {
          if (item.attempts >= 6 || item.created_at <= now - DAY)
            state = "dead";
          else next = now + Math.min(3600000, 30000 * 2 ** item.attempts);
        }
        await env.DB.prepare(
          "UPDATE push_deliveries SET state=?,next_at=?,lease=NULL WHERE id=? AND lease=?",
        )
          .bind(state, next, item.id, lease)
          .run();
      }),
    );
  }
}

export async function maintainPush(env: Cloudflare.Env) {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM push_subscriptions WHERE session_hash NOT IN (SELECT token_hash FROM sessions WHERE expires_at>?) OR person_id NOT IN (SELECT id FROM people WHERE active=1)",
    ).bind(Date.now()),
    env.DB.prepare("DELETE FROM push_deliveries WHERE created_at<?").bind(
      Date.now() - 7 * DAY,
    ),
  ]);
  await drainPush(env);
}

export async function handlePush(
  request: Request,
  env: Cloudflare.Env,
  who: Identity,
  readBody: () => Promise<unknown>,
) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/push/")) return null;
  if (!who.sessionHash || who.kind !== "human")
    throw new ChatError(403, "Sign in as a member.");
  if (path === "/api/push/status" && request.method === "GET") {
    const subscriptions = await env.DB.prepare(
      "SELECT id FROM push_subscriptions WHERE session_hash=? AND person_id=?",
    )
      .bind(who.sessionHash, who.id)
      .all<{ id: string }>();
    return json({
      configured: pushConfigured(env),
      publicKey: env.VAPID_PUBLIC_KEY || null,
      subscriptions: subscriptions.results,
    });
  }
  if (path === "/api/push/subscriptions" && request.method === "POST") {
    if (!pushConfigured(env))
      throw new ChatError(
        503,
        "Push notifications are not configured on this workspace.",
      );
    const input = z
      .object({
        endpoint: z
          .string()
          .max(2048)
          .refine(allowedPushEndpoint, "Unsupported push service."),
        keys: z.object({
          p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
          auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
        }),
      })
      .parse(await readBody());
    try {
      await crypto.subtle.importKey(
        "raw",
        decodeKey(input.keys.p256dh),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
    } catch {
      throw new ChatError(400, "Invalid subscription key.");
    }
    const existing = await env.DB.prepare(
      "SELECT id,person_id FROM push_subscriptions WHERE endpoint=?",
    )
      .bind(input.endpoint)
      .first<{ id: string; person_id: string }>();
    if (existing && existing.person_id !== who.id)
      throw new ChatError(
        409,
        "This browser subscription belongs to another account. Disable it before switching accounts.",
      );
    if (!existing) {
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM push_subscriptions WHERE person_id=?",
      )
        .bind(who.id)
        .first<{ count: number }>();
      if ((count?.count || 0) >= 20)
        throw new ChatError(
          400,
          "Too many devices. Disable notifications on an old device first.",
        );
    }
    const id = existing?.id || crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO push_subscriptions(id,person_id,session_hash,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET session_hash=excluded.session_hash,p256dh=excluded.p256dh,auth=excluded.auth WHERE push_subscriptions.person_id=excluded.person_id`,
    )
      .bind(
        id,
        who.id,
        who.sessionHash,
        input.endpoint,
        input.keys.p256dh,
        input.keys.auth,
        Date.now(),
      )
      .run();
    return json({ id }, 201);
  }
  if (path === "/api/push/subscriptions" && request.method === "DELETE") {
    await env.DB.prepare(
      "DELETE FROM push_subscriptions WHERE session_hash=? AND person_id=?",
    )
      .bind(who.sessionHash, who.id)
      .run();
    return json({ ok: true });
  }
  if (path === "/api/push/test" && request.method === "POST") {
    if (!pushConfigured(env))
      throw new ChatError(503, "Push notifications are not configured.");
    const target = await env.DB.prepare(
      `UPDATE push_subscriptions SET last_test_at=? WHERE id=(SELECT id FROM push_subscriptions
      WHERE session_hash=? AND person_id=? LIMIT 1) AND last_test_at<? RETURNING *`,
    )
      .bind(Date.now(), who.sessionHash, who.id, Date.now() - 60000)
      .first<Subscription>();
    if (!target)
      throw new ChatError(
        429,
        "Enable notifications first, or wait a minute before testing again.",
      );
    let status = 0;
    try {
      status = await transmit(env, target, {
        title: env.WORKSPACE_NAME || "melancholy",
        body: "Notifications are ready on this device.",
        url: "/",
        tag: "test",
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "push_transport_failed",
          error: error instanceof Error ? error.name : "UnknownError",
          reason:
            error instanceof Error
              ? error.message
                  .replace(/https?:\/\/\S+/g, "[endpoint]")
                  .slice(0, 200)
              : "",
        }),
      );
    }
    if (status === 404 || status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id=?")
        .bind(target.id)
        .run();
      throw new ChatError(
        410,
        "This subscription expired. Enable notifications again.",
      );
    }
    if (status < 200 || status >= 300)
      throw new ChatError(
        502,
        "The push service could not accept the notification. Try again later.",
      );
    return json({ accepted: true });
  }
  throw new ChatError(404, "Not found.");
}
