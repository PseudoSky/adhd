import { and, desc, eq, gte, or, sql, type SQL } from "drizzle-orm";

const SEVERITY: Record<string, number> = { length: 3, tool_calls: 2, stop: 1, unknown: 0 };

function mostSevereStr(a: string | undefined, b: string | undefined): string | undefined {
    if (!a && !b) return undefined;
    const sa = SEVERITY[a ?? ""] ?? 0;
    const sb = SEVERITY[b ?? ""] ?? 0;
    return sa >= sb ? a : b;
}

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { taskUsageTable, tasksTable } from "@adhd/agent-store-runtime";
import type {
  GroupedUsageRow,
  TaskUsageInput,
  TaskUsageReport,
  UsageSummary,
} from "../validation/usage.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = BetterSQLite3Database<any>;

export type TaskUsageRow = typeof taskUsageTable.$inferSelect;

export interface UsageQueryResult {
  rows: TaskUsageRow[];
  groups?: GroupedUsageRow[];
  summary: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalToolCalls: number;
    totalModelCalls: number;
    taskCount: number;
    /** Full-price (cache-miss) input — the actual cost driver, not totalInputTokens
     * (BUG-ORCH-009 follow-up gap: previously dropped from this summary block). */
    totalUncachedInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    totalReasoningTokens: number;
    /** PEAK single-call input across every row in scope (a MAX, not a SUM). */
    peakContextTokens: number;
  };
}

/**
 * `inputTokens` is CUMULATIVE BILLED input across model calls — the whole history is
 * re-sent on every call, so it is not a context size and must never be compared against a
 * model's context window. `peakContextTokens` is the real high-water mark and is a MAX,
 * so it is maxed here rather than summed. Conflating the two is what produced a "710K
 * context" post-mortem for a run whose largest context was 43K (FINDING-ORCH-007).
 *
 * Cache fields are surfaced because cache-hit vs cache-miss input is a 50x price
 * difference — without them a caller cannot tell a cheap run from an expensive one of
 * identical token count (BUG-ORCH-009).
 */
