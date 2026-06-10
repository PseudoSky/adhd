# State: usage-query-tool

**Phase:** plugin  
**Kind:** work  
**Depends on:** usage-plugin

## Goal

Add the `usage_query` MCP tool to `server.ts` so callers can query token usage by task ID, agent name, or time window. Also rename the existing `usage` guide tool to `guide` (same state — both touch `server.ts`).

## Semantic distillation

The new tool is named `usage_query`. The existing `usage` tool (which returns a prose server guide) is renamed to `guide` — it IS a guide, not a usage report, and freeing the "usage" namespace avoids caller confusion. It follows the existing server.ts registration pattern (`[ref:server-tool-pattern]`):
1. Define input Zod schema in `validation/usage.ts`
2. Implement query function in `tools/usage.ts`
3. Register in four places in `server.ts`

Input schema (filters — all optional; bare `{}` returns recent rows):
```typescript
export const taskUsageInputSchema = z.object({
  task_id:      z.string().optional(), // exact task; also returns full subtree if this is a root
  root_task_id: z.string().optional(), // all tasks in this delegation tree (root + all descendants)
  agent_name:   z.string().optional(),
  since:        z.string().datetime().optional(), // ISO-8601; filter created_at >=
  include_incomplete: z.boolean().default(false), // include is_complete=0 rows (in-progress / crashed)
  limit:        z.number().int().positive().max(500).default(50),
}).optional();
```

When `task_id` is provided, the query returns both that row AND all rows where `root_task_id = task_id` — giving the full delegation subtree in one call. Callers don't need to know the tree structure.

When `root_task_id` is provided directly, returns all rows matching `root_task_id = ?` plus the root row itself (`task_id = ?`).

Output: `{ rows: TaskUsageRow[], summary: { totalInputTokens, totalOutputTokens, totalToolCalls, totalModelCalls, taskCount } }`. Summary aggregates across all returned rows so callers get the full tree cost in one number.

The query function in `tools/usage.ts` uses drizzle's select API against `taskUsageTable`. It must handle the case where the table is empty (return `[]`).

See `[ref:server-tool-pattern]`.

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/schema.ts"]
mutates:    ["packages/ai/agent-mcp/src/tools/usage.ts",
             "packages/ai/agent-mcp/src/tools/task.ts",
             "packages/ai/agent-mcp/src/validation/usage.ts",
             "packages/ai/agent-mcp/src/validation/task.ts",
             "packages/ai/agent-mcp/src/validation/index.ts",
             "packages/ai/agent-mcp/src/server.ts",
             "packages/ai/agent-mcp/INSTALL.md",
             "packages/ai/agent-mcp/README.md"]
```

## Contract promise

**Added:**
- `validation/usage.ts` — `taskUsageInputSchema`, `TaskUsageInput` type
- `tools/usage.ts` — `usageQuery(db, input)` query function; `buildTaskUsageReport(db, taskId)` enrichment helper
- `usage_query` tool entry in `server.ts` ListTools handler
- `usage_query` case in `server.ts` CallTool handler
- `usage_query` entry in `inProcessDescriptors` array
- `usage_query` case in `inProcessHandler` switch

**Renamed in `server.ts`:**
- `usage` (guide) → `guide` in ListTools descriptor, CallTool case, inProcessDescriptors, and inProcessHandler

**Modified:**
- `validation/index.ts` — export `taskUsageInputSchema`
- `validation/task.ts` — `taskToolOutputSchema` gains optional `usage?: TaskUsageReport` field; add `usageSummarySchema` and `taskUsageReportSchema` Zod definitions
- `tools/task.ts` — `TaskDeps` gains `db: Database`; `resultTool()` and sync `taskTool()` call `buildTaskUsageReport(db, taskId)` to enrich their return value with `usage`

**Deleted:** nothing

## Acceptance criteria

```bash
# [usage-query-tool.1] usage_query tool registered in server.ts ListTools
cd /Users/nix/dev/node/adhd
grep -n '"usage_query"' packages/ai/agent-mcp/src/server.ts | grep -q '.'

# [usage-query-tool.2] usage_query case in CallTool handler
grep -n '"usage_query"' packages/ai/agent-mcp/src/server.ts | grep -q 'case'

# [usage-query-tool.3] usage_query appears in all 4 server.ts registration points
grep -c '"usage_query"' packages/ai/agent-mcp/src/server.ts | grep -qE '[4-9]|[1-9][0-9]'

# [usage-query-tool.4] Query function exists and references taskUsageTable (DB table name unchanged)
grep -n 'taskUsageTable' packages/ai/agent-mcp/src/tools/usage.ts | grep -q '.'

# [usage-query-tool.5] Build passes
npx nx build agent-mcp --skip-nx-cache 2>&1 | tail -3 | grep -iv 'error'

# [usage-query-tool.6] All tests pass
npx nx test agent-mcp 2>&1 | tail -5 | grep -q 'pass\|PASS'

