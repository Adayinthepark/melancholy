"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Hash,
  Lock,
  Plus,
  Search,
  Settings2,
  Sun,
  Moon,
  PanelLeft,
  X,
  Users,
  MessageSquare,
  SquarePen,
  Check,
  Download,
  LogOut,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { api, post, ApiError } from "@/lib/client";
import type { Room, TeamWorkspace, TeamMessage, MessagePage } from "@/lib/chat";
import type { Server, Workspace } from "@/lib/protocol";
import { Mark } from "./brand";
import { Login } from "./login";
import { ChatTimeline } from "./chat-timeline";
import { ChatComposer } from "./chat-composer";
import { TeamSettings, Choice } from "./team-settings";
import { ServerSettings } from "./server-settings";
const emptyPage: MessagePage = { messages: [], hasMore: false, latest: 0 };
export function roomName(room: Room, me: string) {
  return (
    room.name ||
    room.members
      .filter((p) => p.id !== me)
      .map((p) => p.name)
      .join(", ") ||
    "Conversation"
  );
}
function merged(previous: MessagePage, next: MessagePage): MessagePage {
  const boundary = next.messages[0]?.seq;
  if (boundary === undefined) return next;
  const ids = new Set(next.messages.map((m) => m.id));
  if (!previous.messages.some((m) => ids.has(m.id))) return next;
  const older = previous.messages.filter((m) => m.seq < boundary);
  return {
    ...next,
    messages: [...older, ...next.messages],
    hasMore: older.length ? previous.hasMore : next.hasMore,
  };
}
export function TeamWorkspaceApp() {
  const [workspace, setWorkspace] = useState<TeamWorkspace | null>(null),
    [signedIn, setSignedIn] = useState<boolean | null>(null),
    [error, setError] = useState("");
  const [roomId, setRoomId] = useState("general"),
    [threadId, setThreadId] = useState<string | null>(null),
    [root, setRoot] = useState<TeamMessage | null>(null),
    [page, setPage] = useState<MessagePage>(emptyPage),
    [replies, setReplies] = useState<MessagePage>(emptyPage),
    [loading, setLoading] = useState(false);
  const [mobile, setMobile] = useState(false),
    [dark, setDark] = useState(false),
    [connection, setConnection] = useState("connecting"),
    [settings, setSettings] = useState(false),
    [serversOpen, setServersOpen] = useState(false),
    [servers, setServers] = useState<Server[]>([]);
  const [create, setCreate] = useState<"channel" | "message" | null>(null),
    [name, setName] = useState(""),
    [topic, setTopic] = useState(""),
    [visibility, setVisibility] = useState("public"),
    [selected, setSelected] = useState<string[]>([]),
    [peopleQuery, setPeopleQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [browse, setBrowse] = useState(false);
  const [details, setDetails] = useState(false),
    [memberId, setMemberId] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<TeamMessage[]>([]),
    [searching, setSearching] = useState(false);
  const active = useRef({ roomId, threadId }),
    refreshSeq = useRef(0),
    latestRefresh = useRef<() => Promise<void>>(async () => {}),
    readSeq = useRef<Record<string, number>>({}),
    [unreadAnchor, setUnreadAnchor] = useState(0),
    anchorRoom = useRef(""),
    [focusTick, setFocusTick] = useState(0);
  active.current = { roomId, threadId };
  const refresh = useCallback(async () => {
    const sequence = ++refreshSeq.current;
    try {
      const w = await api<TeamWorkspace>("/chat/workspace");
      if (sequence !== refreshSeq.current) return;
      setWorkspace(w);
      setSignedIn(true);
      setError("");
      setRoomId((current) =>
        w.rooms.some((r) => r.id === current)
          ? current
          : w.rooms.find((r) => r.joined)?.id || "",
      );
    } catch (e) {
      if (sequence !== refreshSeq.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setSignedIn(false);
        setWorkspace(null);
      } else setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get("room")) setRoomId(p.get("room")!);
    if (p.get("thread")) setThreadId(p.get("thread"));
    setDark(document.documentElement.classList.contains("dark"));
    void refresh();
  }, [refresh]);
  const current = workspace?.rooms.find((r) => r.id === roomId),
    admin = workspace?.me.role === "owner";
  const load = useCallback(
    async (reset = false) => {
      if (!roomId || !signedIn) return;
      const selection = roomId + ":" + (threadId || "");
      try {
        const [messages, threadRoot, threadReplies] = await Promise.all([
          api<MessagePage>("/chat/rooms/" + roomId + "/messages"),
          threadId
            ? api<{ message: TeamMessage }>("/chat/messages/" + threadId)
            : null,
          threadId
            ? api<MessagePage>(
                "/chat/rooms/" + roomId + "/messages?parent=" + threadId,
              )
            : null,
        ]);
        if (
          active.current.roomId + ":" + (active.current.threadId || "") !==
          selection
        )
          return;
        setPage((p) => (reset ? messages : merged(p, messages)));
        if (threadRoot) {
          setRoot(threadRoot.message);
          setReplies((p) =>
            reset ? threadReplies! : merged(p, threadReplies!),
          );
        }
        setLoading(false);
      } catch (e) {
        if (active.current.roomId !== roomId) return;
        setLoading(false);
        if (e instanceof ApiError && e.status === 401) void refresh();
        else {
          toast.error((e as Error).message);
          if (threadId) {
            setThreadId(null);
            setRoot(null);
          } else void refresh();
        }
      }
    },
    [roomId, threadId, signedIn, refresh],
  );
  latestRefresh.current = async () => {
    await Promise.all([refresh(), load()]);
  };
  useEffect(() => {
    setPage(emptyPage);
    setRoot(null);
    setReplies(emptyPage);
    setLoading(true);
    void load(true);
  }, [load]);
  useEffect(() => {
    if (current && anchorRoom.current !== current.id) {
      anchorRoom.current = current.id;
      setUnreadAnchor(current.unread ? current.last_read || -1 : 0);
    }
  }, [current]);
  useEffect(() => {
    if (!signedIn) return;
    let stopped = false,
      socket: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      heartbeat: ReturnType<typeof setInterval> | undefined,
      update: ReturnType<typeof setTimeout> | undefined,
      attempt = 0;
    const invalidate = () => {
      clearTimeout(update);
      update = setTimeout(() => void latestRefresh.current(), 180);
    };
    function connect() {
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/chat/socket`,
      );
      socket.onopen = () => {
        setConnection("connected");
        attempt = 0;
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
        }, 25000);
      };
      socket.onmessage = (e) => {
        if (e.data !== "pong") invalidate();
      };
      socket.onclose = () => {
        clearInterval(heartbeat);
        if (!stopped) {
          setConnection("reconnecting");
          retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** attempt++));
        }
      };
      socket.onerror = () => socket?.close();
    }
    connect();
    const polling = setInterval(() => {
      if (document.visibilityState === "visible") invalidate();
    }, 15000);
    const focus = () => {
      setFocusTick((v) => v + 1);
      invalidate();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(update);
      clearInterval(heartbeat);
      clearInterval(polling);
      socket?.close();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [signedIn]);
  useEffect(() => {
    if (
      !signedIn ||
      !current?.joined ||
      !page.latest ||
      document.visibilityState !== "visible" ||
      (readSeq.current[roomId] || 0) >= page.latest
    )
      return;
    const seq = page.latest;
    void post("/chat/rooms/" + roomId + "/read", { seq })
      .then(() => {
        readSeq.current[roomId] = seq;
        setWorkspace((w) =>
          w
            ? {
                ...w,
                rooms: w.rooms.map((r) =>
                  r.id === roomId ? { ...r, unread: 0, mentions: 0 } : r,
                ),
              }
            : w,
        );
      })
      .catch(() => {});
  }, [page.latest, roomId, signedIn, current?.joined, focusTick]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!searchOpen) return;
    let stopped = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void api<{ results: TeamMessage[] }>(
        "/chat/search?q=" + encodeURIComponent(query),
      )
        .then((v) => {
          if (!stopped) setResults(v.results);
        })
        .catch((e) => {
          if (!stopped) toast.error(e.message);
        })
        .finally(() => {
          if (!stopped) setSearching(false);
        });
    }, 250);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [query, searchOpen]);
  function choose(id: string, thread: string | null = null) {
    setRoomId(id);
    setThreadId(thread);
    setMobile(false);
    history.replaceState(
      null,
      "",
      "?room=" + encodeURIComponent(id) + (thread ? "&thread=" + thread : ""),
    );
  }
  function openThread(m: TeamMessage) {
    choose(m.room_id, m.parent_id || m.id);
  }
  function theme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("melancholy-theme", next ? "dark" : "light");
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function older(thread = false) {
    const target = thread ? replies : page,
      before = target.messages[0]?.seq;
    if (!before) return;
    const requestedRoom = roomId;
    try {
      const next = await api<MessagePage>(
        "/chat/rooms/" +
          roomId +
          "/messages?before=" +
          before +
          (thread ? "&parent=" + threadId : ""),
      );
      if (active.current.roomId !== requestedRoom) return;
      const apply = (p: MessagePage) => ({
        ...p,
        hasMore: next.hasMore,
        messages: [
          ...next.messages,
          ...p.messages.filter(
            (m) => !next.messages.some((n) => n.id === m.id),
          ),
        ],
      });
      if (thread) setReplies(apply);
      else setPage(apply);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function loadServers() {
    const w = await api<Workspace>("/workspace");
    setServers(w.servers);
    await refresh();
  }
  function startCreate(kind: "channel" | "message") {
    setCreate(kind);
    setName("");
    setTopic("");
    setVisibility("public");
    setSelected([]);
    setPeopleQuery("");
  }
  if (signedIn === false) return <Login onLogin={() => void refresh()} />;
  if (!workspace)
    return (
      <main className="team-loading">
        {error ? (
          <>
            <p>{error}</p>
            <Button onClick={() => void refresh()}>Retry</Button>
          </>
        ) : (
          <>
            <Mark />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </>
        )}
      </main>
    );
  const me = workspace.me;
  const sidebar = (
    <>
      <a className="workspace-brand" href="/">
        <Mark />
        melancholy
      </a>
      <div className="team-workspace-name">{workspace.name}</div>
      <Button
        className="team-new-message"
        variant="outline"
        size="sm"
        onClick={() => startCreate("message")}
      >
        <SquarePen />
        New message
      </Button>
      <nav className="team-nav" aria-label="Conversations">
        <div className="team-nav-label">
          <span>Channels</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Add channel"
            onClick={() => startCreate("channel")}
          >
            <Plus />
          </Button>
        </div>
        {workspace.rooms
          .filter((r) => r.kind === "channel" && r.joined)
          .map((r) => (
            <button
              className={
                "team-room-link" +
                (r.id === roomId ? " selected" : "") +
                (r.unread ? " unread" : "")
              }
              key={r.id}
              onClick={() => choose(r.id)}
            >
              {r.private ? <Lock /> : <Hash />}
              <span>{r.name}</span>
              {r.mentions > 0 ? (
                <Badge variant="secondary">{r.mentions}</Badge>
              ) : r.unread > 0 ? (
                <i aria-label={r.unread + " unread messages"} />
              ) : null}
            </button>
          ))}
        <Button
          className="team-browse"
          variant="ghost"
          size="sm"
          onClick={() => setBrowse(true)}
        >
          <Plus />
          Browse channels
        </Button>
        <div className="team-nav-label">
          <span>Direct messages</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="New direct message"
            onClick={() => startCreate("message")}
          >
            <Plus />
          </Button>
        </div>
        {workspace.rooms
          .filter((r) => r.kind !== "channel" && r.joined)
          .map((r) => (
            <button
              key={r.id}
              className={
                "team-room-link" +
                (r.id === roomId ? " selected" : "") +
                (r.unread ? " unread" : "")
              }
              onClick={() => choose(r.id)}
            >
              {r.kind === "group" ? <Users /> : <MessageSquare />}
              <span>{roomName(r, me.id)}</span>
              {r.mentions > 0 ? (
                <Badge variant="secondary">{r.mentions}</Badge>
              ) : r.unread > 0 ? (
                <i aria-label={r.unread + " unread messages"} />
              ) : null}
            </button>
          ))}
      </nav>
      <div className="team-account">
        <button onClick={() => setSettings(true)} className="team-profile">
          <span className="profile-initial">
            {me.name.slice(0, 1).toUpperCase()}
          </span>
          <span>{me.name}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Workspace menu">
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setSettings(true)}>
                <Settings2 />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  void post("/logout").then(() => {
                    setSignedIn(false);
                    setWorkspace(null);
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
    <div className="team-shell">
      <aside className="team-sidebar">{sidebar}</aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="team-mobile-nav">
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <SheetDescription className="sr-only">
            Channels, direct messages and settings.
          </SheetDescription>
          {sidebar}
        </SheetContent>
      </Sheet>
      <main className={"team-main" + (threadId ? " has-thread" : "")}>
        <header className="team-topbar">
          <Button
            className="team-mobile-toggle"
            variant="ghost"
            size="icon-sm"
            aria-label="Open navigation"
            onClick={() => setMobile(true)}
          >
            <PanelLeft />
          </Button>
          <div className="team-heading">
            {current &&
              (current.kind === "channel" ? (
                current.private ? (
                  <Lock />
                ) : (
                  <Hash />
                )
              ) : (
                <MessageSquare />
              ))}
            <button
              onClick={() => {
                if (current) {
                  setName(current.name);
                  setTopic(current.topic);
                  setDetails(true);
                  setMemberId("");
                }
              }}
            >
              {current ? roomName(current, me.id) : "Conversations"}
            </button>
            <span>{current?.topic}</span>
          </div>
          <div className="team-top-actions">
            {connection === "reconnecting" && (
              <span className="connection-label">Reconnecting…</span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Conversation members"
              disabled={!current}
              onClick={() => {
                setName(current?.name || "");
                setTopic(current?.topic || "");
                setDetails(true);
                setMemberId("");
              }}
            >
              <Users />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Search workspace"
              onClick={() => setSearchOpen(true)}
            >
              <Search />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={dark ? "Light theme" : "Dark theme"}
              onClick={theme}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>
        <div className="team-conversation-layout">
          <section className="team-channel" aria-label="Channel messages">
            {current ? (
              <>
                {loading ? (
                  <div className="chat-loading">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-64" />
                  </div>
                ) : page.messages.length ? (
                  <ChatTimeline
                    messages={page.messages}
                    me={me}
                    hasMore={page.hasMore}
                    onOlder={() => void older()}
                    onThread={openThread}
                    onChange={() => latestRefresh.current()}
                    unreadAfter={unreadAnchor}
                  />
                ) : (
                  <Empty className="chat-empty">
                    <EmptyHeader>
                      <EmptyTitle>
                        {current.kind === "channel"
                          ? "# " + current.name
                          : roomName(current, me.id)}
                      </EmptyTitle>
                      <EmptyDescription>
                        {current.topic || "No messages yet."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {current.joined ? (
                  <ChatComposer
                    key={roomId}
                    roomId={roomId}
                    people={current.members}
                    label={
                      "Message " +
                      (current.kind === "channel" ? "#" : "") +
                      roomName(current, me.id)
                    }
                    onSent={() => latestRefresh.current()}
                  />
                ) : (
                  <div className="join-channel">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void act(() => post("/chat/rooms/" + roomId + "/join"))
                      }
                    >
                      Join channel
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No conversations</EmptyTitle>
                </EmptyHeader>
                <Button
                  variant="outline"
                  onClick={() => startCreate("channel")}
                >
                  Create channel
                </Button>
              </Empty>
            )}
          </section>
          {threadId && current && (
            <section className="team-thread" aria-label="Thread">
              <header>
                <strong>Thread</strong>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close thread"
                  onClick={() => choose(roomId)}
                >
                  <X />
                </Button>
              </header>
              {root ? (
                <ChatTimeline
                  messages={[root, ...replies.messages]}
                  me={me}
                  hasMore={replies.hasMore}
                  onOlder={() => void older(true)}
                  onThread={() => {}}
                  onChange={() => latestRefresh.current()}
                  thread
                />
              ) : (
                <div className="chat-loading">
                  <Skeleton className="h-4 w-40" />
                </div>
              )}
              {current.joined && (
                <ChatComposer
                  key={roomId + threadId}
                  roomId={roomId}
                  parentId={threadId}
                  people={current.members}
                  label="Reply in thread"
                  onSent={() => latestRefresh.current()}
                />
              )}
            </section>
          )}
        </div>
      </main>
      <Dialog
        open={!!create}
        onOpenChange={(v) => {
          if (!v) setCreate(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {create === "channel" ? "Create channel" : "New message"}
            </DialogTitle>
            <DialogDescription>
              {create === "channel"
                ? "Choose who can find and read this channel."
                : "Choose one person for a direct message, or several for a group."}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const result = await post<{ id: string }>(
                  "/chat/rooms",
                  create === "channel"
                    ? {
                        kind: "channel",
                        name,
                        topic,
                        private: visibility === "private",
                        members: selected,
                      }
                    : {
                        kind: selected.length === 1 ? "dm" : "group",
                        members: selected,
                        name: selected.length > 1 ? name : "",
                      },
                );
                await refresh();
                setCreate(null);
                choose(result.id);
              });
            }}
          >
            <FieldGroup>
              {create === "channel" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="channel-name">Channel name</FieldLabel>
                    <Input
                      id="channel-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={40}
                      pattern="[a-z0-9][a-z0-9-]{0,39}"
                      placeholder="project-name"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="channel-topic">Topic</FieldLabel>
                    <Input
                      id="channel-topic"
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      maxLength={200}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="channel-visibility">
                      Visibility
                    </FieldLabel>
                    <Choice
                      id="channel-visibility"
                      value={visibility}
                      onChange={setVisibility}
                      options={[
                        {
                          value: "public",
                          label: "Public — workspace members",
                        },
                        {
                          value: "private",
                          label: "Private — invited members",
                        },
                      ]}
                    />
                  </Field>
                </>
              ) : (
                <>
                  {selected.length > 1 && (
                    <Field>
                      <FieldLabel htmlFor="group-name">
                        Group name (optional)
                      </FieldLabel>
                      <Input
                        id="group-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={80}
                      />
                    </Field>
                  )}
                </>
              )}
              {(create === "message" || visibility === "private") && (
                <Field>
                  <FieldLabel htmlFor="people-query">People</FieldLabel>
                  <Input
                    id="people-query"
                    placeholder="Find a person or bot"
                    value={peopleQuery}
                    onChange={(e) => setPeopleQuery(e.target.value)}
                  />
                  <div className="people-picker">
                    {workspace.people
                      .filter(
                        (p) =>
                          p.id !== me.id &&
                          (admin || p.kind === "human") &&
                          (p.name + " " + p.handle)
                            .toLowerCase()
                            .includes(peopleQuery.toLowerCase()),
                      )
                      .map((p) => (
                        <Button
                          type="button"
                          key={p.id}
                          variant={
                            selected.includes(p.id) ? "secondary" : "ghost"
                          }
                          aria-pressed={selected.includes(p.id)}
                          className="select-person"
                          onClick={() =>
                            setSelected((v) =>
                              v.includes(p.id)
                                ? v.filter((id) => id !== p.id)
                                : [...v, p.id],
                            )
                          }
                        >
                          <span>
                            <strong>{p.name}</strong>
                            <small>
                              @{p.handle}
                              {p.kind === "bot" ? " · bot" : ""}
                            </small>
                          </span>
                          {selected.includes(p.id) && <Check />}
                        </Button>
                      ))}
                  </div>
                </Field>
              )}
              <Button
                disabled={busy || (create === "message" && !selected.length)}
              >
                {create === "channel" ? "Create channel" : "Open conversation"}
              </Button>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={browse} onOpenChange={setBrowse}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Browse channels</DialogTitle>
            <DialogDescription>
              Public channels in this workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="settings-member-list">
            {workspace.rooms
              .filter((r) => r.kind === "channel" && !r.private)
              .map((r) => (
                <button
                  className="browse-channel"
                  key={r.id}
                  onClick={() => {
                    setBrowse(false);
                    choose(r.id);
                  }}
                >
                  <Hash />
                  <div>
                    <strong>{r.name}</strong>
                    <span>{r.topic}</span>
                  </div>
                  {r.joined && <Badge variant="outline">Joined</Badge>}
                </button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {current ? roomName(current, me.id) : "Conversation"}
            </DialogTitle>
            <DialogDescription>
              {current?.kind === "channel"
                ? current.private
                  ? "Private channel"
                  : "Public channel"
                : "Only participants can read this conversation."}
            </DialogDescription>
          </DialogHeader>
          {current && (
            <div className="settings-section">
              {(current.kind === "group" ||
                (current.kind === "channel" &&
                  (current.created_by === me.id || admin))) && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(() =>
                      api("/chat/rooms/" + roomId, {
                        method: "PATCH",
                        body: JSON.stringify({ name, topic }),
                      }),
                    );
                  }}
                >
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="room-name">Name</FieldLabel>
                      <Input
                        id="room-name"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="room-topic">Topic</FieldLabel>
                      <Input
                        id="room-topic"
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                      />
                    </Field>
                    <Button variant="outline" disabled={busy}>
                      Save details
                    </Button>
                  </FieldGroup>
                </form>
              )}
              <div className="settings-member-list">
                {current.members.map((p) => (
                  <div key={p.id} className="person-row">
                    <div>
                      <strong>{p.name}</strong>
                      <span>
                        @{p.handle}
                        {p.kind === "bot" ? " · bot" : ""}
                      </span>
                    </div>
                    {current.kind === "channel" &&
                      p.id !== current.created_by &&
                      (p.id === me.id ||
                        current.created_by === me.id ||
                        admin) && (
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              api(
                                "/chat/rooms/" + roomId + "/members/" + p.id,
                                { method: "DELETE" },
                              ),
                            )
                          }
                        >
                          {p.id === me.id ? "Leave" : "Remove"}
                        </Button>
                      )}
                  </div>
                ))}
              </div>
              {current.kind === "channel" &&
                current.joined &&
                (current.created_by === me.id || admin) && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        await post("/chat/rooms/" + roomId + "/members", {
                          personId: memberId,
                        });
                        setMemberId("");
                      });
                    }}
                  >
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="add-member">
                          Add member or bot
                        </FieldLabel>
                        <Choice
                          id="add-member"
                          value={memberId}
                          onChange={setMemberId}
                          options={workspace.people
                            .filter(
                              (p) =>
                                !current.members.some((m) => m.id === p.id) &&
                                (admin || p.kind === "human"),
                            )
                            .map((p) => ({
                              value: p.id,
                              label: p.name + " (@" + p.handle + ")",
                            }))}
                        />
                      </Field>
                      <Button variant="outline" disabled={busy || !memberId}>
                        Add member
                      </Button>
                    </FieldGroup>
                  </form>
                )}
              <Button variant="ghost" asChild>
                <a href={"/api/chat/rooms/" + roomId + "/export"} download>
                  <Download />
                  Export conversation
                </a>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent
          className="search-dialog sm:max-w-2xl"
          showCloseButton={false}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Search workspace</DialogTitle>
            <DialogDescription>
              Search conversations you can access.
            </DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search messages…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {searching
                  ? "Searching…"
                  : query
                    ? "No messages found."
                    : "Type to search messages."}
              </CommandEmpty>
              <CommandGroup>
                {results.map((m) => (
                  <CommandItem
                    key={m.id}
                    value={m.id}
                    className="chat-search-result"
                    onSelect={() => {
                      setSearchOpen(false);
                      choose(m.room_id, m.parent_id || m.id);
                    }}
                  >
                    <div>
                      <strong>
                        {workspace.rooms.find((r) => r.id === m.room_id)
                          ? roomName(
                              workspace.rooms.find((r) => r.id === m.room_id)!,
                              me.id,
                            )
                          : "Conversation"}
                        <span>{m.author.name}</span>
                      </strong>
                      <p>{m.text.slice(0, 220)}</p>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
      <TeamSettings
        open={settings}
        onOpenChange={setSettings}
        workspace={workspace}
        onChange={refresh}
        onServers={() => {
          setSettings(false);
          void loadServers()
            .then(() => setServersOpen(true))
            .catch((e) => toast.error(e.message));
        }}
      />
      {admin && (
        <ServerSettings
          open={serversOpen}
          onOpenChange={setServersOpen}
          servers={servers}
          onChange={loadServers}
        />
      )}
    </div>
  );
}
