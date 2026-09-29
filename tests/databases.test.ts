import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  evictDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { handleApi } from "../worker/api";
import { hash, secret } from "../worker/auth";
import type { ChannelDatabase, DataRecord } from "../lib/channel-database";
import { channelFiles } from "../worker/channel-data";
import { readChannel } from "../worker/casual";
import type { Person } from "../lib/chat";
beforeAll(async () => {
  await applyD1Migrations(
    env.DB,
    (env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] })
      .TEST_MIGRATIONS,
  );
});
const origin = "https://data.test";
async function req(
  path: string,
  auth: string,
  method = "GET",
  data?: unknown,
  withOrigin = true,
) {
  return handleApi(
    new Request(origin + path, {
      method,
      headers: {
        ...(withOrigin ? { Origin: origin } : {}),
        ...(auth.startsWith("mdb_") || /^[a-f0-9]{64}$/.test(auth)
          ? { Authorization: "Bearer " + auth }
          : { Cookie: auth }),
        ...(data instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(data !== undefined
        ? { body: data instanceof FormData ? data : JSON.stringify(data) }
        : {}),
    }),
  );
}
async function read<T = any>(
  response: Promise<Response>,
  status = 200,
): Promise<T> {
  const r = await response,
    result = await r.json();
  expect({
    status: r.status,
    ...(r.status !== status ? { result } : {}),
  }).toEqual({ status });
  return result as T;
}
async function member() {
  const id = crypto.randomUUID(),
    token = secret();
  await env.DB.prepare(
    "INSERT INTO people(id,handle,name,kind,created_at) VALUES (?,?,?,'human',?)",
  )
    .bind(id, "d" + id.slice(0, 8), "Data member", Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,expires_at,person_id) VALUES (?,?,?)",
  )
    .bind(await hash(token), Date.now() + 86400000, id)
    .run();
  return { id, auth: "melancholy_session=" + token };
}
async function fixture(priv = true) {
  const user = await member();
  const room = await read<{ id: string }>(
    req("/api/chat/rooms", user.auth, "POST", {
      name: "db-" + crypto.randomUUID().slice(0, 8),
      private: priv,
      members: [],
    }),
    201,
  );
  const dbs = await read<{ databases: ChannelDatabase[] }>(
    req(`/api/data/v1/channels/${room.id}/databases`, user.auth),
  );
  const create = async (name = "Research") =>
    read<ChannelDatabase>(
      req(`/api/data/v1/channels/${room.id}/databases`, user.auth, "POST", {
        name,
      }),
      201,
    );
  const db = await create();
  return {
    ...user,
    room: room.id,
    project: dbs.databases[0],
    db,
    base: `/api/data/v1/databases/${db.id}`,
    create,
  };
}
const definition = {
  name: "tasks",
  description: "Tasks",
  fields: {
    title: { type: "string", required: true },
    score: { type: "integer", indexed: true },
    done: { type: "boolean" },
    context: { type: "object" },
  },
};
async function schema(f: Awaited<ReturnType<typeof fixture>>) {
  return read(
    req(f.base + "/collections/tasks", f.auth, "PUT", {
      definition,
      version: 0,
    }),
  );
}
const batch = (collection: string, id: string, data: unknown) => ({
  requestId: crypto.randomUUID(),
  operations: [{ op: "create", collection, id, data }],
});
async function token(
  f: Awaited<ReturnType<typeof fixture>>,
  scopes = ["read"],
) {
  return read<{ id: string; token: string }>(
    req(f.base + "/tokens", f.auth, "POST", {
      name: "External client",
      scopes,
    }),
    201,
  );
}

describe("channel databases", () => {
  it("isolates channel databases and recovers schemas, records and idempotency after eviction", async () => {
    const f = await fixture(),
      second = await f.create("Other");
    await schema(f);
    const input = batch("tasks", "same-id", { title: "Persist me", score: 3 });
    const created = await read(req(f.base + "/batch", f.auth, "POST", input));
    await evictDurableObject(env.CHANNEL_DATABASES.getByName(f.db.id));
    expect(await read(req(f.base + "/batch", f.auth, "POST", input))).toEqual(
      created,
    );
    const result = await read(
      req(f.base + "/collections/tasks/records/same-id", f.auth),
    );
    expect(result).toMatchObject({
      id: "same-id",
      version: 1,
      data: { title: "Persist me", score: 3 },
    });
    expect(
      (await read(req(`/api/data/v1/databases/${second.id}/schema`, f.auth)))
        .collections,
    ).toHaveLength(0);
    await read(
      req(
        `/api/data/v1/databases/${second.id}/collections/tasks/records/same-id`,
        f.auth,
      ),
      404,
    );
  });
  it("validates JSON fields and rejects schema/SQL injection and unsupported constraints", async () => {
    const f = await fixture();
    await schema(f);
    for (const value of [
      { score: 1 },
      { title: "a", score: 2.1 },
      { title: "a", extra: 1 },
      { title: "a", done: "yes" },
      { title: "a", context: [] },
    ])
      await read(
        req(
          f.base + "/batch",
          f.auth,
          "POST",
          batch("tasks", crypto.randomUUID(), value),
        ),
        400,
      );
    await read(
      req(f.base + "/collections/tasks/query", f.auth, "POST", {
        filters: [
          { field: "score); DROP TABLE records;--", op: "eq", value: 1 },
        ],
      }),
      400,
    );
    await read(
      req(f.base + "/collections/tasks", f.auth, "PUT", {
        definition: {
          ...definition,
          fields: { "bad-field": { type: "string" } },
        },
        version: 1,
      }),
      400,
    );
    await read(
      req(f.base + "/collections/tasks", f.auth, "PUT", {
        definition: {
          ...definition,
          fields: { title: { type: "string", invented: true } },
        },
        version: 1,
      }),
      400,
    );
    expect(
      (await read(req(f.base + "/collections/tasks/records", f.auth))).records,
    ).toHaveLength(0);
  });
  it("rolls back an entire mixed batch on conflict and enforces record versions", async () => {
    const f = await fixture();
    await schema(f);
    await read(
      req(
        f.base + "/batch",
        f.auth,
        "POST",
        batch("tasks", "one", { title: "Original" }),
      ),
    );
    const change = {
      requestId: crypto.randomUUID(),
      operations: [
        {
          op: "create",
          collection: "tasks",
          id: "two",
          data: { title: "Should roll back" },
        },
        {
          op: "update",
          collection: "tasks",
          id: "one",
          version: 99,
          data: { title: "Stale" },
        },
      ],
    };
    await read(req(f.base + "/batch", f.auth, "POST", change), 409);
    await read(req(f.base + "/collections/tasks/records/two", f.auth), 404);
    expect(
      (await read(req(f.base + "/collections/tasks/records/one", f.auth)))
        .version,
    ).toBe(1);
    change.operations[1].version = 1;
    await read(req(f.base + "/batch", f.auth, "POST", change));
    expect(
      (await read(req(f.base + "/collections/tasks/records/one", f.auth))).data
        .title,
    ).toBe("Stale");
    change.operations[1].data.title = "Changed request";
    await read(req(f.base + "/batch", f.auth, "POST", change), 409);
  });
  it("allows additive schema evolution atomically and protects existing data", async () => {
    const f = await fixture();
    await schema(f);
    await read(
      req(
        f.base + "/batch",
        f.auth,
        "POST",
        batch("tasks", "one", { title: "Keep" }),
      ),
    );
    const evolved = {
      ...definition,
      fields: { ...definition.fields, source: { type: "string" } },
    };
    await read(
      req(f.base + "/collections/tasks", f.auth, "PUT", {
        definition: evolved,
        version: 1,
      }),
    );
    await read(
      req(f.base + "/collections/tasks", f.auth, "PUT", {
        definition: evolved,
        version: 1,
      }),
      409,
    );
    await read(
      req(f.base + "/collections/tasks", f.auth, "PUT", {
        definition: {
          ...evolved,
          fields: { ...evolved.fields, title: { type: "integer" } },
        },
        version: 2,
      }),
      409,
    );
    await read(
      req(f.base + "/schema", f.auth, "PUT", {
        collections: [
          { definition: { ...definition, name: "other" }, version: 0 },
          {
            definition: {
              ...definition,
              fields: { title: { type: "integer" } },
            },
            version: 2,
          },
        ],
      }),
      409,
    );
    expect(
      (await read(req(f.base + "/schema", f.auth))).collections,
    ).toHaveLength(1);
    await read(
      req(f.base + "/collections/tasks?version=2", f.auth, "DELETE"),
      409,
    );
  });
  it("paginates tied and missing sort values without skipping, including Unicode", async () => {
    const f = await fixture();
    await schema(f);
    await read(
      req(f.base + "/batch", f.auth, "POST", {
        requestId: crypto.randomUUID(),
        operations: ["a", "b", "c", "d", "e"].map((id, i) => ({
          op: "create",
          collection: "tasks",
          id,
          data: { title: "中文", ...(i > 1 ? { score: 2 } : {}) },
        })),
      }),
    );
    for (const direction of ["asc", "desc"]) {
      const found: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { records: DataRecord[]; next: string | null } = await read(
          req(f.base + "/collections/tasks/query", f.auth, "POST", {
            orderBy: "score",
            direction,
            limit: 2,
            ...(cursor ? { cursor } : {}),
          }),
        );
        found.push(...page.records.map((r: DataRecord) => r.id));
        cursor = page.next;
      } while (cursor);
      expect(found).toEqual(
        direction === "asc"
          ? ["a", "b", "c", "d", "e"]
          : ["e", "d", "c", "b", "a"],
      );
    }
    const page = await read(
      req(f.base + "/collections/tasks/query", f.auth, "POST", {
        orderBy: "title",
        limit: 2,
      }),
    );
    await read(
      req(f.base + "/collections/tasks/query", f.auth, "POST", {
        orderBy: "score",
        cursor: page.next,
      }),
      400,
    );
    expect(
      (
        await read(
          req(f.base + "/collections/tasks/query", f.auth, "POST", {
            filters: [{ field: "score", op: "gte", value: 2 }],
          }),
        )
      ).records,
    ).toHaveLength(3);
  });
  it("exposes monotonic change cursors, version history and deletion tombstones", async () => {
    const f = await fixture();
    await schema(f);
    const input = batch("tasks", "one", { title: "A" });
    await read(req(f.base + "/batch", f.auth, "POST", input));
    const recordUrl = f.base + "/collections/tasks/records/one";
    await read(
      req(recordUrl, f.auth, "PUT", {
        requestId: crypto.randomUUID(),
        version: 1,
        data: { title: "B" },
      }),
    );
    await read(
      req(recordUrl, f.auth, "DELETE", {
        requestId: crypto.randomUUID(),
        version: 2,
      }),
    );
    const history = await read(req(recordUrl + "/history", f.auth));
    expect(history.history.map((h: any) => h.version)).toEqual([3, 2, 1]);
    expect(history.history[0].snapshot).toBeNull();
    await read(req(recordUrl, f.auth), 404);
    await read(
      req(
        f.base + "/batch",
        f.auth,
        "POST",
        batch("tasks", "one", { title: "Reused" }),
      ),
      409,
    );
    let after = 0;
    const operations: string[] = [];
    for (let i = 0; i < 4; i++) {
      const changes = await read(
        req(f.base + `/changes?after=${after}&limit=1`, f.auth),
      );
      expect(changes.next).toBeGreaterThan(after);
      after = changes.next;
      operations.push(changes.changes[0].operation);
    }
    expect(operations).toEqual(["schema", "create", "update", "delete"]);
    expect(
      (await read(req(f.base + `/changes?after=${after}`, f.auth))).changes,
    ).toHaveLength(0);
  });
  it("enforces private channels, public read vs membership, CSRF, and manager-only schemas", async () => {
    const f = await fixture(),
      outsider = await member();
    await read(req(f.base, outsider.auth), 404);
    const pub = await fixture(false);
    await schema(pub);
    await read(req(pub.base, outsider.auth));
    await read(
      req(
        pub.base + "/batch",
        outsider.auth,
        "POST",
        batch("tasks", "x", { title: "No" }),
      ),
      403,
    );
    await read(
      req(
        f.base + "/collections/tasks",
        f.auth,
        "PUT",
        { definition, version: 0 },
        false,
      ),
      403,
    );
    await env.DB.prepare("INSERT INTO room_members VALUES (?,?,?)")
      .bind(pub.room, outsider.id, Date.now())
      .run();
    await read(
      req(pub.base + "/collections/tasks", outsider.auth, "PUT", {
        definition,
        version: 1,
      }),
      403,
    );
    await read(
      req(
        pub.base + "/batch",
        outsider.auth,
        "POST",
        batch("tasks", "yes", { title: "Allowed" }),
      ),
    );
  });
  it("restricts external tokens to database and scopes; revocation, expiry and membership apply immediately", async () => {
    const f = await fixture();
    await schema(f);
    const readOnly = await token(f),
      write = await token(f, ["read", "write"]);
    await read(req(f.base, readOnly.token));
    await read(
      req(`/api/data/v1/databases/${f.project.id}`, readOnly.token),
      404,
    );
    await read(
      req(
        f.base + "/batch",
        readOnly.token,
        "POST",
        batch("tasks", "bad", { title: "no" }),
      ),
      403,
    );
    await read(
      req(
        f.base + "/batch",
        write.token,
        "POST",
        batch("tasks", "ok", { title: "yes" }),
      ),
    );
    await read(
      req(f.base + "/collections/tasks", write.token, "PUT", {
        definition,
        version: 1,
      }),
      403,
    );
    await read(
      req(f.base + "/tokens", write.token, "POST", {
        name: "escalation",
        scopes: ["read"],
      }),
      403,
    );
    await read(req(f.base + "/tokens/" + readOnly.id, f.auth, "DELETE"));
    await read(req(f.base, readOnly.token), 401);
    await env.DB.prepare("UPDATE database_tokens SET expires_at=1 WHERE id=?")
      .bind(write.id)
      .run();
    await read(req(f.base, write.token), 401);
    const full = await token(f, ["read", "write", "schema"]);
    await read(
      req(f.base + "/collections/tasks", full.token, "PUT", {
        definition,
        version: 1,
      }),
    );
    await env.DB.prepare(
      "DELETE FROM room_members WHERE room_id=? AND person_id=?",
    )
      .bind(f.room, f.id)
      .run();
    await read(req(f.base, full.token), 401);
  });
  it("checks bot room-scoped API tokens and prevents bot lifecycle/schema access", async () => {
    const f = await fixture();
    await schema(f);
    const id = crypto.randomUUID(),
      tok = secret();
    await env.DB.prepare(
      "INSERT INTO people(id,handle,name,kind,created_at) VALUES (?,?,?,'bot',?)",
    )
      .bind(id, "b" + id.slice(0, 8), "Data bot", Date.now())
      .run();
    await env.DB.prepare("INSERT INTO room_members VALUES (?,?,?)")
      .bind(f.room, id, Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO bot_tokens(id,bot_id,room_id,token_hash,kind,created_at) VALUES (?,?,?,?,'api',?)",
    )
      .bind(crypto.randomUUID(), id, f.room, await hash(tok), Date.now())
      .run();
    await read(
      req(
        f.base + "/batch",
        tok,
        "POST",
        batch("tasks", "bot", { title: "From bot" }),
      ),
    );
    await read(
      req(f.base + "/collections/tasks", tok, "PUT", {
        definition,
        version: 1,
      }),
      403,
    );
    const other = await fixture();
    await env.DB.prepare("INSERT INTO room_members VALUES (?,?,?)")
      .bind(other.room, id, Date.now())
      .run();
    await read(req(other.base, tok), 404);
  });
  it("migrates Notes once, preserves metadata, and shares edits across Notes, Data and Casual", async () => {
    const f = await fixture(),
      id = crypto.randomUUID(),
      time = Date.now() - 10000;
    await env.DB.prepare(
      "INSERT INTO channel_notes(id,room_id,title,content,version,created_by,updated_by,created_at,updated_at) VALUES (?,?,?, ?,4,?,?,?,?)",
    )
      .bind(
        id,
        f.room,
        "Legacy",
        "[Source](/?room=" + f.room + ")",
        f.id,
        f.id,
        time,
        time,
      )
      .run();
    const base = `/api/data/v1/databases/${f.project.id}`;
    const old = await read(
      req(base + `/collections/notes/records/${id}`, f.auth),
    );
    expect(old).toMatchObject({
      version: 4,
      created_at: time,
      created_by: f.id,
    });
    await read(
      req(base + `/collections/notes/records/${id}`, f.auth, "PUT", {
        requestId: crypto.randomUUID(),
        version: 4,
        data: { title: "Edited via API", content: "Knowledge" },
      }),
    );
    await evictDurableObject(env.CHANNEL_DATABASES.getByName(f.project.id));
    const notes = await read(req(`/api/chat/rooms/${f.room}/notes`, f.auth));
    expect(notes.notes[0]).toMatchObject({
      id,
      title: "Edited via API",
      version: 5,
    });
    const who = await env.DB.prepare("SELECT * FROM people WHERE id=?")
      .bind(f.id)
      .first<Person>();
    expect((await readChannel(who!, f.room)).notes[0].title).toBe(
      "Edited via API",
    );
    await read(
      req(`/api/chat/rooms/${f.room}/notes/${id}?version=5`, f.auth, "DELETE"),
    );
    await evictDurableObject(env.CHANNEL_DATABASES.getByName(f.project.id));
    expect(
      (await read(req(`/api/chat/rooms/${f.room}/notes`, f.auth))).notes,
    ).toHaveLength(0);
    expect(
      (
        await env.DB.prepare("SELECT title FROM channel_notes WHERE id=?")
          .bind(id)
          .first()
      )?.title,
    ).toBe("Legacy");
  });
  it("indexes only posted R2 files, resumes events after eviction and prevents deleted-file access", async () => {
    const f = await fixture();
    const base = `/api/data/v1/databases/${f.project.id}`;
    const form = new FormData();
    form.append(
      "file",
      new File(["a private file"], "report.txt", { type: "text/plain" }),
    );
    const file = await read(
      req(`/api/chat/files?room=${f.room}`, f.auth, "POST", form),
      201,
    );
    expect((await channelFiles(f.room)).files).toHaveLength(0);
    const msg = crypto.randomUUID();
    await read(
      req(`/api/chat/rooms/${f.room}/messages`, f.auth, "POST", {
        id: msg,
        text: "Report",
        attachments: [file.id],
      }),
      201,
    );
    const page = await read(req(base + "/collections/files/records", f.auth));
    expect(page.records[0]).toMatchObject({
      id: file.id,
      data: { name: "report.txt", message_id: msg },
    });
    const t = await read<{ token: string }>(
      req(base + "/tokens", f.auth, "POST", {
        name: "Files",
        scopes: ["read", "write"],
      }),
      201,
    );
    const download = await req(
      base + `/collections/files/records/${file.id}/content`,
      t.token,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("a private file");
    await read(
      req(
        base + "/batch",
        t.token,
        "POST",
        batch("files", "fake", { name: "Bad" }),
      ),
      403,
    );
    await read(
      req(base + "/collections/files/records/" + file.id + "/history", t.token),
      403,
    );
    await evictDurableObject(env.CHANNEL_DATABASES.getByName(f.project.id));
    await read(req(`/api/chat/messages/${msg}`, f.auth, "DELETE"));
    expect((await channelFiles(f.room)).files).toHaveLength(0);
    await read(
      req(base + `/collections/files/records/${file.id}/content`, t.token),
      404,
    );
    await read(
      req(base + `/collections/files/records/${file.id}`, t.token),
      404,
    );
    expect(
      JSON.stringify(await read(req(base + "/changes", t.token))),
    ).not.toContain("report.txt");
  });
  it("protects managed schemas and makes archived databases and tokens inaccessible", async () => {
    const f = await fixture(),
      tok = await token(f);
    await read(
      req(`/api/data/v1/databases/${f.project.id}`, f.auth, "DELETE", {
        version: 1,
      }),
      403,
    );
    await read(
      req(
        `/api/data/v1/databases/${f.project.id}/collections/notes`,
        f.auth,
        "PUT",
        {
          definition: { name: "notes", fields: { title: { type: "string" } } },
          version: 1,
        },
      ),
      403,
    );
    await read(req(f.base, f.auth, "PATCH", { version: 1, name: "Renamed" }));
    await read(req(f.base, f.auth, "DELETE", { version: 1 }), 409);
    await read(req(f.base, f.auth, "DELETE", { version: 2 }));
    await read(req(f.base, tok.token), 401);
    await read(req(f.base, f.auth), 404);
    expect(
      (await read(req(`/api/data/v1/channels/${f.room}/databases`, f.auth)))
        .databases,
    ).toHaveLength(1);
  });
});
