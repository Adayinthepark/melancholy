import type { Activity, Attachment } from "./protocol";
export type Person = {
  id: string;
  handle: string;
  name: string;
  kind: "human" | "bot";
  role: "owner" | "member";
  active: number;
  server_id: string | null;
};
export type Room = {
  id: string;
  kind: "channel" | "dm" | "group";
  name: string;
  topic: string;
  private: number;
  created_by: string;
  joined: number;
  unread: number;
  mentions: number;
  last_seq: number;
  last_read: number;
  members: Person[];
};
export type Reaction = { emoji: string; count: number; mine: boolean };
export type TeamMessage = {
  id: string;
  seq: number;
  room_id: string;
  parent_id: string | null;
  author_id: string;
  text: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  attachments: Attachment[];
  reactions: Reaction[];
  reply_count: number;
  run_id: string | null;
  run_status: string | null;
  run_error: string | null;
  activity: Activity[];
  author: Person;
};
export type TeamWorkspace = {
  name: string;
  me: Person;
  people: Person[];
  rooms: Room[];
};
export type MessagePage = {
  messages: TeamMessage[];
  hasMore: boolean;
  latest: number;
};
