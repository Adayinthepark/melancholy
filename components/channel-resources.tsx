"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, post } from "@/lib/client";
import type { Connection } from "@/lib/workbench";
import { emptyResources, type ResourceDraft } from "@/lib/projects";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel, FieldGroup } from "./ui/field";
import { Choice } from "./team-settings";
export async function applyResources(roomId: string, draft: ResourceDraft) {
  if (draft.mode !== "none") {
    if (!draft.connectionId || !draft.repository.trim())
      throw new Error("Choose a GitHub connection and repository.");
    if (draft.mode === "link") {
      const linked = await api<{
        repositories: {
          full_name: string;
          integration_id: string;
          approved: number;
        }[];
      }>("/chat/rooms/" + roomId + "/repositories");
      if (
        !linked.repositories.some(
          (r) =>
            r.approved &&
            r.integration_id === draft.connectionId &&
            r.full_name.toLowerCase() === draft.repository.trim().toLowerCase(),
        )
      )
        await post("/chat/rooms/" + roomId + "/repositories", {
          connectionId: draft.connectionId,
          fullName: draft.repository.trim(),
        });
    } else
      await post("/chat/rooms/" + roomId + "/create-repository", {
        connectionId: draft.connectionId,
        name: draft.repository.trim(),
        organization: draft.organization.trim() || undefined,
        private: draft.private,
      });
  }
  for (const worker of draft.workers)
    await post("/chat/rooms/" + roomId + "/workers", worker);
}
export function ResourceFields({
  value,
  onChange,
}: {
  value: ResourceDraft;
  onChange: (v: ResourceDraft) => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]),
    [cf, setCf] = useState(""),
    [scripts, setScripts] = useState<{ name: string }[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api<{ connections: Connection[] }>("/chat/connections")
      .then((r) => {
        if (live) setConnections(r.connections);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setScripts([]);
    if (!cf) return;
    setLoading(true);
    setError("");
    void api<{ workers: { name: string }[] }>(
      "/chat/connections/" + cf + "/workers",
    )
      .then((r) => {
        if (live) setScripts(r.workers);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [cf]);
  const set = (patch: Partial<ResourceDraft>) =>
    onChange({ ...value, ...patch });
  return (
    <FieldGroup className="resource-fields">
      <Field>
        <FieldLabel htmlFor="resource-mode">GitHub repository</FieldLabel>
        <Choice
          id="resource-mode"
          value={value.mode}
          onChange={(v) => set({ mode: v as ResourceDraft["mode"] })}
          options={[
            { value: "none", label: "No repository yet" },
            { value: "link", label: "Link existing repository" },
            { value: "create", label: "Create a repository" },
          ]}
        />
      </Field>
      {value.mode !== "none" && (
        <>
          <Field>
            <FieldLabel htmlFor="resource-github">GitHub connection</FieldLabel>
            <Choice
              id="resource-github"
              value={value.connectionId}
              onChange={(connectionId) => set({ connectionId })}
              options={connections
                .filter((c) => c.provider === "github")
                .map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="resource-repo">
              {value.mode === "link"
                ? "Repository (owner/name)"
                : "New repository name"}
            </FieldLabel>
            <Input
              id="resource-repo"
              value={value.repository}
              onChange={(e) => set({ repository: e.target.value })}
              placeholder={value.mode === "link" ? "owner/project" : "project"}
              required
            />
          </Field>
          {value.mode === "create" && (
            <>
              <Field>
                <FieldLabel htmlFor="resource-org">
                  Organization (optional)
                </FieldLabel>
                <Input
                  id="resource-org"
                  value={value.organization}
                  onChange={(e) => set({ organization: e.target.value })}
                  placeholder="Leave empty for your GitHub account"
                />
              </Field>
              <label className="project-check">
                <input
                  type="checkbox"
                  checked={value.private}
                  onChange={(e) => set({ private: e.target.checked })}
                />
                Private repository
              </label>
              <p className="project-help">
                Creates on GitHub when you save. If this owner/name already
                exists, it will be linked. The connection needs repository
                creation permission.
              </p>
            </>
          )}
        </>
      )}
      <Field>
        <FieldLabel htmlFor="resource-cloudflare">
          Cloudflare Workers (optional)
        </FieldLabel>
        <Choice
          id="resource-cloudflare"
          value={cf || "none"}
          onChange={(v) => setCf(v === "none" ? "" : v)}
          options={[
            { value: "none", label: "Choose an account" },
            ...connections
              .filter((c) => c.provider === "cloudflare")
              .map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      </Field>
      {loading ? (
        <p className="project-help">Loading Workers…</p>
      ) : (
        cf && (
          <div className="worker-picker">
            {scripts.map((w) => (
              <label key={w.name} className="project-check">
                <input
                  type="checkbox"
                  checked={value.workers.some(
                    (s) => s.connectionId === cf && s.scriptName === w.name,
                  )}
                  onChange={(e) =>
                    set({
                      workers: e.target.checked
                        ? [
                            ...value.workers,
                            { connectionId: cf, scriptName: w.name },
                          ]
                        : value.workers.filter(
                            (s) =>
                              s.connectionId !== cf || s.scriptName !== w.name,
                          ),
                    })
                  }
                />
                {w.name}
              </label>
            ))}
            {!scripts.length && !error && (
              <p className="project-help">No Workers found in this account.</p>
            )}
          </div>
        )
      )}
      {!!value.workers.length && (
        <p className="project-help">
          Selected: {value.workers.map((w) => w.scriptName).join(", ")}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!connections.length && !error && (
        <p className="project-help">
          Add GitHub or Cloudflare in{" "}
          <a href="/settings/workspace">workspace settings</a> to link
          resources.
        </p>
      )}
    </FieldGroup>
  );
}
export function ChannelResources({
  roomId,
  admin,
  onChange,
}: {
  roomId: string;
  admin: boolean;
  onChange: () => Promise<void>;
}) {
  const [workers, setWorkers] = useState<
      {
        id: string;
        script_name: string;
        connection_name: string;
        account_id: string;
      }[]
    >([]),
    [draft, setDraft] = useState(emptyResources),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false);
  async function refresh() {
    setWorkers(
      (
        await api<{ workers: typeof workers }>(
          "/chat/rooms/" + roomId + "/workers",
        )
      ).workers,
    );
  }
  useEffect(() => {
    void refresh().catch((e) => toast.error(e.message));
  }, [roomId]);
  return (
    <section className="channel-resource-list">
      <h3>Workers</h3>
      {workers.map((w) => (
        <div className="project-row" key={w.id}>
          <a
            href={
              "https://dash.cloudflare.com/" +
              w.account_id +
              "/workers/services/view/" +
              encodeURIComponent(w.script_name)
            }
            target="_blank"
            rel="noreferrer"
          >
            {w.script_name}
            <small>{w.connection_name}</small>
          </a>
          {admin && (
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                try {
                  await api("/chat/rooms/" + roomId + "/workers/" + w.id, {
                    method: "DELETE",
                  });
                  await refresh();
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Unlink
            </Button>
          )}
        </div>
      ))}
      {!workers.length && <p className="project-help">No linked Workers.</p>}
      {admin && (
        <>
          <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>
            {open
              ? "Close resource setup"
              : "Create repository or link Workers"}
          </Button>
          {open && (
            <form
              className="project-resource-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await applyResources(roomId, draft);
                  setDraft(emptyResources());
                  await refresh();
                  await onChange();
                  setOpen(false);
                  toast.success("Resources linked.");
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ResourceFields value={draft} onChange={setDraft} />
              <Button disabled={busy} size="sm">
                Save resources
              </Button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
