"use client";
import { AgentContent, AgentActions } from "./agent-content";
import { AgentStatus, isAgentActive, messageProgress } from "./agent-progress";
import { AnimatedIcon } from "./animated-icon";
import { useEffect, useRef, useState } from "react";
import { MessageReadTracker } from "./message-read-tracker";
import { MessageMarkdown } from "./message-markdown";
import { FileLink, isMarkdownFile } from "./file-link";
import { PersonAvatar } from "./person-avatar";
import { mentionText, encodeMentions } from "@/lib/mentions";
import {
  SmilePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Link,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import { Bubble, BubbleContent, BubbleReactions } from "@/components/ui/bubble";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
} from "@/components/ui/attachment";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { api, post } from "@/lib/client";
import type { Person, TeamMessage } from "@/lib/chat";
import { formatSize } from "@/lib/file-size";

export function ChatTimeline({
  messages,
  me,
  hasMore,
  onOlder,
  onThread,
  onChange,
  onSaveNote,
  thread = false,
  unreadAfter = 0,
  onRetry,
  onRead,
  focusMessage,
  hasNewer,
  onLatest,
}: {
  messages: TeamMessage[];
  me: Person;
  hasMore: boolean;
  onOlder: () => void;
  onThread: (message: TeamMessage) => void;
  onChange: () => Promise<void>;
  onSaveNote?: (message: TeamMessage) => void;
  thread?: boolean;
  unreadAfter?: number;
  onRetry?: (message: TeamMessage) => void;
  onRead?: (ids: string[]) => Promise<void>;
  focusMessage?: string | null;
  hasNewer?: boolean;
  onLatest?: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const firstUnread = unreadAfter
    ? messages.find((m) => m.seq > unreadAfter && m.author_id !== me.id)?.id
    : null;
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="chat-scroll">
        <MessageScrollerViewport ref={viewport}>
          <MessageScrollerContent className="chat-message-list">
            {hasMore && (
              <MessageScrollerItem messageId="older">
                <div className="flex justify-center">
                  <Button variant="ghost" size="sm" onClick={onOlder}>
                    Load earlier messages
                  </Button>
                </div>
              </MessageScrollerItem>
            )}
            {messages.map((m, i) => {
              const previous = messages[i - 1],
                divider =
                  !previous ||
                  new Date(previous.created_at).toDateString() !==
                    new Date(m.created_at).toDateString();
              return (
                <MessageScrollerItem
                  key={m.id}
                  messageId={m.id}
                  className={
                    m.id === focusMessage ? "message-highlight" : undefined
                  }
                >
                  {divider && (
                    <Marker variant="separator" className="date-marker">
                      <MarkerContent>
                        {new Date(m.created_at).toLocaleDateString(undefined, {
                          month: "long",
                          day: "numeric",
                        })}
                      </MarkerContent>
                    </Marker>
                  )}
                  {m.id === firstUnread && (
                    <Marker variant="border">
                      <MarkerContent>New messages</MarkerContent>
                    </Marker>
                  )}
                  <ChatRow
                    message={m}
                    me={me}
                    onThread={onThread}
                    onChange={onChange}
                    onSaveNote={onSaveNote}
                    thread={thread}
                    onRetry={onRetry}
                  />
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageReadTracker
          viewport={viewport}
          messages={messages}
          onRead={onRead}
        />
        <MessageFocus
          id={focusMessage}
          present={messages.some((m) => m.id === focusMessage)}
        />
        {hasNewer && (
          <Button
            className="chat-latest-context"
            variant="secondary"
            size="sm"
            onClick={onLatest}
          >
            Back to latest messages
          </Button>
        )}
        {!hasNewer && <MessageScrollerButton />}
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
function MessageFocus({
  id,
  present,
}: {
  id?: string | null;
  present: boolean;
}) {
  const { scrollToMessage } = useMessageScroller();
  useEffect(() => {
    if (id && present)
      scrollToMessage(id, { align: "center", behavior: "auto" });
  }, [id, present, scrollToMessage]);
  return null;
}
export function ChatRow({
  message: m,
  me,
  onThread,
  onChange,
  onSaveNote,
  thread = false,
  onRetry,
}: {
  message: TeamMessage;
  me: Person;
  onThread: (m: TeamMessage) => void;
  onChange: () => Promise<void>;
  onSaveNote?: (message: TeamMessage) => void;
  thread?: boolean;
  onRetry?: (message: TeamMessage) => void;
}) {
  const [edit, setEdit] = useState(false),
    [draft, setDraft] = useState(m.text),
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false),
    [reaction, setReaction] = useState(false),
    [customEmoji, setCustomEmoji] = useState("");
  const hasParts = !!m.parts?.length;
  const delivered = new Set(
    m.parts?.flatMap((p) =>
      p.type === "artifact" && p.artifact.file ? [p.artifact.file.id] : [],
    ) || [],
  );
  const attachments = m.attachments.filter((f) => !delivered.has(f.id));
  const progress = messageProgress(m);
  const active = !!progress && isAgentActive(progress.status);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function react(emoji: string, mine = false) {
    setReaction(false);
    void action(() =>
      api("/chat/messages/" + m.id + "/reactions", {
        method: mine ? "DELETE" : "PUT",
        body: JSON.stringify({ emoji }),
      }),
    );
  }
  return (
    <article
      className={
        "chat-row" +
        (m.deleted_at ? " deleted" : "") +
        (m.delivery ? " delivery-" + m.delivery : "")
      }
      data-message-id={m.id}
    >
      <Message align="start">
        <PersonAvatar person={m.author || me} className="chat-avatar" />
        <MessageContent className="gap-0.5">
          <MessageHeader className="chat-message-header">
            <strong>{m.author?.name || "Former member"}</strong>
            {m.author?.kind === "bot" && <Badge variant="outline">bot</Badge>}
            <time dateTime={new Date(m.created_at).toISOString()}>
              {new Date(m.created_at).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            {m.edited_at && !m.deleted_at && <span>edited</span>}
            {m.delivery === "sending" && <em>Sending…</em>}
          </MessageHeader>
          <Bubble variant="ghost" className="chat-bubble">
            <BubbleContent>
              {m.deleted_at ? (
                <p className="text-muted-foreground italic">Message deleted</p>
              ) : (
                <>
                  {hasParts ? (
                    <AgentContent message={m} me={me} onChange={onChange} />
                  ) : (
                    <div className="markdown">
                      <MessageMarkdown
                        text={m.text}
                        people={m.mentioned_people}
                        refs={m.mention_refs}
                      />
                    </div>
                  )}
                  {!!attachments.length && (
                    <div className="chat-attachments">
                      {attachments.map((file) =>
                        [
                          "image/png",
                          "image/jpeg",
                          "image/gif",
                          "image/webp",
                        ].includes(file.type) ? (
                          <a
                            key={file.id}
                            href={"/api/files/" + file.id + "?preview=1"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="chat-image"
                          >
                            <Attachment state="done" orientation="vertical">
                              <AttachmentMedia variant="image">
                                <img
                                  src={"/api/files/" + file.id + "?preview=1"}
                                  alt={file.name}
                                  loading="lazy"
                                />
                              </AttachmentMedia>
                              <AttachmentContent>
                                <AttachmentTitle>{file.name}</AttachmentTitle>
                              </AttachmentContent>
                            </Attachment>
                          </a>
                        ) : (
                          <FileLink
                            key={file.id}
                            file={file}
                            className="chat-file"
                          >
                            <Attachment state="done">
                              <AttachmentMedia variant="icon">
                                <FileText />
                              </AttachmentMedia>
                              <AttachmentContent>
                                <AttachmentTitle>{file.name}</AttachmentTitle>
                                <AttachmentDescription>
                                  {formatSize(file.size)}
                                  {isMarkdownFile(file) && " · Open Markdown"}
                                </AttachmentDescription>
                              </AttachmentContent>
                            </Attachment>
                          </FileLink>
                        ),
                      )}
                    </div>
                  )}
                  {!hasParts && (
                    <AgentActions
                      parts={m.activity.map((a) => ({
                        ...a,
                        type: "activity" as const,
                      }))}
                    />
                  )}
                  {progress && isAgentActive(progress.status) && (
                    <div className="chat-run-state">
                      <AgentStatus
                        request={progress}
                        roomId={m.room_id}
                        onChange={onChange}
                        inline
                      />
                    </div>
                  )}
                  {m.agent_requests
                    ?.filter(
                      (a) =>
                        !a.reply_id &&
                        (isAgentActive(a.status) || a.status === "failed"),
                    )
                    .map((request) => (
                      <div className="chat-run-state" key={request.bot_id}>
                        <AgentStatus
                          request={request}
                          roomId={m.room_id}
                          onChange={onChange}
                          inline
                        />
                      </div>
                    ))}
                  {m.run_status === "failed" && (
                    <p className="form-error">
                      {m.run_error || "Task failed."}
                    </p>
                  )}
                  {m.run_status === "cancelled" && (
                    <p className="text-muted-foreground text-xs">Stopped</p>
                  )}
                </>
              )}
            </BubbleContent>
            {!!m.reactions.length && !m.deleted_at && (
              <BubbleReactions
                className="chat-reactions"
                align="start"
                layout="inline"
              >
                {m.reactions.map((r) => (
                  <Button
                    key={r.emoji}
                    variant={r.mine ? "secondary" : "outline"}
                    size="xs"
                    aria-label={`${r.emoji} ${r.count}`}
                    aria-pressed={r.mine}
                    onClick={() => react(r.emoji, r.mine)}
                  >
                    {r.emoji}
                    <span>{r.count}</span>
                  </Button>
                ))}
              </BubbleReactions>
            )}
          </Bubble>
          {!thread && !m.parent_id && m.reply_count > 0 && (
            <Button
              className="reply-count"
              variant="ghost"
              size="xs"
              onClick={() => onThread(m)}
            >
              <AnimatedIcon name="reply" size={14} />
              {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}
            </Button>
          )}
        </MessageContent>
      </Message>
      {m.delivery === "failed" && (
        <div className="message-send-error" role="alert">
          <span>{m.delivery_error || "Message not sent."}</span>
          <Button size="xs" variant="ghost" onClick={() => onRetry?.(m)}>
            Retry
          </Button>
        </div>
      )}
      {!m.deleted_at && !m.delivery && (
        <div className="chat-row-actions">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Add reaction"
            onClick={() => setReaction(true)}
          >
            <SmilePlus />
          </Button>
          {!thread && !m.parent_id && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Reply in thread"
              onClick={() => onThread(m)}
            >
              <AnimatedIcon name="reply" size={14} />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Message actions"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(
                        location.origin +
                          "/?room=" +
                          m.room_id +
                          "&thread=" +
                          (m.parent_id || m.id),
                      )
                      .then(() => toast("Link copied"));
                  }}
                >
                  <Link />
                  Copy link
                </DropdownMenuItem>
                {onSaveNote && m.text && (
                  <DropdownMenuItem onClick={() => onSaveNote(m)}>
                    <FileText />
                    Save to Notes
                  </DropdownMenuItem>
                )}
                {m.author_id === me.id && (
                  <DropdownMenuItem
                    onClick={() => {
                      setDraft(
                        mentionText(
                          m.text,
                          m.mentioned_people || [],
                          m.mention_refs,
                        ),
                      );
                      setEdit(true);
                    }}
                  >
                    <Pencil />
                    Edit message
                  </DropdownMenuItem>
                )}
                {(m.author_id === me.id || me.role === "owner") && (
                  <DropdownMenuItem
                    disabled={active}
                    onClick={() => setRemove(true)}
                  >
                    <Trash2 />
                    Delete message
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <Dialog open={edit} onOpenChange={setEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit message</DialogTitle>
            <DialogDescription className="sr-only">
              Change the text of your message.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={"edit-" + m.id}>Message text</FieldLabel>
            <Textarea
              id={"edit-" + m.id}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
            />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEdit(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !draft.trim()}
              onClick={() =>
                void action(async () => {
                  await api("/chat/messages/" + m.id, {
                    method: "PATCH",
                    body: JSON.stringify({
                      text: encodeMentions(draft, m.mentioned_people || []),
                    }),
                  });
                  setEdit(false);
                })
              }
            >
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={remove} onOpenChange={setRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete message?</DialogTitle>
            <DialogDescription>
              Replies will remain in the thread.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api("/chat/messages/" + m.id, { method: "DELETE" });
                  setRemove(false);
                })
              }
            >
              Delete message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={reaction} onOpenChange={setReaction}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>Add reaction</DialogTitle>
            <DialogDescription className="sr-only">
              Choose an emoji.
            </DialogDescription>
          </DialogHeader>
          <div className="emoji-grid">
            {[
              "👍",
              "👀",
              "❤️",
              "🎉",
              "✅",
              "🙏",
              "🔥",
              "😂",
              "🚀",
              "🤔",
              "👋",
              "💯",
            ].map((e) => (
              <Button key={e} variant="ghost" onClick={() => react(e)}>
                {e}
              </Button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              react(customEmoji);
            }}
          >
            <Input
              aria-label="Custom emoji"
              placeholder="Emoji"
              maxLength={32}
              value={customEmoji}
              onChange={(e) => setCustomEmoji(e.target.value)}
            />
            <Button disabled={!customEmoji}>Add</Button>
          </form>
        </DialogContent>
      </Dialog>
    </article>
  );
}
