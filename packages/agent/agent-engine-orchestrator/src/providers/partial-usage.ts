import type { ModelUsageEntry, TokenUsage } from '@adhd/agent-base-types';

/**
 * One model turn inside a response that folds several (claudecli: one `assistant` message of the
 * CLI's stream). `contextTokens` is what the model saw on that turn:
 * `uncachedInputTokens + cacheReadTokens + cacheCreationTokens`. (debd934d)
 */
export interface IProviderTurnUsage {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  contextTokens: number;
}

/** Upper bound on {@link ProviderTokenUsage.perTurnUsage}; the first turns are kept, the rest flagged truncated. */
export const MAX_PER_TURN_USAGE = 64;

/**
 * {@link TokenUsage} as reported by a provider that folds several internal model turns into one
 * response, plus the per-turn context breakdown that folding would otherwise discard.
 */
export interface ProviderTokenUsage extends TokenUsage {
  /**
   * Context of the FIRST model turn of this response (`uncached + cache_read + cache_creation`).
   * The cost/context gate is defined on turn-1 context, which `peakContextTokens` (a max) cannot
   * give. Absent when the response is a single model call (its `inputTokens` IS the first turn).
   */
  firstTurnContextTokens?: number;
  /** Per-turn breakdown, at most {@link MAX_PER_TURN_USAGE} entries (earliest first). */
  perTurnUsage?: IProviderTurnUsage[];
  /** True when the run had more turns than {@link MAX_PER_TURN_USAGE}. */
  perTurnUsageTruncated?: boolean;
  /**
   * True on a zero-token placeholder for a run that spent real resources but reported nothing
   * (killed before any usage appeared): its cost is UNKNOWN, never $0. (afa37093 AC3)
   */
  unmeasured?: boolean;
  /**
   * True when the figures may UNDERCOUNT what was really spent: usage rebuilt from stream-json `assistant`
   * events (their `output_tokens` is a mid-stream snapshot, so output is a lower bound; input and cache figures
   * are exact), or a sum that folds in an attempt whose spend was never reported. `usage_query` exposes it as
   * `usage_lower_bound`. Absent => the figures are exactly what the provider reported. (afa37093 AC3)
   */
  usageLowerBound?: boolean;
}

/**
 * Usage a provider call spent although it did NOT return a response (CLI error result, abort,
 * timeout, crash, or a response the engine discarded). Carried on the thrown error so the engine
 * can record real spend for failed runs. (afa37093)
 */
export interface IProviderPartialUsage {
  /** Absent => the provider emitted no usage before it failed (recorded as an unmeasured zero row). */
  usage?: ProviderTokenUsage;
  rawUsage?: unknown;
  reportedToolUses?: number;
  reportedModelCalls?: number;
  responseModel?: string;
}

// Symbol.for: the same key across duplicated bundles (an `instanceof`-style check would not survive).
const PARTIAL_USAGE_KEY = Symbol.for('@adhd/agent-engine-orchestrator/providerPartialUsage');

/**
 * Attach `partial` to `err` (non-enumerable, so error serialisation is unchanged). Returns `err`.
 * Never throws: a frozen/sealed/non-extensible error (or one holding a non-configurable slot under our key)
 * cannot carry the marker, and replacing it with a TypeError would hide the real failure. (afa37093)
 */
export function attachPartialUsage<E>(err: E, partial: IProviderPartialUsage): E {
  if (typeof err === 'object' && err !== null) {
    try {
      if (Object.isExtensible(err) || Object.prototype.hasOwnProperty.call(err, PARTIAL_USAGE_KEY)) {
        Object.defineProperty(err, PARTIAL_USAGE_KEY, { value: partial, enumerable: false, configurable: true });
      }
    } catch {
      // not attachable: the original error propagates unchanged, without the spend marker
    }
  }
  return err;
}

