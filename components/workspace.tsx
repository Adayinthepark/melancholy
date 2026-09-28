"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  ArrowUp,
  Hash,
  Plus,
  Search,
  Settings2,
  Sun,
  Moon,
  PanelLeft,
  MoreHorizontal,
  MessageSquare,
  SquarePen,
  Server as ServerIcon,
  ChevronDown,
  Paperclip,
  X,
  Square,
  Download,
  Archive,
  Pencil,
  LogOut,
  CodeXml,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { Mark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Login } from "./login";
import { ServerSettings } from "./server-settings";
import { Transcript, formatSize } from "./transcript";
import { api, post, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { Workspace, Thread, Snapshot, Attachment } from "@/lib/protocol";

const blank: Snapshot = {
  messages: [],
  runs: [],
  activity: [],
  hasMore: false,
};
type SearchResult = {
  thread_id: string;
  message_id: string;
  title: string;
  text: string;
  channel_id: string;
};

export function WorkspaceApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState("");
  const [channelId, setChannelId] = useState("general");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [serverId, setServerId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(blank);
  const [loadingThread, setLoadingThread] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connection, setConnection] = useState("connected");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dark, setDark] = useState(false);
  const [settings, setSettings] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [channelDialog, setChannelDialog] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<{
    id: string;
    text: string;
    threadId: string;
    attachments: string[];
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const value = await api<Workspace>("/workspace");
      setWorkspace(value);
      setSignedIn(true);
      setLoadError("");
      setServerId((id) => id || value.servers[0]?.id || "");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSignedIn(false);
        setWorkspace(null);
      } else setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    setDark(document.documentElement.classList.contains("dark"));
    const params = new URLSearchParams(window.location.search);
    if (params.get("thread")) setThreadId(params.get("thread"));
  }, [refresh]);
  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [signedIn, refresh]);
  const current = workspace?.threads.find((t) => t.id === threadId);
  const channel = workspace?.channels.find(
    (c) => c.id === (current?.channel_id || channelId),
  );
  const selectedServer = workspace?.servers.find(
    (s) => s.id === (current?.server_id || serverId),
  );
  const running = snapshot.runs.some((r) =>
    ["queued", "running"].includes(r.status),
  );

  useEffect(() => {
    if (!threadId || !signedIn) {
      setSnapshot(blank);
      return;
    }
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;
    setSnapshot(blank);
    setLoadingThread(true);
    function connect() {
      if (closed) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/threads/${threadId}/socket`,
      );
      socket.onopen = () => {
        attempts = 0;
        setConnection("connected");
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
        }, 25000);
      };
      socket.onmessage = (event) => {
        if (closed || event.data === "pong") return;
        try {
          const value = JSON.parse(event.data);
          if (value.type === "snapshot") {
            setSnapshot((previous) => {
              const first = value.messages[0]?.created_at;
              const older =
                first === undefined
                  ? []
                  : previous.messages.filter(
                      (message) => message.created_at < first,
                    );
              if (!older.length) return value;
              const known = new Set(
                previous.messages.map((message) => message.id),
              );
              // A long disconnect can leave a gap between pages. Reload the
              // latest page in that case so pagination can fill it normally.
              if (
                !value.messages.some((message: Snapshot["messages"][number]) =>
                  known.has(message.id),
                )
              )
                return value;
              const runs = new Map(previous.runs.map((run) => [run.id, run]));
              for (const run of value.runs) runs.set(run.id, run);
              const activity = new Map(
                previous.activity.map((item) => [item.id, item]),
              );
              for (const item of value.activity) activity.set(item.id, item);
              return {
                ...value,
                messages: [...older, ...value.messages],
                runs: [...runs.values()],
                activity: [...activity.values()],
                hasMore: previous.hasMore,
              };
            });
            setLoadingThread(false);
          }
        } catch {
          /* Ignore unknown frames. */
        }
      };
      socket.onclose = () => {
        clearInterval(heartbeat);
        if (!closed) {
          setConnection("reconnecting");
          retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** attempts++));
        }
      };
      socket.onerror = () => socket?.close();
    }
    // HTTP provides an explicit auth/error result when a WebSocket upgrade is rejected.
    void api<Snapshot>(`/threads/${threadId}/messages`)
      .then((value) => {
        if (!closed) {
          setSnapshot(value);
          setLoadingThread(false);
          connect();
        }
      })
      .catch((e) => {
        if (closed) return;
        setLoadingThread(false);
        if (e instanceof ApiError && e.status === 401) setSignedIn(false);
        else {
          toast.error(e.message);
          setThreadId(null);
        }
      });
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      socket?.close();
    };
  }, [threadId, signedIn]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        newThread();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (!searchOpen || !query.trim()) {
      setSearchResults([]);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void api<{ results: SearchResult[] }>(
        `/search?q=${encodeURIComponent(query)}`,
      )
        .then((data) => {
          if (active) setSearchResults(data.results);
        })
        .catch((e) => {
          if (active) toast.error(e.message);
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, searchOpen]);

  function chooseThread(id: string) {
    setThreadId(id);
    setDraft("");
    setAttachments([]);
    pending.current = null;
    setMobile(false);
    history.replaceState(null, "", `?thread=${id}`);
  }
  function newThread() {
    setThreadId(null);
    setDraft("");
    setAttachments([]);
    pending.current = null;
    setMobile(false);
    history.replaceState(null, "", location.pathname);
    setTimeout(() => composer.current?.focus(), 0);
  }
  function chooseChannel(id: string) {
    setChannelId(id);
    newThread();
  }
  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("melancholy-theme", next ? "dark" : "light");
  }
  async function ensureThread() {
    if (threadId) return threadId;
    if (!selectedServer) {
      setSettings(true);
      throw new Error("Connect a server first.");
    }
    const created = await post<Thread>("/threads", {
      channelId,
      serverId: selectedServer.id,
    });
    setThreadId(created.id);
    history.replaceState(null, "", `?thread=${created.id}`);
    await refresh();
    return created.id;
  }
  async function send() {
    if (!draft.trim() || sending || running || uploading) return;
    setSending(true);
    try {
      const id = await ensureThread();
      const ids = attachments.map((a) => a.id);
      if (
        !pending.current ||
        pending.current.threadId !== id ||
        pending.current.text !== draft.trim() ||
        JSON.stringify(pending.current.attachments) !== JSON.stringify(ids)
      )
        pending.current = {
          id: crypto.randomUUID(),
          threadId: id,
          text: draft.trim(),
          attachments: ids,
        };
      await post(`/threads/${id}/messages`, pending.current);
      setDraft("");
      setAttachments([]);
      pending.current = null;
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
      composer.current?.focus();
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      const id = await ensureThread();
      for (const file of Array.from(files).slice(0, 8 - attachments.length)) {
        if (file.size > 10 * 1024 * 1024)
          throw new Error("Files must be 10 MB or smaller.");
        const form = new FormData();
        form.set("file", file);
        const result = await api<Attachment>(`/files?thread=${id}`, {
          method: "POST",
          body: form,
        });
        setAttachments((a) => [...a, result]);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function stop() {
    try {
      await post(`/threads/${threadId}/stop`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function older() {
    if (!threadId || !snapshot.messages[0]) return;
    setLoadingOlder(true);
    try {
      const old = await api<Snapshot>(
        `/threads/${threadId}/messages?before=${snapshot.messages[0].created_at}`,
      );
      setSnapshot((now) => ({
        messages: [...old.messages, ...now.messages],
        runs: [...old.runs, ...now.runs],
        activity: [...old.activity, ...now.activity],
        hasMore: old.hasMore,
      }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }
  async function addChannel() {
    try {
      const result = await post<{ id: string }>("/channels", {
        name: channelName,
      });
      await refresh();
      setChannelDialog(false);
      setChannelName("");
      chooseChannel(result.id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function updateThread(value: unknown) {
    try {
      await api(`/threads/${threadId}`, {
        method: "PATCH",
        body: JSON.stringify(value),
      });
      setRename(false);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (signedIn === false) return <Login onLogin={() => void refresh()} />;
  if (!workspace)
    return (
      <main className="loading-page">
        {loadError ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Workspace unavailable</EmptyTitle>
              <EmptyDescription>{loadError}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => void refresh()}>
                Retry
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="flex w-64 flex-col gap-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-48" />
          </div>
        )}
      </main>
    );

  const visibleThreads = workspace.threads.filter(
    (t) => t.channel_id === (current?.channel_id || channelId),
  );
  const sidebar = (
    <>
      <div className="workspace-brand">
        <span>melancholy</span>
        <Mark />
      </div>
      <div className="workspace-name">
        {workspace.name}
        <span className="workspace-indicator" />
      </div>
      <Button
        variant="outline"
        className="new-thread-button"
        onClick={newThread}
      >
        <SquarePen data-icon="inline-start" />
        New thread<span className="shortcut">⌘ ⇧ O</span>
      </Button>
      <div className="sidebar-scroll">
        <nav aria-label="Channels">
          <div className="nav-heading">
            <span>Channels</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Add channel"
              onClick={() => setChannelDialog(true)}
            >
              <Plus data-icon="inline-start" />
            </Button>
          </div>
          {workspace.channels.map((c) => (
            <button
              key={c.id}
              className={cn(
                "nav-link",
                c.id === (current?.channel_id || channelId) && "is-active",
              )}
              onClick={() => chooseChannel(c.id)}
            >
              <Hash />
              <span>{c.name}</span>
              <span className="nav-count">
                {workspace.threads.filter((t) => t.channel_id === c.id)
                  .length || ""}
              </span>
            </button>
          ))}
        </nav>
        <nav aria-label="Threads">
          <div className="nav-heading">
            <span>Threads</span>
            <span className="nav-count">{visibleThreads.length || ""}</span>
          </div>
          {visibleThreads.slice(0, 30).map((t) => (
            <button
              key={t.id}
              title={t.title}
              className={cn(
                "nav-link thread-link",
                t.id === threadId && "is-current",
              )}
              onClick={() => chooseThread(t.id)}
            >
              <MessageSquare />
              <span className="truncate">{t.title}</span>
            </button>
          ))}
          {!visibleThreads.length && (
            <p className="nav-empty">No threads yet</p>
          )}
        </nav>
        <nav aria-label="Servers">
          <div className="nav-heading">
            <span>Servers</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Connect a server"
              onClick={() => setSettings(true)}
            >
              <Plus data-icon="inline-start" />
            </Button>
          </div>
          {workspace.servers.map((s) => (
            <button
              key={s.id}
              className="nav-link server-link"
              onClick={() => setSettings(true)}
            >
              <span className={cn("server-dot", s.online && "online")} />
              <span className="truncate">{s.name}</span>
              <span className="nav-runtime">
                {s.runtime === "codex" ? "Codex" : "Claude"}
              </span>
            </button>
          ))}
          {!workspace.servers.length && (
            <button className="nav-link" onClick={() => setSettings(true)}>
              <Plus />
              <span>Connect server</span>
            </button>
          )}
        </nav>
      </div>
      <div className="sidebar-footer">
        <button className="nav-link" onClick={() => setSettings(true)}>
          <Settings2 />
          <span>Settings</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Workspace menu">
              <MoreHorizontal data-icon="inline-start" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <a
                  href="https://github.com/adayinthepark/melancholy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <CodeXml />
                  Source code
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  void post("/logout").then(() => {
                    setSignedIn(false);
                    setWorkspace(null);
                    setSnapshot(blank);
                  })
                }
              >
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );

  return (
    <div className="workspace-shell">
      <aside className="desktop-sidebar">{sidebar}</aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="mobile-sidebar">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Channels, threads, and servers
          </SheetDescription>
          {sidebar}
        </SheetContent>
      </Sheet>
      <main className="conversation-panel">
        <header className="channel-header">
          <Button
            variant="ghost"
            size="icon-sm"
            className="mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobile(true)}
          >
            <PanelLeft data-icon="inline-start" />
          </Button>
          <Hash className="channel-hash" />
          <button
            className="channel-title"
            onClick={() => chooseChannel(channel?.id || channelId)}
          >
            {channel?.name || "general"}
          </button>
          <span className="channel-description">{channel?.description}</span>
          <div className="header-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSearchOpen(true)}
              aria-label="Search workspace"
            >
              <Search data-icon="inline-start" />
              <span className="search-label">Search</span>
              <kbd>⌘ K</kbd>
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={dark ? "Light theme" : "Dark theme"}
                  onClick={toggleTheme}
                >
                  {dark ? (
                    <Sun data-icon="inline-start" />
                  ) : (
                    <Moon data-icon="inline-start" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {dark ? "Light theme" : "Dark theme"}
              </TooltipContent>
            </Tooltip>
          </div>
        </header>
        {connection === "reconnecting" && threadId && (
          <div className="connection-banner" role="status">
            Reconnecting. Your messages are saved.
          </div>
        )}
        {current && (
          <div className="thread-header">
            <div>
              <h1>{current.title}</h1>
              <p>
                {selectedServer
                  ? `${selectedServer.runtime === "codex" ? "Codex" : "Claude Code"} on ${selectedServer.name}`
                  : "Server removed"}
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Thread actions"
                >
                  <MoreHorizontal data-icon="inline-start" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={() => {
                      setTitle(current.title);
                      setRename(true);
                    }}
                  >
                    <Pencil />
                    Rename thread
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={`/api/threads/${threadId}/export`}>
                      <Download />
                      Export messages
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      void updateThread({ archived: true }).then(newThread)
                    }
                  >
                    <Archive />
                    Archive thread
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <div className="message-area">
          {loadingThread ? (
            <div className="transcript loading-thread">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ) : snapshot.messages.length ? (
            <Transcript
              key={threadId}
              snapshot={snapshot}
              onOlder={() => void older()}
              loadingOlder={loadingOlder}
            />
          ) : (
            <div className="channel-overview">
              <div className="channel-intro">
                <div className="channel-symbol">
                  <Hash />
                </div>
                <h1>{current ? "New thread" : channel?.name || "general"}</h1>
                <p>
                  {workspace.servers.length
                    ? "Send a message to start a new thread."
                    : "Connect your server to start a conversation."}
                </p>
                {!workspace.servers.length && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSettings(true)}
                  >
                    <ServerIcon data-icon="inline-start" />
                    Connect server
                  </Button>
                )}
              </div>
              {!threadId && visibleThreads.length > 0 && (
                <div className="thread-directory">
                  <div className="directory-heading">Recent threads</div>
                  {visibleThreads.slice(0, 6).map((t) => (
                    <button key={t.id} onClick={() => chooseThread(t.id)}>
                      <MessageSquare />
                      <span>{t.title}</span>
                      <time>
                        {new Date(t.updated_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </time>
                      <ArrowRight />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="composer-region">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="message-input" className="sr-only">
                  Message
                </FieldLabel>
                <InputGroup className="composer-box">
                  <InputGroupTextarea
                    ref={composer}
                    id="message-input"
                    className="composer-input"
                    placeholder={
                      current
                        ? "Reply…"
                        : `Message #${channel?.name || "general"}…`
                    }
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    disabled={!selectedServer}
                    maxLength={32000}
                  />
                  {attachments.length > 0 && (
                    <InputGroupAddon align="block-start">
                      <div className="draft-files">
                        {attachments.map((file) => (
                          <span key={file.id}>
                            {file.name}
                            <small>{formatSize(file.size)}</small>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Remove ${file.name}`}
                              onClick={() =>
                                setAttachments((a) =>
                                  a.filter((v) => v.id !== file.id),
                                )
                              }
                            >
                              <X data-icon="inline-start" />
                            </Button>
                          </span>
                        ))}
                      </div>
                    </InputGroupAddon>
                  )}
                  <InputGroupAddon align="block-end">
                    <InputGroupButton
                      size="icon-sm"
                      aria-label="Attach files"
                      disabled={
                        !selectedServer ||
                        uploading ||
                        attachments.length >= 8 ||
                        running
                      }
                      onClick={() => fileInput.current?.click()}
                    >
                      {uploading ? (
                        <Loader2 className="spin" data-icon="inline-start" />
                      ) : (
                        <Paperclip data-icon="inline-start" />
                      )}
                    </InputGroupButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <InputGroupButton
                          disabled={!!threadId}
                          size="sm"
                          aria-label="Select agent"
                        >
                          {selectedServer ? (
                            <>
                              <span
                                className={cn(
                                  "server-dot",
                                  selectedServer.online && "online",
                                )}
                              />
                              {selectedServer.runtime === "codex"
                                ? "Codex"
                                : "Claude"}
                              <span className="composer-server">
                                {selectedServer.name}
                              </span>
                            </>
                          ) : (
                            "Select server"
                          )}
                          <ChevronDown data-icon="inline-end" />
                        </InputGroupButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="top">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Run on</DropdownMenuLabel>
                          {workspace.servers.map((s) => (
                            <DropdownMenuItem
                              key={s.id}
                              onClick={() => setServerId(s.id)}
                            >
                              <ServerIcon />
                              {s.name}
                              <span className="text-muted-foreground">
                                {s.runtime === "codex" ? "Codex" : "Claude"}
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          <DropdownMenuItem onClick={() => setSettings(true)}>
                            <Plus />
                            Connect server
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <div className="flex-1" />
                    {running ? (
                      <InputGroupButton
                        aria-label="Stop task"
                        size="icon-sm"
                        variant="outline"
                        onClick={() => void stop()}
                      >
                        <Square data-icon="inline-start" />
                      </InputGroupButton>
                    ) : (
                      <InputGroupButton
                        type="submit"
                        aria-label="Send message"
                        size="icon-sm"
                        variant="default"
                        disabled={
                          !draft.trim() ||
                          sending ||
                          uploading ||
                          !selectedServer
                        }
                      >
                        {sending ? (
                          <Loader2 className="spin" data-icon="inline-start" />
                        ) : (
                          <ArrowUp data-icon="inline-start" />
                        )}
                      </InputGroupButton>
                    )}
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </FieldGroup>
          </form>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-label="Upload files"
            onChange={(e) => void upload(e.target.files)}
          />
          <div className="composer-hint">
            <span>
              {selectedServer && !selectedServer.online
                ? "Server offline. Messages will wait for reconnection."
                : ""}
            </span>
            <span>
              Enter to send <span className="hint-divider">/</span> Shift Enter
              for a new line
            </span>
          </div>
        </div>
      </main>
      <ServerSettings
        open={settings}
        onOpenChange={setSettings}
        servers={workspace.servers}
        onChange={refresh}
      />
      <Dialog open={channelDialog} onOpenChange={setChannelDialog}>
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addChannel();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create channel</DialogTitle>
              <DialogDescription>
                Keep related conversations together.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="my-5">
              <Field>
                <FieldLabel htmlFor="channel-name">Name</FieldLabel>
                <Input
                  id="channel-name"
                  placeholder="design"
                  required
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  maxLength={40}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="submit" disabled={!channelName}>
                Create channel
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={rename} onOpenChange={setRename}>
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void updateThread({ title });
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename thread</DialogTitle>
              <DialogDescription className="sr-only">
                Update the title of this conversation
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="my-5">
              <Field>
                <FieldLabel htmlFor="thread-title">Title</FieldLabel>
                <Input
                  id="thread-title"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent
          className="search-dialog sm:max-w-xl"
          showCloseButton={false}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Search workspace</DialogTitle>
            <DialogDescription>Find threads and messages</DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search threads and messages…"
            />
            <CommandList>
              <CommandEmpty>
                {searching ? "Searching…" : "No matching messages"}
              </CommandEmpty>
              {workspace.threads
                .filter((t) =>
                  t.title.toLowerCase().includes(query.toLowerCase()),
                )
                .slice(0, 8).length > 0 && (
                <CommandGroup heading="Threads">
                  {workspace.threads
                    .filter((t) =>
                      t.title.toLowerCase().includes(query.toLowerCase()),
                    )
                    .slice(0, 8)
                    .map((t) => (
                      <CommandItem
                        key={t.id}
                        value={t.id}
                        onSelect={() => {
                          chooseThread(t.id);
                          setSearchOpen(false);
                        }}
                      >
                        <MessageSquare />
                        <span className="truncate">{t.title}</span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              )}
              {searchResults.length > 0 && (
                <CommandGroup heading="Messages">
                  {searchResults.map((r) => (
                    <CommandItem
                      key={r.message_id}
                      value={r.message_id}
                      onSelect={() => {
                        chooseThread(r.thread_id);
                        setSearchOpen(false);
                      }}
                    >
                      <div className="search-result">
                        <strong>{r.title}</strong>
                        <span>{r.text}</span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </div>
  );
}
