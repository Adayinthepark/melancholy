export type Connection = {
  id: string;
  provider:
    "github" | "cloudflare" | import("./credentials").CredentialProvider;
  env_keys?: string;
  updated_at?: number;
  name: string;
  identity: string;
  account_id?: string | null;
  agent_enabled?: number;
};
export type Repository = {
  id: string;
  room_id: string;
  integration_id: string;
  full_name: string;
  url: string;
  approved: number;
  proposed_by: string;
};
export type Issue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  user: { login: string };
  labels: { name: string }[];
  assignees: { login: string }[];
  updated_at: string;
  comments: number;
};
export type IssueComment = {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
};
