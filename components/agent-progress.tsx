"use client";
import { useState } from "react";
import { CircleAlert, CircleHelp, Clock3, Loader2, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { post } from "@/lib/client";
import type { AgentRequest, TeamMessage } from "@/lib/chat";

export function isAgentActive(status: AgentRequest["status"]) {
  return ["pending", "queued", "running", "waiting"].includes(status);
}

export function messageProgress(m: TeamMessage): AgentRequest | null {
  if (!m.run_id || !m.run_status || m.deleted_at) return null;
  const waiting = m.parts?.some(
    (p) =>
      p.type === "interaction" &&
      ["pending", "sending"].includes(p.interaction.state),
  );
  return {
    bot_id: m.author_id,
    bot_name: m.author?.name || "Agent",
    status:
      waiting && ["queued", "running"].includes(m.run_status)
        ? "waiting"
        : (m.run_status as AgentRequest["status"]),
    reply_id: m.id,
    error: m.run_error,
  };
}

export function AgentStatus({
  request,
  roomId,
  onChange,
}: {
  request: AgentRequest;
  roomId: string;
  onChange: () => Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);
  const { status, bot_name, reply_id } = request;
  const label = {
    pending: "Queued…",
    queued: "Waiting to start…",
    running: "Working…",
    waiting: "Waiting for input",
    completed: "Completed",
    failed: reply_id ? "Task failed" : "Could not start",
    cancelled: "Stopped",
    dispatched: "Sent to agent",
  }[status];
  const Icon =
    status === "waiting"
      ? CircleHelp
      : status === "failed"
        ? CircleAlert
        : status === "running"
          ? Loader2
          : Clock3;
  async function stop() {
    setStopping(true);
    try {
      await post("/chat/rooms/" + roomId + "/stop", { messageId: reply_id });
      await onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStopping(false);
    }
  }
  return (
    <div className="agent-progress-row" data-state={status}>
      <Icon
        aria-hidden="true"
        className={
          status === "running" ? "motion-safe:animate-spin" : undefined
        }
      />
      <span className="agent-progress-label">
        <strong>{bot_name}</strong>
        <span aria-hidden="true"> · </span>
        {label}
        {status === "failed" && request.error && (
          <span> — {request.error}</span>
        )}
      </span>
      {reply_id && isAgentActive(status) && (
        <Button
          variant="ghost"
          size="xs"
          disabled={stopping}
          aria-label={`Stop ${bot_name} task`}
          onClick={() => void stop()}
        >
          <Square />
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      )}
    </div>
  );
}

// The request lives on the human message, so activity remains visible even
// when the reply is in a closed thread. Prefer a loaded reply during refreshes.
export function AgentProgress({
  messages,
  onChange,
}: {
  messages: TeamMessage[];
  onChange: () => Promise<void>;
}) {
  const items = new Map<string, { request: AgentRequest; roomId: string }>();
  for (const m of messages) {
    if (m.deleted_at) continue;
    for (const request of m.agent_requests || []) {
      items.set(request.reply_id || m.id + ":" + request.bot_id, {
        request,
        roomId: m.room_id,
      });
    }
  }
  for (const m of messages) {
    const request = messageProgress(m);
    if (request) items.set(m.id, { request, roomId: m.room_id });
  }
  const active = [...items].filter(([, item]) =>
    isAgentActive(item.request.status),
  );
  return (
    <div
      className="agent-progress"
      role="status"
      aria-label="Agent status"
      aria-live="polite"
    >
      {active.map(([id, item]) => (
        <AgentStatus key={id} {...item} onChange={onChange} />
      ))}
    </div>
  );
}
