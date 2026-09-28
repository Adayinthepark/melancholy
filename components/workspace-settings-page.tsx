"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, Sun, Moon } from "lucide-react";
import { toast } from "sonner";
import { Mark } from "./brand";
import { Login } from "./login";
import { TeamSettings } from "./team-settings";
import { ServerSettings } from "./server-settings";
import { ConnectionsSettings } from "./connections-settings";
import { UsageDialog } from "./usage-dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { api, ApiError } from "@/lib/client";
import type { TeamWorkspace } from "@/lib/chat";
import type { Server } from "@/lib/protocol";
const groups = [
  {
    label: "Workspace",
    items: [
      { id: "general", label: "General" },
      { id: "members", label: "Members" },
    ],
  },
  {
    label: "Integrations & credentials",
    items: [
      { id: "cloudflare", label: "Cloudflare" },
      { id: "github", label: "GitHub" },
      { id: "llm", label: "LLM keys" },
      { id: "custom", label: "Custom credentials" },
    ],
  },
  {
    label: "Bot & Agent",
    items: [
      { id: "servers", label: "Servers" },
      { id: "bots", label: "Bots" },
    ],
  },
  { label: "", items: [{ id: "usage", label: "Usage" }] },
];
const details: Record<string, string> = {
  general: "Workspace name and description.",
  members: "People with access to this workspace.",
  cloudflare: "Cloudflare accounts and API tokens.",
  github: "Repository access, issues and coding credentials.",
  llm: "OpenAI compatible, Anthropic compatible, DeepSeek, Kimi and GLM providers.",
  custom: "Service credentials, signing keys and other private values.",
  servers: "Machines running Codex or Claude Code.",
  bots: "Bot identities, message API tokens and incoming webhooks.",
  usage:
    "Reported token usage by server, channel and thread. Input includes cached tokens.",
};
export function WorkspaceSettingsPage({ section }: { section: string }) {
  const [workspace, setWorkspace] = useState<TeamWorkspace | null>(null),
    [signedOut, setSignedOut] = useState(false),
    [error, setError] = useState("");
  const [servers, setServers] = useState<Server[]>([]),
    [dark, setDark] = useState(false),
    [profile, setProfile] = useState(false);
  async function refresh() {
    try {
      const w = await api<TeamWorkspace>("/chat/workspace");
      setWorkspace(w);
      setSignedOut(false);
      setError("");
      if (w.me.role === "owner" && section === "servers")
        setServers((await api<{ servers: Server[] }>("/workspace")).servers);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSignedOut(true);
      else setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    setDark(document.documentElement.classList.contains("dark"));
  }, [section]);
  if (signedOut) return <Login onLogin={() => void refresh()} />;
  if (!workspace)
    return (
      <main className="settings-loading">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button onClick={() => void refresh()}>Retry</Button>
          </>
        ) : (
          "Loading…"
        )}
      </main>
    );
  if (workspace.me.role !== "owner")
    return (
      <main className="settings-loading">
        <h1>Workspace settings</h1>
        <p>Only the workspace owner can manage these settings.</p>
        <a href="/">Back to workspace</a>
      </main>
    );
  const title = groups
    .flatMap((g) => g.items)
    .find((i) => i.id === section)?.label;
  return (
    <div className="workspace-settings-page">
      <aside className="workspace-settings-nav">
        <a className="workspace-brand" href="/">
          <span>{workspace.name}</span>
          <Mark />
        </a>
        <a className="settings-back" href="/">
          <ArrowLeft size={16} />
          Back to workspace
        </a>
        <nav aria-label="Workspace settings">
          {groups.map((g, i) => (
            <div className="settings-nav-group" key={i}>
              {g.label && <span>{g.label}</span>}
              {g.items.map((item) => (
                <a
                  key={item.id}
                  href={
                    "/settings/workspace" +
                    (item.id === "general" ? "" : "/" + item.id)
                  }
                  aria-current={section === item.id ? "page" : undefined}
                >
                  {item.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <Button
          variant="ghost"
          className="settings-profile-link"
          onClick={() => setProfile(true)}
        >
          Profile settings
        </Button>
      </aside>
      <main className="workspace-settings-main">
        <header>
          <span>Workspace settings</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle theme"
            onClick={() => {
              const next = !dark;
              setDark(next);
              document.documentElement.classList.toggle("dark", next);
              localStorage.setItem("melancholy-theme", next ? "dark" : "light");
            }}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </header>
        <div className="workspace-settings-content">
          <h1>{title || "Page not found"}</h1>
          <p className="settings-intro">
            {details[section] || "Choose a settings page from the navigation."}
          </p>
          {error && <p role="alert">{error}</p>}
          {section === "general" && (
            <GeneralSettings workspace={workspace} onChange={refresh} />
          )}
          {section === "members" && (
            <TeamSettings
              embedded
              section="members"
              open
              onOpenChange={() => {}}
              workspace={workspace}
              onChange={refresh}
            />
          )}
          {(["github", "cloudflare", "llm", "custom"] as const).map(
            (group) =>
              section === group && (
                <ConnectionsSettings
                  key={group}
                  group={group}
                  workspace={workspace}
                />
              ),
          )}
          {section === "servers" && (
            <ServerSettings
              embedded
              open
              onOpenChange={() => {}}
              servers={servers}
              onChange={refresh}
            />
          )}
          {section === "bots" && (
            <TeamSettings
              embedded
              section="integrations"
              open
              onOpenChange={() => {}}
              workspace={workspace}
              onChange={refresh}
            />
          )}
          {section === "usage" && (
            <UsageDialog embedded open onOpenChange={() => {}} />
          )}
        </div>
      </main>
      <TeamSettings
        open={profile}
        onOpenChange={setProfile}
        workspace={workspace}
        onChange={refresh}
      />
    </div>
  );
}
function GeneralSettings({
  workspace,
  onChange,
}: {
  workspace: TeamWorkspace;
  onChange: () => Promise<void>;
}) {
  const [name, setName] = useState(workspace.name),
    [description, setDescription] = useState(workspace.description || ""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="workspace-general-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/chat/settings", {
            method: "PATCH",
            body: JSON.stringify({ name, description }),
          });
          await onChange();
          toast("Workspace saved");
        } catch (e) {
          toast.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
          <Input
            id="workspace-name"
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="workspace-description">Description</FieldLabel>
          <Textarea
            id="workspace-description"
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </Field>
        <Field>
          <FieldLabel>Workspace URL</FieldLabel>
          <p>{typeof window !== "undefined" ? window.location.origin : ""}</p>
        </Field>
        <Button disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button>
      </FieldGroup>
    </form>
  );
}
