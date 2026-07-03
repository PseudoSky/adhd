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
  };
}

function summarise(rows: TaskUsageRow[]): UsageSummary {
  return rows.reduce<UsageSummary>(
    (acc, row) => ({
      inputTokens: acc.inputTokens + (row.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (row.outputTokens ?? 0),
      modelCalls: acc.modelCalls + (row.modelCalls ?? 0),
      toolCallCount: acc.toolCallCount + (row.toolCallCount ?? 0),
      latencyMs: acc.latencyMs + (row.latencyMs ?? 0),
      stopReason: mostSevereStr(acc.stopReason, row.stopReason ?? undefined),
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

    return {
      rows: [],
      groups,
      summary: { totalInputTokens, totalOutputTokens, totalToolCalls, totalModelCalls, taskCount },
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
