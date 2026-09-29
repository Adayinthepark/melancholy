import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { handleApi } from "../worker/api";
import { hash } from "../worker/auth";
import {
  allowedPushEndpoint,
  decodeKey,
  drainPush,
  maintainPush,
  queuePush,
} from "../worker/push";
const origin = "https://push.test";
beforeAll(() =>
  applyD1Migrations(
    env.DB,
    (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] })
      .TEST_MIGRATIONS,
  ),
);
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM push_subscriptions").run();
});
afterEach(() => vi.restoreAllMocks());
const encode = (value: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
async function request(
  path: string,
  cookie = "",
  method = "GET",
  body?: unknown,
  requestOrigin = origin,
) {
  return handleApi(
    new Request(origin + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: requestOrigin,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function fixture(kind = "channel") {
  const login = await request("/api/login", "", "POST", {
    key: env.WORKSPACE_KEY,
  });
  const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
  const room = crypto.randomUUID(),
    other = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO people(id,handle,name,kind,created_at) VALUES (?,?,'Other','human',?)",
    ).bind(other, other, Date.now()),
    env.DB.prepare(
      "INSERT INTO rooms(id,kind,name,private,created_by,created_at) VALUES (?,?,?,1,?,?)",
    ).bind(room, kind, room, "owner", Date.now()),
    env.DB.prepare("INSERT INTO room_members VALUES (?,?,?)").bind(
      room,
      "owner",
      Date.now(),
    ),
    env.DB.prepare("INSERT INTO room_members VALUES (?,?,?)").bind(
      room,
      other,
      Date.now(),
    ),
  ]);
  const keys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription = {
    endpoint: "https://web.push.apple.com/" + crypto.randomUUID(),
    keys: {
      p256dh: encode(await crypto.subtle.exportKey("raw", keys.publicKey)),
      auth: encode(auth),
    },
  };
  const saved = await request(
    "/api/push/subscriptions",
    cookie,
    "POST",
    subscription,
  );
  expect(saved.status).toBe(201);
  const { id } = (await saved.json()) as { id: string };
  return { cookie, room, other, keys, auth, subscription, id };
}
async function message(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    parent?: string;
    author?: string;
    mention?: boolean;
    run?: string;
    status?: string;
  } = {},
) {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO chat_messages(id,room_id,parent_id,author_id,text,created_at,run_id,run_status) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      f.room,
      options.parent || null,
      options.author || f.other,
      "Confidential prompt that must never enter push payloads",
      Date.now(),
      options.run || null,
      options.status || null,
    ),
    ...(options.mention
      ? [
          env.DB.prepare("INSERT INTO message_mentions VALUES (?,?)").bind(
            id,
            "owner",
          ),
        ]
      : []),
    queuePush(env.DB, id),
  ]);
  return id;
}
async function deliveries(id: string) {
  return (
    await env.DB.prepare(
      "SELECT * FROM push_deliveries WHERE subscription_id=? ORDER BY id",
    )
      .bind(id)
      .all<{ state: string; message_id: string; attempts: number }>()
  ).results;
}

it("requires a member session and same-origin mutations; rejects unsafe push endpoints and malformed keys", async () => {
  expect((await request("/api/push/status")).status).toBe(401);
  const f = await fixture();
  expect(
    (
      await request(
        "/api/push/subscriptions",
        f.cookie,
        "POST",
        f.subscription,
        "https://evil.test",
      )
    ).status,
  ).toBe(403);
  for (const endpoint of [
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://fcm.googleapis.com.evil.test/x",
    "https://fcm.googleapis.com:444/x",
    "https://user@web.push.apple.com/x",
    "https://example.com/x",
  ]) {
    expect(allowedPushEndpoint(endpoint)).toBe(false);
    expect(
      (
        await request("/api/push/subscriptions", f.cookie, "POST", {
          ...f.subscription,
          endpoint,
        })
      ).status,
    ).toBe(400);
  }
  expect(
    allowedPushEndpoint(
      "https://updates.push.services.mozilla.com/wpush/v2/test",
    ),
  ).toBe(true);
  expect(allowedPushEndpoint("https://jmt17.google.com/fcm/send/test")).toBe(
    true,
  );
  expect(allowedPushEndpoint("https://jmt17.google.com/other")).toBe(false);
  expect(
    (
      await request("/api/push/subscriptions", f.cookie, "POST", {
        ...f.subscription,
        keys: { ...f.subscription.keys, p256dh: "a".repeat(87) },
      })
    ).status,
  ).toBe(400);
  const state = await (await request("/api/push/status", f.cookie)).text();
  expect(state).not.toContain(f.subscription.endpoint);
  expect(state).not.toContain(f.subscription.keys.auth);
  expect(state).not.toContain(env.VAPID_PRIVATE_KEY);
});

