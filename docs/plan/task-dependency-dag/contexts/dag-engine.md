# dag-engine

**Phase:** engine · **Depends on:** — · **Guard:**
```bash
test -f packages/ai/agent-mcp/src/engine/dag-engine.ts && \
grep -q 'dispatchReady' packages/ai/agent-mcp/src/engine/dag-engine.ts && \
grep -q 'cycle\|Cycle' packages/ai/agent-mcp/src/engine/dag-engine.ts && \
npx --yes nx test agent-mcp 2>&1 | grep -qE 'passed'
```

> **PREREQUISITE: `task-schema-foundation` must be deployed before this node executes.**
> Required codebase state:
> - `depends_on`, `on_upstream_failure`, `inputs` columns in `schema.ts` + migration 0004_*
> - `"waiting"` and `"awaiting_input"` in `taskStatusSchema` (`validation/task.ts`)
> - `TaskStore.create()` accepts `dependsOn`, `onUpstreamFailure`; sets `"waiting"` when `dependsOn.length > 0`
> - `@adhd/agent-mcp-types` `TaskStatus` union includes both new values
>
> This node does NOT add migrations, does NOT modify `validation/task.ts` or `task-store.ts`.
> Those are owned by `task-schema-foundation`.

---

## Goal

Create `DagEngine` with two public methods: `validateNoCycle()` (pre-creation cycle check) and
`dispatchReady()` (post-completion fan-in dispatch). Wire both into `tools/task.ts`. Add tests.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/ai/agent-mcp/src/engine/dag-engine.ts`.

- **Delta Spec:**

  **`engine/dag-engine.ts`:**
  ```typescript
  export class DagEngine {
      constructor(
          private readonly db: BetterSQLite3Database<Record<string, never>>,
          private readonly queue: BackgroundQueue,
          private readonly taskStore: TaskStore,
          // Injected at server startup to avoid circular imports with tools/task.ts.
          // Signature: (taskId: string) => Promise<void>
          // Built in index.ts or server setup by closing over the TaskDeps.
          private readonly dispatchFn: (taskId: string) => Promise<void>,
      ) {}

      /**
       * BFS cycle detection. Call BEFORE inserting the new task row.
       * Throws ToolError("VALIDATION_ERROR") if adding newTaskId→dependsOn creates a cycle.
       */
      validateNoCycle(newTaskId: string, dependsOn: string[]): void {
          // Build a set of all ancestors by BFS on the existing depends_on graph.
          // If newTaskId appears in any ancestor's depends_on, we have a cycle.
          const visited = new Set<string>();
          const queue = [...dependsOn];
          while (queue.length > 0) {
              const id = queue.shift()!;
              if (id === newTaskId) {
                  throw new ToolError("VALIDATION_ERROR",
                      `Dependency cycle detected: task ${newTaskId} would depend on itself`);
              }
              if (!visited.has(id)) {
                  visited.add(id);
                  const row = this.db.select({ dependsOn: tasksTable.dependsOn })
                      .from(tasksTable).where(eq(tasksTable.id, id)).get();
                  const upstreamDeps: string[] = row?.dependsOn ? JSON.parse(row.dependsOn) : [];
                  queue.push(...upstreamDeps);
              }
          }
      }

      /**
       * Called after a task reaches a terminal state (completed/failed/cancelled).
       * Scans for waiting tasks that depend on completedTaskId. For each:
       * - If all deps are terminal: evaluate on_upstream_failure and either
       *   dispatch the task or mark it failed.
       *
       * Uses optimistic locking on the UPDATE to prevent the double-enqueue race:
       * two concurrent dispatchReady calls for the same fan-in task can both read
       * "waiting", but only one UPDATE will succeed (the other sees 0 rows changed).
       */
      async dispatchReady(completedTaskId: string): Promise<void> {
          // Find all waiting tasks that include completedTaskId in their depends_on
          const waitingTasks = this.db.select().from(tasksTable)
              .where(eq(tasksTable.status, "waiting")).all();

          for (const task of waitingTasks) {
              const deps: string[] = task.dependsOn ? JSON.parse(task.dependsOn) : [];
              if (!deps.includes(completedTaskId)) continue;

              // Check if all deps are now in terminal state
              const depRows = this.db.select({ id: tasksTable.id, status: tasksTable.status,
                                               result: tasksTable.result })
                  .from(tasksTable).where(inArray(tasksTable.id, deps)).all();

              const allTerminal = depRows.every(r =>
                  ["completed", "failed", "cancelled"].includes(r.status));
              if (!allTerminal) continue;

              // Check for upstream failure
              const anyFailed = depRows.some(r => ["failed", "cancelled"].includes(r.status));
              const policy = (task.onUpstreamFailure ?? "fail") as "fail" | "skip";

              if (anyFailed && policy === "fail") {
                  // Mark dependent as failed
                  const failedId = depRows.find(r => r.status === "failed" || r.status === "cancelled")!.id;
                  this.taskStore.updateStatus(task.id, "failed", {
                      error: `Upstream task ${failedId} ${depRows.find(r=>r.id===failedId)!.status}`,
                  });
                  continue;
              }

              // Build inputs from completed upstream results
              const inputs: Record<string, string> = {};
              for (const dep of depRows) {
                  if (dep.result != null) inputs[dep.id] = dep.result;
              }

              // Optimistic locking: only proceed if this process wins the race.
              // `AND status = 'waiting'` ensures only one concurrent caller transitions
              // the row — the other gets changes=0 and skips enqueue.
              const updated = this.db.update(tasksTable).set({
                  status: "pending",
                  inputs: JSON.stringify(inputs),
                  updatedAt: nowIso(),
              }).where(
                  and(eq(tasksTable.id, task.id), eq(tasksTable.status, "waiting"))
              ).run();

              if (updated.changes === 0) continue; // lost the race — another worker won

              await this.enqueueTask(task.id);
          }
      }

      private async enqueueTask(taskId: string): Promise<void> {
          // Calls the injected dispatchFn — see Notes for exact constructor injection pattern.
          await this.dispatchFn(taskId);
      }
  }
  ```

  **Wiring in `tools/task.ts` and `src/index.ts`:**

  Construct `DagEngine` at server startup (in `src/index.ts` or the module that builds `TaskDeps`),
  passing a `dispatchFn` closure that captures all context needed to run a task:

  ```typescript
  // src/index.ts (or wherever TaskDeps is assembled)
  const dispatchFn = async (taskId: string) => {
      await queue.enqueue(taskId, () => runTask(taskId, deps));
  };
  const dagEngine = new DagEngine(db, queue, taskStore, dispatchFn);
  ```

  In task creation (`tools/task.ts`): call `dagEngine.validateNoCycle(newTaskId, dependsOn)`
  BEFORE `taskStore.create(...)`.

  In the background queue runFn — use a `finally` block to cover ALL terminal paths including
  cancellation:

  ```typescript
  await queue.enqueue(taskId, async () => {
      try {
          await orchestrator.run(taskId, deps);
          // completion/failure handled inside orchestrator
      } finally {
          // dispatchReady must fire regardless of how the task ended
          await dagEngine.dispatchReady(taskId);
      }
  });
  ```

  This `finally` block is the canonical wiring point. It covers `completed`, `failed`, AND
  `cancelled` (abort path). Do NOT wire `dispatchReady` only to the success path.

  **Startup re-enqueue scan (in `src/index.ts`):**
  On server start, after migrations run, re-enqueue any `pending` tasks that were orphaned
  by a crash between `dispatchReady`'s DB update and `queue.enqueue()`:

  ```typescript
  const orphaned = db.select().from(tasksTable)
      .where(eq(tasksTable.status, "pending")).all();
  for (const task of orphaned) {
      await dispatchFn(task.id);
  }
  ```

  This is safe to run on every startup — the queue is idempotent for already-running tasks.

- **Invariants:** See `[inv:waiting-no-queue]`, `[inv:dispatch-on-completion]`,
  `[inv:inputs-populated-at-dispatch]`, `[inv:cycle-check-synchronous]` in `_shared.md`.

- **Validation:** file exists + `dispatchReady` + `Cycle`/`cycle` + tests pass.

---

## Acceptance criteria

- [ ] **[dag-engine.1]** `engine/dag-engine.ts` exists.
      `test -f packages/ai/agent-mcp/src/engine/dag-engine.ts`
- [ ] **[dag-engine.2]** `DagEngine.dispatchReady` method exists.
      `grep -q 'dispatchReady' packages/ai/agent-mcp/src/engine/dag-engine.ts`
- [ ] **[dag-engine.3]** Cycle detection exists in DagEngine.
      `grep -qiE 'cycle|Cycle' packages/ai/agent-mcp/src/engine/dag-engine.ts`
- [ ] **[dag-engine.4]** `validateNoCycle` is called in `tools/task.ts` before task creation.
      `grep -q 'validateNoCycle' packages/ai/agent-mcp/src/tools/task.ts`
- [ ] **[dag-engine.5]** `dispatchReady` is called in `tools/task.ts` after task completion.
      `grep -q 'dispatchReady' packages/ai/agent-mcp/src/tools/task.ts`
- [ ] **[dag-engine.6]** Test file exists with tests for single-dep, fan-in, fail/skip propagation.
      `test -f packages/ai/agent-mcp/src/__tests__/dag-engine.test.ts`
- [ ] **[dag-engine.7]** All tests pass.
      `npx --yes nx test agent-mcp 2>&1 | grep -qE 'passed'`
- [ ] **[dag-engine.8]** `inputs` field added to `ExecutionContext` in `validation/execution.ts`.
      `grep -q 'inputs' packages/ai/agent-mcp/src/validation/execution.ts`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/src/validation/task.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts",
             "packages/ai/agent-mcp/src/engine/queue.ts"]
mutates:    ["packages/ai/agent-mcp/src/engine/dag-engine.ts",
             "packages/ai/agent-mcp/src/tools/task.ts",
             "packages/ai/agent-mcp/src/__tests__/dag-engine.test.ts",
             "packages/ai/agent-mcp/src/index.ts",
             "packages/ai/agent-mcp/src/validation/execution.ts"]
```

