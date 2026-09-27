"use client";
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
  onServers,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: TeamWorkspace;
  onChange: () => Promise<void>;
  onServers: () => void;
}) {
  const [tab, setTab] = useState("profile"),
    [name, setName] = useState(workspace.me.name),
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
    [tokens, setTokens] = useState<Token[]>([]);
  const admin = workspace.me.role === "owner",
    bots = workspace.people.filter((p) => p.kind === "bot");
  async function refreshTokens() {
    if (admin)
      setTokens((await api<{ tokens: Token[] }>("/chat/tokens")).tokens);
  }
  useEffect(() => {
    if (open) {
      setName(workspace.me.name);
      void refreshTokens().catch((e) => toast.error(e.message));
    } else {
      setInvite("");
      setCredential("");
      setPassword("");
    }
  }, [open]);
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="team-settings sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Workspace settings</DialogTitle>
          <DialogDescription className="sr-only">
            Your profile, workspace members, and bot integrations.
          </DialogDescription>
        </DialogHeader>
        <div className="settings-tabs" role="tablist">
          {["profile", "members", ...(admin ? ["integrations"] : [])].map(
            (t) => (
              <Button
                role="tab"
                aria-selected={tab === t}
                key={t}
                size="sm"
                variant={tab === t ? "secondary" : "ghost"}
                onClick={() => setTab(t)}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </Button>
            ),
          )}
        </div>
        {tab === "profile" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api("/chat/profile", {
                  method: "PATCH",
                  body: JSON.stringify({
                    name,
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
                  readOnly
                  value={workspace.me.handle}
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
                    <div>
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
            <Button variant="outline" onClick={onServers}>
              <Server />
              Connect an agent server
            </Button>
            <p className="text-xs text-muted-foreground">
              Add the bot to a channel, then @mention it. Direct messages also
              start agent tasks.
            </p>
            <Separator />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const bot = await post<{ id: string }>("/chat/bots", {
                    name: botName,
                    handle,
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
                      required
                      pattern="[a-z][a-z0-9_-]{1,39}"
                      value={handle}
                      onChange={(e) => setHandle(e.target.value)}
                    />
                  </Field>
                </div>
                <Button variant="outline" disabled={busy}>
                  Create bot
                </Button>
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
                        <FieldLabel htmlFor="token-room">
                          Conversation
                        </FieldLabel>
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
            {tokens.length > 0 && (
              <>
                <Separator />
                <div className="settings-member-list">
                  {tokens.map((t) => (
                    <div key={t.id} className="person-row">
                      <div>
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
            <a className="text-xs text-muted-foreground" href="/legacy">
              Earlier agent conversations
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
