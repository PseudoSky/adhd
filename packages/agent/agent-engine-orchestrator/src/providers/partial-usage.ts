import type { TokenUsage } from '@adhd/agent-base-types';

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

/** Attach `partial` to `err` (non-enumerable, so error serialisation is unchanged). Returns `err`. */
export function attachPartialUsage<E>(err: E, partial: IProviderPartialUsage): E {
  if (typeof err === 'object' && err !== null) {
    Object.defineProperty(err, PARTIAL_USAGE_KEY, { value: partial, enumerable: false, configurable: true });
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
