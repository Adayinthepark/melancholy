import { commandFor, OutputParser } from "./adapters.mjs";

export function interactiveCommand(runtime, sessionId, permission) {
  const legacy = commandFor(runtime, sessionId, permission); // validates the local policy
  if (runtime === "codex")
    return {
      command: "codex",
      args: [
        "app-server",
        ...(permission === "inherit"
          ? []
          : ["-c", `sandbox_mode="${permission}"`]),
      ],
    };
  return {
    command: legacy.command,
    args: [
      ...legacy.args,
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
    ],
  };
}
const clip = (value, max = 20000) => String(value ?? "").slice(0, max);
const detail = (value) =>
  clip(typeof value === "string" ? value : JSON.stringify(value ?? {}));

// One bidirectional CLI process per run. The original request stays on this server;
// browser replies contain only a scoped decision or answers, never tool arguments.
export class InteractiveSession {
  constructor(
    runtime,
    { send, emit, done, sessionId, cwd, permission, prompt },
  ) {
    Object.assign(this, {
      runtime,
      send,
      emit,
      done,
      sessionId,
      cwd,
      permission,
      prompt,
    });
    this.pending = new Map();
    this.answered = new Map();
    this.texts = new Map();
    this.tools = new Map();
    this.error = null;
    this.finished = false;
    this.turnId = null;
    this.messageId = "message-0";
    this.messageCount = 0;
    this.usageBase = null;
    this.legacy = new OutputParser("claude", (e) => {
      if (e.type === "usage") this.emit(e);
    });
  }
  start() {
    if (this.runtime === "codex")
      this.send({
        id: "init",
        method: "initialize",
        params: {
          clientInfo: { name: "melancholy", version: "0.5.0" },
          capabilities: { experimentalApi: true },
        },
      });
    else
      this.send({
        type: "control_request",
        request_id: "melancholy-init",
        request: { subtype: "initialize", hooks: null },
      });
  }
  finish(error) {
    if (this.finished) return;
    this.finished = true;
    if (error) this.error = clip(error, 2000);
    this.done();
  }
  text(id, text) {
    this.texts.set(id, clip(text, 500000));
    this.emit({ type: "text", id: clip(id, 200), text: this.texts.get(id) });
  }
  activity(id, title, output, status) {
    this.tools.set(id, { title, detail: output, status });
    this.emit({
      type: "activity",
      id: clip(id, 200),
      title: clip(title, 300),
      detail: clip(output),
      status: status === "inProgress" ? "running" : status || "running",
    });
  }
  resolve(id, outcome = this.answered.get(id) || "expired") {
    this.pending.delete(id);
    this.answered.set(id, outcome);
    this.emit({ type: "interaction_resolved", id, outcome });
  }
  request(id, source, interaction) {
    if (this.pending.has(id) || this.answered.has(id)) return;
    this.pending.set(id, { source, interaction });
    this.emit({
      type: "interaction",
      interaction: { id, ...interaction, state: "pending" },
    });
  }
  respond(id, response) {
    if (this.finished) return;
    if (this.answered.has(id)) {
      this.emit({
        type: "interaction_resolved",
        id,
        outcome: this.answered.get(id),
      });
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    const { source, interaction } = pending;
    if (
      interaction.kind === "approval" &&
      !["accept", "decline"].includes(response.decision)
    )
      return;
    if (
      interaction.kind === "question" &&
      interaction.questions.some(
        (q) =>
          !Array.isArray(response.answers?.[q.id]) ||
          !response.answers[q.id].length,
      )
    )
      return;
    if (this.runtime === "codex") {
      let result;
      if (interaction.kind === "question")
        result = {
          answers: Object.fromEntries(
            interaction.questions.map((q) => [
              q.id,
              { answers: response.answers[q.id] },
            ]),
          ),
        };
      else if (source.method === "item/permissions/requestApproval")
        result = {
          permissions:
            response.decision === "accept" ? source.params.permissions : {},
          scope: "turn",
        };
      else result = { decision: response.decision };
      this.send({ id: source.id, result });
    } else {
      const request = source.request;
      const result =
        interaction.kind === "question"
          ? {
              behavior: "allow",
              updatedInput: {
                ...request.input,
                answers: Object.fromEntries(
                  interaction.questions.map((q, index) => [
                    request.input.questions[index].question,
                    response.answers[q.id].join(", "),
                  ]),
                ),
              },
            }
          : response.decision === "accept"
            ? { behavior: "allow", updatedInput: request.input }
            : {
                behavior: "deny",
                message: "The user declined this operation.",
              };
      this.send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: source.request_id,
          response: result,
        },
      });
    }
    this.resolve(id, "answered");
  }
  accept(data) {
    if (this.finished) return;
    if (this.runtime === "codex") this.codex(data);
    else this.claude(data);
  }
  codex(data) {
    if (data.id === "init" && !data.method) {
      if (data.error) return this.finish(data.error.message);
      this.send({ method: "initialized", params: {} });
      this.send({
        id: "thread",
        method: this.sessionId ? "thread/resume" : "thread/start",
        params: {
          cwd: this.cwd,
          ...(this.sessionId ? { threadId: this.sessionId } : {}),
          ...(this.permission === "inherit"
            ? {}
            : { sandbox: this.permission }),
        },
      });
      return;
    }
    if (data.id === "thread" && !data.method) {
      if (data.error) return this.finish(data.error.message);
      this.sessionId = data.result?.thread?.id;
      if (!this.sessionId)
        return this.finish("Codex did not return a thread ID.");
      this.emit({ type: "started", sessionId: this.sessionId });
      this.send({
        id: "turn",
        method: "turn/start",
        params: {
          threadId: this.sessionId,
          input: [{ type: "text", text: this.prompt }],
        },
      });
      return;
    }
    if (data.id === "turn" && !data.method) {
      if (data.error) return this.finish(data.error.message);
      this.turnId = data.result?.turn?.id;
      return;
    }
    const p = data.params || {},
      method = data.method;
    if (p.threadId && this.sessionId && p.threadId !== this.sessionId) {
      if (data.id !== undefined)
        this.send({
          id: data.id,
          error: {
            code: -32602,
            message: "Request belongs to another thread.",
          },
        });
      return;
    }
    if (data.id !== undefined && method) {
      const id = "codex:" + data.id;
      if (
        method === "item/tool/requestUserInput" ||
        method === "tool/requestUserInput"
      ) {
        if (!p.questions?.length || p.questions.some((q) => q.isSecret)) {
          this.send({
            id: data.id,
            error: {
              code: -32602,
              message:
                "Secret input is not collected in shared chat. Configure credentials on the server.",
            },
          });
          return;
        }
        this.request(id, data, {
          kind: "question",
          title: "Input requested",
          detail: "",
          questions: p.questions.map((q) => ({
            id: clip(q.id, 200),
            title: clip(q.question, 2000),
            options: (q.options || []).map((o) => ({
              label: clip(o.label, 500),
              description: clip(o.description, 2000),
            })),
            freeform: !!q.isOther || !q.options?.length,
          })),
        });
      } else if (
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/permissions/requestApproval",
        ].includes(method)
      ) {
        // Never accept session-wide permissions or exec-policy amendments from the browser.
        this.request(id, data, {
          kind: "approval",
          title: method.includes("fileChange")
            ? "Approve file changes"
            : method.includes("permissions")
              ? "Approve requested access for this turn"
              : "Approve command",
          detail: detail({
            reason: p.reason,
            command: p.command,
            cwd: p.cwd,
            changes: this.tools.get(p.itemId)?.detail,
            grantRoot: p.grantRoot,
            network: p.networkApprovalContext,
            permissions: p.permissions,
            additionalPermissions: p.additionalPermissions,
          }),
          questions: [],
        });
      } else {
        this.send({
          id: data.id,
          error: {
            code: -32601,
            message:
              "This interactive request is not supported by the connector.",
          },
        });
        this.activity(
          "unsupported:" + data.id,
          "Unsupported interaction",
          method,
          "failed",
        );
      }
      return;
    }
    if (method === "turn/started") this.turnId = p.turn?.id;
    if (method === "serverRequest/resolved")
      this.resolve("codex:" + p.requestId);
    if (method === "item/agentMessage/delta")
      this.text(p.itemId, (this.texts.get(p.itemId) || "") + p.delta);
    if (["item/started", "item/completed"].includes(method)) {
      const i = p.item || {};
      if (i.type === "agentMessage") this.text(i.id, i.text || "");
      else if (i.type === "plan") this.text(i.id, i.text || "");
      else if (
        [
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "webSearch",
          "dynamicToolCall",
          "collabToolCall",
          "imageView",
        ].includes(i.type)
      ) {
        this.activity(
          i.id,
          i.command ||
            i.tool ||
            i.query ||
            (i.type === "fileChange" ? "File changes" : i.type),
          detail(
            i.aggregatedOutput ??
              i.changes ??
              i.result ??
              i.arguments ??
              i.path ??
              "",
          ),
          i.status || (method === "item/completed" ? "completed" : "running"),
        );
      }
    }
    if (method === "item/commandExecution/outputDelta") {
      const old = this.tools.get(p.itemId);
      if (old)
        this.activity(
          p.itemId,
          old.title,
          (old.detail + p.delta).slice(-20000),
          old.status,
        );
    }
    if (method === "thread/tokenUsage/updated") {
      const total = p.tokenUsage?.total,
        last = p.tokenUsage?.last;
      if (total && last) {
        // Thread counters span resumed turns. Subtract the prior turn's baseline.
        if (!this.usageBase)
          this.usageBase = Object.fromEntries(
            [
              "inputTokens",
              "outputTokens",
              "cachedInputTokens",
              "cacheWriteInputTokens",
            ].map((k) => [k, Math.max(0, (total[k] || 0) - (last[k] || 0))]),
          );
        const delta = (key) =>
          Math.max(0, (total[key] || 0) - this.usageBase[key]);
        this.emit({
          type: "usage",
          usage: {
            inputTokens: delta("inputTokens"),
            outputTokens: delta("outputTokens"),
            cachedTokens: delta("cachedInputTokens"),
            cacheWriteTokens: delta("cacheWriteInputTokens"),
          },
        });
      }
    }
    if (method === "turn/completed")
      this.finish(
        p.turn?.status === "failed"
          ? p.turn.error?.message || "Codex task failed."
          : p.turn?.status === "interrupted"
            ? "Codex task was interrupted."
            : null,
      );
    if (method === "error" && !p.willRetry)
      this.error = p.error?.message || "Codex task failed.";
  }
  claude(data) {
    if (
      data.type === "control_response" &&
      data.response?.request_id === "melancholy-init"
    ) {
      if (data.response.subtype === "error")
        return this.finish(data.response.error);
      this.send({
        type: "user",
        session_id: this.sessionId || "",
        message: { role: "user", content: this.prompt },
        parent_tool_use_id: null,
      });
      return;
    }
    if (data.type === "control_cancel_request") {
      this.resolve("claude:" + data.request_id);
      return;
    }
    if (data.type === "control_request") {
      const r = data.request || {},
        id = "claude:" + data.request_id;
      if (r.subtype !== "can_use_tool") {
        this.send({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: data.request_id,
            error: "Unsupported control request.",
          },
        });
        this.activity(
          "unsupported:" + data.request_id,
          "Unsupported interaction",
          r.subtype || "Unknown request",
          "failed",
        );
        return;
      }
      if (r.tool_name === "AskUserQuestion")
        this.request(id, data, {
          kind: "question",
          title: "Input requested",
          detail: "",
          questions: (r.input?.questions || []).map((q, index) => ({
            id: "q" + index,
            title: clip(q.question, 2000),
            options: (q.options || []).map((o) => ({
              label: clip(o.label, 500),
              description: clip(o.description, 2000),
            })),
            multiple: !!q.multiSelect,
            freeform: true,
          })),
        });
      else
        this.request(id, data, {
          kind: "approval",
          title: clip("Approve " + r.tool_name, 300),
          detail: detail({ reason: r.decision_reason, input: r.input }),
          questions: [],
        });
      return;
    }
    if (data.session_id) this.sessionId = data.session_id;
    if (data.type === "system" && data.subtype === "init")
      this.emit({ type: "started", sessionId: this.sessionId });
    if (data.parent_tool_use_id) return; // nested tool messages stay scoped to their action
    const e = data.event;
    if (data.type === "stream_event" && e) {
      if (e.type === "message_start")
        this.messageId = e.message?.id || "message-" + ++this.messageCount;
      const id = this.messageId + ":" + (e.index || 0);
      if (e.type === "content_block_start" && e.content_block?.type === "text")
        this.text(id, e.content_block.text || "");
      if (e.delta?.type === "text_delta")
        this.text(id, (this.texts.get(id) || "") + e.delta.text);
      if (
        e.type === "content_block_start" &&
        e.content_block?.type === "tool_use"
      )
        this.activity(
          e.content_block.id,
          e.content_block.name,
          detail(e.content_block.input),
          "running",
        );
    }
    if (data.type === "assistant") {
      const id = data.message?.id || this.messageId;
      (data.message?.content || []).forEach((b, index) => {
        if (b.type === "text") this.text(id + ":" + index, b.text);
        if (b.type === "tool_use")
          this.activity(b.id, b.name, detail(b.input), "running");
      });
    }
    if (data.type === "user")
      for (const b of data.message?.content || [])
        if (b.type === "tool_result")
          this.activity(
            b.tool_use_id,
            this.tools.get(b.tool_use_id)?.title || "Tool result",
            detail(b.content),
            b.is_error ? "failed" : "completed",
          );
    if (data.type === "result") {
      this.legacy.accept(data);
      if (!this.texts.size && data.result && !data.is_error)
        this.text("result", data.result);
      this.finish(
        data.is_error
          ? data.result || data.errors?.join("\n") || "Claude task failed."
          : null,
      );
    }
  }
}
