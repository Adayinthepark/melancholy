export type Runtime = "codex" | "claude";
export type RunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";
export type Channel = { id: string; name: string; description: string };
export type Server = {
  id: string;
  name: string;
  runtime: Runtime;
  online: boolean;
  cwd: string | null;
  hostname: string | null;
  created_at: number;
};
export type Thread = {
  id: string;
  channel_id: string;
  title: string;
  server_id: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
};
export type Attachment = {
  id: string;
  name: string;
  size: number;
  type: string;
};
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  created_at: number;
  runtime: Runtime | null;
  run_id: string | null;
  attachments: Attachment[];
};
export type Activity = {
  id: string;
  run_id: string;
  kind: "tool" | "status";
  title: string;
  detail: string;
  status: string;
  created_at: number;
};
export type Run = {
  id: string;
  server_id: string;
  runtime: Runtime;
  status: RunStatus;
  session_id: string | null;
  error: string | null;
  created_at: number;
};
export type Snapshot = {
  messages: ChatMessage[];
  runs: Run[];
  activity: Activity[];
  hasMore: boolean;
};
export type Job = {
  id: string;
  threadId: string;
  prompt: string;
  runtime: Runtime;
  sessionId: string | null;
  attachments: Attachment[];
};
export type AgentEvent =
  | { type: "started"; sessionId?: string }
  | { type: "text"; text: string }
  | {
      type: "activity";
      id: string;
      title: string;
      detail?: string;
      status?: string;
    }
  | { type: "completed"; sessionId?: string }
  | { type: "failed"; error: string }
  | { type: "cancelled" };
export type Workspace = {
  name: string;
  channels: Channel[];
  threads: Thread[];
  servers: Server[];
};
