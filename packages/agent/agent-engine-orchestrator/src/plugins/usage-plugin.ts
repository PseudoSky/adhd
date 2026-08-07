import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { taskUsageTable } from "@adhd/agent-store-runtime";
import { estimateCostUsd } from "@adhd/agent-core-provider";
import { nowIso } from '../utils/timestamps.js';
import type { EngineLogger } from '../interfaces.js';
import type {
  IHookRegistry,
  Plugin,
  PostModelResponsePayload,
  PostToolCallPayload,
  TaskStartPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
  TaskCancelledPayload,
} from '@adhd/agent-base-types';

const SEVERITY: Record<string, number> = {
  length: 3,
  tool_calls: 2,
  stop: 1,
  unknown: 0,
};
function mostSevere(
  a: string | null | undefined,
  b: string | null | undefined
): string {
  const sa = SEVERITY[a ?? ''] ?? 0;
  const sb = SEVERITY[b ?? ''] ?? 0;
  return sa >= sb ? a ?? 'unknown' : b ?? 'unknown';
}

interface Accumulator {
  startedAt: number;
  rootTaskId: string | null;
  agentName: string;
  providerType: string;
  model: string;
  mostSevereStopReason: string;
  maxTokens: number | null;
}

export class UsagePlugin implements Plugin {
  readonly name = 'usage';

