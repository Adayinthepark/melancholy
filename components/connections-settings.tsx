"use client";
import { SettingsSkeleton } from "./loading-states";
import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Choice } from "./team-settings";
import { api } from "@/lib/client";
import type { Connection } from "@/lib/workbench";
import type { TeamWorkspace } from "@/lib/chat";
import { providerPresets, type CredentialProvider } from "@/lib/credentials";
import { toast } from "sonner";
type Group = "github" | "cloudflare" | "llm" | "custom";
export function ConnectionsSettings({
  group,
  workspace,
}: {
  group: Group;
  workspace: TeamWorkspace;
}) {
  const defaultProvider = group === "llm" ? "openai" : group;
  const [connections, setConnections] = useState<Connection[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [provider, setProvider] = useState<string>(defaultProvider),
    [name, setName] = useState(""),
    [token, setToken] = useState(""),
    [accountId, setAccountId] = useState("");
  const [baseUrl, setBaseUrl] = useState(providerPresets.openai.base || ""),
    [fields, setFields] = useState([{ name: "", value: "" }]);
  const [editing, setEditing] = useState<Connection | null>(null),
    [formOpen, setFormOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [removing, setRemoving] = useState("");
  const [access, setAccess] = useState<Connection | null>(null),
    [grants, setGrants] = useState<Record<string, boolean>>({}),
    [grantLoading, setGrantLoading] = useState(false),
    [grantError, setGrantError] = useState("");
  const accessSeq = useRef(0);
  const service = provider === "github" || provider === "cloudflare";
  const preset = providerPresets[provider as CredentialProvider];
  async function refresh() {
    setError("");
    try {
      setConnections(
        (await api<{ connections: Connection[] }>("/chat/connections"))
          .connections,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  function begin(c?: Connection) {
    setEditing(c || null);
    setProvider(c?.provider || defaultProvider);
    setName(c?.name || "");
    setToken("");
    setAccountId(c?.account_id || "");
    setBaseUrl(
      c
        ? ""
        : providerPresets[defaultProvider as CredentialProvider]?.base || "",
    );
    setFields(
      c?.env_keys
        ? JSON.parse(c.env_keys).map((name: string) => ({ name, value: "" }))
        : [{ name: "", value: "" }],
    );
    setFormOpen(true);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = service
        ? {
            provider,
            name,
            token,
            ...(provider === "cloudflare" && accountId ? { accountId } : {}),
          }
        : {
            provider,
            name,
            fields:
              provider === "custom"
                ? fields
                : [
                    { name: preset.key, value: token },
                    ...(baseUrl
                      ? [{ name: preset.baseKey!, value: baseUrl }]
                      : []),
                  ],
          };
      await api("/chat/connections" + (editing ? "/" + editing.id : ""), {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(data),
      });
      setFormOpen(false);
      setToken("");
      setFields([{ name: "", value: "" }]);
      await refresh();
      toast(editing ? "Credential replaced" : "Credential saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openAccess(c: Connection) {
    const sequence = ++accessSeq.current;
    setAccess(c);
    setGrantLoading(true);
    setGrantError("");
    setGrants({});
    try {
      const entries = await Promise.all(
        workspace.rooms
          .filter((r) => r.joined)
          .map(async (r) => {
            const data = await api<{ connections: Connection[] }>(
              "/chat/rooms/" + r.id + "/connections",
            );
            return [
              r.id,
              !!data.connections.find((v) => v.id === c.id)?.agent_enabled,
            ] as const;
          }),
      );
      if (sequence === accessSeq.current)
        setGrants(Object.fromEntries(entries));
    } catch (e) {
      if (sequence === accessSeq.current) setGrantError((e as Error).message);
    } finally {
      if (sequence === accessSeq.current) setGrantLoading(false);
    }
  }
  const visible = connections.filter((c) =>
    group === "llm"
      ? !["github", "cloudflare", "custom"].includes(c.provider)
      : c.provider === group,
  );
  return (
    <div className="settings-section">
      <div className="settings-section-toolbar">
        <p>
          Saved values stay private. Authorize each conversation before an agent
          can use them.
        </p>
        <Button onClick={() => begin()}>
          <Plus data-icon="inline-start" />
          Add credential
        </Button>
      </div>
      {error ? (
        <p role="alert">
          {error}{" "}
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </p>
      ) : loading ? (
        <SettingsSkeleton />
      ) : !visible.length ? (
        <p className="settings-empty">No credentials added.</p>
      ) : (
        <div className="credential-list">
          {visible.map((c) => (
            <div className="credential-row" key={c.id}>
              <div className="credential-description">
                <strong>{c.name}</strong>
                <span>{c.identity}</span>
                {c.env_keys && (
                  <small>
                    {(JSON.parse(c.env_keys) as string[]).join(", ")}
                  </small>
                )}
              </div>
              <div className="credential-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void openAccess(c)}
                >
                  Channel access
                </Button>
                <Button size="sm" variant="ghost" onClick={() => begin(c)}>
                  Replace
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRemoving(c.id)}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={formOpen}
        onOpenChange={(v) => {
          if (!busy) {
            setFormOpen(v);
            if (!v) {
              setToken("");
              setFields([{ name: "", value: "" }]);
            }
          }
        }}
      >
        <DialogContent className="credential-dialog sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Replace credential" : "Add credential"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Enter the complete replacement. Existing channel access is retained."
                : "Values are encrypted when saved and cannot be displayed again."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save}>
            <FieldGroup>
              {group === "llm" && (
                <Field>
                  <FieldLabel htmlFor="connection-provider">
                    Provider
                  </FieldLabel>
                  {editing ? (
                    <p>{preset.label}</p>
                  ) : (
                    <Choice
                      id="connection-provider"
                      value={provider}
                      onChange={(v) => {
                        setProvider(v);
                        setToken("");
                        setBaseUrl(
                          providerPresets[v as CredentialProvider].base || "",
                        );
                      }}
                      options={Object.entries(providerPresets)
                        .filter(([k]) => k !== "custom")
                        .map(([value, p]) => ({ value, label: p.label }))}
                    />
                  )}
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="connection-name">
                  Credential name
                </FieldLabel>
                <Input
                  id="connection-name"
                  required
                  maxLength={60}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              {provider === "custom" ? (
                <>
                  {!editing && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setName(name || "App Store Connect");
                        setFields(
                          [
                            "ASC_KEY_ID",
                            "ASC_ISSUER_ID",
                            "ASC_PRIVATE_KEY",
                          ].map((name) => ({ name, value: "" })),
                        );
                      }}
                    >
                      Use App Store Connect fields
                    </Button>
                  )}
                  {fields.map((field, i) => (
                    <div className="credential-field" key={i}>
                      <Field>
                        <FieldLabel htmlFor={"credential-env-" + i}>
                          Environment variable {i + 1}
                        </FieldLabel>
                        <Input
                          id={"credential-env-" + i}
                          value={field.name}
                          readOnly={!!editing}
                          required
                          placeholder="ASC_PRIVATE_KEY"
                          onChange={(e) =>
                            setFields(
                              fields.map((f, n) =>
                                n === i
                                  ? { ...f, name: e.target.value.toUpperCase() }
                                  : f,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={"credential-value-" + i}>
                          Value {i + 1}
                        </FieldLabel>
                        <Textarea
                          id={"credential-value-" + i}
                          required
                          autoComplete="off"
                          spellCheck={false}
                          value={field.value}
                          onChange={(e) =>
                            setFields(
                              fields.map((f, n) =>
                                n === i ? { ...f, value: e.target.value } : f,
                              ),
                            )
                          }
                          rows={3}
                        />
                        <Input
                          type="file"
                          aria-label={"Load value " + (i + 1) + " from file"}
                          accept=".p8,.pem,.key,.json,.txt"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            if (file.size > 16384) {
                              toast.error("Choose a file under 16 KB.");
                              return;
                            }
                            const value = await file.text();
                            setFields((prev) =>
                              prev.map((f, n) =>
                                n === i ? { ...f, value } : f,
                              ),
                            );
                          }}
                        />
                      </Field>
                      {!editing && fields.length > 1 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setFields(fields.filter((_, n) => n !== i))
                          }
                        >
                          <Trash2 />
                          Remove field
                        </Button>
                      )}
                    </div>
                  ))}
                  {!editing && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={fields.length >= 20}
                      onClick={() =>
                        setFields([...fields, { name: "", value: "" }])
                      }
                    >
                      <Plus />
                      Add field
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Use service-prefixed names ending in _KEY, _TOKEN, _SECRET,
                    _PASSWORD, _ID, _URL, _JSON or _CERTIFICATE. Multiline
                    private keys are preserved.
                  </p>
                </>
              ) : (
                <>
                  <Field>
                    <FieldLabel htmlFor="connection-token">
                      {provider === "github"
                        ? "GitHub token"
                        : provider === "cloudflare"
                          ? "Cloudflare API token"
                          : "API key"}
                    </FieldLabel>
                    <Input
                      id="connection-token"
                      type="password"
                      autoComplete="new-password"
                      required
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                  </Field>
                  {!service && (
                    <Field>
                      <FieldLabel htmlFor="connection-base">
                        API base URL
                      </FieldLabel>
                      <Input
                        id="connection-base"
                        type="url"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        required={
                          !!editing &&
                          !!editing.env_keys &&
                          JSON.parse(editing.env_keys).includes(preset.baseKey)
                        }
                        readOnly={
                          !!editing &&
                          !!editing.env_keys &&
                          !JSON.parse(editing.env_keys).includes(preset.baseKey)
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Exports {preset.key}
                        {baseUrl ? " and " + preset.baseKey : ""}. The agent's
                        model configuration determines how it uses these values.
                      </p>
                    </Field>
                  )}
                  {provider === "cloudflare" && (
                    <Field>
                      <FieldLabel htmlFor="cf-account">Account ID</FieldLabel>
                      <Input
                        id="cf-account"
                        value={accountId}
                        onChange={(e) => setAccountId(e.target.value)}
                        pattern="[a-f0-9]{32}"
                      />
                    </Field>
                  )}
                  {service && (
                    <p className="text-xs text-muted-foreground">
                      {provider === "github"
                        ? "Use a token with repository access and Issues read/write for issue management."
                        : "Use an API token with the account and resource permissions needed for your tasks."}
                    </p>
                  )}
                </>
              )}
              <Button disabled={busy}>
                {busy
                  ? service
                    ? "Checking connection…"
                    : "Saving…"
                  : editing
                    ? "Replace credential"
                    : "Save credential"}
              </Button>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!removing}
        onOpenChange={(v) => {
          if (!v) setRemoving("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove credential?</DialogTitle>
            <DialogDescription>
              Removes all channel grants and any linked repository and issue
              associations. Running tasks may already have received the value.
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/chat/connections/" + removing, {
                  method: "DELETE",
                });
                setRemoving("");
                await refresh();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove credential
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!access}
        onOpenChange={(v) => {
          if (!v) {
            accessSeq.current++;
            setAccess(null);
          }
        }}
      >
        <DialogContent className="credential-dialog">
          <DialogHeader>
            <DialogTitle>Channel access</DialogTitle>
            <DialogDescription>
              {access?.name}. Members of enabled conversations can ask agents to
              use this credential. Changes apply to future task starts.
            </DialogDescription>
          </DialogHeader>
          {grantLoading ? (
            <SettingsSkeleton />
          ) : grantError ? (
            <p role="alert">{grantError}</p>
          ) : (
            <div className="settings-section">
              {workspace.rooms
                .filter((r) => r.joined)
                .map((r) => (
                  <div className="credential-grant" key={r.id}>
                    <span>
                      {r.name ||
                        r.members
                          .filter((p) => p.id !== workspace.me.id)
                          .map((p) => p.name)
                          .join(", ")}
                    </span>
                    <Button
                      size="sm"
                      variant={grants[r.id] ? "secondary" : "outline"}
                      disabled={busy}
                      aria-pressed={!!grants[r.id]}
                      onClick={async () => {
                        setBusy(true);
                        const sequence = accessSeq.current;
                        const enabled = !grants[r.id];
                        try {
                          await api(
                            `/chat/rooms/${r.id}/connections/${access!.id}`,
                            {
                              method: "PUT",
                              body: JSON.stringify({
                                agentEnabled: enabled,
                              }),
                            },
                          );
                          if (sequence === accessSeq.current)
                            setGrants((current) => ({
                              ...current,
                              [r.id]: enabled,
                            }));
                        } catch (e) {
                          toast.error((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {grants[r.id] ? "Enabled" : "Enable"}
                    </Button>
                  </div>
                ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
