import { runInDurableObject } from "cloudflare:test";
import type { Conversation } from "../worker/conversation";
import type { Activity, ChatMessage, Run } from "../lib/protocol";
// Storage inspection for durability tests; no browser history API is exposed.
export async function inspectAgent(stub: DurableObjectStub<Conversation>) {
  return runInDurableObject(stub, (_instance, state) => ({
    messages: state.storage.sql
      .exec<Omit<ChatMessage, "attachments"> & { attachments: string }>(
        "SELECT * FROM messages ORDER BY created_at,id",
      )
      .toArray(),
    runs: state.storage.sql
      .exec<Run & { job: string }>(
        "SELECT * FROM runs ORDER BY created_at DESC",
      )
      .toArray(),
    activity: state.storage.sql
      .exec<Activity>("SELECT * FROM activity ORDER BY created_at")
      .toArray(),
  }));
}
