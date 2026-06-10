import { and, desc, eq, gte, or, type SQL } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { taskUsageTable } from "../db/schema.js";
import type {
  TaskUsageInput,
  TaskUsageReport,
  UsageSummary,
} from "../validation/usage.js";

/**
 * Drizzle database handle. Identical to what the stores and UsagePlugin receive.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = BetterSQLite3Database<any>;

/** A single row from the `task_usage` table, as returned by drizzle select. */
export type TaskUsageRow = typeof taskUsageTable.$inferSelect;

export interface UsageQueryResult {
  rows: TaskUsageRow[];
  summary: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalToolCalls: number;
    totalModelCalls: number;
    taskCount: number;
  };
}

/**
 * Folds a set of `task_usage` rows into a single {@link UsageSummary}.
 *
 * claudecli rows carry zeros for token counts — they are summed as-is, so a
 * caller seeing `inputTokens === 0` must not conclude "zero tokens consumed";
 * it may mean the provider does not report token counts. See
 * `[inv:claudecli-undefined]`.
 */
function summarise(rows: TaskUsageRow[]): UsageSummary {
  return rows.reduce<UsageSummary>(
    (acc, row) => ({
      inputTokens: acc.inputTokens + (row.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (row.outputTokens ?? 0),
      modelCalls: acc.modelCalls + (row.modelCalls ?? 0),
      toolCallCount: acc.toolCallCount + (row.toolCallCount ?? 0),
      latencyMs: acc.latencyMs + (row.latencyMs ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      toolCallCount: 0,
      latencyMs: 0,
    }
  );
}

/**
 * `usage_query` tool implementation.
 *
 * Queries `task_usage` with optional filters. Every filter is optional; a bare
 * `{}` (or `undefined`) returns the most recent rows, capped at `limit`.
 *
 * - `task_id`: returns that row AND the full delegation subtree
 *   (`task_id = ? OR root_task_id = ?`).
 * - `root_task_id`: returns the root row plus every descendant
 *   (`task_id = ? OR root_task_id = ?`).
 * - `agent_name`, `since`: plain equality / lower-bound filters.
 * - `include_incomplete` (default false): when false, only `is_complete = 1`
 *   rows are returned.
 *
 * Returns `{ rows: [], summary: { ...zeros, taskCount: 0 } }` when the table
 * is empty or nothing matches.
 */
export function usageQuery(db: Database, input: TaskUsageInput): UsageQueryResult {
  const filters: SQL[] = [];

  // task_id and root_task_id both expand to a subtree match.
  if (input?.task_id) {
    const id = input.task_id;
    const subtree = or(eq(taskUsageTable.taskId, id), eq(taskUsageTable.rootTaskId, id));
    if (subtree) filters.push(subtree);
  }
  if (input?.root_task_id) {
    const id = input.root_task_id;
    const subtree = or(eq(taskUsageTable.taskId, id), eq(taskUsageTable.rootTaskId, id));
    if (subtree) filters.push(subtree);
  }
  if (input?.agent_name) {
    filters.push(eq(taskUsageTable.agentName, input.agent_name));
  }
  if (input?.since) {
    filters.push(gte(taskUsageTable.createdAt, input.since));
  }
  if (!input?.include_incomplete) {
    filters.push(eq(taskUsageTable.isComplete, 1));
  }

  const limit = input?.limit ?? 50;

  const rows = db
    .select()
    .from(taskUsageTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(taskUsageTable.createdAt))
    .limit(limit)
    .all();

  return {
    rows,
    summary: {
      totalInputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
      totalOutputTokens: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
      totalToolCalls: rows.reduce((n, r) => n + (r.toolCallCount ?? 0), 0),
      totalModelCalls: rows.reduce((n, r) => n + (r.modelCalls ?? 0), 0),
      taskCount: rows.length,
    },
  };
}

/**
 * Builds a {@link TaskUsageReport} for enriching a `task` / `result` response.
 *
 * - `direct`: aggregates `task_usage WHERE task_id = ?` (this task's own model
 *   calls only).
 * - `subtree`: aggregates `task_usage WHERE task_id = ? OR root_task_id = ?`
 *   (this task plus every sub-task that recorded it as its root).
 * - `taskCount`: number of distinct rows folded into the subtree.
 *
 * Returns `undefined` when no `task_usage` row exists for the task — i.e. the
 * task ran zero model calls (still running, or cancelled before its first
 * model call). See `[shape:TaskUsageReport]`.
 *
 * claudecli rows are present with zero token counts and are returned as-is.
 */
export function buildTaskUsageReport(
  db: Database,
  taskId: string
): TaskUsageReport | undefined {
  const subtreeRows = db
    .select()
    .from(taskUsageTable)
    .where(or(eq(taskUsageTable.taskId, taskId), eq(taskUsageTable.rootTaskId, taskId)))
    .all();

  if (subtreeRows.length === 0) {
    return undefined;
  }

  const directRows = subtreeRows.filter(row => row.taskId === taskId);

  return {
    direct: summarise(directRows),
    subtree: summarise(subtreeRows),
    taskCount: subtreeRows.length,
  };
}
