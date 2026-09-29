"use client";
import { useEffect, useRef, useState } from "react";
import { Database, Plus, RefreshCw, KeyRound, Download } from "lucide-react";
import { toast } from "sonner";
import { api, post } from "@/lib/client";
import type { Room, TeamWorkspace } from "@/lib/chat";
import type {
  ChannelDatabase,
  DataCollection,
  DataRecord,
} from "@/lib/channel-database";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Choice } from "./team-settings";
const root = "/data/v1";
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const example = {
  name: "tasks",
  description: "Project tasks",
  fields: {
    title: { type: "string", required: true },
    status: { type: "string", indexed: true },
  },
};
type Token = { id: string; name: string; scopes: string[]; expires_at: number };
export function ChannelDatabases({
  room,
  workspace,
  active,
}: {
  room: Room;
  workspace: TeamWorkspace;
  active: boolean;
}) {
  const [list, setList] = useState<ChannelDatabase[] | null>(null),
    [selected, setSelected] = useState("");
  const [create, setCreate] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const creationId = useRef(crypto.randomUUID());
  const canManage =
    !!room.joined &&
    (workspace.me.role === "owner" || room.created_by === workspace.me.id);
  const refresh = async () => {
    const r = await api<{ databases: ChannelDatabase[] }>(
      `${root}/channels/${room.id}/databases`,
    );
    setList(r.databases);
    setSelected((old) =>
      r.databases.some((d) => d.id === old) ? old : r.databases[0]?.id || "",
    );
  };
  useEffect(() => {
    if (active) void refresh().catch((e) => setError(e.message));
  }, [room.id, active]);
  return (
    <div className="project-panel database-panel">
      <div className="project-toolbar">
        <div>
          <h2>Data</h2>
          <p className="project-help">
            Channel databases, collections and external connections.
          </p>
        </div>
        <div className="database-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh databases"
            onClick={() => void refresh().catch((e) => setError(e.message))}
          >
            <RefreshCw />
          </Button>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                creationId.current = crypto.randomUUID();
                setName("");
                setDescription("");
                setCreate(true);
              }}
            >
              <Plus />
              New database
            </Button>
          )}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {list === null ? (
        <p className="project-help">Loading databases…</p>
      ) : (
        <>
          <nav className="database-list" aria-label="Channel databases">
            {list.map((db) => (
              <button
                key={db.id}
                aria-current={db.id === selected ? "true" : undefined}
                onClick={() => setSelected(db.id)}
              >
                <Database size={16} />
                <span>{db.name}</span>
                {!!db.managed && <small>Notes & files</small>}
              </button>
            ))}
          </nav>
          {list.find((d) => d.id === selected) && (
            <DatabaseDetail
              key={selected}
              database={list.find((d) => d.id === selected)!}
              canManage={canManage}
              canWrite={!!room.joined}
              active={active}
              onChange={refresh}
            />
          )}
        </>
      )}
      <Dialog open={create} onOpenChange={setCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New database</DialogTitle>
            <DialogDescription>
              Keep a separate set of structured data in this channel.
            </DialogDescription>
          </DialogHeader>
          <form
            className="database-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const db = await post<ChannelDatabase>(
                  `${root}/channels/${room.id}/databases`,
                  { id: creationId.current, name, description },
                );
                await refresh();
                setSelected(db.id);
                setCreate(false);
                toast.success("Database created.");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Database name
              <Input
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Description
              <Input
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <Button disabled={busy} type="submit">
              Create database
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function DatabaseDetail({
  database: db,
  canManage,
  canWrite,
  active,
  onChange,
}: {
  database: ChannelDatabase;
  canManage: boolean;
  canWrite: boolean;
  active: boolean;
  onChange: () => Promise<void>;
}) {
  const base = `${root}/databases/${db.id}`;
  const [collections, setCollections] = useState<DataCollection[]>([]),
    [name, setName] = useState("");
  const [records, setRecords] = useState<DataRecord[]>([]),
    [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("{}");
  const [schema, setSchema] = useState<string | null>(null),
    [schemaVersion, setSchemaVersion] = useState(0);
  const [edit, setEdit] = useState<{
      record: DataRecord | null;
      data: string;
    } | null>(null),
    [tokenOpen, setTokenOpen] = useState(false),
    [archive, setArchive] = useState(false);
  const [history, setHistory] = useState<string | null>(null);
  const mutationId = useRef(crypto.randomUUID()),
    generation = useRef(0);
  const current = collections.find((c) => c.name === name),
    fileIndex = !!db.managed && name === "files";
  const refreshSchema = async () => {
    const result = await api<{ collections: DataCollection[] }>(
      base + "/schema",
    );
    setCollections(result.collections);
    setName((old) =>
      result.collections.some((c) => c.name === old)
        ? old
        : result.collections[0]?.name || "",
    );
  };
  const loadRecords = async (cursor?: string, value = query) => {
    if (!name) {
      setRecords([]);
      setLoading(false);
      return;
    }
    const seq = ++generation.current;
    setLoading(true);
    try {
      const result = await post<{ records: DataRecord[]; next: string | null }>(
        `${base}/collections/${name}/query`,
        { ...JSON.parse(value), ...(cursor ? { cursor } : {}) },
      );
      if (seq !== generation.current) return;
      setRecords((old) =>
        cursor ? [...old, ...result.records] : result.records,
      );
      setNext(result.next);
    } finally {
      if (seq === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (active) void refreshSchema().catch((e) => setError(e.message));
  }, [active]);
  useEffect(() => {
    if (active) {
      setQuery("{}");
      void loadRecords(undefined, "{}").catch((e) => setError(e.message));
    }
    return () => {
      generation.current++;
    };
  }, [name, active]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const startEdit = (record: DataRecord | null) => {
    mutationId.current = crypto.randomUUID();
    const initial = Object.fromEntries(
      Object.entries(current?.fields || {})
        .filter(([, f]) => f.required)
        .map(([key, f]) => [
          key,
          f.type === "string"
            ? ""
            : f.type === "boolean"
              ? false
              : f.type === "array"
                ? []
                : f.type === "object"
                  ? {}
                  : 0,
        ]),
    );
    setEdit({ record, data: pretty(record?.data || initial) });
    setError("");
  };
  const startSchema = (existing?: DataCollection) => {
    setSchemaVersion(existing?.version || 0);
    setSchema(
      pretty(
        existing
          ? {
              name: existing.name,
              description: existing.description,
              fields: existing.fields,
            }
          : example,
      ),
    );
    setError("");
  };
  return (
    <div className="database-detail">
      <div className="project-toolbar">
        <div>
          <h3>{db.name}</h3>
          <p className="project-help">
            {db.description || "Structured data for this channel."}
          </p>
        </div>
        <div className="database-actions">
          {canManage && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setTokenOpen(true)}
              >
                <KeyRound />
                API access
              </Button>
              <Button size="sm" variant="outline" onClick={() => startSchema()}>
                <Plus />
                Collection
              </Button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p role="alert">
          {error}{" "}
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void run(async () => {
                await refreshSchema();
                await loadRecords();
              })
            }
          >
            Reload data
          </Button>
        </p>
      )}
      <div className="database-layout">
        <nav aria-label="Database collections">
          {collections.map((c) => (
            <button
              key={c.name}
              aria-current={c.name === name ? "true" : undefined}
              onClick={() => {
                setName(c.name);
                setError("");
              }}
            >
              <span>{c.name}</span>
              <small>{c.count}</small>
            </button>
          ))}
          {!collections.length && (
            <p className="project-help">
              Add a collection to define its fields.
            </p>
          )}
        </nav>
        <div className="database-content">
          {current && (
            <>
              <div className="project-toolbar">
                <div>
                  <h3>{current.name}</h3>
                  <p className="project-help">{current.description}</p>
                </div>
                <div className="database-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => startSchema(current)}
                  >
                    Schema
                  </Button>
                  {canWrite && !fileIndex && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(null)}
                    >
                      <Plus />
                      Record
                    </Button>
                  )}
                </div>
              </div>
              <form
                className="database-query"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => loadRecords());
                }}
              >
                <label>
                  Query · JSON
                  <Input
                    className="database-code"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={
                      '{"filters":[{"field":"status","op":"eq","value":"open"}]}'
                    }
                  />
                </label>
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                >
                  Run query
                </Button>
              </form>
              <div className="database-records">
                {!records.length && (
                  <p className="project-help">
                    {loading
                      ? "Loading records…"
                      : "No records match this query."}
                  </p>
                )}
                {records.map((record) => (
                  <article key={record.id}>
                    <div className="project-toolbar">
                      <code>{record.id}</code>
                      <div className="database-actions">
                        <small>v{record.version}</small>
                        {fileIndex ? (
                          <a
                            href={`/api${base}/collections/files/records/${record.id}/content`}
                            download
                            aria-label={`Download ${record.data.name}`}
                          >
                            <Download size={16} />
                          </a>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() =>
                                void run(async () =>
                                  setHistory(
                                    pretty(
                                      await api(
                                        `${base}/collections/${name}/records/${record.id}/history`,
                                      ),
                                    ),
                                  ),
                                )
                              }
                            >
                              History
                            </Button>
                            {canWrite && (
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => startEdit(record)}
                              >
                                Edit record
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    <pre>{pretty(record.data)}</pre>
                  </article>
                ))}
              </div>
              {next && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading || busy}
                  onClick={() => void run(() => loadRecords(next))}
                >
                  Load more records
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <p className="project-help database-endpoint">
        API endpoint <code>/api/data/v1/databases/{db.id}</code> ·{" "}
        <a
          href="https://github.com/adayinthepark/melancholy/blob/main/docs/channel-databases.md"
          target="_blank"
          rel="noreferrer"
        >
          API guide
        </a>
      </p>
      {canManage && !db.managed && (
        <Button variant="ghost" size="sm" onClick={() => setArchive(true)}>
          Archive database
        </Button>
      )}
      <Dialog
        open={schema !== null}
        onOpenChange={(open) => {
          if (!open) setSchema(null);
        }}
      >
        <DialogContent className="database-dialog">
          <DialogHeader>
            <DialogTitle>
              {schemaVersion ? "Collection schema" : "New collection"}
            </DialogTitle>
            <DialogDescription>
              {current?.managed && schemaVersion
                ? "This built-in schema is maintained by the workspace."
                : "Define typed fields in JSON. Existing schemas can add optional fields and relax constraints."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Collection schema JSON"
            className="database-code"
            rows={14}
            value={schema || ""}
            onChange={(e) => setSchema(e.target.value)}
            readOnly={!canManage || (!!current?.managed && !!schemaVersion)}
          />
          {error && <p role="alert">{error}</p>}
          {canManage && !(current?.managed && schemaVersion) && (
            <div className="database-actions">
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const definition = JSON.parse(schema!);
                    await api(`${base}/collections/${definition.name}`, {
                      method: "PUT",
                      body: JSON.stringify({
                        definition,
                        version: schemaVersion,
                      }),
                    });
                    setSchema(null);
                    await refreshSchema();
                    setName(definition.name);
                    toast.success("Collection saved.");
                  })
                }
              >
                Save schema
              </Button>
              {!!schemaVersion && current?.count === 0 && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `${base}/collections/${current.name}?version=${schemaVersion}`,
                        { method: "DELETE" },
                      );
                      setSchema(null);
                      await refreshSchema();
                    })
                  }
                >
                  Delete empty collection
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!edit}
        onOpenChange={(open) => {
          if (!open) setEdit(null);
        }}
      >
        <DialogContent className="database-dialog">
          <DialogHeader>
            <DialogTitle>
              {edit?.record ? "Edit record" : "New record"}
            </DialogTitle>
            <DialogDescription>
              {edit?.record
                ? `Version ${edit.record.version}. A concurrent edit will require reloading.`
                : "Provide values for the fields defined in this collection."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Record JSON"
            className="database-code"
            rows={12}
            value={edit?.data || ""}
            onChange={(e) =>
              setEdit((old) => (old ? { ...old, data: e.target.value } : old))
            }
          />
          {error && <p role="alert">{error}</p>}
          <div className="database-actions">
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const record = edit!.record;
                  await post(base + "/batch", {
                    requestId: mutationId.current,
                    operations: [
                      {
                        op: record ? "update" : "create",
                        collection: name,
                        id: record?.id || mutationId.current,
                        data: JSON.parse(edit!.data),
                        ...(record ? { version: record.version } : {}),
                      },
                    ],
                  });
                  setEdit(null);
                  await refreshSchema();
                  await loadRecords();
                  toast.success("Record saved.");
                })
              }
            >
              Save record
            </Button>
            {edit?.record && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await post(base + "/batch", {
                      requestId: mutationId.current + "-delete",
                      operations: [
                        {
                          op: "delete",
                          collection: name,
                          id: edit.record!.id,
                          version: edit.record!.version,
                        },
                      ],
                    });
                    setEdit(null);
                    await refreshSchema();
                    await loadRecords();
                  })
                }
              >
                Delete record
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={history !== null}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
      >
        <DialogContent className="database-dialog">
          <DialogHeader>
            <DialogTitle>Record history</DialogTitle>
            <DialogDescription>
              Most recent 50 versions. Older versions are available through the
              API cursor.
            </DialogDescription>
          </DialogHeader>
          <pre className="database-history">{history}</pre>
        </DialogContent>
      </Dialog>
      <Dialog open={archive} onOpenChange={setArchive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {db.name}?</DialogTitle>
            <DialogDescription>
              This removes the database from the channel and revokes its API
              tokens. Stored data is retained for operator recovery.
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert">{error}</p>}
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(base, {
                  method: "DELETE",
                  body: JSON.stringify({ version: db.version }),
                });
                await onChange();
              })
            }
          >
            Archive database
          </Button>
        </DialogContent>
      </Dialog>
      <DatabaseTokens
        open={tokenOpen}
        onOpenChange={setTokenOpen}
        base={base}
      />
    </div>
  );
}
function DatabaseTokens({
  open,
  onOpenChange,
  base,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  base: string;
}) {
  const [tokens, setTokens] = useState<Token[]>([]),
    [name, setName] = useState(""),
    [scope, setScope] = useState("read"),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () =>
    setTokens((await api<{ tokens: Token[] }>(base + "/tokens")).tokens);
  useEffect(() => {
    if (open) void refresh().catch((e) => setError(e.message));
    else setToken("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="database-dialog">
        <DialogHeader>
          <DialogTitle>Database API access</DialogTitle>
          <DialogDescription>
            Tokens access only this database and expire after 90 days. Access
            also ends if their creator leaves the channel.
          </DialogDescription>
        </DialogHeader>
        <form
          className="database-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const result = await post<{ token: string }>(base + "/tokens", {
                name,
                scopes:
                  scope === "schema"
                    ? ["read", "write", "schema"]
                    : scope === "write"
                      ? ["read", "write"]
                      : ["read"],
              });
              setToken(result.token);
              setName("");
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Token name
            <Input
              required
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Access
            <Choice
              id="database-token-access"
              value={scope}
              onChange={setScope}
              options={[
                { value: "read", label: "Read records and changes" },
                { value: "write", label: "Read and write records" },
                { value: "schema", label: "Read, write and manage schemas" },
              ]}
            />
          </label>
          <Button type="submit" disabled={busy}>
            Create token
          </Button>
        </form>
        {token && (
          <div className="database-token">
            <p>Copy this token now. It will only be shown once.</p>
            <Input
              readOnly
              aria-label="New database API token"
              value={token}
              onFocus={(e) => e.target.select()}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(token)
                  .then(() => toast.success("Token copied."))
                  .catch(() =>
                    setError("Select the token and copy it manually."),
                  )
              }
            >
              Copy token
            </Button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="database-token-list">
          {tokens.map((t) => (
            <div key={t.id}>
              <span>
                {t.name}
                <small>
                  {t.scopes.join(", ")} · Expires{" "}
                  {new Date(t.expires_at).toLocaleDateString()}
                </small>
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  void api(base + "/tokens/" + t.id, { method: "DELETE" })
                    .then(refresh)
                    .catch((e) => setError(e.message))
                }
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
