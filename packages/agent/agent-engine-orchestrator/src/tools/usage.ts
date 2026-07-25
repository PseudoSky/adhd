import { and, desc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";

const SEVERITY: Record<string, number> = { length: 3, tool_calls: 2, stop: 1, unknown: 0 };

function mostSevereStr(a: string | undefined, b: string | undefined): string | undefined {
    if (!a && !b) return undefined;
    const sa = SEVERITY[a ?? ""] ?? 0;
    const sb = SEVERITY[b ?? ""] ?? 0;
    return sa >= sb ? a : b;
}

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { taskEventsTable, taskUsageTable, tasksTable } from "@adhd/agent-store-runtime";
import { estimateCostUsd } from "@adhd/agent-core-provider";
import type {
  ContextSizeAt,
  GroupedUsageRow,
  TaskUsageInput,
  TaskUsageReport,
  UsageGrain,
  UsageGrainResponse,
  UsageGrainSummary,
  UsageRow,
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

// ──────────────────────────────────────────────
// Grain-based usage query (DESIGN.md §2-§4, DEBT-AGENTMCP-ACCOUNTING-001)
// ──────────────────────────────────────────────

const ZERO_METRICS = {
  input_tokens: 0,
  output_tokens: 0,
  uncached_input_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  reasoning_tokens: 0,
  tool_call_count: 0,
  model_calls: 0,
  compute_ms: 0,
  total_ms: 0,
  tool_call_est_result_tokens: 0,
};

/** Sums the 10 additive fields + MAXes context_size, across whatever grain of row is passed. */
function summariseGrainRows(rows: UsageRow[]): UsageGrainSummary {
  const totals = rows.reduce(
    (acc, r) => ({
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      uncached_input_tokens: acc.uncached_input_tokens + r.uncached_input_tokens,
      cache_read_tokens: acc.cache_read_tokens + r.cache_read_tokens,
      cache_creation_tokens: acc.cache_creation_tokens + r.cache_creation_tokens,
      reasoning_tokens: acc.reasoning_tokens + r.reasoning_tokens,
      tool_call_count: acc.tool_call_count + r.tool_call_count,
      model_calls: acc.model_calls + r.model_calls,
      compute_ms: acc.compute_ms + r.compute_ms,
      total_ms: acc.total_ms + r.total_ms,
      tool_call_est_result_tokens: acc.tool_call_est_result_tokens + r.tool_call_est_result_tokens,
    }),
    { ...ZERO_METRICS }
  );

  // NULL (never 0) once ANY row's cost is unknown — a partial sum would silently
  // understate true cost (same "never silently wrong" rule as the per-row field).
  let estCostUsd: number | null = 0;
  let context_size = 0;
  let context_size_at: ContextSizeAt | null = null;
  for (const r of rows) {
    estCostUsd = estCostUsd === null || r.est_cost_usd === null ? null : estCostUsd + r.est_cost_usd;
    if (r.context_size > context_size) {
      context_size = r.context_size;
      context_size_at = r.context_size_at;
    }
  }

  return {
    row_count: rows.length,
    ...totals,
    est_cost_usd: rows.length === 0 ? null : estCostUsd,
    context_size,
    context_size_at,
  };
}

/** Turn grain rows have no aggregation to do — a turn's own row is its context peak. */
function contextSizeAtSelf(taskId: string, callIndex: number | null): ContextSizeAt {
  return { task_id: taskId, call_index: callIndex };
}

/** created_at DESC comparator shared by every grain's row ordering. */
function compareCreatedAtDesc(a: UsageRow, b: UsageRow): number {
  if (a.created_at < b.created_at) return 1;
  if (a.created_at > b.created_at) return -1;
  return 0;
}

function taskScopeWhere(db: Database, input: TaskUsageInput): SQL | undefined {
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
  return filters.length > 0 ? and(...filters) : undefined;
}

/** Task grain (§4): one row per `task_usage` entry — the pre-existing cumulative rollup,
 * just remapped onto the flattened snake_case row shape. */
function taskGrainRows(db: Database, input: TaskUsageInput): UsageRow[] {
  const whereClause = taskScopeWhere(db, input);
  const limit = input?.limit ?? 50;

  const joined = db
    .select({ usage: taskUsageTable, sessionId: tasksTable.sessionId })
    .from(taskUsageTable)
    .leftJoin(tasksTable, eq(taskUsageTable.taskId, tasksTable.id))
    .where(whereClause)
    .orderBy(desc(taskUsageTable.createdAt))
    .limit(limit)
    .all();

  return joined.map(({ usage: r, sessionId }) => ({
    session_id: sessionId ?? null,
    task_id: r.taskId,
    root_task_id: r.rootTaskId ?? null,
    call_index: null,
    agent_name: r.agentName,
    provider_type: r.providerType,
    model: r.model,
    created_at: r.createdAt,
    is_complete: r.isComplete === 1,
    stop_reason: r.stopReason ?? null,
    input_tokens: r.inputTokens ?? 0,
    output_tokens: r.outputTokens ?? 0,
    uncached_input_tokens: r.uncachedInputTokens ?? 0,
    cache_read_tokens: r.cacheReadTokens ?? 0,
    cache_creation_tokens: r.cacheCreationTokens ?? 0,
    reasoning_tokens: r.reasoningTokens ?? 0,
    tool_call_count: r.toolCallCount ?? 0,
    model_calls: r.modelCalls ?? 0,
    // compute_ms/est_tool_result_tokens/est_cost_usd are additive rollups that only
    // exist from migration 0010 onward — NULL on any pre-migration row, coalesced
    // to 0 here (never 0 for est_cost_usd unless it's genuinely a $0 rate-card hit;
    // a pre-migration NULL and a "model unknown" NULL are indistinguishable at this
    // grain, both correctly surface as "no cost data" via the same NULL passthrough).
    compute_ms: r.computeMs ?? 0,
    total_ms: r.latencyMs ?? 0,
    tool_call_est_result_tokens: r.estToolResultTokens ?? 0,
    est_cost_usd: r.estCostUsd ?? null,
    context_size: r.peakContextTokens ?? 0,
    context_size_at: contextSizeAtSelf(r.taskId, r.peakContextAt ?? null),
  }));
}

/** Session grain (§4): Σ over every task in `tasks.session_id = X` — transitively Σ over
 * every turn in the session. Identity fields with no single value across the session
 * (task_id, agent_name, provider_type, model, stop_reason) are null; `context_size_at`
 * still identifies exactly which task/call produced the session's peak. */
function sessionGrainRows(db: Database, input: TaskUsageInput): UsageRow[] {
  const whereClause = taskScopeWhere(db, input);

  const joined = db
    .select({ usage: taskUsageTable, task: tasksTable })
    .from(taskUsageTable)
    .innerJoin(tasksTable, eq(taskUsageTable.taskId, tasksTable.id))
    .where(whereClause)
    .all();

  const bySession = new Map<string, typeof joined>();
  for (const row of joined) {
    const sid = row.task.sessionId;
    if (!sid) continue; // session grain requires a session id — see DESIGN.md §2 precondition
    const existing = bySession.get(sid);
    if (existing) {
      existing.push(row);
    } else {
      bySession.set(sid, [row]);
    }
  }

  const rows: UsageRow[] = [];
  for (const [sessionId, group] of bySession) {
    let allComplete = true;
    let minCreatedAt = Infinity;
    let maxCompletedAt = -Infinity;
    let estCostUsd: number | null = 0;
    let context_size = 0;
    let context_size_at: ContextSizeAt = { task_id: group[0].usage.taskId, call_index: null };
    const totals = { ...ZERO_METRICS };

    for (const { usage: u, task: t } of group) {
      totals.input_tokens += u.inputTokens ?? 0;
      totals.output_tokens += u.outputTokens ?? 0;
      totals.uncached_input_tokens += u.uncachedInputTokens ?? 0;
      totals.cache_read_tokens += u.cacheReadTokens ?? 0;
      totals.cache_creation_tokens += u.cacheCreationTokens ?? 0;
      totals.reasoning_tokens += u.reasoningTokens ?? 0;
      totals.tool_call_count += u.toolCallCount ?? 0;
      totals.model_calls += u.modelCalls ?? 0;
      totals.compute_ms += u.computeMs ?? 0;
      totals.tool_call_est_result_tokens += u.estToolResultTokens ?? 0;

      estCostUsd = estCostUsd === null || u.estCostUsd == null ? null : estCostUsd + u.estCostUsd;

      const peak = u.peakContextTokens ?? 0;
      if (peak > context_size) {
        context_size = peak;
        context_size_at = { task_id: u.taskId, call_index: u.peakContextAt ?? null };
      }

      const created = Date.parse(t.createdAt);
      if (!Number.isNaN(created) && created < minCreatedAt) minCreatedAt = created;
      const completed = Date.parse(t.completedAt ?? t.updatedAt ?? t.createdAt);
      if (!Number.isNaN(completed) && completed > maxCompletedAt) maxCompletedAt = completed;

      if (u.isComplete !== 1) allComplete = false;
    }

    // Real elapsed span (MAX(completed) - MIN(created)) across the session's tasks —
    // correctly handles concurrent/delegated sub-tasks instead of oversumming them
    // (DESIGN.md §4/§6).
    const total_ms =
      Number.isFinite(minCreatedAt) && Number.isFinite(maxCompletedAt)
        ? Math.max(0, maxCompletedAt - minCreatedAt)
        : 0;

    // Earliest task's created_at represents the session's start for this row.
    const created_at = group.reduce(
      (earliest, { task: t }) => (t.createdAt < earliest ? t.createdAt : earliest),
      group[0].task.createdAt
    );

    rows.push({
      session_id: sessionId,
      task_id: null,
      root_task_id: null,
      call_index: null,
      agent_name: null,
      provider_type: null,
      model: null,
      created_at,
      is_complete: allComplete,
      stop_reason: null,
      ...totals,
      total_ms,
      est_cost_usd: estCostUsd,
      context_size,
      context_size_at,
    });
  }

  rows.sort(compareCreatedAtDesc);
  const limit = input?.limit ?? 50;
  return rows.slice(0, limit);
}

interface TaskEventRow {
  taskId: string;
  type: string;
  payload: string | null;
  createdAt: string;
}

/** Turn grain (§4): the base unit — one row per `MODEL_RESPONSE` event, sourced from
 * `task_events` (not `task_usage`). Tool-result token estimates are attributed to the
 * turn they were produced under by walking events in creation order per task and
 * accumulating `TOOL_RESULT`s between a `MODEL_RESPONSE` and the next `MODEL_REQUEST`
 * (or end of task) — mirroring exactly how the orchestrator interleaves them. */
function turnGrainRows(db: Database, input: TaskUsageInput): UsageRow[] {
  const whereClause = taskScopeWhere(db, input);

  const taskInfo = db
    .select({ usage: taskUsageTable, sessionId: tasksTable.sessionId })
    .from(taskUsageTable)
    .leftJoin(tasksTable, eq(taskUsageTable.taskId, tasksTable.id))
    .where(whereClause)
    .all();

  if (taskInfo.length === 0) return [];

  const infoByTaskId = new Map(taskInfo.map((r) => [r.usage.taskId, r]));
  const taskIds = [...infoByTaskId.keys()];

  const events = db
    .select({
      taskId: taskEventsTable.taskId,
      type: taskEventsTable.type,
      payload: taskEventsTable.payload,
      createdAt: taskEventsTable.createdAt,
    })
    .from(taskEventsTable)
    .where(
      and(
        inArray(taskEventsTable.taskId, taskIds),
        or(
          eq(taskEventsTable.type, "MODEL_REQUEST"),
          eq(taskEventsTable.type, "MODEL_RESPONSE"),
          eq(taskEventsTable.type, "TOOL_RESULT")
        )
      )
    )
    .orderBy(taskEventsTable.taskId, taskEventsTable.createdAt)
    .all() as TaskEventRow[];

  const rows: UsageRow[] = [];
  let currentTaskId: string | null = null;
  let callIndex = 0;
  let pendingToolTokens = 0;
  let lastResponseRow: UsageRow | null = null;

  const flush = () => {
    if (lastResponseRow) {
      lastResponseRow.tool_call_est_result_tokens += pendingToolTokens;
    }
    pendingToolTokens = 0;
  };

  for (const evt of events) {
    if (evt.taskId !== currentTaskId) {
      flush();
      currentTaskId = evt.taskId;
      callIndex = 0;
      lastResponseRow = null;
    }

    if (evt.type === "MODEL_REQUEST") {
      flush();
      lastResponseRow = null;
    } else if (evt.type === "MODEL_RESPONSE") {
      flush();
      callIndex += 1;
      const info = infoByTaskId.get(evt.taskId);
      if (!info) continue; // filtered out of scope (e.g. agent_name/since) at the task level
      const payload = (evt.payload ? JSON.parse(evt.payload) : {}) as {
        stopReason?: string;
        toolCallCount?: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        uncachedInputTokens?: number;
        reasoningTokens?: number;
        computeMs?: number;
      };
      const inputTokens = payload.inputTokens ?? 0;
      const outputTokens = payload.outputTokens ?? 0;
      const cacheReadTokens = payload.cacheReadTokens ?? 0;
      const cacheCreationTokens = payload.cacheCreationTokens ?? 0;
      // Prefer the provider-normalized value captured on the event; fall back to the
      // reconstruction formula (DESIGN.md §4) for events recorded before this field
      // was added to the MODEL_RESPONSE payload.
      const uncachedInputTokens =
        payload.uncachedInputTokens ?? Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
      const reasoningTokens = payload.reasoningTokens ?? 0;
      const computeMs = payload.computeMs ?? 0;
      const model = info.usage.model;
      const estCostUsd = estimateCostUsd(model, {
        uncachedInputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        outputTokens,
      });

      const row: UsageRow = {
        session_id: info.sessionId ?? null,
        task_id: evt.taskId,
        root_task_id: info.usage.rootTaskId ?? null,
        call_index: callIndex,
        agent_name: info.usage.agentName,
        provider_type: info.usage.providerType,
        model,
        created_at: evt.createdAt,
        is_complete: true, // a persisted turn is always a completed model call
        stop_reason: payload.stopReason ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        uncached_input_tokens: uncachedInputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        reasoning_tokens: reasoningTokens,
        tool_call_count: payload.toolCallCount ?? 0,
        model_calls: 1,
        compute_ms: computeMs,
        total_ms: computeMs, // trivial at turn grain — no gap within one call (DESIGN.md §4)
        tool_call_est_result_tokens: 0, // filled in by subsequent TOOL_RESULT events, if any
        est_cost_usd: estCostUsd,
        context_size: inputTokens, // trivial at turn grain — one call IS its own peak
        context_size_at: contextSizeAtSelf(evt.taskId, callIndex),
      };
      rows.push(row);
      lastResponseRow = row;
    } else if (evt.type === "TOOL_RESULT") {
      const payload = (evt.payload ? JSON.parse(evt.payload) : {}) as {
        tool_call_est_result_tokens?: number;
      };
      pendingToolTokens += payload.tool_call_est_result_tokens ?? 0;
    }
  }
  flush();

  const since = input?.since;
  const filtered = since ? rows.filter((r) => r.created_at >= since) : rows;
  filtered.sort(compareCreatedAtDesc);

  const limit = input?.limit ?? 50;
  return filtered.slice(0, limit);
}

/**
 * Grain-based `usage_query` (DESIGN.md §2-§4). Additive alongside the legacy
 * `usageQuery` (which retains `group_by`) — this is the new default path for
 * un-grouped queries and the only path that supports `grain: 'session' | 'turn'`.
 */
export function usageQueryByGrain(db: Database, input: TaskUsageInput): UsageGrainResponse {
  const grain: UsageGrain = input?.grain ?? "task";
  let rows: UsageRow[];
  switch (grain) {
    case "turn":
      rows = turnGrainRows(db, input);
      break;
    case "session":
      rows = sessionGrainRows(db, input);
      break;
    default:
      rows = taskGrainRows(db, input);
  }

  return { grain, rows, summary: summariseGrainRows(rows) };
}