it("queues only mentions, direct/group messages and participated threads, once per device; never own messages", async () => {
  const f = await fixture();
  await message(f);
  await message(f, { author: "owner", mention: true });
  const mention = await message(f, { mention: true });
  const root = await message(f, { author: "owner" });
  const reply = await message(f, { parent: root });
  const unrelated = await message(f);
  await message(f, { parent: unrelated });
  await env.DB.batch([queuePush(env.DB, mention), queuePush(env.DB, reply)]);
  expect((await deliveries(f.id)).map((d) => d.message_id)).toEqual([
    mention,
    reply,
  ]);
  for (const kind of ["dm", "group"]) {
    const direct = await fixture(kind);
    await message(direct);
    expect(await deliveries(direct.id)).toHaveLength(1);
  }
});

it("waits for agent terminal status and deduplicates repeated stream projections", async () => {
  const f = await fixture("dm");
  const id = await message(f, { run: crypto.randomUUID(), status: "running" });
  expect(await deliveries(f.id)).toHaveLength(0);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE chat_messages SET run_status='completed' WHERE id=?",
    ).bind(id),
    queuePush(env.DB, id),
  ]);
  await env.DB.batch([queuePush(env.DB, id), queuePush(env.DB, id)]);
  expect(await deliveries(f.id)).toHaveLength(1);
});

it("rechecks membership, read state, deletion and session expiry before sending", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 201 }));
  for (const mode of ["leave", "read", "message-read", "deleted", "expired"]) {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
    const f = await fixture("dm"),
      id = await message(f);
    if (mode === "leave")
      await env.DB.prepare(
        "DELETE FROM room_members WHERE room_id=? AND person_id=?",
      )
        .bind(f.room, "owner")
        .run();
    if (mode === "read")
      await env.DB.prepare(
        "INSERT INTO room_reads SELECT room_id,?,seq FROM chat_messages WHERE id=?",
      )
        .bind("owner", id)
        .run();
    if (mode === "message-read")
      await env.DB.prepare(
        "INSERT INTO message_reads(person_id,message_id,read_at) VALUES(?,?,?)",
      )
        .bind("owner", id, Date.now())
        .run();
    if (mode === "deleted")
      await env.DB.prepare("UPDATE chat_messages SET deleted_at=? WHERE id=?")
        .bind(Date.now(), id)
        .run();
    if (mode === "expired")
      await env.DB.prepare(
        "UPDATE sessions SET expires_at=0 WHERE token_hash=(SELECT session_hash FROM push_subscriptions WHERE id=?)",
      )
        .bind(f.id)
        .run();
    await drainPush(env);
    expect((await deliveries(f.id))[0].state).toBe("skipped");
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("removes subscriptions and queued deliveries on logout and disable", async () => {
  for (const path of ["/api/logout", "/api/push/subscriptions"]) {
    const f = await fixture("dm");
    await message(f);
    expect(
      (
        await request(
          path,
          f.cookie,
          path === "/api/logout" ? "POST" : "DELETE",
        )
      ).status,
    ).toBe(200);
    expect(await deliveries(f.id)).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT id FROM push_subscriptions WHERE id=?")
        .bind(f.id)
        .first(),
    ).toBeNull();
  }
});