  private readonly accumulators = new Map<string, Accumulator>();
  private readonly logger: EngineLogger;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: BetterSQLite3Database<any>,
    logger?: EngineLogger
  ) {
    this.logger = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
  }

  install(hooks: IHookRegistry): void {
    hooks.register('task:start', (payload) => this.onTaskStart(payload));
    hooks.register('post:model_response', (payload) =>
      this.onModelResponse(payload)
    );
    hooks.register('post:tool_call', (payload) => this.onToolCall(payload));
    hooks.register('task:completed', (payload) => this.onTerminal(payload));
    hooks.register('task:failed', (payload) => this.onTerminal(payload));
    hooks.register('task:cancelled', (payload) => this.onTerminal(payload));
  }

  private onTaskStart(payload: TaskStartPayload): void {
    try {
      const { executionContext } = payload;
      const provider = executionContext.agentDefinition.provider;
      this.accumulators.set(executionContext.taskId, {
        startedAt: Date.now(),
        rootTaskId: payload.rootTaskId ?? null,
        agentName: executionContext.agentName,
        providerType: provider.type,
        model: ('model' in provider && provider.model) || 'default',
        mostSevereStopReason: 'unknown',
        maxTokens:
          'maxTokens' in provider && typeof provider.maxTokens === 'number'
            ? provider.maxTokens
            : null,
      });
    } catch (err) {
      this.logger.error({ err }, 'UsagePlugin: task:start handler failed');
    }
  }

  private onModelResponse(payload: PostModelResponsePayload): void {
    try {
      const { executionContext, tokenUsage, toolCallCount, computeMs } = payload;
      const taskId = executionContext.taskId;
      const acc = this.accumulators.get(taskId);

      const inputTokens = tokenUsage?.inputTokens ?? 0;
      const outputTokens = tokenUsage?.outputTokens ?? 0;
      const toolCalls = toolCallCount ?? 0;

      const incoming = tokenUsage?.stopReason ?? 'unknown';
      if (acc) {
        acc.mostSevereStopReason = mostSevere(
          acc.mostSevereStopReason,
          incoming
        );
      }

      const provider = executionContext.agentDefinition.provider;
      const model =
        acc?.model ?? (('model' in provider && provider.model) || 'default');

      // est_cost_usd: linear/additive, so valid to compute per-turn and sum. null
      // (never 0) when the model has no rate-card entry — never report an unknown
      // model's cost as $0.
      const turnCost = estimateCostUsd(model, {
        uncachedInputTokens: tokenUsage?.uncachedInputTokens ?? 0,
        cacheReadTokens: tokenUsage?.cacheReadTokens ?? 0,
        cacheCreationTokens: tokenUsage?.cacheCreationTokens ?? 0,
        outputTokens,
      });

      this.db
        .insert(taskUsageTable)
        .values({
          taskId,
          rootTaskId: acc?.rootTaskId ?? null,
          agentName: acc?.agentName ?? executionContext.agentName,
          providerType: acc?.providerType ?? provider.type,
          model,
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
          uncachedInputTokens: tokenUsage?.uncachedInputTokens ?? null,
          reasoningTokens: tokenUsage?.reasoningTokens ?? null,
          // First call for this task: its input IS the peak so far.
          peakContextTokens: inputTokens,
          peakContextAt: 1,
          // CUMULATIVE Σ turn compute_ms (DESIGN.md §6) — this call's is the first.
          computeMs,
          // First call for this task: whatever cost this turn produced (or NULL if
          // the model is unrecognized — never 0).
          ...(turnCost !== null ? { estCostUsd: turnCost } : {}),
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
            cacheReadTokens: sql`COALESCE(${
              taskUsageTable.cacheReadTokens
            }, 0) + ${tokenUsage?.cacheReadTokens ?? 0}`,
            cacheCreationTokens: sql`COALESCE(${
              taskUsageTable.cacheCreationTokens
            }, 0) + ${tokenUsage?.cacheCreationTokens ?? 0}`,
            uncachedInputTokens: sql`COALESCE(${
              taskUsageTable.uncachedInputTokens
            }, 0) + ${tokenUsage?.uncachedInputTokens ?? 0}`,
            reasoningTokens: sql`COALESCE(${
              taskUsageTable.reasoningTokens
            }, 0) + ${tokenUsage?.reasoningTokens ?? 0}`,
            // PEAK, not sum. Every other column here accumulates; this one must not —
            // conflating cumulative-billed with peak-context is what made a 715K run look
            // like a 715K context when the real high-water mark was 43K (FINDING-ORCH-007).
            peakContextTokens: sql`MAX(COALESCE(${
              taskUsageTable.peakContextTokens
            }, 0), ${inputTokens})`,
            // Record WHICH call peaked, but only when this call is the new peak.
            peakContextAt: sql`CASE WHEN ${inputTokens} > COALESCE(${
              taskUsageTable.peakContextTokens
            }, 0) THEN ${taskUsageTable.modelCalls} + 1 ELSE ${taskUsageTable.peakContextAt} END`,
            // CUMULATIVE Σ turn compute_ms — always additive, no special case (DESIGN.md §6).
            computeMs: sql`COALESCE(${taskUsageTable.computeMs}, 0) + ${computeMs}`,
            // Additive when this turn priced; forced NULL once ANY turn's model has no
            // rate-card entry — a partial sum would silently understate true cost, and
            // NULL is the only value that can't be misread as "this task cost $X".
            estCostUsd:
              turnCost !== null
                ? sql`COALESCE(${taskUsageTable.estCostUsd}, 0) + ${turnCost}`
                : sql`NULL`,
          },
        })
        .run();
    } catch (err) {
      this.logger.error({ err }, 'UsagePlugin: post:model_response handler failed');
    }
  }

  private onToolCall(payload: PostToolCallPayload): void {
    try {
      const { executionContext, estResultTokens } = payload;
      const taskId = executionContext.taskId;

      // A TOOL_CALL's post:tool_call can only ever fire for a task that already
      // has a task_usage row — a model must have responded with a tool call
      // first (which fires post:model_response / the INSERT) before any tool
      // executes. So this is always an UPDATE, never an insert-or-update.
      this.db
        .update(taskUsageTable)
        .set({
          estToolResultTokens: sql`COALESCE(${taskUsageTable.estToolResultTokens}, 0) + ${estResultTokens}`,
        })
        .where(eq(taskUsageTable.taskId, taskId))
        .run();
    } catch (err) {
      this.logger.error({ err }, 'UsagePlugin: post:tool_call handler failed');
    }
  }

  private onTerminal(
    payload: TaskCompletedPayload | TaskFailedPayload | TaskCancelledPayload
  ): void {
    try {
      const taskId = payload.executionContext.taskId;
      const acc = this.accumulators.get(taskId);

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
      this.logger.error({ err }, 'UsagePlugin: terminal handler failed');
    }
  }
}
