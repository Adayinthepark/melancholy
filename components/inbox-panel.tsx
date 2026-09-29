"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AtSign,
  Check,
  CheckCheck,
  MessageSquare,
  ArrowUpRight,
  Inbox,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import { PersonAvatar } from "./person-avatar";
import { api, post } from "@/lib/client";
import { mentionText } from "@/lib/mentions";
import type { InboxPage, TeamWorkspace, TeamMessage } from "@/lib/chat";

export function InboxPanel({
  workspace,
  onOpen,
  onChange,
}: {
  workspace: TeamWorkspace;
  onOpen: (message: TeamMessage) => void;
  onChange: () => Promise<void>;
}) {
  const [filter, setFilter] = useState("unread");
  const [page, setPage] = useState<InboxPage | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sequence = useRef(0);
  const load = useCallback(
    async (before?: number) => {
      const request = ++sequence.current;
      setLoading(true);
      try {
        const next = await api<InboxPage>(
          "/chat/inbox?filter=" + filter + (before ? "&before=" + before : ""),
        );
        if (request !== sequence.current) return;
        setPage((previous) =>
          before && previous
            ? {
                ...next,
                messages: [
                  ...previous.messages,
                  ...next.messages.filter(
                    (m) => !previous.messages.some((p) => p.id === m.id),
                  ),
                ],
              }
            : next,
        );
        setError("");
      } catch (e) {
        if (request === sequence.current) setError((e as Error).message);
      } finally {
        if (request === sequence.current) setLoading(false);
      }
    },
    [filter],
  );
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load, workspace]);
  async function mark(message?: TeamMessage) {
    if (!page) return;
    setBusy(true);
    try {
      if (message) await post("/chat/read", { messageIds: [message.id] });
      else await post("/chat/inbox/read", { filter, through: page.through });
      await onChange();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="inbox-panel" aria-label="Inbox">
      <Tabs
        value={filter}
        onValueChange={(value) => {
          setPage(null);
          setFilter(value);
        }}
      >
        <div className="inbox-toolbar">
          <TabsList variant="line">
            <TabsTrigger value="unread" disabled={busy}>
              <Inbox />
              Unread
            </TabsTrigger>
            <TabsTrigger value="mentions" disabled={busy}>
              <AtSign />
              Mentions
            </TabsTrigger>
          </TabsList>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void mark()}
            disabled={busy || loading || !page?.messages.some((m) => m.unread)}
          >
            <CheckCheck />
            Mark all as read
          </Button>
        </div>
        <TabsContent value={filter} className="inbox-content">
          {error && (
            <div className="inbox-error">
              <p role="alert">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          )}
          {!page && loading ? (
            <div className="inbox-loading" aria-label="Loading inbox">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : page && !page.messages.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {filter === "unread" ? <CheckCheck /> : <AtSign />}
                </EmptyMedia>
                <EmptyTitle>
                  {filter === "unread"
                    ? "You’re all caught up"
                    : "No mentions yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {filter === "unread"
                    ? "New messages from your conversations will appear here."
                    : "Messages that mention you will appear here."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            page?.messages.map((message) => {
              const room = workspace.rooms.find(
                (r) => r.id === message.room_id,
              );
              const name =
                room?.name ||
                room?.members
                  .filter((p) => p.id !== workspace.me.id)
                  .map((p) => p.name)
                  .join(", ") ||
                "Conversation";
              return (
                <article
                  key={message.id}
                  className={
                    "inbox-message" + (message.unread ? " is-unread" : "")
                  }
                  data-message-id={message.id}
                >
                  <div className="inbox-message-location">
                    <span>
                      {room?.kind === "channel" ? "# " : ""}
                      {name}
                    </span>
                    {message.parent_id && (
                      <span>
                        <MessageSquare />
                        Thread reply
                      </span>
                    )}
                    {!!message.mentioned && (
                      <span>
                        <AtSign />
                        Mention
                      </span>
                    )}
                  </div>
                  <div className="inbox-message-body">
                    <PersonAvatar person={message.author} />
                    <div className="inbox-message-main">
                      <div className="inbox-message-meta">
                        <strong>{message.author.name}</strong>
                        <time
                          dateTime={new Date(message.created_at).toISOString()}
                        >
                          {new Date(message.created_at).toLocaleString(
                            undefined,
                            {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                          )}
                        </time>
                        {message.unread && (
                          <Badge variant="secondary">Unread</Badge>
                        )}
                      </div>
                      <button
                        className="inbox-message-preview"
                        onClick={() => onOpen(message)}
                        aria-label={"Open message from " + message.author.name}
                      >
                        <p>
                          {mentionText(
                            message.text,
                            message.mentioned_people || [],
                            message.mention_refs,
                          ) ||
                            (message.run_status === "running"
                              ? "Agent is working…"
                              : "Shared an attachment")}
                        </p>
                        {!!message.attachments.length && (
                          <span>
                            {message.attachments.map((a) => a.name).join(", ")}
                          </span>
                        )}
                      </button>
                      <div className="inbox-message-actions">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => onOpen(message)}
                        >
                          <ArrowUpRight />
                          Open conversation
                        </Button>
                        {message.unread && (
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() => void mark(message)}
                          >
                            <Check />
                            Mark as read
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })
          )}
          {page?.hasMore && (
            <Button
              className="inbox-more"
              variant="outline"
              disabled={loading}
              onClick={() => void load(page.before!)}
            >
              {loading ? "Loading…" : "Load more"}
            </Button>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
