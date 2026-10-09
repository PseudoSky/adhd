import { eq, sql } from 'drizzle-orm';
import { selectionOf, wireModelOf } from '../providers/resolve-selection.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { taskUsageTable, createPriceSource } from "@adhd/agent-store-runtime";
import { estimateCost } from "@adhd/agent-core-provider";
import type { IPriceSource } from "@adhd/agent-core-provider";
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

/** Optional collaborators for {@link UsagePlugin} (all default to the production wiring). */
export interface IUsagePluginOptions {
  /** As-of price source. Defaults to `createPriceSource(db)` (the runtime price-history table). */
  priceSource?: IPriceSource;
  /** ISO-8601 clock used as the pricing instant for each turn. Defaults to `nowIso`. */
  now?: () => string;
}

/**
 * Default logger when the host passes none. `warn`/`error` go to stderr (never stdout: stdio MCP
 * owns it) so an unpriced model is LOUD by default; a silent default made the warning
 * undeliverable in the host, which constructs `new UsagePlugin(db)`. `info`/`debug` stay quiet.
 */
function defaultLogger(): EngineLogger {
  return {
    info: () => {},
    debug: () => {},
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
  } as EngineLogger;
}

export class UsagePlugin implements Plugin {
  readonly name = 'usage';

  private readonly accumulators = new Map<string, Accumulator>();
  private readonly logger: EngineLogger;
  private readonly source: IPriceSource;
  private readonly now: () => string;
  /** `(provider, model)` pairs already warned about as unpriced — one WARN per pair per plugin instance. */
  private readonly warnedUnpriced = new Set<string>();

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: BetterSQLite3Database<any>,
    logger?: EngineLogger,
    opts?: IUsagePluginOptions
  ) {
    this.logger = logger ?? defaultLogger();
    this.source = opts?.priceSource ?? createPriceSource(db);
    this.now = opts?.now ?? nowIso;
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
      const selection = selectionOf(executionContext);
      this.accumulators.set(executionContext.taskId, {
        startedAt: Date.now(),
        rootTaskId: payload.rootTaskId ?? null,
        agentName: executionContext.agentName,
        providerType: selection.providerType,
        model: wireModelOf(executionContext) || 'default',
        mostSevereStopReason: 'unknown',
        maxTokens:
          typeof selection.maxTokens === 'number' ? selection.maxTokens : null,
      });
    } catch (err) {
      this.logger.error({ err }, 'UsagePlugin: task:start handler failed');
    }
  }

  private onModelResponse(payload: PostModelResponsePayload): void {
    try {
      const { executionContext, tokenUsage, toolCallCount, computeMs } = payload;
      // Providers that fold several internal turns into one response report the real count.
      const modelCalls = payload.modelCalls ?? 1;
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

      const model = acc?.model ?? (wireModelOf(executionContext) || 'default');

      // est_cost_usd: linear/additive, so valid to compute per-turn and sum. null
      // (never 0) when the model has no rate-card entry — never report an unknown
      // model's cost as $0.
      // Priced as-of THIS turn's instant against the price history (falls back to the bundled
      // snapshot / rate card inside estimateCost), and carries the basis + record pointer.
      const est = estimateCost(
        model,
        {
          uncachedInputTokens: tokenUsage?.uncachedInputTokens ?? 0,
          cacheReadTokens: tokenUsage?.cacheReadTokens ?? 0,
          cacheCreationTokens: tokenUsage?.cacheCreationTokens ?? 0,
          outputTokens,
        },
        { asOf: this.now(), source: this.source }
      );
      const turnCost = est.costUsd;
      const turnPriced = turnCost !== null;
      const responseModel = payload.responseModel ?? null;
      const providerType = acc?.providerType ?? selectionOf(executionContext).providerType;

      if (!turnPriced) {
        const key = `${providerType}:${model}`;
        if (!this.warnedUnpriced.has(key)) {
          this.warnedUnpriced.add(key);
          this.logger.warn(
            { model, providerType, responseModel },
            `UsagePlugin: unpriced model "${model}" (${providerType}) has no rate-card or price-history entry; ` +
              'est_cost_usd is NULL for tasks that use it and its tokens are reported as unpriced_tokens'
          );
        }
      }

      this.db
        .insert(taskUsageTable)
        .values({
          taskId,
          rootTaskId: acc?.rootTaskId ?? null,
          agentName: acc?.agentName ?? executionContext.agentName,
          providerType,
          model,
          inputTokens,
          outputTokens,
          toolCallCount: toolCalls,
          modelCalls,
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
          // Provenance (1f1c8598 FS1): what served the call, which basis priced it, the price
          // record used, and an explicit status — an unpriced row is never just a silent NULL.
          responseModel,
          costBasis: est.basis,
          pricingRef: est.pricingRef,
          costStatus: est.status,
          pricedCostUsd: turnCost ?? 0,
          unpricedTokens: turnPriced ? 0 : inputTokens + outputTokens,
          createdAt: nowIso(),
        })
        .onConflictDoUpdate({
          target: taskUsageTable.taskId,
          set: {
            inputTokens: sql`${taskUsageTable.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${taskUsageTable.outputTokens} + ${outputTokens}`,
            toolCallCount: sql`${taskUsageTable.toolCallCount} + ${toolCalls}`,
            modelCalls: sql`${taskUsageTable.modelCalls} + ${modelCalls}`,
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
            }, 0) THEN ${taskUsageTable.modelCalls} + ${modelCalls} ELSE ${taskUsageTable.peakContextAt} END`,
            // CUMULATIVE Σ turn compute_ms — always additive, no special case (DESIGN.md §6).
            computeMs: sql`COALESCE(${taskUsageTable.computeMs}, 0) + ${computeMs}`,
            // Additive when this turn priced; forced NULL once ANY turn's model has no
            // rate-card entry — a partial sum would silently understate true cost, and
            // NULL is the only value that can't be misread as "this task cost $X".
            estCostUsd:
              turnCost !== null
                ? sql`COALESCE(${taskUsageTable.estCostUsd}, 0) + ${turnCost}`
                : sql`NULL`,
            // Provider-reported model: last non-null wins.
            responseModel: sql`COALESCE(${responseModel}, ${taskUsageTable.responseModel})`,
            // Basis + record pointer describe the LAST PRICED turn; an unpriced turn keeps them.
            costBasis: turnPriced
              ? sql`${est.basis}`
              : sql`${taskUsageTable.costBasis}`,
            pricingRef: turnPriced
              ? sql`${est.pricingRef}`
              : sql`${taskUsageTable.pricingRef}`,
            // Priced portion only: unpriced turns add 0 so a partial task still reports what
            // WAS priced next to its NULL est_cost_usd.
            pricedCostUsd: sql`COALESCE(${taskUsageTable.pricedCostUsd}, 0) + ${turnCost ?? 0}`,
            unpricedTokens: sql`COALESCE(${taskUsageTable.unpricedTokens}, 0) + ${
              turnPriced ? 0 : inputTokens + outputTokens
            }`,
            // all priced => priced; all unpriced => unpriced_model; mixed => partial.
            costStatus: turnPriced
              ? sql`CASE WHEN ${taskUsageTable.costStatus} IS NULL OR ${taskUsageTable.costStatus} = 'priced' THEN 'priced' ELSE 'partial' END`
              : sql`CASE WHEN ${taskUsageTable.costStatus} = 'unpriced_model' THEN 'unpriced_model' ELSE 'partial' END`,
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
