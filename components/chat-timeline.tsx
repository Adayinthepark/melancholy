"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  MessageSquare,
  SmilePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Link,
  FileText,
  Square,
  ChevronRight,
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
import { formatSize } from "./transcript";

export function ChatTimeline({
  messages,
  me,
  hasMore,
  onOlder,
  onThread,
  onChange,
  thread = false,
  unreadAfter = 0,
}: {
  messages: TeamMessage[];
  me: Person;
  hasMore: boolean;
  onOlder: () => void;
  onThread: (message: TeamMessage) => void;
  onChange: () => Promise<void>;
  thread?: boolean;
  unreadAfter?: number;
}) {
  const firstUnread = unreadAfter
    ? messages.find((m) => m.seq > unreadAfter && m.author_id !== me.id)?.id
    : null;
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="chat-scroll">
        <MessageScrollerViewport>
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
                <MessageScrollerItem key={m.id} messageId={m.id}>
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
                    thread={thread}
                  />
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
export function ChatRow({
  message: m,
  me,
  onThread,
  onChange,
  thread = false,
}: {
  message: TeamMessage;
  me: Person;
  onThread: (m: TeamMessage) => void;
  onChange: () => Promise<void>;
  thread?: boolean;
}) {
  const [edit, setEdit] = useState(false),
    [draft, setDraft] = useState(m.text),
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false),
    [reaction, setReaction] = useState(false),
    [customEmoji, setCustomEmoji] = useState("");
  const active = m.run_status === "queued" || m.run_status === "running";
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
      className={"chat-row" + (m.deleted_at ? " deleted" : "")}
      data-message-id={m.id}
    >
      <Message align="start">
        <Avatar className="chat-avatar">
          <AvatarFallback>
            {m.author?.name.slice(0, 2).toUpperCase() || "?"}
          </AvatarFallback>
        </Avatar>
        <MessageContent>
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
          </MessageHeader>
          <Bubble variant="ghost" className="chat-bubble">
            <BubbleContent>
              {m.deleted_at ? (
                <p className="text-muted-foreground italic">Message deleted</p>
              ) : (
                <>
                  <div className="markdown">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ children, ...props }) => (
                          <a
                            {...props}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {m.text}
                    </ReactMarkdown>
                  </div>
                  {!!m.attachments.length && (
                    <div className="chat-attachments">
                      {m.attachments.map((file) =>
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
                          <a
                            key={file.id}
                            href={"/api/files/" + file.id}
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
                                </AttachmentDescription>
                              </AttachmentContent>
                            </Attachment>
                          </a>
                        ),
                      )}
                    </div>
                  )}
                  {!!m.activity.length && (
                    <details className="chat-tool-log">
                      <summary>
                        <ChevronRight />
                        {m.activity.length}{" "}
                        {m.activity.length === 1 ? "step" : "steps"}
                      </summary>
                      {m.activity.map((a) => (
                        <details key={a.id}>
                          <summary>
                            {a.title}
                            <span>{a.status}</span>
                          </summary>
                          {a.detail && <pre>{a.detail}</pre>}
                        </details>
                      ))}
                    </details>
                  )}
                  {active && (
                    <div className="chat-run-state">
                      <span>
                        {m.run_status === "queued"
                          ? "Waiting for server"
                          : "Working…"}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-label="Stop task"
                        onClick={() =>
                          void action(() =>
                            post("/chat/rooms/" + m.room_id + "/stop", {
                              messageId: m.id,
                            }),
                          )
                        }
                      >
                        <Square />
                        Stop
                      </Button>
                    </div>
                  )}
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
              <BubbleReactions className="chat-reactions" align="start">
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
              <MessageSquare />
              {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}
            </Button>
          )}
        </MessageContent>
      </Message>
      {!m.deleted_at && (
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
              <MessageSquare />
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
                {m.author_id === me.id && (
                  <DropdownMenuItem
                    onClick={() => {
                      setDraft(m.text);
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
                    body: JSON.stringify({ text: draft }),
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
