export type ChannelNote = {
  id: string;
  title: string;
  content: string;
  version: number;
  updated_at: number;
  updated_by: string;
};
export type ChannelFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  message_id: string;
  parent_id?: string | null;
  created_at: number;
};
export type ChannelTimer = {
  id: string;
  name: string;
  prompt: string;
  bot_id: string;
  created_by: string;
  interval_minutes: number;
  next_at: number;
  enabled: number;
  version: number;
  last_error: string | null;
  last_message_id: string | null;
  runs: number;
};
export type ChannelSuggestion = {
  id: string;
  name: string;
  topic: string;
  brief: string;
};
export type ResourceDraft = {
  mode: "none" | "link" | "create";
  connectionId: string;
  repository: string;
  organization: string;
  private: boolean;
  workers: { connectionId: string; scriptName: string }[];
};
export const emptyResources = (): ResourceDraft => ({
  mode: "none",
  connectionId: "",
  repository: "",
  organization: "",
  private: true,
  workers: [],
});
