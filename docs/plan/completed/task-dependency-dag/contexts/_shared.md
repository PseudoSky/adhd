# Shared Definitions — task-dependency-dag

## [def:WaitingStatus]

`"waiting"` is a new task status meaning "all dependencies not yet resolved". A `waiting` task is
never enqueued. It transitions to `pending` (and is immediately dispatched) when all its
`depends_on` entries have reached a terminal status.

Terminal statuses: `completed`, `failed`, `cancelled`.

## [def:DependencyResolution]

A downstream task's dependencies are "resolved" when every task ID in its `depends_on` array has
reached a terminal status. Resolution is evaluated by `DagEngine.dispatchReady()` after each task
terminal event.

## [def:UpstreamFailure]

When an upstream task reaches `failed` or `cancelled`:
- `on_upstream_failure === "fail"` (default): downstream transitions to `failed` immediately,
  error set to `"Upstream task <id> failed/cancelled"`. Never dispatched.
- `on_upstream_failure === "skip"`: downstream is treated as if the upstream completed. Dispatched
  when all other deps are also resolved. Upstream results that are `null` or `undefined` are
  omitted from `inputs`.

## [shape:DependsOn]

```typescript
// In taskSchema / tasksTable:
dependsOn?: string[]           // JSON-serialised array of task UUIDs; null if no deps
onUpstreamFailure?: "fail" | "skip"  // default: "fail"
inputs?: Record<string, string>      // taskId → upstream result string; set at dispatch time
```

## [shape:ExecutionContextInputs]

`ExecutionContext` gains an optional `inputs` field:
```typescript
inputs?: Record<string, string>   // populated from the task row at run-time start
```

## [ref:task-status-enum]

`tasksTable.status` enum in `db/schema.ts` and `taskStatusSchema` z.enum in `validation/task.ts`
must always list the same values. Add `"waiting"` to both in the `dag-schema` and `dag-types`
states respectively.

## [ref:drizzle-upsert-increment]

Accumulator columns use `sql\`${table.col} + ${value}\`` in `onConflictDoUpdate`. Non-accumulator
new columns (`dependsOn`, `onUpstreamFailure`, `inputs`) use direct assignment.

## [ref:tool-error-throw]

All new operational errors use `throw new ToolError("CODE", message)`. Cycle detection throws
`new ToolError("VALIDATION_ERROR", "Dependency cycle detected: ...")`.

## [inv:waiting-no-queue]

Tasks with status `"waiting"` are NEVER passed to `BackgroundQueue.enqueue()`. Only `"pending"`
tasks are enqueued. The transition from `waiting` → `pending` and enqueue happens atomically in
`DagEngine.dispatchReady()`.

## [inv:dispatch-on-completion]

`DagEngine.dispatchReady(completedTaskId)` is called by the task completion path in
`tools/task.ts`. It must fire on EVERY terminal event (`completed`, `failed`, `cancelled`) so
that `on_upstream_failure` can be evaluated correctly.

## [inv:inputs-populated-at-dispatch]

`inputs` is populated from the DB at dispatch time in `DagEngine.dispatchReady()` — immediately
before enqueueing. It is written to the task row so it survives process restart. It is NOT
re-populated on later status changes.

## [inv:cycle-check-synchronous]

`DagEngine.validateNoCycle(newTaskId, dependsOn, db)` runs synchronously before the task row is
inserted. If a cycle is detected, `ToolError("VALIDATION_ERROR", ...)` is thrown and no row
is written.
