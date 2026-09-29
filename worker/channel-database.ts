import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  collectionDefinition,
  dataName,
  recordId,
  recordOperation,
  recordQuery,
  noteCollection,
  fileCollection,
  type CollectionDefinition,
  type DataRecord,
} from "../lib/channel-database";

class DataError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type DataReply =
  { ok: true; value: unknown } | { ok: false; status: number; error: string };
type Stored = Omit<DataRecord, "data"> & { data: string; deleted: number };
const stable = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const decode = (row: Stored): DataRecord => ({
  id: row.id,
  data: JSON.parse(row.data),
  version: row.version,
  created_by: row.created_by,
  updated_by: row.updated_by,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/** One SQLite object per database. Authorization is performed by the Worker,
 * which resolves the catalog before calling this internal RPC-only object. */
export class ChannelDatabase extends DurableObject<Cloudflare.Env> {
  private preparing?: Promise<void>;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS collections(name TEXT PRIMARY KEY,definition TEXT NOT NULL,version INTEGER NOT NULL,managed INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL,created_by TEXT NOT NULL,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(collection,id));
      CREATE INDEX IF NOT EXISTS records_updated ON records(collection,deleted,updated_at,id);
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,collection TEXT NOT NULL,record_id TEXT,operation TEXT NOT NULL,version INTEGER NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history(collection TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,snapshot TEXT,actor TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(collection,id,version));
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
  }
  private rows<T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) {
    return this.ctx.storage.sql.exec<T>(sql, ...args).toArray();
  }
  private one<T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) {
    return this.rows<T>(sql, ...args)[0];
  }
  private collection(name: string) {
    dataName.parse(name);
    const row = this.one<{
      definition: string;
      version: number;
      managed: number;
    }>(
      "SELECT definition,version,managed FROM collections WHERE name=? AND deleted=0",
      name,
    );
    if (!row) throw new DataError(404, "Collection not found.");
    return {
      ...(JSON.parse(row.definition) as CollectionDefinition),
      version: row.version,
      managed: !!row.managed,
    };
  }
  private record(collection: string, id: string) {
    return this.one<Stored>(
      "SELECT * FROM records WHERE collection=? AND id=?",
      collection,
      id,
    );
  }
  private change(
    collection: string,
    id: string | null,
    operation: string,
    version: number,
    actor: string,
    at: number,
  ) {
    this.ctx.storage.sql.exec(
      "INSERT INTO changes(collection,record_id,operation,version,actor,at) VALUES (?,?,?,?,?,?)",
      collection,
      id,
      operation,
      version,
      actor,
      at,
    );
  }
  private schema(input: unknown, actor: string, managed = false) {
    const { definition: raw, version } = z
      .object({
        definition: z.unknown(),
        version: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    const definition = collectionDefinition.parse(raw),
      old = this.one<{
        version: number;
        definition: string;
        managed: number;
        deleted: number;
      }>("SELECT * FROM collections WHERE name=?", definition.name);
    if (old?.deleted)
      throw new DataError(
        409,
        "This collection name was retired. Choose a new name.",
      );
    if (old?.managed && !managed)
      throw new DataError(
        403,
        "Built-in collection schemas are managed by the workspace.",
      );
    if ((old?.version || 0) !== version)
      throw new DataError(
        409,
        "The collection schema changed. Reload before saving.",
      );
    if (
      !old &&
      Number(
        this.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM collections WHERE deleted=0",
        )?.n,
      ) >= 32
    )
      throw new DataError(400, "A database supports up to 32 collections.");
    if (old) {
      const previous = JSON.parse(old.definition) as CollectionDefinition;
      for (const [key, field] of Object.entries(previous.fields)) {
        const next = definition.fields[key];
        if (
          !next ||
          next.type !== field.type ||
          (!!next.required && !field.required) ||
          (next.maxLength &&
            (!field.maxLength || next.maxLength < field.maxLength))
        )
          throw new DataError(
            409,
            "Schema updates may add optional fields or relax constraints. Removing fields, changing types or tightening constraints requires a new collection.",
          );
      }
      for (const [key, field] of Object.entries(definition.fields))
        if (!previous.fields[key] && field.required)
          throw new DataError(
            409,
            "New fields must be optional for existing records.",
          );
      for (const key of Object.keys(previous.fields))
        this.ctx.storage.sql.exec(
          `DROP INDEX IF EXISTS "field_${definition.name}_${key}"`,
        );
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO collections(name,definition,version,managed) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET definition=excluded.definition,version=excluded.version",
      definition.name,
      JSON.stringify(definition),
      version + 1,
      Number(managed),
    );
    for (const [key, field] of Object.entries(definition.fields))
      if (field.indexed)
        this.ctx.storage.sql.exec(
          `CREATE INDEX "field_${definition.name}_${key}" ON records(json_extract(data,'$.${key}'),id) WHERE collection='${definition.name}' AND deleted=0`,
        );
    this.change(
      definition.name,
      null,
      "schema",
      version + 1,
      actor,
      Date.now(),
    );
    return this.collection(definition.name);
  }
  private validate(
    definition: CollectionDefinition,
    data: Record<string, unknown>,
  ) {
    for (const key of Object.keys(data))
      if (!Object.hasOwn(definition.fields, key))
        throw new DataError(400, `Unknown field: ${key}`);
    for (const [key, field] of Object.entries(definition.fields)) {
      const value = data[key];
      if (value === undefined) {
        if (field.required)
          throw new DataError(400, `Missing required field: ${key}`);
        continue;
      }
      const valid =
        field.type === "integer"
          ? Number.isSafeInteger(value)
          : field.type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : field.type === "array"
              ? Array.isArray(value)
              : field.type === "object"
                ? !!value && typeof value === "object" && !Array.isArray(value)
                : typeof value === field.type;
      if (
        !valid ||
        (typeof value === "string" &&
          field.maxLength &&
          value.length > field.maxLength)
      )
        throw new DataError(
          400,
          `Invalid value for ${key}: expected ${field.type}${field.maxLength ? ` (max ${field.maxLength} characters)` : ""}.`,
        );
    }
    if (
      definition.name === "notes" &&
      this.collection("notes").managed &&
      !String(data.title).trim()
    )
      throw new DataError(400, "A note needs a title.");
  }
  private write(
    input: unknown,
    actor: string,
    internal = false,
  ): DataRecord | { id: string; deleted: true; version: number } {
    const op = recordOperation.parse(input),
      definition = this.collection(op.collection);
    if (definition.managed && definition.name === "files" && !internal)
      throw new DataError(
        403,
        "The file index is maintained from posted attachments.",
      );
    const old = this.record(op.collection, op.id);
    if (op.op === "create" && old)
      throw new DataError(
        409,
        "Record ID already exists (or was deleted). Use a new ID or retry with the original request ID.",
      );
    if (
      op.op !== "create" &&
      (!old || old.deleted || old.version !== op.version)
    )
      throw new DataError(
        409,
        "This record changed or was deleted. Reload before saving.",
      );
    if (op.op !== "delete") this.validate(definition, op.data);
    const now = Date.now(),
      version = (old?.version || 0) + 1;
    this.ctx.storage.sql.exec(
      "INSERT INTO records(collection,id,data,version,created_by,updated_by,created_at,updated_at,deleted) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at,deleted=excluded.deleted",
      op.collection,
      op.id,
      JSON.stringify(op.op === "delete" ? {} : op.data),
      version,
      old?.created_by || actor,
      actor,
      old?.created_at || now,
      now,
      Number(op.op === "delete"),
    );
    const record = decode(this.record(op.collection, op.id)!);
    // Files have no content history: deleted attachment metadata must not survive through history APIs.
    if (!(definition.managed && definition.name === "files"))
      this.ctx.storage.sql.exec(
        "INSERT INTO history VALUES (?,?,?,?,?,?)",
        op.collection,
        op.id,
        version,
        op.op === "delete" ? null : JSON.stringify(record),
        actor,
        now,
      );
    this.change(op.collection, op.id, op.op, version, actor, now);
    return op.op === "delete" ? { id: op.id, deleted: true, version } : record;
  }
  private query(name: string, input: unknown) {
    const definition = this.collection(name),
      query = recordQuery.parse(input),
      args: SqlStorageValue[] = [name];
    const expression = (field: string) => {
      if (["id", "version", "created_at", "updated_at"].includes(field))
        return `"${field}"`;
      if (
        !Object.hasOwn(definition.fields, field) ||
        ["array", "object"].includes(definition.fields[field].type)
      )
        throw new DataError(400, "Query fields must be known scalar fields.");
      return `json_extract(data,'$.${field}')`;
    };
    const terms = ["collection=?", "deleted=0"];
    for (const filter of query.filters) {
      terms.push(
        `${expression(filter.field)} ${{ eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.op]} ?`,
      );
      args.push(
        typeof filter.value === "boolean" ? Number(filter.value) : filter.value,
      );
    }
    const sort = expression(query.orderBy),
      direction = query.direction === "asc" ? "ASC" : "DESC",
      sign = direction === "ASC" ? ">" : "<";
    const fingerprint = stable({
      name,
      filters: query.filters,
      orderBy: query.orderBy,
      direction: query.direction,
    });
    if (query.cursor) {
      let cursor;
      try {
        cursor = z
          .object({
            query: z.string(),
            value: z.union([z.string(), z.number(), z.null()]),
            id: recordId,
          })
          .parse(JSON.parse(decodeURIComponent(atob(query.cursor))));
      } catch {
        throw new DataError(400, "Invalid record cursor.");
      }
      if (cursor.query !== fingerprint)
        throw new DataError(400, "Use this cursor with the same query.");
      if (cursor.value === null) {
        terms.push(
          `((${sort} IS NULL AND id ${sign} ?)${direction === "ASC" ? ` OR ${sort} IS NOT NULL` : ""})`,
        );
        args.push(cursor.id);
      } else {
        terms.push(
          `((${sort} ${sign} ?) OR (${sort} = ? AND id ${sign} ?)${direction === "DESC" ? ` OR ${sort} IS NULL` : ""})`,
        );
        args.push(cursor.value, cursor.value, cursor.id);
      }
    }
    args.push(query.limit + 1);
    const rows = this.rows<Stored & { sort_value: string | number | null }>(
      `SELECT *,${sort} AS sort_value FROM records WHERE ${terms.join(" AND ")} ORDER BY ${sort} ${direction},id ${direction} LIMIT ?`,
      ...args,
    );
    const more = rows.length > query.limit,
      page = rows.slice(0, query.limit),
      last = page.at(-1);
    return {
      records: page.map(decode),
      next:
        more && last
          ? btoa(
              encodeURIComponent(
                JSON.stringify({
                  query: fingerprint,
                  value: last.sort_value,
                  id: last.id,
                }),
              ),
            )
          : null,
    };
  }
  /** Import legacy Notes once; replay committed attachment events before reads.
   * No D1 Notes writer remains after this deployment. File events carry snapshots
   * from the same D1 transaction as publication/deletion, and are replay-safe. */
  async prepareProject(roomId: string): Promise<DataReply> {
    try {
      if (!this.preparing)
        this.preparing = this.importProject(roomId).finally(() => {
          this.preparing = undefined;
        });
      await this.preparing;
      return { ok: true, value: null };
    } catch (error) {
      return this.failure(error);
    }
  }
  private async importProject(roomId: string) {
    const bound = this.one<{ value: string }>(
      "SELECT value FROM meta WHERE key='room'",
    );
    if (bound && bound.value !== roomId)
      throw new DataError(409, "Database channel mismatch.");
    if (!bound)
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("INSERT INTO meta VALUES ('room',?)", roomId);
        this.schema({ definition: noteCollection, version: 0 }, "system", true);
        this.schema({ definition: fileCollection, version: 0 }, "system", true);
      });
    if (!this.one("SELECT 1 FROM meta WHERE key='notes_imported'")) {
      let after = "";
      while (true) {
        const rows = (
          await this.env.DB.prepare(
            "SELECT * FROM channel_notes WHERE room_id=? AND id>? ORDER BY id LIMIT 100",
          )
            .bind(roomId, after)
            .all<{
              id: string;
              title: string;
              content: string;
              version: number;
              created_by: string;
              updated_by: string;
              created_at: number;
              updated_at: number;
            }>()
        ).results;
        this.ctx.storage.transactionSync(() => {
          for (const row of rows) {
            if (this.record("notes", row.id)) continue;
            this.ctx.storage.sql.exec(
              "INSERT INTO records(collection,id,data,version,created_by,updated_by,created_at,updated_at) VALUES ('notes',?,?,?,?,?,?,?)",
              row.id,
              JSON.stringify({ title: row.title, content: row.content }),
              row.version,
              row.created_by,
              row.updated_by,
              row.created_at,
              row.updated_at,
            );
            this.ctx.storage.sql.exec(
              "INSERT INTO history VALUES ('notes',?,?,?,?,?)",
              row.id,
              row.version,
              JSON.stringify(decode(this.record("notes", row.id)!)),
              row.updated_by,
              row.updated_at,
            );
            this.change(
              "notes",
              row.id,
              "import",
              row.version,
              row.updated_by,
              row.updated_at,
            );
          }
        });
        if (rows.length < 100) break;
        after = rows.at(-1)!.id;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO meta VALUES ('notes_imported','1')",
      );
    }
    for (let page = 0; page < 100; page++) {
      const cursor = Number(
        this.one<{ value: string }>(
          "SELECT value FROM meta WHERE key='files_cursor'",
        )?.value || 0,
      );
      const events = (
        await this.env.DB.prepare(
          "SELECT seq,file_id,payload FROM channel_file_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT 100",
        )
          .bind(roomId, cursor)
          .all<{ seq: number; file_id: string; payload: string | null }>()
      ).results;
      this.ctx.storage.transactionSync(() => {
        for (const event of events) {
          const old = this.record("files", event.file_id);
          if (!event.payload) {
            if (old && !old.deleted)
              this.write(
                {
                  op: "delete",
                  collection: "files",
                  id: event.file_id,
                  version: old.version,
                },
                "system",
                true,
              );
          } else {
            const value = JSON.parse(event.payload),
              data = {
                name: value.name,
                size: value.size,
                type: value.type,
                message_id: value.message_id,
                ...(value.parent_id ? { parent_id: value.parent_id } : {}),
                seq: value.seq,
                uploader_id: value.uploader_id,
              };
            // A restored attachment can reuse its ID; user record IDs cannot.
            if (old?.deleted)
              this.ctx.storage.sql.exec(
                "UPDATE records SET deleted=0 WHERE collection='files' AND id=?",
                event.file_id,
              );
            this.write(
              old
                ? {
                    op: "update",
                    collection: "files",
                    id: event.file_id,
                    version: old.version,
                    data,
                  }
                : {
                    op: "create",
                    collection: "files",
                    id: event.file_id,
                    data,
                  },
              "system",
              true,
            );
            this.ctx.storage.sql.exec(
              "UPDATE records SET created_at=? WHERE collection='files' AND id=?",
              value.created_at,
              event.file_id,
            );
          }
        }
        if (events.length)
          this.ctx.storage.sql.exec(
            "INSERT INTO meta VALUES ('files_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            String(events.at(-1)!.seq),
          );
      });
      if (events.length < 100) return;
    }
    throw new DataError(
      503,
      "The file index is catching up. Retry this request.",
    );
  }
  private failure(error: unknown): DataReply {
    if (error instanceof DataError)
      return { ok: false, status: error.status, error: error.message };
    if (error instanceof z.ZodError)
      return {
        ok: false,
        status: 400,
        error: error.issues[0]?.message || "Invalid data.",
      };
    throw error;
  }
  async call(
    action: string,
    input: unknown,
    actor: string,
  ): Promise<DataReply> {
    try {
      if (this.preparing) await this.preparing;
      const value = this.ctx.storage.transactionSync(() =>
        this.dispatch(action, input, actor),
      );
      return { ok: true, value };
    } catch (error) {
      return this.failure(error);
    }
  }
  private dispatch(action: string, input: unknown, actor: string): unknown {
    if (action === "collections")
      return {
        collections: this.rows<{ name: string; count: number }>(
          "SELECT c.name,(SELECT COUNT(*) FROM records r WHERE r.collection=c.name AND r.deleted=0) AS count FROM collections c WHERE c.deleted=0 ORDER BY c.name",
        ).map((row) => ({ ...this.collection(row.name), count: row.count })),
      };
    if (action === "schema") {
      const schemas = z
        .array(
          z
            .object({
              definition: collectionDefinition,
              version: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .min(1)
        .max(32)
        .parse(input);
      return { collections: schemas.map((s) => this.schema(s, actor)) };
    }
    if (action === "drop") {
      const { collection, version } = z
          .object({
            collection: dataName,
            version: z.number().int().positive(),
          })
          .parse(input),
        current = this.collection(collection);
      if (current.managed)
        throw new DataError(403, "Built-in collections cannot be deleted.");
      if (
        current.version !== version ||
        this.one(
          "SELECT 1 FROM records WHERE collection=? AND deleted=0 LIMIT 1",
          collection,
        )
      )
        throw new DataError(
          409,
          "Only an empty collection at its current version can be deleted.",
        );
      for (const key of Object.keys(current.fields))
        this.ctx.storage.sql.exec(
          `DROP INDEX IF EXISTS "field_${collection}_${key}"`,
        );
      this.ctx.storage.sql.exec(
        "UPDATE collections SET deleted=1,version=version+1 WHERE name=?",
        collection,
      );
      this.change(collection, null, "drop", version + 1, actor, Date.now());
      return { ok: true };
    }
    if (action === "query") {
      const { collection, query } = z
        .object({ collection: dataName, query: z.unknown() })
        .parse(input);
      return this.query(collection, query);
    }
    if (action === "get" || action === "history") {
      const { collection, id, before } = z
          .object({
            collection: dataName,
            id: recordId,
            before: z
              .number()
              .int()
              .positive()
              .default(Number.MAX_SAFE_INTEGER),
          })
          .parse(input),
        definition = this.collection(collection),
        row = this.record(collection, id);
      if (!row || (action === "get" && row.deleted))
        throw new DataError(404, "Record not found.");
      if (action === "get") return decode(row);
      if (definition.managed && collection === "files")
        throw new DataError(
          403,
          "Attachment history is unavailable. Use the current file index.",
        );
      const history = this.rows<{
        version: number;
        snapshot: string | null;
        actor: string;
        at: number;
      }>(
        "SELECT version,snapshot,actor,at FROM history WHERE collection=? AND id=? AND version<? ORDER BY version DESC LIMIT 51",
        collection,
        id,
        before,
      );
      return {
        history: history
          .slice(0, 50)
          .map((h) => ({
            ...h,
            snapshot: h.snapshot ? JSON.parse(h.snapshot) : null,
          })),
        next: history.length > 50 ? history[49].version : null,
      };
    }
    if (action === "batch") {
      const { requestId, operations } = z
          .object({
            requestId: recordId,
            operations: z.array(recordOperation).min(1).max(100),
          })
          .strict()
          .parse(input),
        fingerprint = stable({ actor, operations });
      const previous = this.one<{ fingerprint: string; response: string }>(
        "SELECT * FROM requests WHERE id=?",
        requestId,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new DataError(
            409,
            "Request ID was already used for different operations.",
          );
        return JSON.parse(previous.response);
      }
      const result = { records: operations.map((op) => this.write(op, actor)) };
      this.ctx.storage.sql.exec(
        "INSERT INTO requests VALUES (?,?,?)",
        requestId,
        fingerprint,
        JSON.stringify(result),
      );
      return result;
    }
    if (action === "changes") {
      const { after, limit } = z
        .object({
          after: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(100).default(100),
        })
        .parse(input);
      const changes = this.rows<{ seq: number }>(
        "SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT ?",
        after,
        limit + 1,
      );
      return {
        changes: changes.slice(0, limit),
        next: changes[Math.min(changes.length, limit) - 1]?.seq || after,
        hasMore: changes.length > limit,
      };
    }
    throw new DataError(404, "Unknown database operation.");
  }
}
