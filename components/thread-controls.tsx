"use client";
import { AnimatedIcon } from "./animated-icon";
import { useEffect, useState } from "react";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Choice } from "./team-settings";
import { api } from "@/lib/client";
import type { Person } from "@/lib/chat";
import { toast } from "sonner";
import { UsageDialog } from "./usage-dialog";
export function ThreadControls({
  id,
  roomId,
  people,
  focused,
}: {
  id: string;
  roomId: string;
  people: Person[];
  focused: boolean;
}) {
  const [bot, setBot] = useState("*"),
    [busy, setBusy] = useState(false),
    [usage, setUsage] = useState(false);
  useEffect(() => {
    let live = true;
    void api<{ bot_id: string | null }>("/chat/threads/" + id + "/preferences")
      .then((r) => {
        if (live) setBot(r.bot_id || "*");
      })
      .catch((e) => toast.error(e.message));
    return () => {
      live = false;
    };
  }, [id]);
  const options = people.filter((p) => p.kind === "bot" && p.server_id);
  return (
    <div className="thread-controls">
      {options.length > 0 && (
        <div className="thread-auto">
          <label htmlFor={"auto-" + id}>Auto trigger</label>
          <fieldset disabled={busy}>
            <Choice
              id={"auto-" + id}
              value={bot}
              onChange={(value) => {
                setBusy(true);
                void api("/chat/threads/" + id + "/preferences", {
                  method: "PUT",
                  body: JSON.stringify({ botId: value === "*" ? null : value }),
                })
                  .then(() => setBot(value))
                  .catch((e) => toast.error(e.message))
                  .finally(() => setBusy(false));
              }}
              options={[
                { value: "*", label: "Off" },
                ...options.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
          </fieldset>
        </div>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Thread token usage"
        onClick={() => setUsage(true)}
      >
        <BarChart3 />
      </Button>
      <Button variant="ghost" size="icon-sm" asChild>
        <a
          href={
            focused ? "/?room=" + roomId + "&thread=" + id : "/thread/" + id
          }
          aria-label={focused ? "Back to channel" : "Open thread page"}
        >
          {focused ? <ArrowLeft /> : <AnimatedIcon name="expand" />}
        </a>
      </Button>
      <UsageDialog
        open={usage}
        onOpenChange={setUsage}
        roomId={roomId}
        threadId={id}
      />
    </div>
  );
}
