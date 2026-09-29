import { z } from "zod";

export const dataName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const recordId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const fieldDefinition = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
    required: z.boolean().optional(),
    indexed: z.boolean().optional(),
    description: z.string().max(500).optional(),
    maxLength: z.number().int().min(1).max(100000).optional(),
  })
  .strict();
export const collectionDefinition = z
  .object({
    name: dataName,
    description: z.string().max(1000).default(""),
    fields: z
      .record(dataName, fieldDefinition)
      .refine(
        (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 32,
        "Use 1–32 fields.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [key, field] of Object.entries(value.fields)) {
      if (
        [
          "id",
          "version",
          "created_at",
          "updated_at",
          "created_by",
          "updated_by",
          "__proto__",
          "constructor",
          "prototype",
        ].includes(key)
      )
        ctx.addIssue({ code: "custom", message: `Reserved field: ${key}` });
      if (field.indexed && ["object", "array"].includes(field.type))
        ctx.addIssue({
          code: "custom",
          message: "Only scalar fields can be indexed.",
        });
      if (field.maxLength && field.type !== "string")
        ctx.addIssue({
          code: "custom",
          message: "maxLength applies to strings.",
        });
    }
  });
export type CollectionDefinition = z.infer<typeof collectionDefinition>;
export type DataCollection = CollectionDefinition & {
  version: number;
  managed: boolean;
  count: number;
};
export type ChannelDatabase = {
  id: string;
  room_id: string;
  name: string;
  description: string;
  managed: number;
  created_by: string;
  created_at: number;
  version: number;
};
export type DataRecord = {
  id: string;
  data: Record<string, unknown>;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
};
export const recordData = z
  .record(z.string(), z.unknown())
  .refine(
    (v) => new TextEncoder().encode(JSON.stringify(v)).length <= 256000,
    "A record cannot exceed 256 KB.",
  );
export const recordOperation = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("create"),
      collection: dataName,
      id: recordId,
      data: recordData,
    })
    .strict(),
  z
    .object({
      op: z.literal("update"),
      collection: dataName,
      id: recordId,
      version: z.number().int().positive(),
      data: recordData,
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      collection: dataName,
      id: recordId,
      version: z.number().int().positive(),
    })
    .strict(),
]);
export const recordQuery = z
  .object({
    filters: z
      .array(
        z
          .object({
            field: dataName,
            op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
            value: z.union([
              z.string().max(1000),
              z.number().finite(),
              z.boolean(),
            ]),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    orderBy: dataName.default("id"),
    direction: z.enum(["asc", "desc"]).default("asc"),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().max(16000).optional(),
  })
  .strict();
export type RecordQuery = z.input<typeof recordQuery>;
export const noteCollection: CollectionDefinition = {
  name: "notes",
  description: "Shared Markdown project notes",
  fields: {
    title: { type: "string", required: true, maxLength: 160 },
    content: { type: "string", required: true, maxLength: 100000 },
  },
};
export const fileCollection: CollectionDefinition = {
  name: "files",
  description: "Posted R2 attachments; maintained by the workspace",
  fields: {
    name: { type: "string", required: true },
    size: { type: "integer", required: true },
    type: { type: "string", required: true },
    message_id: { type: "string", required: true },
    parent_id: { type: "string" },
    seq: { type: "integer", required: true, indexed: true },
    uploader_id: { type: "string", required: true },
  },
};