it("claims delivery once across concurrent drains, retries temporary failures and removes gone subscriptions", async () => {
  const f = await fixture("dm");
  await message(f);
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 503 }));
  await Promise.all([drainPush(env), drainPush(env)]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await deliveries(f.id))[0]).toMatchObject({
    state: "pending",
    attempts: 1,
  });
  fetcher.mockImplementation(async () => new Response(null, { status: 201 }));
  await env.DB.prepare(
    "UPDATE push_deliveries SET next_at=0 WHERE subscription_id=?",
  )
    .bind(f.id)
    .run();
  await drainPush(env);
  expect((await deliveries(f.id))[0]).toMatchObject({
    state: "sent",
    attempts: 2,
  });
  await drainPush(env);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const gone = await fixture("dm");
  await message(gone);
  fetcher.mockImplementation(async () => new Response(null, { status: 410 }));
  await maintainPush(env);
  expect(
    await env.DB.prepare("SELECT id FROM push_subscriptions WHERE id=?")
      .bind(gone.id)
      .first(),
  ).toBeNull();
});

async function decrypt(
  body: Uint8Array,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const serverKey = body.slice(21, 21 + body[20]);
  const server = await crypto.subtle.importKey(
    "raw",
    serverKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: server },
    f.keys.privateKey,
    256,
  );
  const text = new TextEncoder();
  async function hkdf(
    key: ArrayBuffer | Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    bits: number,
  ) {
    return crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits"]),
      bits,
    );
  }
  const client = new Uint8Array(
    await crypto.subtle.exportKey("raw", f.keys.publicKey),
  );
  const info = new Uint8Array([
    ...text.encode("WebPush: info\0"),
    ...client,
    ...serverKey,
  ]);
  const ikm = await hkdf(shared, f.auth, info, 256);
  const key = await hkdf(
    ikm,
    body.slice(0, 16),
    text.encode("Content-Encoding: aes128gcm\0"),
    128,
  );
  const iv = await hkdf(
    ikm,
    body.slice(0, 16),
    text.encode("Content-Encoding: nonce\0"),
    96,
  );
  const clear = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]),
      body.slice(21 + body[20]),
    ),
  );
  let end = clear.length - 1;
  while (clear[end] === 0) end--;
  expect(clear[end]).toBe(2);
  return JSON.parse(new TextDecoder().decode(clear.slice(0, end)));
}

it("sends RFC 8291 encrypted private payloads with a valid VAPID signature and safe thread route", async () => {
  const f = await fixture(),
    root = await message(f, { author: "owner" });
  await message(f, { parent: root });
  let payload: RequestInit | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    payload = init;
    return new Response(null, { status: 201 });
  });
  await drainPush(env);
  const headers = new Headers(payload!.headers);
  expect(headers.get("content-encoding")).toBe("aes128gcm");
  expect(payload!.redirect).toBe("manual");
  const encoded = payload!.body as Uint8Array;
  expect(new TextDecoder().decode(encoded)).not.toContain("Confidential");
  const clear = await decrypt(encoded, f);
  expect(clear.title).toBe("Other · #" + f.room);
  expect(clear.url).toBe("/thread/" + root);
  expect(clear.body).toBe("Replied in a thread.");
  expect(JSON.stringify(clear)).not.toContain("Confidential");
  const jwt = headers
    .get("authorization")!
    .match(/t=([^,]+)/)![1]
    .split(".");
  expect(JSON.parse(new TextDecoder().decode(decodeKey(jwt[1]))).aud).toBe(
    "https://web.push.apple.com",
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decodeKey(env.VAPID_PUBLIC_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decodeKey(jwt[2]),
      new TextEncoder().encode(jwt[0] + "." + jwt[1]),
    ),
  ).toBe(true);
});

