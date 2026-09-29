import { integrationHealth } from "./integration-health";
import { databases, databaseCall } from "./database-store";
import { canReadRoom } from "./team-auth";
import type { ChannelDatabase } from "../lib/channel-database";
import {
  casualPrincipal,
  workspaceOverview,
  readChannel,
  suggestChannel,
  isCasual,
} from "./casual";
import { notes, saveNote, channelFiles } from "./channel-data";
import { Type, type TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceClient } from "@cloudflare/computer";
import { posix } from "node:path";
import type { cloudAccess } from "./cloud-config";
import type { Job } from "../lib/protocol";
import { github } from "./integrations";

type Options = {
  workspace: WorkspaceClient;
  env: Cloudflare.Env;
  config: Awaited<ReturnType<typeof cloudAccess>>;
  job: Job;
  plan: (value: unknown) => void;
};
export function workspacePath(path: string) {
  const normalized = posix.resolve("/workspace", path);
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/"))
    throw new Error("Path must be inside /workspace.");
  return normalized;
}
export function cloudTools({
  workspace,
  env,
  config,
  job,
  plan,
}: Options): AgentTool[] {
  const result = (value: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: (typeof value === "string" ? value : JSON.stringify(value)).slice(
          0,
          48000,
        ),
      },
    ],
    details: {},
  });
  function tool<T extends TSchema>(
    name: string,
    description: string,
    parameters: T,
    execute: AgentTool<T>["execute"],
  ): AgentTool {
    return { name, label: name, description, parameters, execute } as AgentTool;
  }
  return [
    tool(
      "channel_database",
      "Discover this channel's databases and JSON schemas, query/get records or atomically write a batch. action=list returns databases; collections returns schemas; query input={collection,query:{filters?,orderBy?,direction?,limit?,cursor?}}; get input={collection,id}; batch input={requestId,operations:[{op:create|update|delete,collection,id,data?,version?}]}. Reuse requestId on retries. Notes shares the Project database. Files is read-only. In Casual chat, provide channelId for read access only.",
      Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("collections"),
          Type.Literal("query"),
          Type.Literal("get"),
          Type.Literal("batch"),
          Type.Literal("changes"),
        ]),
        databaseId: Type.Optional(Type.String()),
        channelId: Type.Optional(Type.String()),
        input: Type.Optional(Type.Unknown()),
      }),
      async (_id, args) => {
        const roomId = config.casual ? args.channelId : config.room_id;
        if (!roomId) throw new Error("Choose a channel first.");
        if (config.casual) {
          if (args.action === "batch")
            throw new Error(
              "Casual chat can inspect project databases but cannot modify them.",
            );
          if (
            !(await canReadRoom(
              roomId,
              await casualPrincipal(config.room_id, config.bot_id),
            ))
          )
            throw new Error("Channel not found.");
        }
        const available = await databases(roomId);
        if (args.action === "list") return result(available);
        const db = available.find(
          (d: ChannelDatabase) => d.id === args.databaseId,
        );
        if (!db) throw new Error("Database not found in this channel.");
        return result(
          await databaseCall(db, args.action, args.input || {}, config.bot_id),
        );
      },
    ),
    ...(config.casual
      ? [
          tool(
            "integration_status",
            "In Casual chat: verify GitHub/Cloudflare authentication without exposing credentials. Model and custom credentials return configuration status only.",
            Type.Object({ integrationId: Type.String() }),
            async (_id, args) =>
              result(
                await integrationHealth(
                  await casualPrincipal(config.room_id, config.bot_id),
                  args.integrationId,
                ),
              ),
          ),
          tool(
            "workspace_overview",
            "In Casual chat only: inspect the human user's accessible channels and integration metadata. Never returns secrets.",
            Type.Object({}),
            async () =>
              result(
                await workspaceOverview(
                  await casualPrincipal(config.room_id, config.bot_id),
                ),
              ),
          ),
          tool(
            "workspace_channel",
            "In Casual chat only: read recent discussion, Notes and file metadata in an accessible channel.",
            Type.Object({
              channelId: Type.String(),
              query: Type.Optional(Type.String({ maxLength: 200 })),
            }),
            async (_id, args) =>
              result(
                await readChannel(
                  await casualPrincipal(config.room_id, config.bot_id),
                  args.channelId,
                  args.query,
                ),
              ),
          ),
          tool(
            "suggest_channel",
            "In Casual chat only: propose a channel and project brief. The human reviews and creates it.",
            Type.Object({
              name: Type.String(),
              topic: Type.String(),
              brief: Type.String(),
            }),
            async (_id, args) =>
              result(await suggestChannel(config.room_id, config.bot_id, args)),
          ),
        ]
      : []),
    tool(
      "channel_notes",
      "Read this channel's shared project Notes.",
      Type.Object({}),
      async () => result(await notes(config.room_id)),
    ),
    tool(
      "save_note",
      "Save confirmed findings in this channel. Editing requires the note's current version. Do not use this for Casual chat.",
      Type.Object({
        title: Type.String(),
        content: Type.String(),
        id: Type.Optional(Type.String()),
        version: Type.Optional(Type.Integer()),
      }),
      async (_id, args) => {
        if (await isCasual(config.room_id))
          throw new Error("Recommend a channel first.");
        return result(
          await saveNote(config.room_id, config.bot_id, args, args.id),
        );
      },
    ),
    tool(
      "channel_files",
      "List this conversation's posted R2 files.",
      Type.Object({}),
      async () => result(await channelFiles(config.room_id)),
    ),
    tool(
      "update_plan",
      "Record and update a short task plan. Mark steps completed only after checking results.",
      Type.Object({
        steps: Type.Array(
          Type.Object({
            title: Type.String({ maxLength: 200 }),
            status: Type.Union([
              Type.Literal("pending"),
              Type.Literal("in_progress"),
              Type.Literal("completed"),
            ]),
          }),
          { minItems: 1, maxItems: 12 },
        ),
      }),
      async (_id, args) => {
        plan(args.steps);
        return result(args);
      },
    ),
    tool(
      "read",
      "Read a UTF-8 file from the persistent workspace. Use offset and limit to read large files in parts.",
      Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })),
      }),
      async (_id, args) => {
        const path = workspacePath(args.path);
        const stat = await workspace.fs.stat(path);
        if (stat.size > 2 * 1024 * 1024)
          throw new Error(
            "File is too large for text reading. Use javascript to process it.",
          );
        const lines = (await workspace.fs.readFile(path, "utf8")).split("\n");
        const start = (args.offset || 1) - 1;
        return result({
          totalLines: lines.length,
          text: lines
            .slice(start, start + (args.limit || 200))
            .map((line, i) => `${start + i + 1}: ${line}`)
            .join("\n"),
        });
      },
    ),
    tool(
      "write",
      "Create or replace a UTF-8 workspace file. Parent directories are created.",
      Type.Object({
        path: Type.String(),
        content: Type.String({ maxLength: 200000 }),
      }),
      async (_id, args) => {
        const path = workspacePath(args.path);
        await workspace.fs.mkdir(posix.dirname(path), { recursive: true });
        await workspace.fs.writeFile(path, args.content);
        return result({
          path,
          bytes: new TextEncoder().encode(args.content).length,
        });
      },
    ),
    tool(
      "edit",
      "Replace one exact, unique text match in an existing file. Read the file first.",
      Type.Object({
        path: Type.String(),
        oldText: Type.String({ minLength: 1 }),
        newText: Type.String(),
      }),
      async (_id, args) => {
        const path = workspacePath(args.path);
        if ((await workspace.fs.stat(path)).size > 2 * 1024 * 1024)
          throw new Error("File too large.");
        const old = await workspace.fs.readFile(path, "utf8");
        if (old.split(args.oldText).length !== 2)
          throw new Error(
            "oldText must match exactly once. Read the file and include more context.",
          );
        await workspace.fs.writeFile(
          path,
          old.replace(args.oldText, () => args.newText),
        );
        return result({ path, replaced: true });
      },
    ),
    ...(["bash", "javascript"] as const).map((name) =>
      tool(
        name,
        name === "bash"
          ? "Run supported emulated shell commands in /workspace (ls, cat, grep, sed, etc.). No npm, native binaries or networking."
          : "Run an isolated ES module exporting default async function(input). node:fs/promises reads/writes workspace files. No network or npm packages. Useful for data processing and JS tests.",
        Type.Object({
          source: Type.String({ minLength: 1, maxLength: 32000 }),
        }),
        async (id, args, signal) => {
          const handle = await workspace.runtime.exec(args.source, {
            id,
            backend: name === "bash" ? "shell" : "javascript",
            cwd: "/workspace",
            encoding: "utf8",
            timeoutMs: 30000,
          });
          const abort = () => {
            void handle.kill().catch(() => {});
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          try {
            return result(await handle.result());
          } finally {
            signal?.removeEventListener("abort", abort);
            handle[Symbol.dispose]();
          }
        },
      ),
    ),
    tool(
      "read_thread",
      "Read recent visible messages in the current task thread, including original requirements.",
      Type.Object({}),
      async () => {
        const rows = await env.DB.prepare(
          "SELECT m.id,p.name,m.text FROM chat_messages m JOIN people p ON p.id=m.author_id WHERE m.room_id=? AND m.deleted_at IS NULL AND (m.id=? OR m.parent_id=? OR (?=m.room_id AND m.parent_id IS NULL)) ORDER BY m.seq DESC LIMIT 60",
        )
          .bind(config.room_id, config.root_id, config.root_id, config.root_id)
          .all();
        return result(rows.results.reverse());
      },
    ),
    tool(
      "search_messages",
      "Search visible messages in the current conversation. Results include message IDs.",
      Type.Object({ query: Type.String({ minLength: 2, maxLength: 200 }) }),
      async (_id, args) =>
        result(
          (
            await env.DB.prepare(
              "SELECT id,parent_id,text FROM chat_messages WHERE room_id=? AND deleted_at IS NULL AND instr(lower(text),lower(?))>0 ORDER BY seq DESC LIMIT 30",
            )
              .bind(config.room_id, args.query)
              .all()
          ).results,
        ),
    ),
    tool(
      "github_read",
      "Read authorized GitHub repository metadata, a file, issue, or PR. The repository must be linked and enabled for agents in this conversation. File content is returned as UTF-8.",
      Type.Object({
        repository: Type.String(),
        resource: Type.Union([
          Type.Literal("repository"),
          Type.Literal("file"),
          Type.Literal("issue"),
          Type.Literal("pull_request"),
        ]),
        path: Type.Optional(Type.String()),
        number: Type.Optional(Type.Integer({ minimum: 1 })),
        ref: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      async (_id, args) => {
        const repo = await env.DB.prepare(
          "SELECT r.integration_id,r.full_name FROM room_repositories r JOIN room_integrations i ON i.integration_id=r.integration_id AND i.room_id=r.room_id WHERE r.room_id=? AND r.full_name=? AND r.approved=1 AND i.agent_enabled=1",
        )
          .bind(config.room_id, args.repository)
          .first<{ integration_id: string; full_name: string }>();
        if (!repo)
          throw new Error(
            "Repository is not linked and authorized for this conversation.",
          );
        const root =
          "/repos/" +
          repo.full_name.split("/").map(encodeURIComponent).join("/");
        let path = root;
        if (args.resource === "file") {
          if (
            !args.path ||
            args.path.split("/").some((s) => s === ".." || s === ".")
          )
            throw new Error("Enter a repository-relative file path.");
          path +=
            "/contents/" +
            args.path.split("/").map(encodeURIComponent).join("/") +
            (args.ref ? "?ref=" + encodeURIComponent(args.ref) : "");
        }
        if (args.resource === "issue" || args.resource === "pull_request") {
          if (!args.number) throw new Error("Issue or PR number is required.");
          path +=
            (args.resource === "issue" ? "/issues/" : "/pulls/") + args.number;
        }
        const data = await github<{ content?: string; encoding?: string }>(
          repo.integration_id,
          path,
        );
        return result(
          data.content && data.encoding === "base64"
            ? Buffer.from(data.content, "base64").toString("utf8")
            : data,
        );
      },
    ),
    tool(
      "import_attachment",
      "Copy an attachment from the current task into /workspace for processing.",
      Type.Object({ id: Type.String(), path: Type.String() }),
      async (_id, args) => {
        const file = await env.DB.prepare(
          "SELECT f.id,f.size FROM chat_files f JOIN chat_messages m ON m.id=f.message_id WHERE f.id=? AND f.room_id=? AND m.deleted_at IS NULL AND (m.id=? OR m.parent_id=? OR (?=m.room_id AND m.parent_id IS NULL))",
        )
          .bind(
            args.id,
            config.room_id,
            config.root_id,
            config.root_id,
            config.root_id,
          )
          .first<{ id: string; size: number }>();
        if (!file || file.size > 10 * 1024 * 1024)
          throw new Error("Attachment unavailable in this thread.");
        const object = await env.FILES.get(file.id);
        if (!object) throw new Error("Attachment unavailable.");
        const path = workspacePath(args.path);
        await workspace.fs.mkdir(posix.dirname(path), { recursive: true });
        await workspace.fs.writeFile(path, object.body);
        return result({ path, size: file.size });
      },
    ),
    tool(
      "publish_file",
      "Attach a workspace file to this agent reply and return its authenticated download link.",
      Type.Object({ path: Type.String() }),
      async (callId, args) => {
        const path = workspacePath(args.path),
          stat = await workspace.fs.stat(path);
        if (stat.size > 10 * 1024 * 1024)
          throw new Error("Files must be at most 10 MB.");
        const message = await env.DB.prepare(
          "SELECT id FROM chat_messages WHERE run_id=? AND author_id=? AND deleted_at IS NULL",
        )
          .bind(job.id, config.bot_id)
          .first<{ id: string }>();
        if (!message) throw new Error("Agent reply is unavailable.");
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(job.id + ":" + callId),
        );
        const id = Array.from(new Uint8Array(digest), (n) =>
          n.toString(16).padStart(2, "0"),
        )
          .join("")
          .slice(0, 32);
        const attachment = {
          id,
          name: posix.basename(path),
          size: stat.size,
          type: "application/octet-stream",
        };
        const count = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM chat_files WHERE message_id=?",
        )
          .bind(message.id)
          .first<{ n: number }>();
        if ((count?.n || 0) >= 8)
          throw new Error("At most eight files per reply.");
        const transfer = new FixedLengthStream(stat.size);
        const copying = (await workspace.fs.readFile(path)).pipeTo(
          transfer.writable,
        );
        await Promise.all([copying, env.FILES.put(id, transfer.readable)]);
        await env.DB.batch([
          env.DB.prepare(
            "INSERT OR IGNORE INTO chat_files(id,room_id,uploader_id,message_id,name,size,type,created_at) VALUES (?,?,?,?,?,?,?,?)",
          ).bind(
            id,
            config.room_id,
            config.bot_id,
            message.id,
            attachment.name,
            stat.size,
            attachment.type,
            Date.now(),
          ),
          env.DB.prepare(
            "UPDATE chat_messages SET attachments=(SELECT json_group_array(json_object('id',id,'name',name,'size',size,'type',type)) FROM chat_files WHERE message_id=?) WHERE id=? AND deleted_at IS NULL",
          ).bind(message.id, message.id),
        ]);
        return result({ ...attachment, url: "/api/chat/files/" + id });
      },
    ),
  ];
}
