import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { tasksTable } from "@adhd/agent-store-runtime";
import { ToolError } from "../validation/errors.js";
import { nowIso } from "../utils/timestamps.js";
import type { EngineLogger } from "../interfaces.js";

export interface DagTaskStore {
    create(input: {
        id?: string;
        sessionId: string | null;
        prompt: string;
        parentTaskId?: string;
        recursionDepth?: number;
        dependsOn?: string[];
        onUpstreamFailure?: "fail" | "skip";
        isEphemeral?: boolean;
    }): { id: string; status: string; result?: string; error?: string; dependsOn?: string[] | null; inputs?: Record<string, string> | null; onUpstreamFailure?: string | null };
    read(taskId: string): { id: string; status: string; result?: string; error?: string; dependsOn?: string[] | null; inputs?: Record<string, string> | null; onUpstreamFailure?: string | null; sessionId?: string | null; isEphemeral?: boolean; prompt: string; recursionDepth: number };
    updateStatus(taskId: string, status: string, fields?: Record<string, unknown>): void;
    list(filter?: Record<string, unknown>): Array<{ id: string; status: string; result?: string; error?: string; dependsOn?: string[] | null; inputs?: Record<string, string> | null; onUpstreamFailure?: string | null }>;
    registerCancellation(taskId: string, controller: AbortController): void;
    unregisterCancellation(taskId: string): void;
    cancel(taskId: string): void;
    appendEvent(evt: { taskId: string; type: string; payload?: unknown }): void;
}

export interface DagQueue {
    enqueue(taskId: string, fn: () => Promise<void>): void;
    pending: number;
    size: number;
}

export class DagEngine {
    private readonly logger: EngineLogger;

    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>,
        private readonly queue: DagQueue,
        private readonly taskStore: DagTaskStore,
        private readonly dispatchFn: (taskId: string) => Promise<void>,
        logger?: EngineLogger
    ) {
        this.logger = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
    }

    validateNoCycle(newTaskId: string, dependsOn: string[]): void {
        const visited = new Set<string>();
        const queue = [...dependsOn];

        while (queue.length > 0) {
            const id = queue.shift();
            if (!id) throw new Error('Empty queue in validateNoCycle');

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

    async dispatchReady(completedTaskId: string): Promise<void> {
        const waitingTasks = this.db
            .select()
            .from(tasksTable)
            .where(eq(tasksTable.status, "waiting"))
            .all();

        for (const task of waitingTasks) {
            const deps: string[] = task.depends_on
                ? (JSON.parse(task.depends_on) as string[])
                : [];

            if (!deps.includes(completedTaskId)) continue;
            if (deps.length === 0) continue;

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
                this.logger.info(
                    { taskId: task.id, failedDepId: failedDep.id, status: failedDep.status },
                    "Propagating upstream failure to waiting task",
                );

                this.taskStore.updateStatus(task.id, "failed", {
                    error: `Upstream task ${failedDep.id} ${failedDep.status}`,
                });

                await this.dispatchReady(task.id);
                continue;
            }

            const inputs: Record<string, string> = {};
            for (const dep of depRows) {
                if (dep.status === "completed" && dep.result != null) {
                    inputs[dep.id] = dep.result;
                }
            }

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
                this.logger.debug({ taskId: task.id }, "DagEngine: lost optimistic lock, skipping enqueue");
                continue;
            }

            this.logger.info(
                { taskId: task.id, deps, inputs: Object.keys(inputs) },
                "DagEngine: dispatching ready task",
            );

            await this.dispatchFn(task.id);
        }
    }
}