# [usage-query-tool.7] INSTALL.md documents usage_query in permissions.allow
grep -n 'usage_query' packages/ai/agent-mcp/INSTALL.md | grep -q '.'

# [usage-query-tool.8] README.md references usage_query tool
grep -n 'usage_query' packages/ai/agent-mcp/README.md | grep -q '.'

# [usage-query-tool.9] Query function supports root_task_id subtree lookup
grep -n 'root_task_id\|rootTaskId' packages/ai/agent-mcp/src/tools/usage.ts | grep -q '.'

# [usage-query-tool.10] Input schema includes root_task_id and include_incomplete fields
grep -n 'root_task_id\|include_incomplete' packages/ai/agent-mcp/src/validation/usage.ts | grep -q '.'

# [usage-query-tool.15] guide tool exists in server.ts (usage renamed to guide)
grep -n '"guide"' packages/ai/agent-mcp/src/server.ts | grep -q '.'

# [usage-query-tool.16] Old standalone 'usage' guide tool name is gone from server.ts
# (task_usage table name may still appear in tools/usage.ts — only check server.ts for the tool name)
! grep -n 'name.*"usage"\b\|case.*"usage"\b' packages/ai/agent-mcp/src/server.ts | grep -qv 'usage_query'

# [usage-query-tool.11] taskToolOutputSchema has optional usage field
grep -n 'usage' packages/ai/agent-mcp/src/validation/task.ts | grep -q 'TaskUsageReport\|usageReport\|subtree'

# [usage-query-tool.12] resultTool enriches response with usage (direct + subtree)
grep -n 'buildTaskUsageReport\|usage' packages/ai/agent-mcp/src/tools/task.ts | grep -q 'buildTaskUsageReport\|direct\|subtree'

# [usage-query-tool.13] Sync taskTool includes usage in return value
# resultTool and sync task path both call buildTaskUsageReport
grep -n 'buildTaskUsageReport' packages/ai/agent-mcp/src/tools/task.ts | wc -l | grep -qE '[2-9]'

# [usage-query-tool.14] claudecli path: buildTaskUsageReport returns zeros, not undefined/error
# The helper must handle the case where task_usage row has zero tokens (claudecli row)
grep -n 'inputTokens.*0\|inputTokens.*??\|inputTokens.*\?\.' packages/ai/agent-mcp/src/tools/usage.ts | grep -q '.'
```

## Commit points

**R1 (plan write):** Plan file edits committed.

**R2 (work product):** After guard exits 0:
```
feat(agent-mcp): add usage_query MCP tool; rename usage guide tool to guide
```

## Notes

The existing `usage` tool returns a prose how-to guide. Rename it `guide` — it IS a guide, and "usage" unambiguously means resource consumption after this feature lands. Two-line change in server.ts: the `name:` in ListTools and the `case` string in CallTool (plus inProcessDescriptors and inProcessHandler).

INSTALL.md `permissions.allow` list in the package docs will need `"mcp__agent-mcp__usage_query"` added and `"mcp__agent-mcp__usage"` updated to `"mcp__agent-mcp__guide"` — documentation-only changes. Do both in this state's commit.

Also add `task_usage` to INSTALL.md's `permissions.allow` list and to the README tool reference table.

For the drizzle query, look at `AgentStore.list()` for the reference pattern — it's the simplest select-all case.

**Enriching `result` and `task` responses (`[dod.2]`):**

Add a helper `buildTaskUsageReport(db: Database, taskId: string): TaskUsageReport | undefined` to `tools/usage.ts`:
- If no `task_usage` row exists for `taskId`, return `undefined` (task ran zero model calls).
- `direct`: `SELECT * FROM task_usage WHERE task_id = ?` → aggregate into `UsageSummary`.
- `subtree`: `SELECT * FROM task_usage WHERE task_id = ? OR root_task_id = ?` → aggregate + count rows for `taskCount`.
- claudecli rows have zeros — return them as-is; callers see `usage.direct.inputTokens === 0`.

`TaskDeps` gains `db: Database` (or a typed drizzle instance). `server.ts` already has `db` in scope — pass it when constructing the `taskDeps` object.

In `resultTool()`:
```typescript
export function resultTool(input, deps): Task & { usage?: TaskUsageReport } {
  const task = deps.taskStore.read(input.task_id);
  const usage = buildTaskUsageReport(deps.db, task.id);
  return { ...task, usage };
}
```

In sync `taskTool()` (session mode), after `runTask()`:
```typescript
const finalTask = deps.taskStore.read(task.id);
const usage = buildTaskUsageReport(deps.db, task.id);
return { task_id: finalTask.id, status: finalTask.status, result: finalTask.result, usage };
```

In `runEphemeralTask()`, after the orchestrator runs:
```typescript
const usage = buildTaskUsageReport(deps.db, taskId);
return { task_id: taskId, status: capturedStatus, result: capturedResult, usage };
```

See `[shape:TaskUsageReport]` and `[shape:UsageSummary]` in `contexts/_shared.md`.
