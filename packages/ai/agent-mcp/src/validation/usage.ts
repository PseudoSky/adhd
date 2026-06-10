import { z } from "zod";

/**
 * Input schema for the `usage_query` MCP tool.
 *
 * Every filter is optional — a bare `{}` returns the most recent rows
 * (ordered by created_at desc, capped at `limit`). Filters compose with AND.
 */
export const taskUsageInputSchema = z
  .object({
    /**
     * Exact task. When set, the query also returns the full delegation subtree:
     * every row where `root_task_id = task_id`, plus the task's own row.
     */
    task_id: z.string().optional(),
    /**
     * All tasks in this delegation tree (the root row plus every descendant
     * whose `root_task_id` matches).
     */
    root_task_id: z.string().optional(),
    agent_name: z.string().optional(),
    /** ISO-8601 timestamp; filter `created_at >=` this value. */
    since: z.string().datetime().optional(),
    /** Include `is_complete = 0` rows (in-progress or crashed-before-terminal). */
    include_incomplete: z.boolean().default(false),
    limit: z.number().int().positive().max(500).default(50),
  })
  .optional();

export type TaskUsageInput = z.infer<typeof taskUsageInputSchema>;

/**
 * Aggregated token counts for a single task or a subtree.
 */
export const usageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  stopReason: z.string().optional(),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

/**
 * Token usage rollup attached to a task response (`[shape:TaskUsageReport]`).
 *
 * - `direct`: this task's own model calls only (`task_id = ?`).
 * - `subtree`: this task plus all sub-tasks (`task_id = ? OR root_task_id = ?`).
 * - `subtree` equals `direct` when `taskCount === 1`.
 */
export const taskUsageReportSchema = z.object({
  direct: usageSummarySchema,
  subtree: usageSummarySchema,
  taskCount: z.number().int().positive(),
});

export type TaskUsageReport = z.infer<typeof taskUsageReportSchema>;
