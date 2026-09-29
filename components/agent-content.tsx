"use client";
import { useState } from "react";
import { FileText, Download, ChevronRight, ListChecks } from "lucide-react";
import { Button } from "./ui/button";
import { MessageMarkdown } from "./message-markdown";
import { FieldSet } from "./ui/field";
import { Marker, MarkerContent } from "./ui/marker";
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
} from "./ui/attachment";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/dialog";
import {
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireTitle,
  QuestionnaireChoices,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireInput,
  QuestionnaireError,
  QuestionnaireProgress,
  QuestionnaireActions,
  QuestionnairePrevious,
  QuestionnaireNext,
  QuestionnaireSubmit,
} from "./ui/questionnaire";
import { api, post } from "@/lib/client";
import { formatSize } from "@/lib/file-size";
import type { Person, TeamMessage } from "@/lib/chat";
import type {
  AgentArtifact,
  AgentInteraction,
  AgentPart,
  InteractionResponse,
} from "@/lib/agent-parts";
import type { ChannelNote } from "@/lib/projects";

export function AgentAction({
  part,
}: {
  part: Extract<AgentPart, { type: "activity" }>;
}) {
  return (
    <details className="agent-action">
      <summary>
        <ChevronRight aria-hidden="true" />
        <span>{part.title}</span>
        <span className="agent-action-status">{part.status}</span>
      </summary>
      <pre>
        {part.title}
        {part.detail ? "\n\n" + part.detail : ""}
      </pre>
    </details>
  );
}
export function AgentActions({
  parts,
}: {
  parts: Extract<AgentPart, { type: "activity" }>[];
}) {
  if (!parts.length) return null;
  const running = parts.some((p) =>
    ["running", "pending", "queued"].includes(p.status),
  );
  const failed = parts.some((p) => ["failed", "error"].includes(p.status));
  return (
    <div className="agent-actions" data-agent-part="activity">
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="xs">
            <ListChecks />
            {parts.length} {parts.length === 1 ? "action" : "actions"}
            {running ? " · Running" : failed ? " · Failed" : ""}
            <ChevronRight />
          </Button>
        </DialogTrigger>
        <DialogContent className="agent-actions-dialog">
          <DialogHeader>
            <DialogTitle>Action details</DialogTitle>
            <DialogDescription>
              {parts.length} {parts.length === 1 ? "step" : "steps"} in
              execution order. Expand a step to see its command and output.
            </DialogDescription>
          </DialogHeader>
          <div className="agent-actions-list">
            {parts.map((p) => (
              <AgentAction key={p.id} part={p} />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function DeliveredArtifact({
  artifact,
  roomId,
}: {
  artifact: AgentArtifact;
  roomId: string;
}) {
  const [open, setOpen] = useState(false),
    [note, setNote] = useState<ChannelNote | null>(null),
    [error, setError] = useState("");
  const file = artifact.file;
  async function showNote() {
    setOpen(true);
    setNote(null);
    setError("");
    try {
      setNote(
        await api<ChannelNote>(
          `/chat/rooms/${roomId}/notes/${artifact.noteId}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const card = (
    <Attachment state="done">
      <AttachmentMedia variant="icon">
        {artifact.noteId ? <FileText /> : <Download />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{artifact.name}</AttachmentTitle>
        <AttachmentDescription>
          {artifact.noteId
            ? "Saved to Notes · Open document"
            : file
              ? formatSize(file.size) + " · Download"
              : "Delivery"}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
  return (
    <div className="agent-delivery" data-agent-part="artifact">
      {artifact.noteId ? (
        <button
          type="button"
          className="agent-document-button"
          onClick={() => void showNote()}
        >
          {card}
        </button>
      ) : file ? (
        <a href={"/api/files/" + file.id}>
          {["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            file.type,
          ) && (
            <img
              className="agent-delivery-image"
              src={"/api/files/" + file.id + "?preview=1"}
              alt={file.name}
              loading="lazy"
            />
          )}
          {card}
        </a>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="agent-document-dialog">
          <DialogHeader>
            <DialogTitle>{note?.title || artifact.name}</DialogTitle>
            <DialogDescription>
              Saved in this channel’s Notes. Edits there are reflected here.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : note ? (
            <div className="markdown agent-document-body">
              <MessageMarkdown text={note.content} />
            </div>
          ) : (
            <p role="status">Loading document…</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function AgentQuestionnaire({
  interaction: i,
  message,
  me,
  onChange,
}: {
  interaction: AgentInteraction;
  message: TeamMessage;
  me: Person;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = ["queued", "running"].includes(message.run_status || "");
  const canAnswer = active && (me.role === "owner" || me.id === i.requestedBy);
  const questions =
    i.kind === "approval"
      ? [
          {
            id: "decision",
            title: i.title,
            options: [
              {
                label: "Allow once",
                value: "accept",
                description: "Approve this request only.",
              },
              {
                label: "Decline",
                value: "decline",
                description: "Return the refusal to the agent.",
              },
            ],
            freeform: false,
            multiple: false,
          },
        ]
      : i.questions.map((q) => ({
          ...q,
          options: q.options.map((o) => ({ ...o, value: o.label })),
        }));
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canAnswer) return;
    const form = new FormData(event.currentTarget);
    const response: InteractionResponse =
      i.kind === "approval"
        ? { decision: form.get("decision") as "accept" | "decline" }
        : {
            answers: Object.fromEntries(
              questions.map((q) => [
                q.id,
                form
                  .getAll(q.id)
                  .map(String)
                  .filter((s) => s.trim()),
              ]),
            ),
          };
    setBusy(true);
    setError("");
    try {
      await post(
        `/chat/messages/${message.id}/interactions/${encodeURIComponent(i.id)}`,
        response,
      );
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (i.state !== "pending" || !active)
    return (
      <div className="agent-questionnaire-result" data-agent-part="interaction">
        <Marker variant="border">
          <MarkerContent>
            {i.state === "sending" && active
              ? "Sending answer to the agent…"
              : i.state === "answered"
                ? "Answer sent"
                : "Request closed"}
          </MarkerContent>
        </Marker>
        <span>{i.title}</span>
        {i.response && (
          <p>
            {i.response.decision === "accept"
              ? "Allowed once"
              : i.response.decision === "decline"
                ? "Declined"
                : Object.values(i.response.answers || {})
                    .map((a) => a.join(", "))
                    .join(" · ")}
          </p>
        )}
      </div>
    );
  return (
    <section
      className="agent-questionnaire"
      aria-label={i.title}
      data-agent-part="interaction"
    >
      <Marker>
        <MarkerContent>
          {i.kind === "approval"
            ? "Approval needed"
            : "Waiting for your answer"}
        </MarkerContent>
      </Marker>
      {i.detail && <pre className="agent-request-detail">{i.detail}</pre>}
      <FieldSet disabled={busy || !canAnswer}>
        <Questionnaire
          defaultItem={questions[0]?.id}
          items={questions.map((q) => ({
            name: q.id,
            required: true,
            choices: q.options.map((o) => ({ value: o.value })),
          }))}
          onSubmit={submit}
        >
          {questions.length > 1 && <QuestionnaireProgress />}
          {questions.map((q) => (
            <QuestionnaireItem
              key={q.id}
              name={q.id}
              multiple={q.multiple}
              required
            >
              <QuestionnaireTitle>{q.title}</QuestionnaireTitle>
              <QuestionnaireChoices>
                {q.options.map((o) => (
                  <QuestionnaireChoice key={o.value} value={o.value}>
                    {o.label}
                    {o.description && (
                      <QuestionnaireChoiceDescription>
                        {o.description}
                      </QuestionnaireChoiceDescription>
                    )}
                  </QuestionnaireChoice>
                ))}
                {q.freeform && (
                  <QuestionnaireInput
                    aria-label={"Your answer: " + q.title}
                    placeholder="Type your answer…"
                    maxLength={4000}
                  />
                )}
              </QuestionnaireChoices>
              <QuestionnaireError />
            </QuestionnaireItem>
          ))}
          <QuestionnaireActions>
            <QuestionnairePrevious size="sm" />
            <QuestionnaireNext size="sm" />
            <QuestionnaireSubmit size="sm" disabled={busy || !canAnswer}>
              {busy ? "Sending…" : "Send answer"}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
      </FieldSet>
      {!canAnswer && (
        <p className="text-muted-foreground text-xs">
          The task’s author or a workspace owner can respond.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
export function AgentContent({
  message,
  me,
  onChange,
}: {
  message: TeamMessage;
  me: Person;
  onChange: () => Promise<void>;
}) {
  const groups: (
    | Exclude<AgentPart, { type: "activity" }>
    | {
        type: "actions";
        id: string;
        parts: Extract<AgentPart, { type: "activity" }>[];
      }
  )[] = [];
  for (const part of message.parts || []) {
    if (part.type === "activity") {
      const last = groups.at(-1);
      if (last?.type === "actions") last.parts.push(part);
      else groups.push({ type: "actions", id: part.id, parts: [part] });
    } else groups.push(part);
  }
  return (
    <div className="agent-content">
      {groups.map((p) =>
        p.type === "text" ? (
          <div key={p.id} className="markdown" data-agent-part="text">
            <MessageMarkdown
              text={p.text}
              people={message.mentioned_people}
              refs={message.mention_refs}
            />
          </div>
        ) : p.type === "actions" ? (
          <AgentActions key={p.id} parts={p.parts} />
        ) : p.type === "artifact" ? (
          <DeliveredArtifact
            key={p.id}
            artifact={p.artifact}
            roomId={message.room_id}
          />
        ) : (
          <AgentQuestionnaire
            key={p.id}
            interaction={p.interaction}
            message={message}
            me={me}
            onChange={onChange}
          />
        ),
      )}
    </div>
  );
}
