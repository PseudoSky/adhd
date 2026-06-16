import { z } from "zod";

/**
 * Input schema for the `usage_query` MCP tool.
 *
 * Every filter is optional — a bare `{}` returns the most recent rows
 * (ordered by created_at desc, capped at `limit`). Filters compose with AND.
 *
 * When `group_by` is set, rows are aggregated by the chosen dimension and the
 * response contains a `groups` array instead of raw `rows`. All other filters
 * still apply before grouping. `limit` caps the number of groups returned,
 * ordered by total token spend (input + output) descending.
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
    /**
     * Aggregate by a dimension instead of returning raw rows.
     *
     * - `"agent"` — one row per agent, ordered by total token spend desc.
     * - `"model"` — one row per model string (e.g. "claude-opus-4-5").
     * - `"provider"` — one row per provider type ("openai", "anthropic", …).
     *
     * Includes `completedCount`, `failedCount`, `cancelledCount` via a join
     * with the `tasks` table. All other filters compose with AND before
     * grouping. `limit` caps the number of groups.
     */
    group_by: z.enum(["agent", "model", "provider"]).optional(),
  })
  .optional();

export type TaskUsageInput = z.infer<typeof taskUsageInputSchema>;

/**
 * One row in the `groups` array returned by `usage_query` when `group_by` is
 * set. Aggregates all matching `task_usage` rows along the chosen dimension.
 *
 * `completedCount`, `failedCount`, `cancelledCount` come from a LEFT JOIN with
 * the `tasks` table. Rows where the tasks row is absent (e.g. ephemeral tasks
 * whose row was deleted) are counted as neither completed nor failed.
 */
export const groupedUsageRowSchema = z.object({
  /** The value of the grouped dimension — agentName, model, or providerType. */
  key: z.string(),
  /** Total number of completed `task_usage` rows in this group. */
  taskCount: z.number().int().nonnegative(),
  /** Tasks that reached `status = 'completed'`. */
  completedCount: z.number().int().nonnegative(),
  /** Tasks that reached `status = 'failed'`. */
  failedCount: z.number().int().nonnegative(),
  /** Tasks that reached `status = 'cancelled'`. */
  cancelledCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  /** Average per-task wall-clock latency in ms (0-latency rows excluded). */
  avgLatencyMs: z.number().nonnegative(),
  /** Sum of Anthropic prompt-cache read tokens (null for non-caching providers). */
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  /** Sum of Anthropic prompt-cache creation tokens (null for non-caching providers). */
  cacheCreationTokens: z.number().int().nonnegative().nullable(),
});
export type GroupedUsageRow = z.infer<typeof groupedUsageRowSchema>;

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
