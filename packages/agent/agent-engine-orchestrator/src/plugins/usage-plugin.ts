import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { taskUsageTable } from "@adhd/agent-store-runtime";
import { nowIso } from '../utils/timestamps.js';
import type { EngineLogger } from '../interfaces.js';
import type {
  IHookRegistry,
  Plugin,
  PostModelResponsePayload,
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
      const { executionContext, tokenUsage, toolCallCount } = payload;
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

      this.db
        .insert(taskUsageTable)
        .values({
          taskId,
          rootTaskId: acc?.rootTaskId ?? null,
          agentName: acc?.agentName ?? executionContext.agentName,
          providerType: acc?.providerType ?? provider.type,
          model:
            acc?.model ??
            (('model' in provider && provider.model) || 'default'),
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
            cacheReadTokens: sql`COALESCE(${
              taskUsageTable.cacheReadTokens
            }, 0) + ${tokenUsage?.cacheReadTokens ?? 0}`,
            cacheCreationTokens: sql`COALESCE(${
              taskUsageTable.cacheCreationTokens
            }, 0) + ${tokenUsage?.cacheCreationTokens ?? 0}`,
          },
        })
        .run();
    } catch (err) {
      this.logger.error({ err }, 'UsagePlugin: post:model_response handler failed');
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