function summarise(rows: TaskUsageRow[]): UsageSummary {
  return rows.reduce<UsageSummary>(
    (acc, row) => ({
      inputTokens: acc.inputTokens + (row.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (row.outputTokens ?? 0),
      modelCalls: acc.modelCalls + (row.modelCalls ?? 0),
      toolCallCount: acc.toolCallCount + (row.toolCallCount ?? 0),
      latencyMs: acc.latencyMs + (row.latencyMs ?? 0),
      stopReason: mostSevereStr(acc.stopReason, row.stopReason ?? undefined),
      uncachedInputTokens: acc.uncachedInputTokens + (row.uncachedInputTokens ?? 0),
      cacheReadTokens: acc.cacheReadTokens + (row.cacheReadTokens ?? 0),
      cacheCreationTokens: acc.cacheCreationTokens + (row.cacheCreationTokens ?? 0),
      reasoningTokens: acc.reasoningTokens + (row.reasoningTokens ?? 0),
      // MAX across rows — deliberately NOT a sum.
      peakContextTokens: Math.max(acc.peakContextTokens, row.peakContextTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
      toolCallCount: 0,
      latencyMs: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      peakContextTokens: 0,
    }
  );
}

export function usageQuery(db: Database, input: TaskUsageInput): UsageQueryResult {
  const filters: SQL[] = [];

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

  const whereClause = filters.length > 0 ? and(...filters) : undefined;
  const limit = input?.limit ?? 50;

  if (input?.group_by) {
    let groupCol: typeof taskUsageTable.model | typeof taskUsageTable.providerType | typeof taskUsageTable.agentName;
    if (input.group_by === "model") {
        groupCol = taskUsageTable.model;
    } else if (input.group_by === "provider") {
        groupCol = taskUsageTable.providerType;
    } else {
        groupCol = taskUsageTable.agentName;
    }

    const groups = db
      .select({
        key: groupCol,
        taskCount:          sql<number>`count(*)`,
        completedCount:     sql<number>`sum(case when ${tasksTable.status} = 'completed' then 1 else 0 end)`,
        failedCount:        sql<number>`sum(case when ${tasksTable.status} = 'failed' then 1 else 0 end)`,
        cancelledCount:     sql<number>`sum(case when ${tasksTable.status} = 'cancelled' then 1 else 0 end)`,
        inputTokens:        sql<number>`sum(${taskUsageTable.inputTokens})`,
        outputTokens:       sql<number>`sum(${taskUsageTable.outputTokens})`,
        toolCallCount:      sql<number>`sum(${taskUsageTable.toolCallCount})`,
        modelCalls:         sql<number>`sum(${taskUsageTable.modelCalls})`,
        avgLatencyMs:       sql<number>`avg(case when ${taskUsageTable.latencyMs} > 0 then ${taskUsageTable.latencyMs} else null end)`,
        cacheReadTokens:    sql<number | null>`sum(${taskUsageTable.cacheReadTokens})`,
        cacheCreationTokens: sql<number | null>`sum(${taskUsageTable.cacheCreationTokens})`,
        // BUG-ORCH-009 follow-up: these were dropped from the grouped view even though
        // the non-grouped (raw rows) path always had them — folded in the same way
        // cacheReadTokens/cacheCreationTokens already were.
        uncachedInputTokens: sql<number | null>`sum(${taskUsageTable.uncachedInputTokens})`,
        reasoningTokens:    sql<number | null>`sum(${taskUsageTable.reasoningTokens})`,
        // MAX across the group, deliberately NOT a sum (FINDING-ORCH-007).
        peakContextTokens:  sql<number | null>`max(${taskUsageTable.peakContextTokens})`,
      })
      .from(taskUsageTable)
      .leftJoin(tasksTable, eq(taskUsageTable.taskId, tasksTable.id))
      .where(whereClause)
      .groupBy(groupCol)
      .orderBy(desc(sql`sum(${taskUsageTable.inputTokens} + ${taskUsageTable.outputTokens})`))
      .limit(limit)
      .all() as GroupedUsageRow[];

    const totalInputTokens  = groups.reduce((n, r) => n + r.inputTokens, 0);
    const totalOutputTokens = groups.reduce((n, r) => n + r.outputTokens, 0);
    const totalToolCalls    = groups.reduce((n, r) => n + r.toolCallCount, 0);
    const totalModelCalls   = groups.reduce((n, r) => n + r.modelCalls, 0);
    const taskCount         = groups.reduce((n, r) => n + r.taskCount, 0);
    const totalUncachedInputTokens = groups.reduce((n, r) => n + (r.uncachedInputTokens ?? 0), 0);
    const totalCacheReadTokens = groups.reduce((n, r) => n + (r.cacheReadTokens ?? 0), 0);
    const totalCacheCreationTokens = groups.reduce((n, r) => n + (r.cacheCreationTokens ?? 0), 0);
    const totalReasoningTokens = groups.reduce((n, r) => n + (r.reasoningTokens ?? 0), 0);
    // MAX across groups — deliberately NOT a sum.
    const peakContextTokens = groups.reduce((n, r) => Math.max(n, r.peakContextTokens ?? 0), 0);

    return {
      rows: [],
      groups,
      summary: {
        totalInputTokens,
        totalOutputTokens,
        totalToolCalls,
        totalModelCalls,
        taskCount,
        totalUncachedInputTokens,
        totalCacheReadTokens,
        totalCacheCreationTokens,
        totalReasoningTokens,
        peakContextTokens,
      },
    };
  }

  const rows = db
    .select()
    .from(taskUsageTable)
    .where(whereClause)
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
      totalUncachedInputTokens: rows.reduce((n, r) => n + (r.uncachedInputTokens ?? 0), 0),
      totalCacheReadTokens: rows.reduce((n, r) => n + (r.cacheReadTokens ?? 0), 0),
      totalCacheCreationTokens: rows.reduce((n, r) => n + (r.cacheCreationTokens ?? 0), 0),
      totalReasoningTokens: rows.reduce((n, r) => n + (r.reasoningTokens ?? 0), 0),
      // MAX across rows — deliberately NOT a sum (FINDING-ORCH-007).
      peakContextTokens: rows.reduce((n, r) => Math.max(n, r.peakContextTokens ?? 0), 0),
    },
  };
}

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
