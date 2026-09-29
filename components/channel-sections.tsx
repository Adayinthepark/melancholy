"use client";
import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { FileText, Download, Plus, Clock } from "lucide-react";
import { api, post } from "@/lib/client";
import type { Room, TeamWorkspace } from "@/lib/chat";
import type { ChannelNote, ChannelFile, ChannelTimer } from "@/lib/projects";
import type { Attachment } from "@/lib/protocol";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Choice } from "./team-settings";
import { MessageMarkdown } from "./message-markdown";
import { ChannelDatabases } from "./channel-databases";
import { ChannelWorkbench } from "./channel-workbench";
export function ChannelSections({
  tab,
  room,
  workspace,
  onThread,
}: {
  tab: string;
  room: Room;
  workspace: TeamWorkspace;
  onThread: (id: string) => void;
}) {
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => {
    if (tab !== "chat") setVisited((v) => (v.includes(tab) ? v : [...v, tab]));
  }, [tab]);
  return (
    <section
      className="channel-section"
      aria-label={"Channel " + tab}
      style={tab === "chat" ? { display: "none" } : undefined}
    >
      {visited.includes("notes") && (
        <div hidden={tab !== "notes"}>
          <ChannelNotes
            room={room}
            workspace={workspace}
            active={tab === "notes"}
          />
        </div>
      )}
      {visited.includes("files") && (
        <div hidden={tab !== "files"}>
          <ChannelFiles
            room={room}
            onThread={onThread}
            active={tab === "files"}
          />
        </div>
      )}
      {visited.includes("issues") && (
        <div hidden={tab !== "issues"}>
          <ChannelWorkbench
            embedded
            open
            onOpenChange={() => {}}
            room={room}
            workspace={workspace}
            onThread={onThread}
          />
        </div>
      )}
      {visited.includes("data") && (
        <div hidden={tab !== "data"}>
          <ChannelDatabases
            room={room}
            workspace={workspace}
            active={tab === "data"}
          />
        </div>
      )}
      {visited.includes("timer") && (
        <div hidden={tab !== "timer"}>
          <ChannelTimers
            room={room}
            workspace={workspace}
            onThread={onThread}
            active={tab === "timer"}
          />
        </div>
      )}
    </section>
  );
}

