"use client";
import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Choice } from "./team-settings";
import { MessageMarkdown } from "./message-markdown";
import { api, post } from "@/lib/client";
import type { Room, TeamWorkspace, TeamMessage } from "@/lib/chat";
import type {
  Connection,
  Repository,
  Issue,
  IssueComment,
} from "@/lib/workbench";
export function ChannelWorkbench({
  open,
  onOpenChange,
  room,
  workspace,
  onThread,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  room: Room;
  workspace: TeamWorkspace;
  onThread: (id: string) => void;
}) {
  const admin = workspace.me.role === "owner";
  const [tab, setTab] = useState("issues"),
    [repos, setRepos] = useState<Repository[]>([]),
    [connections, setConnections] = useState<Connection[]>([]),
    [available, setAvailable] = useState<Connection[]>([]),
    [repoId, setRepoId] = useState(""),
    [connectionId, setConnectionId] = useState(""),
    [fullName, setFullName] = useState(""),
    [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]),
    [state, setState] = useState("open"),
    [page, setPage] = useState(1),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false),
    [selected, setSelected] = useState<Issue | null>(null),
    [comments, setComments] = useState<IssueComment[]>([]),
    [comment, setComment] = useState(""),
    [create, setCreate] = useState(false),
    [editing, setEditing] = useState(false),
    [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [labels, setLabels] = useState(""),
    [assignees, setAssignees] = useState("");
  const detailVersion = useRef(0);
  useEffect(() => {
    detailVersion.current++;
    setSelected(null);
    setEditing(false);
    setCreate(false);
  }, [repoId, open]);
  const repo = repos.find((r) => r.id === repoId);
  async function refresh() {
    const [r, c, a] = await Promise.all([
      api<{ repositories: Repository[] }>(
        "/chat/rooms/" + room.id + "/repositories",
      ),
      api<{ connections: Connection[] }>(
        "/chat/rooms/" + room.id + "/connections",
      ),
      admin ? api<{ connections: Connection[] }>("/chat/connections") : null,
    ]);
    setRepos(r.repositories);
    setConnections(c.connections);
    if (a) setAvailable(a.connections);
    setRepoId((current) =>
      r.repositories.some((r) => r.id === current && r.approved)
        ? current
        : r.repositories.find((r) => r.approved)?.id || "",
    );
  }
  useEffect(() => {
    if (open) {
      setSelected(null);
      void refresh().catch((e) => toast.error(e.message));
    }
  }, [open, room.id]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!open || !repoId) return;
    let active = true;
    setLoading(true);
    void api<{ issues: Issue[]; hasMore: boolean }>(
      "/chat/repositories/" +
        repoId +
        "/issues?state=" +
        state +
        "&page=" +
        page,
    )
      .then((r) => {
        if (active) {
          setIssues(r.issues);
          setMore(r.hasMore);
        }
      })
      .catch((e) => toast.error(e.message))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repoId, state, page, open]);
  async function view(issue: Issue) {
    const version = ++detailVersion.current;
    setSelected(issue);
    setEditing(false);
    setComments([]);
    try {
      const [latest, comments] = await Promise.all([
        api<Issue>("/chat/repositories/" + repoId + "/issues/" + issue.number),
        api<IssueComment[]>(
          "/chat/repositories/" +
            repoId +
            "/issues/" +
            issue.number +
            "/comments",
        ),
      ]);
      if (version !== detailVersion.current) return;
      setSelected(latest);
      setComments(comments);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  function edit(issue?: Issue) {
    setTitle(issue?.title || "");
    setBody(issue?.body || "");
    setLabels(issue?.labels.map((x) => x.name).join(", ") || "");
    setAssignees(issue?.assignees.map((x) => x.login).join(", ") || "");
    if (issue) setEditing(true);
    else setCreate(true);
  }
  const issueForm = (
    <form
      className="issue-form"
      onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          const data = {
            title,
            body,
            labels: labels
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
            assignees: assignees
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          };
          const saved = await api<Issue>(
            "/chat/repositories/" +
              repoId +
              "/issues" +
              (editing && selected ? "/" + selected.number : ""),
            { method: editing ? "PATCH" : "POST", body: JSON.stringify(data) },
          );
          setCreate(false);
          setEditing(false);
          setIssues((list) => [
            saved,
            ...list.filter((i) => i.number !== saved.number),
          ]);
          await view(saved);
        });
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="issue-title">Title</FieldLabel>
          <Input
            id="issue-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={256}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="issue-body">Description</FieldLabel>
          <Textarea
            id="issue-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
          />
        </Field>
        <div className="form-two-columns">
          <Field>
            <FieldLabel htmlFor="issue-labels">Labels</FieldLabel>
            <Input
              id="issue-labels"
              placeholder="bug, enhancement"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="issue-assignees">Assignees</FieldLabel>
            <Input
              id="issue-assignees"
              placeholder="GitHub usernames, comma separated"
              value={assignees}
              onChange={(e) => setAssignees(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button disabled={busy}>
            {editing ? "Save issue" : "Create issue"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setCreate(false);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="channel-workbench sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>#{room.name}</DialogTitle>
          <DialogDescription className="sr-only">
            Repositories, GitHub issues and channel credentials.
          </DialogDescription>
        </DialogHeader>
        <div className="workbench-tabs">
          <Button
            variant={tab === "issues" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTab("issues")}
          >
            Issues
          </Button>
          <Button
            variant={tab === "repositories" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTab("repositories")}
          >
            Repositories & connections
          </Button>
        </div>
        {tab === "repositories" ? (
          <div className="settings-section">
            <div>
              {repos.map((r) => (
                <div className="repository-row" key={r.id}>
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {r.full_name}
                  </a>
                  {!r.approved && (
                    <Badge variant="outline">Awaiting approval</Badge>
                  )}
                  {admin && (
                    <div className="flex gap-1">
                      {!r.approved && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              api(
                                "/chat/rooms/" +
                                  room.id +
                                  "/repositories/" +
                                  r.id,
                                { method: "PUT" },
                              ),
                            )
                          }
                        >
                          Approve
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            api(
                              "/chat/rooms/" +
                                room.id +
                                "/repositories/" +
                                r.id,
                              { method: "DELETE" },
                            ),
                          )
                        }
                      >
                        {r.approved ? "Unlink" : "Reject"}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {admin && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await post("/chat/rooms/" + room.id + "/repositories", {
                      connectionId,
                      fullName,
                    });
                    setFullName("");
                  });
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="repository-connection">
                      GitHub connection
                    </FieldLabel>
                    <Choice
                      id="repository-connection"
                      value={connectionId}
                      onChange={setConnectionId}
                      options={available
                        .filter((c) => c.provider === "github")
                        .map((c) => ({ value: c.id, label: c.name }))}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="repository-name">
                      Repository
                    </FieldLabel>
                    <Input
                      id="repository-name"
                      placeholder="owner/repository"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      required
                    />
                  </Field>
                  <Button disabled={busy || !connectionId} variant="outline">
                    Link repository
                  </Button>
                </FieldGroup>
              </form>
            )}
            <div className="settings-section">
              <h3>Agent credentials</h3>
              <p className="text-sm text-muted-foreground">
                Allow this channel's agents to use a connection. Its token
                becomes available to tasks on your servers. One connection per
                service can be enabled.
              </p>
              {(admin ? available : connections).map((c) => {
                const assigned = connections.find((x) => x.id === c.id);
                return (
                  <div className="repository-row" key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      <small>
                        {c.provider} · {c.identity}
                      </small>
                    </div>
                    {admin ? (
                      <Choice
                        id={"grant-" + c.id}
                        value={
                          assigned?.agent_enabled
                            ? "enabled"
                            : assigned
                              ? "linked"
                              : "none"
                        }
                        onChange={(v) =>
                          void act(() =>
                            api(
                              "/chat/rooms/" + room.id + "/connections/" + c.id,
                              {
                                method: v === "none" ? "DELETE" : "PUT",
                                ...(v === "none"
                                  ? {}
                                  : {
                                      body: JSON.stringify({
                                        agentEnabled: v === "enabled",
                                      }),
                                    }),
                              },
                            ),
                          )
                        }
                        options={[
                          { value: "none", label: "Not connected" },
                          {
                            value: "linked",
                            label: "Connected, no agent access",
                          },
                          { value: "enabled", label: "Agent access enabled" },
                        ]}
                      />
                    ) : (
                      <span>
                        {assigned?.agent_enabled
                          ? "Agent access enabled"
                          : "Connected"}
                      </span>
                    )}
                  </div>
                );
              })}
              {!available.length && admin && (
                <p className="text-sm text-muted-foreground">
                  Add a connection in Settings → Connections.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="issue-workspace">
            <div className="issue-toolbar">
              <Choice
                id="issue-repo"
                value={repoId}
                onChange={(id) => {
                  setRepoId(id);
                  setSelected(null);
                  setCreate(false);
                  setPage(1);
                }}
                options={repos
                  .filter((r) => r.approved)
                  .map((r) => ({ value: r.id, label: r.full_name }))}
              />
              <Choice
                id="issue-state"
                value={state}
                onChange={(v) => {
                  setState(v);
                  setPage(1);
                  setSelected(null);
                }}
                options={[
                  { value: "open", label: "Open" },
                  { value: "closed", label: "Closed" },
                  { value: "all", label: "All" },
                ]}
              />
              {repo && room.joined > 0 && (
                <Button size="sm" onClick={() => edit()}>
                  New issue
                </Button>
              )}
            </div>
            {!repo ? (
              <p>Link a GitHub repository to see its issues.</p>
            ) : create ? (
              issueForm
            ) : selected ? (
              <section className="issue-detail">
                <div className="issue-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected(null)}
                  >
                    Back to issues
                  </Button>
                  <a href={selected.html_url} target="_blank" rel="noreferrer">
                    Open in GitHub
                  </a>
                </div>
                {editing ? (
                  issueForm
                ) : (
                  <>
                    <h2>
                      <span>#{selected.number}</span> {selected.title}
                    </h2>
                    <div className="issue-meta">
                      <Badge variant="outline">{selected.state}</Badge>
                      {selected.labels.map((l) => (
                        <Badge key={l.name} variant="secondary">
                          {l.name}
                        </Badge>
                      ))}
                      <span>
                        {selected.assignees.map((p) => p.login).join(", ")}
                      </span>
                    </div>
                    <div className="markdown">
                      <MessageMarkdown text={selected.body || ""} />
                    </div>
                    {room.joined > 0 && (
                      <div className="issue-actions">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => edit(selected)}
                        >
                          Edit issue
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const value = await api<Issue>(
                                "/chat/repositories/" +
                                  repoId +
                                  "/issues/" +
                                  selected.number,
                                {
                                  method: "PATCH",
                                  body: JSON.stringify({
                                    state:
                                      selected.state === "open"
                                        ? "closed"
                                        : "open",
                                  }),
                                },
                              );
                              setIssues((list) =>
                                list.map((i) =>
                                  i.number === value.number ? value : i,
                                ),
                              );
                              setSelected(value);
                            })
                          }
                        >
                          {selected.state === "open"
                            ? "Close issue"
                            : "Reopen issue"}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const result = await post<{
                                message: TeamMessage;
                              }>("/chat/rooms/" + room.id + "/messages", {
                                id: crypto.randomUUID(),
                                text:
                                  "[" +
                                  repo.full_name +
                                  " #" +
                                  selected.number +
                                  ": " +
                                  selected.title +
                                  "](" +
                                  selected.html_url +
                                  ")\n\n" +
                                  (selected.body || "").slice(0, 28000),
                              });
                              await post(
                                "/chat/repositories/" +
                                  repoId +
                                  "/issues/" +
                                  selected.number +
                                  "/threads",
                                { rootId: result.message.id },
                              );
                              onThread(result.message.id);
                            })
                          }
                        >
                          Work in thread
                        </Button>
                      </div>
                    )}
                    {comments.map((c) => (
                      <article className="issue-comment" key={c.id}>
                        <strong>{c.user.login}</strong>
                        <div className="markdown">
                          <MessageMarkdown text={c.body} />
                        </div>
                      </article>
                    ))}
                    {room.joined > 0 && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act(async () => {
                            const c = await post<IssueComment>(
                              "/chat/repositories/" +
                                repoId +
                                "/issues/" +
                                selected.number +
                                "/comments",
                              { body: comment },
                            );
                            setComments((list) => [...list, c]);
                            setComment("");
                          });
                        }}
                      >
                        <FieldGroup>
                          <Field>
                            <FieldLabel htmlFor="issue-comment">
                              Comment
                            </FieldLabel>
                            <Textarea
                              id="issue-comment"
                              value={comment}
                              onChange={(e) => setComment(e.target.value)}
                              required
                            />
                          </Field>
                          <Button disabled={busy || !comment.trim()} size="sm">
                            Comment
                          </Button>
                        </FieldGroup>
                      </form>
                    )}
                  </>
                )}
              </section>
            ) : loading ? (
              <p>Loading issues…</p>
            ) : (
              <>
                <div className="issue-list">
                  {issues.map((i) => (
                    <button
                      key={i.number}
                      className="issue-row"
                      onClick={() => void view(i)}
                    >
                      <span className="issue-number">#{i.number}</span>
                      <span>
                        <strong>{i.title}</strong>
                        <small>
                          {i.labels.map((l) => l.name).join(", ")}
                          {i.assignees.length
                            ? " · " + i.assignees.map((a) => a.login).join(", ")
                            : ""}
                        </small>
                      </span>
                      <span>{i.comments ? i.comments + " comments" : ""}</span>
                    </button>
                  ))}
                  {!issues.length && <p>No issues in this view.</p>}
                </div>
                <div className="issue-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page === 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <span>Page {page}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!more}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
