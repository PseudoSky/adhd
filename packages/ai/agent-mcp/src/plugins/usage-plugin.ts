import { eq, sql } from "drizzle-orm";

const SEVERITY: Record<string, number> = { length: 3, tool_calls: 2, stop: 1, unknown: 0 };
function mostSevere(a: string | null | undefined, b: string | null | undefined): string {
    const sa = SEVERITY[a ?? ""] ?? 0;
    const sb = SEVERITY[b ?? ""] ?? 0;
    return sa >= sb ? (a ?? "unknown") : (b ?? "unknown");
}

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { taskUsageTable } from "../db/schema.js";
import { logger } from "../logger.js";
import { nowIso } from "../utils/timestamps.js";
import type {
    IHookRegistry,
    Plugin,
    PostModelResponsePayload,
    TaskStartPayload,
    TaskCompletedPayload,
    TaskFailedPayload,
    TaskCancelledPayload,
} from "@adhd/agent-mcp-types";

/**
 * Per-task in-memory state held only for the lifetime of a running task.
 *
 * Token counts are NOT kept here — they are written incrementally to the
 * `task_usage` table on every `post:model_response` (see [inv:incremental-write]),
 * so the only state the plugin needs in memory is the start timestamp and the
 * identity fields used to populate a freshly-inserted row, plus the
 * `rootTaskId` resolved at task-creation time (see [inv:root-task-resolution]).
 */
interface Accumulator {
    /** Date.now() captured at task:start — used to compute latency at terminal. */
    startedAt: number;
    /** Root task id from the in-memory caller chain; null = this task IS the root. */
    rootTaskId: string | null;
    agentName: string;
    providerType: string;
    model: string;
    /** Most severe stop reason seen so far; updated on every post:model_response. */
    mostSevereStopReason: string;
    /** Provider maxTokens config value; null for claudecli or unconfigured providers. */
    maxTokens: number | null;
}

/**
 * Observational plugin that records per-task token usage into `task_usage`.
 *
 * Write strategy (see [inv:incremental-write]):
 *   - task:start            → remember startedAt + identity in memory; no DB write.
 *   - post:model_response   → UPSERT: INSERT the row on first call (is_complete=0),
 *                             then accumulate input/output tokens + tool/model
 *                             counts on every subsequent call. Durable across crash.
 *   - task:completed/failed/cancelled → final UPDATE: latency_ms, root_task_id,
 *                             is_complete=1; drop the in-memory entry.
 *
 * INVARIANT [inv:plugin-no-throw]: every handler is wrapped in try/catch and logs
 * errors silently. An observational plugin must never crash the host process.
 */
export class UsagePlugin implements Plugin {
    readonly name = "usage";

    private readonly accumulators = new Map<string, Accumulator>();

    constructor(
        // Drizzle better-sqlite3 instance — identical to what the stores receive.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private readonly db: BetterSQLite3Database<any>
    ) {}

    install(hooks: IHookRegistry): void {
        hooks.register("task:start", payload => this.onTaskStart(payload));
        hooks.register("post:model_response", payload => this.onModelResponse(payload));
        hooks.register("task:completed", payload => this.onTerminal(payload));
        hooks.register("task:failed", payload => this.onTerminal(payload));
        hooks.register("task:cancelled", payload => this.onTerminal(payload));
    }

    private onTaskStart(payload: TaskStartPayload): void {
        try {
            const { executionContext } = payload;
            const provider = executionContext.agentDefinition.provider;
            this.accumulators.set(executionContext.taskId, {
                startedAt: Date.now(),
                // rootTaskId is resolved at task-creation time and forwarded in the
                // task:start payload — never walk the tasks DB (ephemeral tasks have
                // no tasks row). See [inv:root-task-resolution].
                rootTaskId: payload.rootTaskId ?? null,
                agentName: executionContext.agentName,
                providerType: provider.type,
                model: ("model" in provider && provider.model) || "default",
                mostSevereStopReason: "unknown",
                maxTokens: ("maxTokens" in provider && typeof provider.maxTokens === "number")
                    ? provider.maxTokens
                    : null,
            });
        } catch (err) {
            logger.error({ err }, "UsagePlugin: task:start handler failed");
        }
    }

