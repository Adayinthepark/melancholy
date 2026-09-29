"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import type { TeamWorkspace } from "@/lib/chat";
import type { ChannelSuggestion } from "@/lib/projects";
import { Button } from "./ui/button";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Choice } from "./team-settings";
export function CasualSettings({
  workspace,
  onChange,
}: {
  workspace: TeamWorkspace;
  onChange: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(!!workspace.casual?.enabled),
    [bot, setBot] = useState(workspace.casual?.bot_id || ""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="settings-section"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/chat/casual/settings", {
            method: "PUT",
            body: JSON.stringify({ enabled, botId: bot || null }),
          });
          await onChange();
          toast.success("Casual chat settings saved.");
        } catch (e) {
          toast.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        A private place to think aloud. Your steward can read the channels you
        can access and see integration status, then suggest a channel when an
        idea is ready.
      </p>
      <FieldGroup>
        <label className="project-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable Casual chat for workspace members
        </label>
        <Field>
          <FieldLabel htmlFor="casual-agent">Reasoning agent</FieldLabel>
          <Choice
            id="casual-agent"
            value={bot}
            onChange={setBot}
            options={workspace.people
              .filter((p) => p.kind === "bot" && (p.server_id || p.cloud_agent))
              .map((p) => ({
                value: p.id,
                label:
                  p.name + " · " + (p.server_id ? "Server" : "Cloudflare · Pi"),
              }))}
          />
        </Field>
        <p className="project-help">
          Server agents use their existing CLI and environment. Cloudflare
          agents use their configured model key. Each member has a separate
          conversation; changing agents starts a separate history. Existing
          conversations remain available.
        </p>
        {!workspace.people.some((p) => p.server_id || p.cloud_agent) && (
          <p>
            <a href="/settings/workspace/bots">Create an agent bot</a> or{" "}
            <a href="/settings/workspace/servers">connect a Server</a> first.
          </p>
        )}
        <Button disabled={busy || (enabled && !bot)}>Save Casual chat</Button>
      </FieldGroup>
    </form>
  );
}
export function CasualSuggestions({
  roomId,
  revision,
  onCreate,
}: {
  roomId: string;
  revision: number;
  onCreate: (s?: ChannelSuggestion) => void;
}) {
  const [list, setList] = useState<ChannelSuggestion[]>([]);
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const r = await api<{ suggestions: ChannelSuggestion[] }>(
          "/chat/rooms/" + roomId + "/suggestions",
        );
        if (live) setList(r.suggestions);
      } catch {
        /* A failed refresh must not disrupt the conversation. */
      }
    }
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [roomId, revision]);
  return (
    <div className="casual-suggestions">
      <div className="project-toolbar">
        <span className="project-help">
          Private · reads your accessible channels
        </span>
        <Button size="xs" variant="ghost" onClick={() => onCreate()}>
          Create channel from idea
        </Button>
      </div>
      {list.map((s) => (
        <div className="casual-proposal" key={s.id}>
          <div>
            <strong>Explore #{s.name}</strong>
            <p>{s.topic}</p>
          </div>
          <Button size="xs" variant="outline" onClick={() => onCreate(s)}>
            Review channel
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              try {
                await api("/chat/rooms/" + roomId + "/suggestions/" + s.id, {
                  method: "DELETE",
                });
                setList((l) => l.filter((x) => x.id !== s.id));
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          >
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}
