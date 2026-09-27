"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Terminal,
  Loader2,
  Square,
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
import { Bubble, BubbleContent } from "@/components/ui/bubble";
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
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentMedia,
} from "@/components/ui/attachment";
import type { Snapshot } from "@/lib/protocol";

export function Transcript({
  snapshot,
  onOlder,
  loadingOlder,
}: {
  snapshot: Snapshot;
  onOlder: () => void;
  loadingOlder: boolean;
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="transcript">
            {snapshot.hasMore && (
              <MessageScrollerItem messageId="older">
                <div className="flex justify-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={loadingOlder}
                    onClick={onOlder}
                  >
                    {loadingOlder ? "Loading…" : "Load earlier messages"}
                  </Button>
                </div>
              </MessageScrollerItem>
            )}
            {snapshot.messages.map((message, index) => {
              const run = snapshot.runs.find((r) => r.id === message.run_id);
              const activity = snapshot.activity.filter(
                (a) => a.run_id === message.run_id,
              );
              const pending = run && ["queued", "running"].includes(run.status);
              const day = new Date(message.created_at).toLocaleDateString(
                undefined,
                { month: "long", day: "numeric" },
              );
              const previous = snapshot.messages[index - 1];
              const divider =
                !previous ||
                new Date(previous.created_at).toDateString() !==
                  new Date(message.created_at).toDateString();
              return (
                <MessageScrollerItem key={message.id} messageId={message.id}>
                  {divider && (
                    <Marker variant="separator" className="date-marker">
                      <MarkerContent>{day}</MarkerContent>
                    </Marker>
                  )}
                  <Message className="conversation-message">
                    <Avatar className="message-avatar size-8">
                      <AvatarFallback>
                        {message.role === "user"
                          ? "Y"
                          : message.runtime === "claude"
                            ? "A"
                            : "C"}
                      </AvatarFallback>
                    </Avatar>
                    <MessageContent>
                      <MessageHeader className="message-heading">
                        <span className="sender-name">
                          {message.role === "user"
                            ? "You"
                            : message.runtime === "claude"
                              ? "Claude"
                              : "Codex"}
                        </span>
                        {message.role === "assistant" && (
                          <Badge variant="outline">agent</Badge>
                        )}
                        <time
                          dateTime={new Date(message.created_at).toISOString()}
                        >
                          {new Date(message.created_at).toLocaleTimeString(
                            undefined,
                            { hour: "2-digit", minute: "2-digit" },
                          )}
                        </time>
                        {message.text && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="message-copy"
                            aria-label="Copy message"
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(message.text)
                                .then(() => toast("Copied"));
                            }}
                          >
                            <Copy data-icon="inline-start" />
                          </Button>
                        )}
                      </MessageHeader>
                      {message.role === "assistant" && activity.length > 0 && (
                        <details className="activity">
                          <summary>
                            <ChevronRight className="activity-chevron" />
                            <Terminal />
                            <span>
                              {activity.length}{" "}
                              {activity.length === 1 ? "step" : "steps"}
                            </span>
                            <span className="activity-summary">
                              {pending ? "In progress" : "Execution log"}
                            </span>
                          </summary>
                          <div className="activity-list">
                            {activity.map((item) => (
                              <details key={item.id} className="activity-step">
                                <summary>
                                  {["completed", "success"].includes(
                                    item.status,
                                  ) ? (
                                    <Check />
                                  ) : (
                                    <ChevronRight />
                                  )}
                                  <span>{item.title}</span>
                                </summary>
                                {item.detail && <pre>{item.detail}</pre>}
                              </details>
                            ))}
                          </div>
                        </details>
                      )}
                      {message.text && (
                        <Bubble variant="ghost">
                          <BubbleContent>
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
                                  img: ({ src, alt }) => (
                                    <a
                                      href={
                                        typeof src === "string"
                                          ? src
                                          : undefined
                                      }
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      {alt || "Open image"}
                                    </a>
                                  ),
                                }}
                              >
                                {message.text}
                              </ReactMarkdown>
                            </div>
                          </BubbleContent>
                        </Bubble>
                      )}
                      {message.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {message.attachments.map((file) => (
                            <Attachment key={file.id} size="sm" state="done">
                              <AttachmentMedia
                                variant={
                                  file.type.startsWith("image/")
                                    ? "image"
                                    : "icon"
                                }
                              >
                                {[
                                  "image/png",
                                  "image/jpeg",
                                  "image/webp",
                                  "image/gif",
                                ].includes(file.type) ? (
                                  <img
                                    src={`/api/files/${file.id}?preview=1`}
                                    alt={file.name}
                                  />
                                ) : (
                                  <FileText />
                                )}
                              </AttachmentMedia>
                              <AttachmentContent>
                                <AttachmentTitle>{file.name}</AttachmentTitle>
                                <AttachmentDescription>
                                  {formatSize(file.size)}
                                </AttachmentDescription>
                              </AttachmentContent>
                              <AttachmentActions>
                                <AttachmentAction
                                  aria-label={`Download ${file.name}`}
                                  asChild
                                >
                                  <a href={`/api/files/${file.id}`}>
                                    <Download data-icon="inline-start" />
                                  </a>
                                </AttachmentAction>
                              </AttachmentActions>
                            </Attachment>
                          ))}
                        </div>
                      )}
                      {message.role === "assistant" && pending && (
                        <div className="run-state" role="status">
                          <Loader2 className="spin" />
                          {run.status === "queued"
                            ? "Waiting for server"
                            : "Working"}
                        </div>
                      )}
                      {message.role === "assistant" &&
                        run?.status === "failed" && (
                          <div className="run-error" role="alert">
                            {run.error ||
                              "This turn failed. Send a message to try again."}
                          </div>
                        )}
                      {message.role === "assistant" &&
                        run?.status === "cancelled" && (
                          <div className="run-state">
                            <Square />
                            Stopped
                          </div>
                        )}
                      {message.role === "assistant" &&
                        !message.text &&
                        run?.status === "completed" && (
                          <div className="run-state">
                            <Check />
                            Completed without a text response.
                          </div>
                        )}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label="Latest messages" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
export function formatSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