it("identifies the sender and conversation for mentions, DMs, groups and Casual chat task results", async () => {
  for (const scenario of [
    "mention",
    "dm",
    "group",
    "casual",
    "failed",
    "cancelled",
  ]) {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
    const f = await fixture(
      scenario === "mention"
        ? "channel"
        : scenario === "group"
          ? "group"
          : "dm",
    );
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE people SET name='Research bot',kind='bot' WHERE id=?",
      ).bind(f.other),
      env.DB.prepare("UPDATE rooms SET name=? WHERE id=?").bind(
        scenario === "group" ? "Launch team " + f.room : "push-" + f.room,
        f.room,
      ),
    ]);
    if (scenario === "casual")
      await env.DB.prepare(
        "INSERT INTO casual_rooms(user_id,room_id,bot_id) VALUES(?,?,?)",
      )
        .bind("owner", f.room, f.other)
        .run();
    const task = ["dm", "casual", "failed", "cancelled"].includes(scenario);
    await message(f, {
      mention: scenario === "mention",
      ...(task
        ? {
            run: crypto.randomUUID(),
            status: ["failed", "cancelled"].includes(scenario)
              ? scenario
              : "completed",
          }
        : {}),
    });
    let payload: RequestInit | undefined;
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        payload = init;
        return new Response(null, { status: 201 });
      });
    await drainPush(env);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const clear = await decrypt(payload!.body as Uint8Array, f);
    expect(clear.title).toBe(
      "Research bot" +
        (scenario === "mention"
          ? " · #push-" + f.room
          : scenario === "group"
            ? " · Launch team " + f.room
            : scenario === "casual"
              ? " · Casual chat"
              : ""),
    );
    expect(clear.body).toBe(
      scenario === "mention"
        ? "Mentioned you."
        : scenario === "group"
          ? "Sent you a message."
          : scenario === "failed"
            ? "Agent task failed."
            : scenario === "cancelled"
              ? "Agent task stopped."
              : "Agent task completed.",
    );
    expect(clear.url).toBe("/?room=" + f.room);
    expect(JSON.stringify(clear)).not.toContain("Confidential");
    if (scenario === "casual")
      await env.DB.prepare("DELETE FROM casual_rooms WHERE room_id=?")
        .bind(f.room)
        .run();
    fetcher.mockRestore();
  }
});

it("limits test notifications and only delivers to the current session", async () => {
  const f = await fixture();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 201 }));
  expect((await request("/api/push/test", f.cookie, "POST")).status).toBe(200);
  expect((await request("/api/push/test", f.cookie, "POST")).status).toBe(429);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("integrates notification queuing into real message writes and final agent projections", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(null, { status: 201 }),
  );
  const f = await fixture();
  const token = "d".repeat(64);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions(token_hash,person_id,expires_at) VALUES (?,?,?)",
  )
    .bind(await hash(token), f.other, Date.now() + 60000)
    .run();
  const posted = await request(
    "/api/chat/rooms/" + f.room + "/messages",
    "melancholy_session=" + token,
    "POST",
    { text: "<@owner> hello" },
  );
  expect(posted.status).toBe(201);
  // Automatic waitUntil delivery may already have claimed the row; insertion is transactional.
  expect(await deliveries(f.id)).toHaveLength(1);
  await env.DB.prepare("DELETE FROM push_deliveries").run();
  const root = await message(f, { author: "owner" });
  const server = crypto.randomUUID(),
    thread = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO servers(id,name,runtime,token_hash,created_at) VALUES (?,'push-test','codex',?,?)",
    ).bind(server, crypto.randomUUID(), Date.now()),
    env.DB.prepare(
      "INSERT INTO people(id,handle,name,kind,server_id,created_at) VALUES (?,?,'Agent','bot',?,?)",
    ).bind(server, server, server, Date.now()),
    env.DB.prepare("INSERT INTO room_members VALUES (?,?,?)").bind(
      f.room,
      server,
      Date.now(),
    ),
    env.DB.prepare("INSERT INTO agent_threads VALUES (?,?,?,?)").bind(
      thread,
      f.room,
      root,
      server,
    ),
  ]);
  const conversation = env.CONVERSATIONS.getByName(thread);
  const run = await conversation.send({
    threadId: thread,
    serverId: server,
    runtime: "codex",
    text: "Do the work",
    id: crypto.randomUUID(),
    attachments: [],
    chat: { roomId: f.room, botId: server, parentId: root },
  });
  await conversation.receive(run.id, 1, {
    type: "started",
    sessionId: "push-test-session",
  });
  await conversation.receive(run.id, 2, { type: "text", text: "Streaming" });
  expect(await deliveries(f.id)).toHaveLength(0);
  await conversation.receive(run.id, 3, { type: "completed" });
  expect(await deliveries(f.id)).toHaveLength(1);
  await conversation.receive(run.id, 3, { type: "completed" });
  expect(await deliveries(f.id)).toHaveLength(1);
});
