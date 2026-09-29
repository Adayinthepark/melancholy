import type { AgentEvent, Attachment } from "./protocol";
export type AgentQuestion = {
  id: string;
  title: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
  freeform?: boolean;
};
export type AgentInteraction = {
  id: string;
  kind: "approval" | "question";
  title: string;
  detail: string;
  questions: AgentQuestion[];
  requestedBy?: string;
  state: "pending" | "sending" | "answered" | "expired";
  response?: InteractionResponse;
  answeredBy?: string;
};
export type InteractionResponse = {
  decision?: "accept" | "decline";
  answers?: Record<string, string[]>;
};
export type AgentArtifact = {
  id: string;
  name: string;
  noteId?: string;
  file?: Attachment;
};
export type AgentPart =
  | { type: "text"; id: string; text: string }
  | {
      type: "activity";
      id: string;
      title: string;
      detail: string;
      status: string;
    }
  | { type: "artifact"; id: string; artifact: AgentArtifact }
  | { type: "interaction"; id: string; interaction: AgentInteraction };

// Stable item IDs retain their first position as streaming snapshots and retries arrive.
export function updateParts(
  parts: AgentPart[],
  event: AgentEvent,
  seq: number,
  previousText: string,
): AgentPart[] {
  let part: AgentPart | undefined;
  if (event.type === "text") {
    if (event.id)
      part = { type: "text", id: "text:" + event.id, text: event.text };
    else if (event.text.startsWith(previousText)) {
      const tail = parts.at(-1),
        delta = event.text.slice(previousText.length);
      if (delta)
        part = {
          type: "text",
          id: tail?.type === "text" ? tail.id : "text:legacy:" + seq,
          text: (tail?.type === "text" ? tail.text : "") + delta,
        };
    } else {
      // Reconcile aggregate snapshots from older connectors without repeating earlier prose.
      let shared = 0;
      while (
        shared < previousText.length &&
        previousText[shared] === event.text[shared]
      )
        shared++;
      let offset = 0;
      parts = parts.map((p) => {
        if (p.type !== "text") return p;
        const keep = Math.max(0, shared - offset);
        offset += p.text.length;
        return { ...p, text: p.text.slice(0, keep) };
      });
      const tail = parts.at(-1);
      const rest = event.text.slice(shared);
      if (rest)
        part = {
          type: "text",
          id: tail?.type === "text" ? tail.id : "text:legacy:" + seq,
          text: (tail?.type === "text" ? tail.text : "") + rest,
        };
    }
  }
  if (event.type === "activity")
    part = {
      type: "activity",
      id: "activity:" + event.id,
      title: event.title,
      detail: event.detail || "",
      status: event.status || "running",
    };
  if (event.type === "artifact")
    part = {
      type: "artifact",
      id: "artifact:" + event.artifact.id,
      artifact: event.artifact,
    };
  if (event.type === "interaction")
    part = {
      type: "interaction",
      id: "interaction:" + event.interaction.id,
      interaction: event.interaction,
    };
  if (event.type === "interaction_resolved")
    return parts.map((p) =>
      p.type === "interaction" && p.interaction.id === event.id
        ? {
            ...p,
            interaction: {
              ...p.interaction,
              state:
                event.outcome ||
                (p.interaction.response ? "answered" : "expired"),
            },
          }
        : p,
    );
  if (["completed", "failed", "cancelled"].includes(event.type))
    return parts.map((p) =>
      p.type === "interaction" &&
      ["pending", "sending"].includes(p.interaction.state)
        ? { ...p, interaction: { ...p.interaction, state: "expired" } }
        : p,
    );
  if (!part) return parts;
  const index = parts.findIndex((p) => p.id === part.id);
  if (index < 0) return [...parts, part];
  return parts.map((p, i) => (i === index ? part! : p));
}
