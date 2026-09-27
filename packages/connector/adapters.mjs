// The CLI controls tools, permissions, authentication and model selection.
// The transport never turns a prompt into a shell command.
export function commandFor(runtime, sessionId, permission = "read-only") {
  if (!["read-only", "workspace-write", "inherit"].includes(permission))
    throw new Error(
      "Permission must be read-only, workspace-write, or inherit.",
    );
  if (runtime === "codex") {
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (permission !== "inherit")
      args.push("-c", `sandbox_mode="${permission}"`);
    if (sessionId) args.push("resume", sessionId);
    args.push("-");
    return { command: "codex", args };
  }
  if (runtime === "claude") {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (permission === "read-only") args.push("--permission-mode", "plan");
    else if (permission === "workspace-write")
      args.push("--permission-mode", "acceptEdits");
    if (sessionId) args.push("--resume", sessionId);
    return { command: "claude", args };
  }
  throw new Error("Runtime must be codex or claude.");
}

export class OutputParser {
  constructor(runtime, onEvent) {
    this.runtime = runtime;
    this.onEvent = onEvent;
    this.sessionId = null;
    this.items = new Map();
    this.text = "";
    this.error = null;
  }
  accept(data) {
    if (this.runtime === "codex") {
      if (data.type === "thread.started") {
        this.sessionId = data.thread_id;
        this.onEvent({ type: "started", sessionId: this.sessionId });
      }
      if (data.type === "turn.failed" || data.type === "error")
        this.error =
          data.error?.message ||
          data.message ||
          "Codex could not complete this turn.";
      const item = data.item;
      if (item?.type === "agent_message") {
        this.items.set(item.id, item.text || "");
        this.text = [...this.items.values()].join("\n\n");
        this.onEvent({ type: "text", text: this.text });
      }
      if (
        item &&
        [
          "command_execution",
          "file_change",
          "mcp_tool_call",
          "web_search",
        ].includes(item.type)
      ) {
        const title =
          item.command ||
          (item.type === "file_change"
            ? "File changes"
            : item.tool || item.query || item.type.replaceAll("_", " "));
        const detail =
          item.aggregated_output ||
          (item.changes
            ? item.changes
                .map((c) => `${c.kind || "edit"} ${c.path}`)
                .join("\n")
            : "");
        this.onEvent({
          type: "activity",
          id: item.id,
          title: title.slice(0, 300),
          detail: detail.slice(-20000),
          status:
            item.status ||
            (data.type === "item.completed" ? "completed" : "running"),
        });
      }
    } else {
      if (data.session_id) this.sessionId = data.session_id;
      if (data.type === "system" && data.subtype === "init")
        this.onEvent({ type: "started", sessionId: this.sessionId });
      if (
        data.type === "stream_event" &&
        data.event?.delta?.type === "text_delta"
      ) {
        this.text += data.event.delta.text;
        this.onEvent({ type: "text", text: this.text });
      }
      if (data.type === "assistant" && !data.parent_tool_use_id) {
        const content = data.message?.content || [];
        const text = content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        if (text && !this.text.endsWith(text)) {
          this.text += (this.text ? "\n\n" : "") + text;
          this.onEvent({ type: "text", text: this.text });
        }
        for (const block of content.filter((c) => c.type === "tool_use"))
          this.onEvent({
            type: "activity",
            id: block.id,
            title: block.name,
            detail: JSON.stringify(block.input).slice(0, 20000),
            status: "running",
          });
      }
      if (data.type === "user")
        for (const block of data.message?.content || []) {
          if (block.type === "tool_result")
            this.onEvent({
              type: "activity",
              id: block.tool_use_id,
              title: "Tool result",
              detail: (typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content)
              ).slice(-20000),
              status: block.is_error ? "failed" : "completed",
            });
        }
      if (data.type === "result") {
        if (data.is_error)
          this.error =
            data.result ||
            data.errors?.join("\n") ||
            "Claude could not complete this turn.";
        else if (data.result) {
          this.text = data.result;
          this.onEvent({ type: "text", text: this.text });
        }
      }
    }
  }
}