---

## Contract Promise

- **Added:** `DagEngine` class in `engine/dag-engine.ts` with `validateNoCycle()` + `dispatchReady()`
- **Modified:** `tools/task.ts` — wires DagEngine at creation and completion
- **Modified:** `validation/execution.ts` — `ExecutionContext` gains `inputs?: Record<string,string>`

---

## Commit points

- [ ] **After DagEngine implementation + wiring + tests pass** (mandatory):
      `feat(agent-mcp): dag-engine — DagEngine with cycle check and fan-in dispatch`

---

## Notes

- **Footgun: dispatchReady is async but task completion is currently sync.** `tools/task.ts`
  currently calls `taskStore.updateStatus(taskId, "completed", {...})` synchronously in the
  queue callback. Wiring `await dagEngine.dispatchReady(taskId)` here requires the callback to
  be async. Verify the queue's `enqueue(taskId, runFn)` accepts `async () => void`.
- **dispatchFn injection (required).** DagEngine must NOT import from `tools/task.ts` — that
  creates a circular dependency. Instead, build a `dispatchFn` closure at server startup in
  `src/index.ts` that closes over the `TaskDeps` (provider, registry, session store, etc.) and
  pass it as the 4th constructor argument. The closure calls `queue.enqueue(taskId, () =>
  runTask(taskId, deps))`. This is the only correct pattern — do not attempt to import
  `runTask` from tools/task.ts inside dag-engine.ts.
- **Cycle check is O(N) BFS** — not a problem at agent-mcp scale (< 1000 tasks in practice).
  No index needed for the cycle check.
- **`inArray` from drizzle-orm** — use for the batch dep-status query.
- **Test the `on_upstream_failure: "skip"` case explicitly** — it's the non-default behaviour
  and easy to get wrong (the downstream should still dispatch even if upstream failed).
- **inputs injection**: For the `on_upstream_failure: "skip"` case, only include upstreams with
  `status === "completed"` in the `inputs` map. Failed upstreams have no result to inject.
