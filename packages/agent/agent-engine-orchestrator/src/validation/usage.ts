import { z } from "zod";

export const taskUsageInputSchema = z
  .object({
    task_id: z.string().optional(),
    root_task_id: z.string().optional(),
    agent_name: z.string().optional(),
    since: z.string().datetime().optional(),
    include_incomplete: z.boolean().default(false),
    limit: z.number().int().positive().max(500).default(50),
    group_by: z.enum(["agent", "model", "provider"]).optional(),
  })
  .optional();

export type TaskUsageInput = z.infer<typeof taskUsageInputSchema>;

export const groupedUsageRowSchema = z.object({
  key: z.string(),
  taskCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  cancelledCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  avgLatencyMs: z.number().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheCreationTokens: z.number().int().nonnegative().nullable(),
});
export type GroupedUsageRow = z.infer<typeof groupedUsageRowSchema>;

export const usageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  stopReason: z.string().optional(),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

export const taskUsageReportSchema = z.object({
  direct: usageSummarySchema,
  subtree: usageSummarySchema,
  taskCount: z.number().int().positive(),
});

export type TaskUsageReport = z.infer<typeof taskUsageReportSchema>;
