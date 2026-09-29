import { z } from "zod";
export const interactionSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["approval", "question"]),
  title: z.string().min(1).max(300),
  detail: z.string().max(20000),
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        title: z.string().min(1).max(2000),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(500),
              description: z.string().max(2000).optional(),
            }),
          )
          .max(20),
        multiple: z.boolean().optional(),
        freeform: z.boolean().optional(),
      }),
    )
    .max(10),
  state: z.literal("pending"),
});
export const interactionResponseSchema = z
  .object({
    decision: z.enum(["accept", "decline"]).optional(),
    answers: z
      .record(
        z.string().max(200),
        z.array(z.string().trim().min(1).max(4000)).min(1).max(20),
      )
      .optional(),
  })
  .strict();