    private onModelResponse(payload: PostModelResponsePayload): void {
        try {
            const { executionContext, tokenUsage, toolCallCount } = payload;
            const taskId = executionContext.taskId;
            const acc = this.accumulators.get(taskId);

            // Tokens are undefined for claudecli — record zeros so the row still
            // exists. See [inv:claudecli-undefined].
            const inputTokens = tokenUsage?.inputTokens ?? 0;
            const outputTokens = tokenUsage?.outputTokens ?? 0;
            const toolCalls = toolCallCount ?? 0;

            // Update most-severe stop reason in memory before writing to DB.
            const incoming = tokenUsage?.stopReason ?? "unknown";
            if (acc) {
                acc.mostSevereStopReason = mostSevere(acc.mostSevereStopReason, incoming);
            }

            const provider = executionContext.agentDefinition.provider;

            // UPSERT (see [inv:incremental-write]): insert on the first model
            // response, accumulate on every subsequent one. Durable across crash.
            this.db
                .insert(taskUsageTable)
                .values({
                    taskId,
                    rootTaskId: acc?.rootTaskId ?? null,
                    agentName: acc?.agentName ?? executionContext.agentName,
                    providerType: acc?.providerType ?? provider.type,
                    model:
                        acc?.model ??
                        (("model" in provider && provider.model) || "default"),
                    inputTokens,
                    outputTokens,
                    toolCallCount: toolCalls,
                    modelCalls: 1,
                    latencyMs: 0,
                    isComplete: 0,
                    stopReason: acc?.mostSevereStopReason ?? incoming,
                    maxTokens: acc?.maxTokens ?? null,
                    cacheReadTokens: tokenUsage?.cacheReadTokens ?? null,
                    cacheCreationTokens: tokenUsage?.cacheCreationTokens ?? null,
                    createdAt: nowIso(),
                })
                .onConflictDoUpdate({
                    target: taskUsageTable.taskId,
                    set: {
                        inputTokens: sql`${taskUsageTable.inputTokens} + ${inputTokens}`,
                        outputTokens: sql`${taskUsageTable.outputTokens} + ${outputTokens}`,
                        toolCallCount: sql`${taskUsageTable.toolCallCount} + ${toolCalls}`,
                        modelCalls: sql`${taskUsageTable.modelCalls} + 1`,
                        stopReason: acc?.mostSevereStopReason ?? incoming,
                        cacheReadTokens: sql`COALESCE(${taskUsageTable.cacheReadTokens}, 0) + ${tokenUsage?.cacheReadTokens ?? 0}`,
                        cacheCreationTokens: sql`COALESCE(${taskUsageTable.cacheCreationTokens}, 0) + ${tokenUsage?.cacheCreationTokens ?? 0}`,
                        // maxTokens deliberately OMITTED from SET — constant per task
                    },
                })
                .run();
        } catch (err) {
            logger.error({ err }, "UsagePlugin: post:model_response handler failed");
        }
    }

    private onTerminal(
        payload: TaskCompletedPayload | TaskFailedPayload | TaskCancelledPayload
    ): void {
        try {
            const taskId = payload.executionContext.taskId;
            const acc = this.accumulators.get(taskId);

            // If no post:model_response ever fired there is no row to finalise —
            // the task consumed zero tokens (cancelled before first model call).
            // The UPDATE simply affects zero rows, which is correct.
            const latencyMs = acc ? Date.now() - acc.startedAt : 0;
            const rootTaskId =
                acc?.rootTaskId ?? payload.executionContext.rootTaskId ?? null;

            this.db
                .update(taskUsageTable)
                .set({
                    latencyMs,
                    rootTaskId,
                    isComplete: 1,
                })
                .where(eq(taskUsageTable.taskId, taskId))
                .run();

            this.accumulators.delete(taskId);
        } catch (err) {
            logger.error({ err }, "UsagePlugin: terminal handler failed");
        }
    }
}
