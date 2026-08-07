import { and, eq } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { taskEventsTable, tasksTable } from "../db/schema.js";
import { logger } from "../logger.js";
import type { Task, TaskEventType, TaskListInput, TaskStatus } from "../validation/schemas.js";
import { taskSchema } from "../validation/schemas.js";
import { ToolError } from "../validation/errors.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";

export class TaskStore {
    private readonly cancellationMap = new Map<string, AbortController>();

    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>
    ) {}

    create(input: {
        sessionId: string | null;
        prompt: string;
        parentTaskId?: string;
        recursionDepth?: number;
        dependsOn?: string[];
        onUpstreamFailure?: "fail" | "skip";
        inputs?: Record<string, string>;
        isEphemeral?: boolean;
        id?: string;
    }): Task {
        const now = nowIso();
        const id = input.id ?? generateId();

        const status = input.dependsOn && input.dependsOn.length > 0 ? "waiting" : "pending";

        this.db.insert(tasksTable).values({
            id,
            sessionId: input.sessionId ?? null,
            parentTaskId: input.parentTaskId ?? null,
            isEphemeral: input.isEphemeral ? 1 : 0,
            recursionDepth: input.recursionDepth ?? 0,
            status,
            prompt: input.prompt,
            depends_on: input.dependsOn ? JSON.stringify(input.dependsOn) : null,
            on_upstream_failure: input.onUpstreamFailure ?? null,
            inputs: input.inputs ? JSON.stringify(input.inputs) : null,
            createdAt: now,
            updatedAt: now,
        }).run();

        logger.info(
            {
                taskId: id,
                sessionId: input.sessionId,
                parentTaskId: input.parentTaskId,
                recursionDepth: input.recursionDepth ?? 0,
                status,
                isEphemeral: input.isEphemeral ?? false,
                dependsOn: input.dependsOn,
            },
            "Task created"
        );

        return this.read(id);
    }

    updateStatus(
        id: string,
        status: TaskStatus,
        fields?: {
            result?: string;
            error?: string;
            completedAt?: string;
            cancelledAt?: string;
            resumeToken?: string;
        }
    ): Task {
        const now = nowIso();

        this.db
            .update(tasksTable)
            .set({
                status,
                updatedAt: now,
                result: fields?.result ?? null,
                error: fields?.error ?? null,
                completedAt: fields?.completedAt ?? null,
                cancelledAt: fields?.cancelledAt ?? null,
                ...(fields?.resumeToken !== undefined
                    ? { resume_token: fields.resumeToken }
                    : {}),
            })
            .where(eq(tasksTable.id, id))
            .run();

        return this.read(id);
    }

    read(id: string): Task {
        const row = this.db
            .select()
            .from(tasksTable)
            .where(eq(tasksTable.id, id))
            .get();

        if (!row) {
            throw new ToolError(
                "TASK_NOT_FOUND",
                `Task '${id}' not found`
            );
        }

        return taskSchema.parse({
            id: row.id,
            sessionId: row.sessionId ?? undefined,
            isEphemeral: row.isEphemeral === 1,
            parentTaskId: row.parentTaskId ?? undefined,
            recursionDepth: row.recursionDepth,
            status: row.status,
            prompt: row.prompt,
            result: row.result ?? undefined,
            error: row.error ?? undefined,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            completedAt: row.completedAt ?? undefined,
            cancelledAt: row.cancelledAt ?? undefined,
            dependsOn: row.depends_on ? JSON.parse(row.depends_on) : null,
            onUpstreamFailure: row.on_upstream_failure ?? null,
            inputs: row.inputs ? JSON.parse(row.inputs) : null,
            resumeToken: row.resume_token ?? null,
        });
    }

    list(input: TaskListInput): Task[] {
        const conditions = [];

        if (input.session_id) {
            conditions.push(eq(tasksTable.sessionId, input.session_id));
        }

        if (input.status) {
            conditions.push(eq(tasksTable.status, input.status));
        }

        if (input.is_ephemeral !== undefined) {
            conditions.push(eq(tasksTable.isEphemeral, input.is_ephemeral ? 1 : 0));
        }

        const rows =
            conditions.length > 0
                ? this.db
                    .select()
                    .from(tasksTable)
                    .where(and(...conditions))
                    .all()
                : this.db.select().from(tasksTable).all();

        return rows.map(row =>
            taskSchema.parse({
                id: row.id,
                sessionId: row.sessionId ?? undefined,
                isEphemeral: row.isEphemeral === 1,
                parentTaskId: row.parentTaskId ?? undefined,
                recursionDepth: row.recursionDepth,
                status: row.status,
                prompt: row.prompt,
                result: row.result ?? undefined,
                error: row.error ?? undefined,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                completedAt: row.completedAt ?? undefined,
                cancelledAt: row.cancelledAt ?? undefined,
                dependsOn: row.depends_on ? JSON.parse(row.depends_on) : null,
                onUpstreamFailure: row.on_upstream_failure ?? null,
                inputs: row.inputs ? JSON.parse(row.inputs) : null,
                resumeToken: row.resume_token ?? null,
            })
        );
    }

    appendEvent(event: {
        taskId: string;
        type: TaskEventType;
        payload?: unknown;
    }): void {
        const now = nowIso();
        this.db.insert(taskEventsTable).values({
            id: generateId(),
            taskId: event.taskId,
            type: event.type,
            payload: event.payload ? JSON.stringify(event.payload) : null,
            createdAt: now,
        }).run();
    }

    // ──────────────────────────────────────────────
    // Cancellation map (in-memory only)
    // ──────────────────────────────────────────────

    registerCancellation(taskId: string, controller: AbortController): void {
        this.cancellationMap.set(taskId, controller);
    }

    unregisterCancellation(taskId: string): void {
        this.cancellationMap.delete(taskId);
    }

    cancel(taskId: string): void {
        const controller = this.cancellationMap.get(taskId);

        if (controller) {
            controller.abort();
        }

        this.updateStatus(taskId, "cancelled", {
            cancelledAt: nowIso(),
            error: "Task was cancelled",
        });

        logger.info({ taskId }, "Task cancelled");
    }
}