/** The partial usage carried by `err` (or by any `cause` in its chain), if any. */
export function readPartialUsage(err: unknown): IProviderPartialUsage | undefined {
  for (let e: unknown = err, depth = 0; typeof e === 'object' && e !== null && depth < 5; depth++) {
    const hit = (e as Record<symbol, unknown>)[PARTIAL_USAGE_KEY];
    if (hit) return hit as IProviderPartialUsage;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

const sumOpt = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

function mergeBreakdown(a: ModelUsageEntry[], b: ModelUsageEntry[]): ModelUsageEntry[] {
  const out = a.map((e) => ({ ...e }));
  for (const e of b) {
    const hit = out.find((m) => m.model === e.model);
    if (!hit) {
      out.push({ ...e });
      continue;
    }
    hit.uncachedInputTokens += e.uncachedInputTokens;
    hit.cacheReadTokens += e.cacheReadTokens;
    hit.cacheCreationTokens += e.cacheCreationTokens;
    hit.cacheCreation1hTokens += e.cacheCreation1hTokens;
    hit.outputTokens += e.outputTokens;
    const cost = sumOpt(hit.reportedCostUsd, e.reportedCostUsd);
    if (cost !== undefined) hit.reportedCostUsd = cost;
  }
  return out;
}

/**
 * Add two usages spent by DIFFERENT provider calls of one logical request (a retried attempt and its successor):
 * every token class (cache tiers included), the provider-reported cost and the call counts are summed; peak
 * context is the max. An UNMEASURED side contributes nothing known, so the other side wins but is marked a
 * {@link ProviderTokenUsage.usageLowerBound}. The per-model and per-turn breakdowns are kept only when BOTH sides
 * have one (a breakdown covering part of the tokens would misprice the rest). `earlier` is the first attempt.
 */
export function mergeProviderUsage(earlier: ProviderTokenUsage, later: ProviderTokenUsage): ProviderTokenUsage {
  if (earlier.unmeasured && later.unmeasured) return { ...later };
  if (earlier.unmeasured) return { ...later, usageLowerBound: true };
  if (later.unmeasured) return { ...earlier, usageLowerBound: true };

  const merged: ProviderTokenUsage = {
    ...later,
    inputTokens: earlier.inputTokens + later.inputTokens,
    outputTokens: earlier.outputTokens + later.outputTokens,
  };
  const numeric = [
    'uncachedInputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'cacheCreation1hTokens',
    'reasoningTokens',
    'cliReportedCostUsd',
  ] as const;
  for (const k of numeric) {
    const v = sumOpt(earlier[k], later[k]);
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const peak = Math.max(earlier.peakContextTokens ?? 0, later.peakContextTokens ?? 0);
  if (peak > 0) merged.peakContextTokens = peak;
  else delete merged.peakContextTokens;

  if (earlier.modelBreakdown?.length && later.modelBreakdown?.length) {
    merged.modelBreakdown = mergeBreakdown(earlier.modelBreakdown, later.modelBreakdown);
  } else {
    delete merged.modelBreakdown;
  }

  delete merged.firstTurnContextTokens;
  delete merged.perTurnUsage;
  delete merged.perTurnUsageTruncated;
  if (earlier.perTurnUsage?.length && later.perTurnUsage?.length && earlier.firstTurnContextTokens !== undefined) {
    const all = [...earlier.perTurnUsage, ...later.perTurnUsage];
    merged.firstTurnContextTokens = earlier.firstTurnContextTokens;
    merged.perTurnUsage = all.slice(0, MAX_PER_TURN_USAGE);
    if (all.length > MAX_PER_TURN_USAGE || earlier.perTurnUsageTruncated || later.perTurnUsageTruncated) {
      merged.perTurnUsageTruncated = true;
    }
  }

  if (earlier.usageLowerBound || later.usageLowerBound) merged.usageLowerBound = true;
  else delete merged.usageLowerBound;
  return merged;
}

/**
 * Sum the spend of two failed provider calls of one logical request. A call that started but reported nothing
 * (`{}`) makes the other side's usage a lower bound. `earlier` undefined => `later` unchanged (a never-started
 * attempt carries no partial at all, so it never reaches here).
 */
export function mergePartialUsage(
  earlier: IProviderPartialUsage | undefined,
  later: IProviderPartialUsage
): IProviderPartialUsage {
  if (!earlier) return later;
  let usage: ProviderTokenUsage | undefined;
  if (earlier.usage && later.usage) usage = mergeProviderUsage(earlier.usage, later.usage);
  else if (earlier.usage) usage = { ...earlier.usage, usageLowerBound: true };
  else if (later.usage) usage = { ...later.usage, usageLowerBound: true };
  const toolUses = sumOpt(earlier.reportedToolUses, later.reportedToolUses);
  const modelCalls = sumOpt(earlier.reportedModelCalls, later.reportedModelCalls);
  const responseModel = later.responseModel ?? earlier.responseModel;
  const rawUsage = later.rawUsage ?? earlier.rawUsage;
  return {
    ...(usage ? { usage } : {}),
    ...(rawUsage !== undefined ? { rawUsage } : {}),
    ...(toolUses !== undefined ? { reportedToolUses: toolUses } : {}),
    ...(modelCalls !== undefined ? { reportedModelCalls: modelCalls } : {}),
    ...(responseModel !== undefined ? { responseModel } : {}),
  };
}