function ChannelNotes({
  room,
  workspace,
  active,
}: {
  room: Room;
  workspace: TeamWorkspace;
  active: boolean;
}) {
  const [notes, setNotes] = useState<ChannelNote[] | null>(null),
    [selected, setSelected] = useState<ChannelNote | null>(null),
    [editing, setEditing] = useState(false),
    [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(false),
    [error, setError] = useState("");
  const noteRequest = useRef(crypto.randomUUID());
  async function refresh() {
    const r = await api<{ notes: ChannelNote[] }>(
      "/chat/rooms/" + room.id + "/notes",
    );
    setNotes(r.notes);
    setError("");
    return r.notes;
  }
  useEffect(() => {
    if (active)
      void refresh()
        .then((list) => {
          if (!editing)
            setSelected(
              (current) =>
                list.find((n) => n.id === current?.id) || list[0] || null,
            );
        })
        .catch((e) => setError(e.message));
  }, [room.id, active]);
  function edit(note: ChannelNote | null) {
    noteRequest.current = crypto.randomUUID();
    setSelected(note);
    setTitle(note?.title || "");
    setContent(note?.content || "");
    setEditing(true);
    setPreview(false);
    setError("");
  }
  return (
    <div className="channel-notes">
      <div className="project-toolbar">
        <div>
          <h2>Notes</h2>
          <p className="project-help">
            Decisions, findings and project knowledge.
          </p>
        </div>
        {!!room.joined && (
          <Button size="sm" variant="outline" onClick={() => edit(null)}>
            <Plus />
            New note
          </Button>
        )}
      </div>
      {error && (
        <p role="alert">
          {error}{" "}
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void refresh()
                .then((list) => {
                  if (selected) {
                    const n = list.find((n) => n.id === selected.id);
                    if (n) edit(n);
                    else {
                      setSelected(null);
                      setEditing(false);
                    }
                  }
                })
                .catch((e) => setError(e.message))
            }
          >
            Reload notes
          </Button>
        </p>
      )}
      <div className="notes-layout">
        <nav aria-label="Channel notes">
          {notes === null ? (
            <p>Loading notes…</p>
          ) : notes.length ? (
            notes.map((n) => (
              <button
                key={n.id}
                className={selected?.id === n.id ? "selected" : ""}
                onClick={() => {
                  setSelected(n);
                  setEditing(false);
                  setError("");
                }}
              >
                <FileText size={16} />
                <span>
                  {n.title}
                  <small>{new Date(n.updated_at).toLocaleDateString()}</small>
                </span>
              </button>
            ))
          ) : (
            <p className="project-help">
              No notes yet. Save the decisions you want the next person or agent
              to find.
            </p>
          )}
        </nav>
        <div className="note-document">
          {editing ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const note = await api<ChannelNote>(
                    "/chat/rooms/" +
                      room.id +
                      "/notes" +
                      (selected ? "/" + selected.id : ""),
                    {
                      method: selected ? "PUT" : "POST",
                      body: JSON.stringify({
                        title,
                        requestId: noteRequest.current,
                        content,
                        version: selected?.version,
                      }),
                    },
                  );
                  await refresh();
                  setSelected(note);
                  setEditing(false);
                  toast.success("Note saved.");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="note-title">Title</FieldLabel>
                  <Input
                    id="note-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={160}
                    required
                  />
                </Field>
                <Field>
                  <div className="project-toolbar">
                    <FieldLabel htmlFor="note-content">
                      Content · Markdown
                    </FieldLabel>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => setPreview(!preview)}
                    >
                      {preview ? "Edit text" : "Preview"}
                    </Button>
                  </div>
                  {preview ? (
                    <div className="note-preview">
                      <MessageMarkdown text={content} />
                    </div>
                  ) : (
                    <Textarea
                      id="note-content"
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      rows={16}
                      maxLength={100000}
                    />
                  )}
                </Field>
                <div className="flex gap-2">
                  <Button disabled={busy}>Save note</Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </FieldGroup>
            </form>
          ) : selected ? (
            <article>
              <div className="project-toolbar">
                <h3>{selected.title}</h3>
                {!!room.joined && (
                  <div className="flex gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => edit(selected)}
                    >
                      Edit note
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api(
                            "/chat/rooms/" +
                              room.id +
                              "/notes/" +
                              selected.id +
                              "?version=" +
                              selected.version,
                            { method: "DELETE" },
                          );
                          setSelected(null);
                          await refresh();
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Delete note
                    </Button>
                  </div>
                )}
              </div>
              <p className="project-help">
                Updated {new Date(selected.updated_at).toLocaleString()} ·{" "}
                {workspace.people.find((p) => p.id === selected.updated_by)
                  ?.name || "Member"}
              </p>
              <MessageMarkdown text={selected.content} />
            </article>
          ) : notes?.length ? (
            <p className="project-help">Select a note to read.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
function ChannelFiles({
  room,
  onThread,
  active,
}: {
  active: boolean;
  room: Room;
  onThread: (id: string) => void;
}) {
  const [files, setFiles] = useState<ChannelFile[]>([]),
    [next, setNext] = useState<number | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function load(before?: number) {
    setLoading(true);
    try {
      const r = await api<{ files: ChannelFile[]; next: number | null }>(
        "/chat/rooms/" +
          room.id +
          "/files" +
          (before ? "?before=" + before : ""),
      );
      setFiles((f) => (before ? [...f, ...r.files] : r.files));
      setNext(r.next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (active) void load();
  }, [room.id, active]);
  return (
    <div>
      <div className="project-toolbar">
        <div>
          <h2>Files</h2>
          <p className="project-help">
            Files shared in this channel, stored privately in R2.
          </p>
        </div>
        {!!room.joined && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? "Uploading…" : "Upload file"}
          </Button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label="Upload channel file"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          try {
            if (file.size > 10 * 1024 * 1024)
              throw new Error("Files must be 10 MB or smaller.");
            const form = new FormData();
            form.set("file", file);
            const attachment = await api<Attachment>(
              "/chat/files?room=" + room.id,
              { method: "POST", body: form },
            );
            await post("/chat/rooms/" + room.id + "/messages", {
              id: crypto.randomUUID(),
              text: "",
              attachments: [attachment.id],
            });
            await load();
          } catch (e) {
            toast.error((e as Error).message);
          } finally {
            setBusy(false);
            if (input.current) input.current.value = "";
          }
        }}
      />
      {error && (
        <p role="alert">
          {error}
          <Button variant="ghost" size="xs" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      )}
      <div className="project-file-list">
        {files.map((f) => (
          <div className="project-row" key={f.id}>
            <FileText size={18} />
            <div className="project-row-main">
              <a href={"/api/chat/files/" + f.id} download={f.name}>
                {f.name}
              </a>
              <small>
                {f.size < 1024
                  ? f.size + " B"
                  : f.size < 1024 * 1024
                    ? (f.size / 1024).toFixed(1) + " KB"
                    : (f.size / 1024 / 1024).toFixed(1) + " MB"}{" "}
                · {new Date(f.created_at).toLocaleDateString()}
              </small>
            </div>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onThread(f.parent_id || f.message_id)}
            >
              View message
            </Button>
            <a
              href={"/api/chat/files/" + f.id}
              download={f.name}
              aria-label={"Download " + f.name}
            >
              <Download size={16} />
            </a>
          </div>
        ))}
      </div>
      {loading ? (
        <p className="project-help">Loading files…</p>
      ) : !files.length && !error ? (
        <p className="project-help">No files shared yet.</p>
      ) : null}
      {next && (
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void load(next)}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
function localTime() {
  const d = new Date(Date.now() + 3600000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function ChannelTimers({
  room,
  workspace,
  onThread,
  active,
}: {
  active: boolean;
  room: Room;
  workspace: TeamWorkspace;
  onThread: (id: string) => void;
}) {
  const [timers, setTimers] = useState<ChannelTimer[] | null>(null),
    [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [prompt, setPrompt] = useState(""),
    [bot, setBot] = useState(""),
    [when, setWhen] = useState(localTime),
    [interval, setInterval] = useState("0"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    setTimers(
      (
        await api<{ timers: ChannelTimer[] }>(
          "/chat/rooms/" + room.id + "/timers",
        )
      ).timers,
    );
    setError("");
  }
  useEffect(() => {
    if (!active) return;
    void refresh().catch((e) => setError(e.message));
    const timer = setIntervalSafe(() => void refresh().catch(() => {}), 30000);
    return () => clearInterval(timer);
  }, [room.id, active]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const timerRequest = useRef(crypto.randomUUID());
  const bots = room.members.filter(
    (p) => p.kind === "bot" && (p.server_id || p.cloud_agent),
  );
  return (
    <div>
      <div className="project-toolbar">
        <div>
          <h2>Timer</h2>
          <p className="project-help">
            Scheduled agent tasks. Each execution has its own thread.
          </p>
        </div>
        {!!room.joined && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreating(!creating)}
          >
            <Plus />
            {creating ? "Close form" : "New timer"}
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {creating && (
        <form
          className="project-timer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await post("/chat/rooms/" + room.id + "/timers", {
                id: timerRequest.current,
                name,
                prompt,
                botId: bot,
                nextAt: new Date(when).getTime(),
                intervalMinutes: Number(interval),
              });
              timerRequest.current = crypto.randomUUID();
              setCreating(false);
              setName("");
              setPrompt("");
            });
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="timer-name">Task name</FieldLabel>
              <Input
                id="timer-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="timer-prompt">Instructions</FieldLabel>
              <Textarea
                id="timer-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                maxLength={16000}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="timer-bot">Agent</FieldLabel>
              <Choice
                id="timer-bot"
                value={bot}
                onChange={setBot}
                options={bots.map((p) => ({ value: p.id, label: p.name }))}
              />
              {!bots.length && (
                <p className="project-help">
                  Ask the workspace owner to add a Server or Cloudflare bot to
                  this channel.
                </p>
              )}
            </Field>
            <div className="form-two-columns">
              <Field>
                <FieldLabel htmlFor="timer-when">
                  First run · your local time
                </FieldLabel>
                <Input
                  id="timer-when"
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="timer-repeat">Repeat</FieldLabel>
                <Choice
                  id="timer-repeat"
                  value={interval}
                  onChange={setInterval}
                  options={[
                    { value: "0", label: "Once" },
                    { value: "60", label: "Every hour" },
                    { value: "1440", label: "Every 24 hours" },
                    { value: "10080", label: "Every 7 days" },
                  ]}
                />
              </Field>
            </div>
            <p className="project-help">
              Runs within about a minute of the scheduled time. Repeats use
              fixed intervals; daylight-saving changes do not shift the
              schedule. Missed intervals are combined into one run. Model and
              Server costs apply.
            </p>
            <Button disabled={busy || !bot}>Create timer</Button>
          </FieldGroup>
        </form>
      )}
      {timers === null ? (
        <p className="project-help">Loading timers…</p>
      ) : timers.length ? (
        timers.map((t) => (
          <div className="project-timer" key={t.id}>
            <div className="project-toolbar">
              <strong>
                <Clock size={15} />
                {t.name}
              </strong>
              <span className="project-help">
                {t.enabled
                  ? "Scheduled"
                  : t.runs && !t.interval_minutes
                    ? "Triggered"
                    : "Paused"}
              </span>
            </div>
            <p className="timer-instructions">{t.prompt}</p>
            <p className="project-help">
              {workspace.people.find((p) => p.id === t.bot_id)?.name ||
                "Unavailable agent"}{" "}
              ·{" "}
              {t.interval_minutes
                ? "Every " +
                  (t.interval_minutes % 1440 === 0
                    ? t.interval_minutes / 1440 + " days"
                    : t.interval_minutes + " minutes")
                : "Once"}
              {t.enabled
                ? " · Next " + new Date(t.next_at).toLocaleString()
                : ""}{" "}
              · {t.runs} runs
            </p>
            {t.last_error && <p role="alert">{t.last_error}</p>}
            <div className="flex gap-2">
              {t.last_message_id && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onThread(t.last_message_id!)}
                >
                  Latest run
                </Button>
              )}
              {!!room.joined &&
                (workspace.me.role === "owner" ||
                  t.created_by === workspace.me.id) && (
                  <>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          api("/chat/rooms/" + room.id + "/timers/" + t.id, {
                            method: "PATCH",
                            body: JSON.stringify({
                              enabled: !t.enabled,
                              version: t.version,
                            }),
                          }),
                        )
                      }
                    >
                      {t.enabled
                        ? "Pause"
                        : t.interval_minutes
                          ? "Resume"
                          : "Run again"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          api("/chat/rooms/" + room.id + "/timers/" + t.id, {
                            method: "DELETE",
                          }),
                        )
                      }
                    >
                      Remove timer
                    </Button>
                  </>
                )}
            </div>
          </div>
        ))
      ) : (
        !creating && <p className="project-help">No scheduled tasks yet.</p>
      )}
    </div>
  );
}
const setIntervalSafe = globalThis.setInterval;
