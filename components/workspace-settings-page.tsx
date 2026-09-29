"use client";
import { CasualSettings } from "./casual-chat";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SettingsSkeleton } from "./loading-states";
import { Skeleton } from "./ui/skeleton";
import {
  ArrowLeft,
  Sun,
  Moon,
  SlidersHorizontal,
  Users,
  Cloud,
  GitBranch,
  KeyRound,
  LockKeyhole,
  Server as ServerIcon,
  Bot,
  ChartNoAxesColumn,
  UserRound,
  MessageSquare,
} from "lucide-react";
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
      { id: "general", label: "General", icon: SlidersHorizontal },
      { id: "members", label: "Members", icon: Users },
    ],
  },
  {
    label: "Integrations & credentials",
    items: [
      { id: "cloudflare", label: "Cloudflare", icon: Cloud },
      { id: "github", label: "GitHub", icon: GitBranch },
      { id: "llm", label: "LLM keys", icon: KeyRound },
      { id: "custom", label: "Custom credentials", icon: LockKeyhole },
    ],
  },
  {
    label: "Bot & Agent",
    items: [
      { id: "servers", label: "Servers", icon: ServerIcon },
      { id: "bots", label: "Bots", icon: Bot },
      { id: "casual", label: "Casual chat", icon: MessageSquare },
    ],
  },
  {
    label: "",
    items: [{ id: "usage", label: "Usage", icon: ChartNoAxesColumn }],
  },
];
const details: Record<string, string> = {
  general: "Workspace name and description.",
  members: "People with access to this workspace.",
  cloudflare: "Cloudflare accounts and API tokens.",
  github: "Repository access, issues and coding credentials.",
  llm: "OpenAI compatible, Anthropic compatible, DeepSeek, Kimi and GLM providers.",
  custom: "Service credentials, signing keys and other private values.",
  servers: "Machines running Codex or Claude Code.",
  casual: "Your private workspace steward, powered by an agent you choose.",
  bots: "Cloud agents, connected agents, message API tokens and webhooks.",
  usage:
    "Reported token usage by server, channel and thread. Input includes cached tokens.",
};
export function WorkspaceSettingsPage() {
  const reducedMotion = useReducedMotion();
  const pathname = usePathname();
  const section = pathname.split("/")[3] || "general";
  const [workspace, setWorkspace] = useState<TeamWorkspace | null>(null),
    [signedOut, setSignedOut] = useState(false),
    [error, setError] = useState("");
  const [servers, setServers] = useState<Server[] | null>(null),
    [serverError, setServerError] = useState(""),
    [dark, setDark] = useState(false),
    [profile, setProfile] = useState(false);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const w = await api<TeamWorkspace>("/chat/workspace");
      if (sequence !== refreshSequence.current) return;
      setWorkspace(w);
      setSignedOut(false);
      setError("");
    } catch (e) {
      if (sequence !== refreshSequence.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setSignedOut(true);
        setWorkspace(null);
        setServers(null);
      } else setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    setDark(document.documentElement.classList.contains("dark"));
  }, [refresh, section]);
  async function refreshServers() {
    setServerError("");
    try {
      setServers((await api<{ servers: Server[] }>("/workspace")).servers);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) void refresh();
      else setServerError((e as Error).message);
    }
  }
  useEffect(() => {
    if (workspace?.me.role === "owner" && section === "servers")
      void refreshServers();
  }, [section, workspace?.me.id, workspace?.me.role]);
  if (signedOut) return <Login onLogin={() => void refresh()} />;
  const title = groups
    .flatMap((g) => g.items)
    .find((i) => i.id === section)?.label;
  return (
    <div className="workspace-settings-page">
      <aside className="workspace-settings-nav">
        <Link className="workspace-brand" href="/">
          <span>{workspace?.name || <Skeleton className="h-4 w-24" />}</span>
          <Mark />
        </Link>
        <Link className="settings-back" href="/">
          <ArrowLeft size={16} />
          Back to workspace
        </Link>
        <nav aria-label="Workspace settings">
          {groups.map((g, i) => (
            <div className="settings-nav-group" key={i}>
              {g.label && <span>{g.label}</span>}
              {g.items.map((item) => (
                <Link
                  key={item.id}
                  href={
                    "/settings/workspace" +
                    (item.id === "general" ? "" : "/" + item.id)
                  }
                  aria-current={section === item.id ? "page" : undefined}
                >
                  <item.icon aria-hidden="true" />
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <Button
          variant="ghost"
          className="settings-profile-link"
          disabled={!workspace}
          onClick={() => setProfile(true)}
        >
          <UserRound data-icon="inline-start" />
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
        <motion.div
          className="workspace-settings-content"
          key={section}
          initial={{ opacity: reducedMotion ? 1 : 0.6 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.16 }}
        >
          <h1>{title || "Page not found"}</h1>
          <p className="settings-intro">
            {details[section] || "Choose a settings page from the navigation."}
          </p>
          {error && (
            <p role="alert">
              {error}{" "}
              <Button variant="outline" onClick={() => void refresh()}>
                Retry
              </Button>
            </p>
          )}
          {!workspace ? (
            !error && (
              <SettingsSkeleton
                kind={
                  section === "general"
                    ? "form"
                    : section === "usage"
                      ? "usage"
                      : "list"
                }
              />
            )
          ) : workspace.me.role !== "owner" ? (
            <p>Only the workspace owner can manage these settings.</p>
          ) : (
            <>
              {section === "casual" && (
                <CasualSettings workspace={workspace} onChange={refresh} />
              )}
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
              {section === "servers" &&
                (serverError ? (
                  <p role="alert">
                    {serverError}{" "}
                    <Button
                      variant="outline"
                      onClick={() => void refreshServers()}
                    >
                      Retry
                    </Button>
                  </p>
                ) : servers === null ? (
                  <SettingsSkeleton />
                ) : (
                  <ServerSettings
                    embedded
                    open
                    onOpenChange={() => {}}
                    servers={servers}
                    onChange={refreshServers}
                  />
                ))}
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
            </>
          )}
        </motion.div>
      </main>
      {workspace && (
        <TeamSettings
          open={profile}
          onOpenChange={setProfile}
          workspace={workspace}
          onChange={refresh}
        />
      )}
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
