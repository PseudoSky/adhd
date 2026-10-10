import { eq, sql } from 'drizzle-orm';
import { selectionOf, wireModelOf } from '../providers/resolve-selection.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { taskUsageTable, createPriceSource } from "@adhd/agent-store-runtime";
import { estimateCost } from "@adhd/agent-core-provider";
import type { ICostEstimate, IPriceSource } from "@adhd/agent-core-provider";
import { nowIso } from '../utils/timestamps.js';
import type { ProviderTokenUsage } from '../providers/partial-usage.js';
import type { EngineLogger } from '../interfaces.js';
import type {
  IHookRegistry,
  ModelUsageEntry,
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

/** Tokens a breakdown entry represents, used to pick the entry that "is" the task's model. */
function entryTokens(e: ModelUsageEntry): number {
  return e.uncachedInputTokens + e.cacheReadTokens + e.cacheCreationTokens + e.outputTokens;
}

/**
 * One model's cumulative share of a task, as persisted in `task_usage.model_breakdown_json`
 * (79aebb26 BK8): the tokens it served, what was priced for it, and why if it could not be.
 */
export interface IStoredModelUsage extends ModelUsageEntry {
  /** Cumulative priced cost for this model; excludes any unpriced turn. */
  pricedCostUsd: number;
  /** `priced` | `unpriced_model` | `partial` (some turns priced, some not). */
  costStatus: string;
  /** Why the model could not be priced; absent when every turn priced. */
  unpricedReason?: string;
}

/** all priced => priced; none priced => unpriced_model; mixed => partial. */
function statusOfEntries(unpricedCount: number, total: number): string {
  if (unpricedCount === 0) return 'priced';
  return unpricedCount === total ? 'unpriced_model' : 'partial';
}

/** A `modelBreakdown` priced entry-by-entry (strict: an id with no rate card is unpriced, never family-priced). */
export interface IPricedBreakdown {
  /** The breakdown entries, in order. */
  entries: ModelUsageEntry[];
  /** Per-entry estimate, parallel to `entries`. */
  ests: ICostEstimate[];
  /** Per-entry cost (null = unpriced), parallel to `entries`. */
  entryCosts: Array<number | null>;
  /** Sum of the priced entries (excludes unpriced ones). */
  pricedPortion: number;
  unpricedCount: number;
  /** Tokens of the unpriced entries. */
  unpricedTokens: number;
  /** null as soon as any entry is unpriced (never a partial sum presented as the cost). */
  costUsd: number | null;
  /** `priced` | `unpriced_model` | `partial`. */
  status: string;
  /** The last priced estimate (basis + record pointer), if any entry priced. */
  lastPriced: ICostEstimate | undefined;
}

/**
 * Price a multi-model response entry by entry as of `asOf`. Shared by the write path
 * ({@link UsagePlugin}) and the `usage_query` turn re-pricing so a turn re-priced from its
 * MODEL_RESPONSE event equals the turn priced at write time. (79aebb26 BK8)
 */
export function priceModelBreakdown(
  breakdown: readonly ModelUsageEntry[],
  asOf: string,
  source: IPriceSource
): IPricedBreakdown {
  const ests = breakdown.map((e) =>
    estimateCost(
      e.model,
      {
        uncachedInputTokens: e.uncachedInputTokens,
        cacheReadTokens: e.cacheReadTokens,
        cacheCreationTokens: e.cacheCreationTokens,
        cacheCreation1hTokens: e.cacheCreation1hTokens,
        outputTokens: e.outputTokens,
      },
      { asOf, source, strict: true }
    )
  );
  const entryCosts = ests.map((est) => est.costUsd);
  const unpricedCount = entryCosts.filter((c) => c === null).length;
  const pricedPortion = entryCosts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
  return {
    entries: [...breakdown],
    ests,
    entryCosts,
    pricedPortion,
    unpricedCount,
    unpricedTokens: breakdown
      .filter((_, i) => entryCosts[i] === null)
      .reduce((sum, e) => sum + entryTokens(e), 0),
    costUsd: unpricedCount === 0 ? pricedPortion : null,
    status: statusOfEntries(unpricedCount, breakdown.length),
    lastPriced: [...ests].reverse().find((est) => est.costUsd !== null),
  };
}

/** Fold one turn's `incoming` entries (already priced) into the stored per-model totals. Pure. */
function mergeBreakdown(
  storedJson: string | null | undefined,
  incoming: IStoredModelUsage[]
): IStoredModelUsage[] {
  let merged: IStoredModelUsage[] = [];
  if (storedJson) {
    try {
      const parsed: unknown = JSON.parse(storedJson);
      if (Array.isArray(parsed)) merged = parsed as IStoredModelUsage[];
    } catch {
      merged = [];
    }
  }
  for (const e of incoming) {
    const hit = merged.find((m) => m.model === e.model);
    if (!hit) {
      merged.push({ ...e });
      continue;
    }
    hit.uncachedInputTokens += e.uncachedInputTokens;
    hit.cacheReadTokens += e.cacheReadTokens;
    hit.cacheCreationTokens += e.cacheCreationTokens;
    hit.cacheCreation1hTokens += e.cacheCreation1hTokens;
    hit.outputTokens += e.outputTokens;
    hit.pricedCostUsd += e.pricedCostUsd;
    if (e.reportedCostUsd !== undefined) hit.reportedCostUsd = (hit.reportedCostUsd ?? 0) + e.reportedCostUsd;
    if (hit.costStatus !== e.costStatus) hit.costStatus = 'partial';
    if (e.unpricedReason !== undefined) hit.unpricedReason = e.unpricedReason;
  }
  return merged;
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
      // Peak CONTEXT of this response: a provider that folds several model turns into one summed
      // `inputTokens` (claudecli) reports the true per-turn max; otherwise the one call IS the peak.
      // `inputTokens` stays the cumulative, cache-inclusive sum for billing. (7ead5eaa BK4)
      const peakCandidate = Math.max(tokenUsage?.peakContextTokens ?? 0, 0) || inputTokens;
      const outputTokens = tokenUsage?.outputTokens ?? 0;
      const toolCalls = toolCallCount ?? 0;

      const incoming = tokenUsage?.stopReason ?? 'unknown';
      if (acc) {
        acc.mostSevereStopReason = mostSevere(
          acc.mostSevereStopReason,
          incoming
        );
      }

      // The model the task was REQUESTED with (agent config; may be an alias such as "haiku").
      const requestedModel = acc?.model ?? (wireModelOf(executionContext) || 'default');
      if ((tokenUsage as ProviderTokenUsage | undefined)?.unmeasured) {
        this.recordUnmeasured(payload, acc, requestedModel);
        return;
      }
      const breakdown = tokenUsage?.modelBreakdown?.length ? tokenUsage.modelBreakdown : undefined;
      const asOf = this.now();

      // est_cost_usd: linear/additive, so valid to compute per-turn and sum. null
      // (never 0) when the model has no rate-card entry — never report an unknown
      // model's cost as $0.
      // Priced as-of THIS turn's instant against the price history (falls back to the bundled
      // snapshot / rate card inside estimateCost), and carries the basis + record pointer.
      //
      // 79aebb26 BK8: when the provider reports WHICH concrete model(s) served the response
      // (claudecli `modelUsage`), each entry is priced at its OWN rate card (strict: no family
      // fallback, so an unknown concrete id is unpriced, never priced at another model's rate) and
      // the entries are summed. The task's `model` is then the resolved id with the most tokens and
      // the requested alias is kept in `requested_model`.
      let storedEntries: IStoredModelUsage[] = [];
      let model = requestedModel;
      let turnCost: number | null;
      let pricedPortion: number;
      let unpricedTokenCount: number;
      let turnStatus: string;
      let turnBasis: string | null;
      let turnPricingRef: string | null;
      if (breakdown) {
        const primary = breakdown.reduce((best, e) => (entryTokens(e) > entryTokens(best) ? e : best));
        model = primary.model;
        const priced = priceModelBreakdown(breakdown, asOf, this.source);
        const ests = priced.ests;
        storedEntries = breakdown.map((e, i): IStoredModelUsage => ({
          ...e,
          pricedCostUsd: ests[i].costUsd ?? 0,
          costStatus: ests[i].status,
          ...(ests[i].costUsd === null
            ? { unpricedReason: `no rate card or price-history entry for resolved model "${e.model}"` }
            : {}),
        }));
        pricedPortion = priced.pricedPortion;
        unpricedTokenCount = priced.unpricedTokens;
        turnCost = priced.costUsd;
        turnStatus = priced.status;
        turnBasis = priced.lastPriced?.basis ?? null;
        turnPricingRef = priced.lastPriced?.pricingRef ?? null;
      } else {
        const est = estimateCost(
          model,
          {
            uncachedInputTokens: tokenUsage?.uncachedInputTokens ?? 0,
            cacheReadTokens: tokenUsage?.cacheReadTokens ?? 0,
            cacheCreationTokens: tokenUsage?.cacheCreationTokens ?? 0,
            cacheCreation1hTokens: tokenUsage?.cacheCreation1hTokens ?? 0,
            outputTokens,
          },
          { asOf, source: this.source }
        );
        turnCost = est.costUsd;
        pricedPortion = turnCost ?? 0;
        unpricedTokenCount = turnCost !== null ? 0 : inputTokens + outputTokens;
        turnStatus = est.status;
        turnBasis = est.basis;
        turnPricingRef = est.pricingRef;
      }
      // The 1-hour-TTL subset of this response's cache writes (8333f755 AC3): the response-level scalar, else
      // the sum over the per-model entries a folded response carries.
      const cacheCreation1h =
        tokenUsage?.cacheCreation1hTokens ??
        (breakdown ? breakdown.reduce((n, e) => n + e.cacheCreation1hTokens, 0) : 0);
      const turnPriced = turnCost !== null;
      const responseModel = payload.responseModel ?? (breakdown ? model : null);
      const cliReportedCostUsd = tokenUsage?.cliReportedCostUsd;
      const providerType = acc?.providerType ?? selectionOf(executionContext).providerType;

      if (!turnPriced) {
        // Breakdown path: warn per UNPRICED resolved model (a priced sibling must not mask it).
        const unpricedModels = breakdown
          ? storedEntries.filter((e) => e.costStatus === 'unpriced_model').map((e) => e.model)
          : [model];
        for (const unpricedModel of unpricedModels) {
          const key = `${providerType}:${unpricedModel}`;
          if (this.warnedUnpriced.has(key)) continue;
          this.warnedUnpriced.add(key);
          this.logger.warn(
            { model: unpricedModel, requestedModel, providerType, responseModel },
            `UsagePlugin: unpriced model "${unpricedModel}" (${providerType}) has no rate-card or price-history entry; ` +
              'est_cost_usd is NULL for tasks that use it and its tokens are reported as unpriced_tokens'
          );
        }
      }

      // Cumulative per-model breakdown (read-merge-write: the plugin is the sole writer of this task's row).
      let breakdownJson: string | null = null;
      if (breakdown) {
        const stored = this.db
          .select({ json: taskUsageTable.modelBreakdownJson })
          .from(taskUsageTable)
          .where(eq(taskUsageTable.taskId, taskId))
          .get() as { json: string | null } | undefined;
        breakdownJson = JSON.stringify(mergeBreakdown(stored?.json, storedEntries));
      }

      this.db
        .insert(taskUsageTable)
        .values({
          taskId,
          rootTaskId: acc?.rootTaskId ?? null,
          agentName: acc?.agentName ?? executionContext.agentName,
          providerType,
          model,
          requestedModel,
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
          cacheCreation1hTokens: cacheCreation1h,
          uncachedInputTokens: tokenUsage?.uncachedInputTokens ?? null,
          reasoningTokens: tokenUsage?.reasoningTokens ?? null,
          // First call for this task: its input IS the peak so far.
          peakContextTokens: peakCandidate,
          // 1-based model-call index of the response that peaked. A first response folding N
          // calls (claudecli) is call N: response-granular, as in the update path. (7ead5eaa AC4.6)
          peakContextAt: modelCalls,
          // CUMULATIVE Σ turn compute_ms (DESIGN.md §6) — this call's is the first.
          computeMs,
          // First call for this task: whatever cost this turn produced (or NULL if
          // the model is unrecognized — never 0).
          ...(turnCost !== null ? { estCostUsd: turnCost } : {}),
          // Provenance (1f1c8598 FS1): what served the call, which basis priced it, the price
          // record used, and an explicit status — an unpriced row is never just a silent NULL.
          responseModel,
          costBasis: turnBasis,
          pricingRef: turnPricingRef,
          costStatus: turnStatus,
          pricedCostUsd: pricedPortion,
          unpricedTokens: unpricedTokenCount,
          ...(cliReportedCostUsd !== undefined ? { cliReportedCostUsd } : {}),
          ...(breakdownJson !== null ? { modelBreakdownJson: breakdownJson } : {}),
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
            cacheCreation1hTokens: sql`COALESCE(${
              taskUsageTable.cacheCreation1hTokens
            }, 0) + ${cacheCreation1h}`,
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
            }, 0), ${peakCandidate})`,
            // Record WHICH call peaked (1-based model-call index; for a response that folds N
            // calls it is the LAST call of that response), only when this response is a strictly
            // new peak. (7ead5eaa AC4.6)
            peakContextAt: sql`CASE WHEN ${peakCandidate} > COALESCE(${
              taskUsageTable.peakContextTokens
            }, 0) THEN ${taskUsageTable.modelCalls} + ${modelCalls} ELSE ${taskUsageTable.peakContextAt} END`,
            // CUMULATIVE Σ turn compute_ms — always additive, no special case (DESIGN.md §6).
            computeMs: sql`COALESCE(${taskUsageTable.computeMs}, 0) + ${computeMs}`,
            // Additive while every turn so far priced; forced NULL once ANY turn's model has no
            // price and STICKY thereafter — a partial sum would silently understate true cost, and
            // NULL is the only value that can't be misread as "this task cost $X". Stickiness keys
            // off the stored cost_status (old-row value in SQLite's SET): 'partial' or
            // 'unpriced_model' means an earlier turn was unpriced, so a later priced turn must not
            // resurrect a non-NULL cost (it would count only the turns since the last NULL).
            estCostUsd:
              turnCost !== null
                ? sql`CASE WHEN ${taskUsageTable.costStatus} IS NULL OR ${taskUsageTable.costStatus} = 'priced' THEN COALESCE(${taskUsageTable.estCostUsd}, 0) + ${turnCost} ELSE NULL END`
                : sql`NULL`,
            // Provider-reported model: last non-null wins.
            responseModel: sql`COALESCE(${responseModel}, ${taskUsageTable.responseModel})`,
            // Basis + record pointer describe the LAST PRICED turn; an unpriced turn keeps them.
            costBasis: turnBasis !== null
              ? sql`${turnBasis}`
              : sql`${taskUsageTable.costBasis}`,
            pricingRef: turnPricingRef !== null
              ? sql`${turnPricingRef}`
              : sql`${taskUsageTable.pricingRef}`,
            // Priced portion only: unpriced turns add 0 so a partial task still reports what
            // WAS priced next to its NULL est_cost_usd.
            pricedCostUsd: sql`COALESCE(${taskUsageTable.pricedCostUsd}, 0) + ${pricedPortion}`,
            unpricedTokens: sql`COALESCE(${taskUsageTable.unpricedTokens}, 0) + ${unpricedTokenCount}`,
            // CLI-reported cost is informational and additive; absent turns add nothing (NULL stays NULL).
            ...(cliReportedCostUsd !== undefined
              ? { cliReportedCostUsd: sql`COALESCE(${taskUsageTable.cliReportedCostUsd}, 0) + ${cliReportedCostUsd}` }
              : {}),
            ...(breakdownJson !== null ? { modelBreakdownJson: sql`${breakdownJson}` } : {}),
            // all priced => priced; all unpriced => unpriced_model; mixed => partial.
            costStatus: this.statusUpsert(turnStatus, turnPriced),
          },
        })
        .run();
    } catch (err) {
      this.logger.error({ err }, 'UsagePlugin: post:model_response handler failed');
    }
  }

  /**
   * afa37093 AC3: a provider call that spent real resources but reported nothing (killed before any usage
   * appeared). Its tokens and cost are UNKNOWN: the row is created (so the task is visible in `usage_query`)
   * with zero tokens, a NULL `est_cost_usd` (never $0) and `cost_status = 'unmeasured'`. Folding into a task that
   * already has measured turns degrades it to `partial` and makes its estimate NULL, exactly like an unpriced turn.
   */
  private recordUnmeasured(
    payload: PostModelResponsePayload,
    acc: Accumulator | undefined,
    requestedModel: string
  ): void {
    const { executionContext, computeMs } = payload;
    const taskId = executionContext.taskId;
    const providerType = acc?.providerType ?? selectionOf(executionContext).providerType;
    this.db
      .insert(taskUsageTable)
      .values({
        taskId,
        rootTaskId: acc?.rootTaskId ?? null,
        agentName: acc?.agentName ?? executionContext.agentName,
        providerType,
        model: requestedModel,
        requestedModel,
        inputTokens: 0,
        outputTokens: 0,
        toolCallCount: 0,
        modelCalls: 0,
        latencyMs: 0,
        isComplete: 0,
        stopReason: acc?.mostSevereStopReason ?? 'unknown',
        maxTokens: acc?.maxTokens ?? null,
        peakContextTokens: 0,
        peakContextAt: 0,
        computeMs,
        responseModel: payload.responseModel ?? null,
        costStatus: 'unmeasured',
        pricedCostUsd: 0,
        unpricedTokens: 0,
        createdAt: nowIso(),
      })
      .onConflictDoUpdate({
        target: taskUsageTable.taskId,
        set: {
          computeMs: sql`COALESCE(${taskUsageTable.computeMs}, 0) + ${computeMs}`,
          estCostUsd: sql`NULL`,
          costStatus: sql`CASE WHEN ${taskUsageTable.costStatus} = 'unmeasured' THEN 'unmeasured' ELSE 'partial' END`,
        },
      })
      .run();
  }

  /** SQL for the running `cost_status` after folding a turn of `turnStatus` into the stored value. */
  private statusUpsert(turnStatus: string, turnPriced: boolean): ReturnType<typeof sql> {
    if (turnStatus === 'partial') return sql`'partial'`;
    if (turnPriced) {
      return sql`CASE WHEN ${taskUsageTable.costStatus} IS NULL OR ${taskUsageTable.costStatus} = 'priced' THEN 'priced' ELSE 'partial' END`;
    }
    return sql`CASE WHEN ${taskUsageTable.costStatus} = 'unpriced_model' THEN 'unpriced_model' ELSE 'partial' END`;
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
