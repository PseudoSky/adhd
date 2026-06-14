import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { tasksTable } from "../db/schema.js";
import { logger } from "../logger.js";
import type { TaskStore } from "../store/task-store.js";
import type { BackgroundQueue } from "./queue.js";
import { ToolError } from "../validation/errors.js";
import { nowIso } from "../utils/timestamps.js";

/**
 * DagEngine manages task dependency resolution.
 *
 * Two public methods:
 * - `validateNoCycle()` — synchronous BFS cycle check; called BEFORE row insert.
 * - `dispatchReady()` — post-terminal fan-in dispatch; called in the queue runFn
 *   `finally` block so it fires on every terminal event (completed/failed/cancelled).
 *
 * The `dispatchFn` is injected at server startup (built in src/index.ts) to avoid
 * circular imports: DagEngine must NOT import from tools/task.ts.
 */
export class DagEngine {
    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>,
        private readonly queue: BackgroundQueue,
        private readonly taskStore: TaskStore,
        /**
         * Injected at server startup to avoid circular imports with tools/task.ts.
         * Signature: (taskId: string) => Promise<void>
         * Built in index.ts by closing over the TaskDeps.
         */
        private readonly dispatchFn: (taskId: string) => Promise<void>,
    ) {}

    /**
     * BFS cycle detection. Call BEFORE inserting the new task row.
     *
     * Walks the existing dependency graph upward from each member of `dependsOn`.
     * If `newTaskId` appears as an ancestor, adding it would create a cycle.
     *
     * Throws ToolError("VALIDATION_ERROR") if a cycle is detected.
     * Does NOT write any rows — purely a read operation.
     *
     * Invariant: [inv:cycle-check-synchronous]
     */
    validateNoCycle(newTaskId: string, dependsOn: string[]): void {
        const visited = new Set<string>();
        const queue = [...dependsOn];

        while (queue.length > 0) {
            const id = queue.shift()!;

            if (id === newTaskId) {
                throw new ToolError(
                    "VALIDATION_ERROR",
                    `Dependency cycle detected: task ${newTaskId} would depend on itself via its dependency chain`,
                );
            }

            if (!visited.has(id)) {
                visited.add(id);

                const row = this.db
                    .select({ dependsOn: tasksTable.depends_on })
                    .from(tasksTable)
                    .where(eq(tasksTable.id, id))
                    .get();

                const upstreamDeps: string[] = row?.dependsOn
                    ? (JSON.parse(row.dependsOn) as string[])
                    : [];

                queue.push(...upstreamDeps);
            }
        }
    }

    /**
     * Called after a task reaches a terminal state (completed/failed/cancelled).
     *
     * Scans all `waiting` tasks for those that include `completedTaskId` in their
     * `depends_on`. For each:
     *   - If all deps are in a terminal state, evaluate `on_upstream_failure`:
     *     - "fail" (default): mark the downstream as failed immediately.
     *     - "skip": dispatch anyway; only include completed upstreams in `inputs`.
     *
     * Uses optimistic locking (`AND status='waiting'` on the UPDATE) to prevent
     * double-enqueue when two concurrent terminal events race for the same fan-in
     * task.
     *
     * Invariants: [inv:waiting-no-queue], [inv:dispatch-on-completion],
     *             [inv:inputs-populated-at-dispatch]
     */
    async dispatchReady(completedTaskId: string): Promise<void> {
        // Fetch all waiting tasks in a single query
        const waitingTasks = this.db
            .select()
            .from(tasksTable)
            .where(eq(tasksTable.status, "waiting"))
            .all();

        for (const task of waitingTasks) {
            const deps: string[] = task.depends_on
                ? (JSON.parse(task.depends_on) as string[])
                : [];

            // Skip if this task doesn't depend on the just-completed task
            if (!deps.includes(completedTaskId)) continue;

            // Nothing to dispatch if there are no deps (should not happen for
            // waiting tasks, but guard defensively)
            if (deps.length === 0) continue;

            // Check all deps for terminal status
            const depRows = this.db
                .select({
                    id: tasksTable.id,
                    status: tasksTable.status,
                    result: tasksTable.result,
                })
                .from(tasksTable)
                .where(inArray(tasksTable.id, deps))
                .all();

            const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
            const allTerminal = depRows.every(r => terminalStatuses.has(r.status));
            if (!allTerminal) continue;

            const policy = (task.on_upstream_failure ?? "fail") as "fail" | "skip";
            const failedDep = depRows.find(
                r => r.status === "failed" || r.status === "cancelled",
            );

            if (failedDep && policy === "fail") {
                // Mark downstream as failed — no enqueue
                logger.info(
                    { taskId: task.id, failedDepId: failedDep.id, status: failedDep.status },
                    "Propagating upstream failure to waiting task",
                );

                this.taskStore.updateStatus(task.id, "failed", {
                    error: `Upstream task ${failedDep.id} ${failedDep.status}`,
                });

                // Recursively dispatch tasks that depend on this now-failed task
                await this.dispatchReady(task.id);
                continue;
            }

            // policy === "skip" or all deps completed:
            // Build inputs from completed upstream results only.
            // Skip-case: omit failed/cancelled upstreams (no result to inject).
            const inputs: Record<string, string> = {};
            for (const dep of depRows) {
                if (dep.status === "completed" && dep.result != null) {
                    inputs[dep.id] = dep.result;
                }
            }

            // Optimistic lock: transition waiting → pending atomically.
            // If another concurrent dispatchReady call already transitioned this
            // row, changes === 0 and we skip enqueue to avoid double-dispatch.
            const updated = this.db
                .update(tasksTable)
                .set({
                    status: "pending",
                    inputs: JSON.stringify(inputs),
                    updatedAt: nowIso(),
                })
                .where(
                    and(
                        eq(tasksTable.id, task.id),
                        eq(tasksTable.status, "waiting"),
                    ),
                )
                .run();

            if (updated.changes === 0) {
                // Lost the race — another worker already transitioned this task
                logger.debug({ taskId: task.id }, "DagEngine: lost optimistic lock, skipping enqueue");
                continue;
            }

            logger.info(
                { taskId: task.id, deps, inputs: Object.keys(inputs) },
                "DagEngine: dispatching ready task",
            );

            await this.dispatchFn(task.id);
        }
    }
}
