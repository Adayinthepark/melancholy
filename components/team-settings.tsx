"use client";
import { Textarea } from "./ui/textarea";
import Link from "next/link";
import { SettingsSkeleton } from "./loading-states";
import { DeviceSettings } from "./device-settings";
import { useEffect, useState } from "react";
import { Copy, Plus, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { BotAvatarEditor } from "./bot-avatar-editor";
import { PersonAvatar } from "./person-avatar";
import { api, post } from "@/lib/client";
import type { TeamWorkspace } from "@/lib/chat";
export function Choice({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Select…" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
type Token = {
  id: string;
  bot_id: string;
  room_id: string | null;
  kind: string;
};
export function TeamSettings({
  open,
  onOpenChange,
  workspace,
  onChange,
  section = "profile",
  embedded = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: TeamWorkspace;
  onChange: () => Promise<void>;
  section?: "profile" | "members" | "integrations";
  embedded?: boolean;
}) {
  const tab = section;
  const [name, setName] = useState(workspace.me.name),
    [username, setUsername] = useState(workspace.me.handle),
    [password, setPassword] = useState(""),
    [invite, setInvite] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState("");
  const [botName, setBotName] = useState(""),
    [handle, setHandle] = useState(""),
    [botId, setBotId] = useState(""),
    [kind, setKind] = useState("api"),
    [roomId, setRoomId] = useState("*"),
    [credential, setCredential] = useState(""),
    [tokens, setTokens] = useState<Token[] | null>(null),
    [tokenError, setTokenError] = useState("");
  const [execution, setExecution] = useState("api");
  const [editingBot, setEditingBot] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [maxSteps, setMaxSteps] = useState(40);
  const [modelKeys, setModelKeys] = useState<
    { id: string; name: string; provider: string }[] | null
  >(null);
  const [modelKeyError, setModelKeyError] = useState("");
  const admin = workspace.me.role === "owner",
    bots = workspace.people.filter((p) => p.kind === "bot");
  async function editCloudBot(id: string) {
    setBusy(true);
    try {
      const { bots: configurations } = await api<{
        bots: {
          bot_id: string;
          credential_id: string | null;
          model: string;
          instructions: string;
          max_steps: number;
        }[];
      }>("/chat/cloud-bots");
      const config = configurations.find((c) => c.bot_id === id),
        person = bots.find((p) => p.id === id);
      if (!config || !person) return;
      setEditingBot(id);
      setExecution("cloudflare");
      setBotName(person.name);
      setHandle(person.handle);
      setModelKey(config.credential_id || "");
      setModelName(config.model);
      setInstructions(config.instructions);
      setMaxSteps(config.max_steps);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refreshModelKeys() {
    setModelKeyError("");
    try {
      const result = await api<{
        connections: { id: string; name: string; provider: string }[];
      }>("/chat/connections");
      setModelKeys(
        result.connections.filter((c) =>
          ["openai", "anthropic", "deepseek", "kimi", "glm"].includes(
            c.provider,
          ),
        ),
      );
    } catch (e) {
      setModelKeyError((e as Error).message);
    }
  }
  useEffect(() => {
    if (
      open &&
      admin &&
      section === "integrations" &&
      execution === "cloudflare"
    )
      void refreshModelKeys();
  }, [open, admin, section, execution]);
  async function refreshTokens() {
    if (admin && section === "integrations") {
      setTokenError("");
      try {
        setTokens((await api<{ tokens: Token[] }>("/chat/tokens")).tokens);
      } catch (e) {
        setTokenError((e as Error).message);
      }
    }
  }
  useEffect(() => {
    if (open) {
      setName(workspace.me.name);
      setUsername(workspace.me.handle);
      void refreshTokens().catch((e) => toast.error(e.message));
    } else {
      setInvite("");
      setCredential("");
      setPassword("");
    }
  }, [open, section]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await onChange();
      await refreshTokens();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function secretField(value: string, label: string) {
    return (
      <div className="secret-result">
        <Field>
          <FieldLabel>{label}</FieldLabel>
          <div className="flex gap-2">
            <Input
              value={value}
              readOnly
              aria-label={label}
              onFocus={(e) => e.target.select()}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label={"Copy " + label}
              onClick={() =>
                void navigator.clipboard
                  .writeText(value)
                  .then(() => toast("Copied"))
              }
            >
              <Copy />
            </Button>
          </div>
        </Field>
      </div>
    );
  }
  const content = (
    <>
      {tab === "profile" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("/chat/profile", {
                method: "PATCH",
                body: JSON.stringify({
                  name,
                  handle: username,
                  ...(password ? { password } : {}),
                }),
              });
              setPassword("");
              toast("Profile saved");
            });
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="profile-avatar">Avatar</FieldLabel>
              <div className="profile-avatar-control">
                <PersonAvatar person={workspace.me} />
                <Input
                  id="profile-avatar"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label="Upload avatar"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void act(async () => {
                        await api("/chat/avatar", {
                          method: "POST",
                          headers: { "Content-Type": file.type },
                          body: file,
                        });
                      });
                  }}
                />
                {workspace.me.avatar_key && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void act(() => api("/chat/avatar", { method: "DELETE" }))
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="profile-name">Display name</FieldLabel>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={60}
              />
            </Field>
            <Field>
              <FieldLabel>Username</FieldLabel>
              <Input
                value={username}
                required
                pattern="[a-z][a-z0-9_-]{1,39}"
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                aria-label="Your username"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="profile-password">New password</FieldLabel>
              <Input
                id="profile-password"
                type="password"
                autoComplete="new-password"
                placeholder="At least 12 characters"
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button disabled={busy}>Save profile</Button>
          </FieldGroup>
        </form>
      )}
      {tab === "profile" && <DeviceSettings />}
      {tab === "members" && (
        <div className="settings-section">
          {admin && (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setInvite(
                      (await post<{ url: string }>("/chat/invitations")).url,
                    ),
                  )
                }
              >
                <Plus />
                Create invitation
              </Button>
              {invite && (
                <>
                  {secretField(invite, "Invitation link")}
                  <p className="text-xs text-muted-foreground">
                    Single use. Expires in 7 days.
                  </p>
                </>
              )}
              <Separator />
            </>
          )}
          <div className="settings-member-list">
            {workspace.people
              .filter((p) => p.kind === "human")
              .map((p) => (
                <div key={p.id} className="person-row">
                  <PersonAvatar person={p} />
                  <div className="person-details">
                    <strong>{p.name}</strong>
                    <span>@{p.handle}</span>
                  </div>
                  {p.role === "owner" ? (
                    <Badge variant="outline">owner</Badge>
                  ) : (
                    admin &&
                    (confirm === p.id ? (
                      <Button
                        variant="destructive"
                        size="xs"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api("/chat/people/" + p.id, {
                              method: "DELETE",
                            });
                            setConfirm("");
                          })
                        }
                      >
                        Confirm removal
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={"Remove access for " + p.name}
                        onClick={() => setConfirm(p.id)}
                      >
                        <Trash2 />
                      </Button>
                    ))
                  )}
                </div>
              ))}
          </div>
        </div>
      )}
      {tab === "integrations" && admin && (
        <div className="settings-section">
          <div className="settings-member-list">
            {bots.map((p) => (
              <div key={p.id} className="person-row">
                <PersonAvatar person={p} />
                <div className="person-details">
                  <strong>{p.name}</strong>
                  <span>@{p.handle}</span>
                </div>
                <Badge variant="outline">
                  {p.cloud_agent
                    ? "Cloudflare · Pi"
                    : p.server_id
                      ? "Server"
                      : "API"}
                </Badge>
                <BotAvatarEditor person={p} onChange={onChange} />
                {!!p.cloud_agent && (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => void editCloudBot(p.id)}
                  >
                    Configure
                  </Button>
                )}
              </div>
            ))}
          </div>
          <form
            className="bot-settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                if (editingBot) {
                  await api("/chat/cloud-bots/" + editingBot, {
                    method: "PATCH",
                    body: JSON.stringify({
                      credentialId: modelKey,
                      model: modelName,
                      instructions,
                      maxSteps,
                    }),
                  });
                  setEditingBot("");
                  setBotName("");
                  setHandle("");
                  toast("Bot updated");
                  return;
                }
                const bot = await post<{ id: string }>("/chat/bots", {
                  name: botName,
                  handle,
                  execution,
                  ...(execution === "cloudflare"
                    ? {
                        cloud: {
                          credentialId: modelKey,
                          model: modelName,
                          instructions,
                          maxSteps,
                        },
                      }
                    : {}),
                });
                setBotId(bot.id);
                setBotName("");
                setHandle("");
                toast("Bot created");
              });
            }}
          >
            <FieldGroup>
              <div className="form-two-columns">
                <Field>
                  <FieldLabel htmlFor="bot-name">Bot name</FieldLabel>
                  <Input
                    id="bot-name"
                    disabled={!!editingBot}
                    required
                    value={botName}
                    maxLength={60}
                    onChange={(e) => {
                      setBotName(e.target.value);
                      setHandle(
                        e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9_-]/g, "-")
                          .slice(0, 40),
                      );
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="bot-handle">Bot username</FieldLabel>
                  <Input
                    id="bot-handle"
                    disabled={!!editingBot}
                    required
                    pattern="[a-z][a-z0-9_-]{1,39}"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="bot-execution">Run on</FieldLabel>
                <Choice
                  id="bot-execution"
                  value={execution}
                  onChange={(value) => {
                    if (!editingBot) setExecution(value);
                  }}
                  options={[
                    { value: "api", label: "External bot · API / webhook" },
                    {
                      value: "cloudflare",
                      label: "Cloudflare · built-in Pi (experimental)",
                    },
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  For a server running an agent CLI,{" "}
                  <Link
                    className="underline"
                    href="/settings/workspace/servers"
                  >
                    connect a server
                  </Link>
                  .
                </p>
              </Field>
              {execution === "cloudflare" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Runs without your own server. Includes task planning,
                    persistent files, lightweight shell and JavaScript tools.
                    Full Linux builds and npm are not available in this preview.
                  </p>
                  {modelKeyError ? (
                    <p role="alert">
                      {modelKeyError}{" "}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void refreshModelKeys()}
                      >
                        Retry
                      </Button>
                    </p>
                  ) : modelKeys === null ? (
                    <SettingsSkeleton />
                  ) : modelKeys.length === 0 ? (
                    <p>
                      <Link
                        className="underline"
                        href="/settings/workspace/llm"
                      >
                        Add an LLM key
                      </Link>{" "}
                      to create a cloud agent.
                    </p>
                  ) : (
                    <Field>
                      <FieldLabel htmlFor="bot-model-key">LLM key</FieldLabel>
                      <Choice
                        id="bot-model-key"
                        value={modelKey}
                        onChange={setModelKey}
                        options={modelKeys.map((c) => ({
                          value: c.id,
                          label: c.name + " · " + c.provider,
                        }))}
                      />
                      <p className="text-xs text-muted-foreground">
                        This bot uses the selected key in conversations it
                        joins. Model charges go to that provider account;
                        Cloudflare usage is billed separately.
                      </p>
                    </Field>
                  )}
                  <Field>
                    <FieldLabel htmlFor="bot-model">Model ID</FieldLabel>
                    <Input
                      id="bot-model"
                      disabled={busy}
                      required
                      value={modelName}
                      onChange={(e) => setModelName(e.target.value)}
                      maxLength={120}
                      placeholder="Exact model ID from your provider"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="bot-instructions">
                      Instructions
                    </FieldLabel>
                    <Textarea
                      id="bot-instructions"
                      disabled={busy}
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      maxLength={12000}
                      placeholder="What this agent should do and how it should work"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="bot-max-steps">
                      Maximum model steps per task
                    </FieldLabel>
                    <Input
                      id="bot-max-steps"
                      disabled={busy}
                      type="number"
                      min={1}
                      max={100}
                      value={maxSteps}
                      onChange={(e) => setMaxSteps(Number(e.target.value))}
                    />
                    <p className="text-xs text-muted-foreground">
                      Tasks stop after this limit or 10 minutes. Send a
                      follow-up to continue.
                    </p>
                  </Field>
                </>
              )}
              <Button
                variant="outline"
                disabled={
                  busy ||
                  (execution === "cloudflare" &&
                    (!modelKey || !modelName.trim()))
                }
              >
                {editingBot ? "Save bot" : "Create bot"}
              </Button>
              {editingBot && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditingBot("");
                    setBotName("");
                    setHandle("");
                  }}
                >
                  Cancel
                </Button>
              )}
            </FieldGroup>
          </form>
          {bots.length > 0 && (
            <>
              <Separator />
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const result = await post<{
                      token: string;
                      url?: string;
                    }>("/chat/tokens", {
                      botId,
                      kind,
                      ...(roomId !== "*" ? { roomId } : {}),
                    });
                    setCredential(result.url || result.token);
                  });
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="token-bot">Bot</FieldLabel>
                    <Choice
                      id="token-bot"
                      value={botId}
                      onChange={(v) => {
                        setBotId(v);
                        setRoomId("*");
                      }}
                      options={bots.map((p) => ({
                        value: p.id,
                        label: p.name + " (@" + p.handle + ")",
                      }))}
                    />
                  </Field>
                  <div className="form-two-columns">
                    <Field>
                      <FieldLabel htmlFor="token-kind">Credential</FieldLabel>
                      <Choice
                        id="token-kind"
                        value={kind}
                        onChange={setKind}
                        options={[
                          { value: "api", label: "API token" },
                          { value: "webhook", label: "Incoming webhook" },
                        ]}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="token-room">Conversation</FieldLabel>
                      <Choice
                        id="token-room"
                        value={roomId}
                        onChange={setRoomId}
                        options={[
                          {
                            value: "*",
                            label:
                              kind === "webhook"
                                ? "Choose a conversation"
                                : "All joined conversations",
                          },
                          ...workspace.rooms
                            .filter(
                              (r) =>
                                r.joined &&
                                r.members.some((p) => p.id === botId),
                            )
                            .map((r) => ({
                              value: r.id,
                              label:
                                r.name ||
                                r.members.map((p) => p.name).join(", "),
                            })),
                        ]}
                      />
                    </Field>
                  </div>
                  <Button
                    disabled={
                      busy || !botId || (kind === "webhook" && roomId === "*")
                    }
                  >
                    Create credential
                  </Button>
                </FieldGroup>
              </form>
              {credential && (
                <>
                  {secretField(credential, "New credential")}
                  <p className="text-xs text-muted-foreground">
                    Shown once. Keep it private.
                  </p>
                </>
              )}
            </>
          )}
          {tab === "integrations" && tokenError && (
            <p role="alert">
              {tokenError}{" "}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshTokens()}
              >
                Retry
              </Button>
            </p>
          )}
          {tab === "integrations" && tokens === null && !tokenError && (
            <SettingsSkeleton />
          )}
          {!!tokens?.length && (
            <>
              <Separator />
              <div className="settings-member-list">
                {tokens!.map((t) => (
                  <div key={t.id} className="person-row">
                    <div className="person-details">
                      <strong>
                        {bots.find((p) => p.id === t.bot_id)?.name || "Bot"}
                      </strong>
                      <span>
                        {t.kind === "webhook" ? "Webhook" : "API token"}
                        {t.room_id
                          ? " · " +
                            (workspace.rooms.find((r) => r.id === t.room_id)
                              ?.name || "Conversation")
                          : ""}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          api("/chat/tokens/" + t.id, { method: "DELETE" }),
                        )
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
          <a
            className="text-xs underline"
            href="https://github.com/adayinthepark/melancholy/blob/main/docs/bot-api.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            Bot API documentation
          </a>
        </div>
      )}
    </>
  );
  if (embedded) return content;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="team-settings sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Profile settings</DialogTitle>
          <DialogDescription className="sr-only">
            Your avatar, name, username and password.
          </DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
