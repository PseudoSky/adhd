import type { ProviderChatResponse, ProviderLimitWarning } from '../providers/types.js';
import type { ProviderTokenUsage } from '../providers/partial-usage.js';

/** The slice of a provider response (or of a failed call's partial usage) that becomes a MODEL_RESPONSE event. */
export interface IModelResponseSource {
  stopReason: string;
  hasContent: boolean;
  toolCallCount: number;
  modelCalls?: number;
  responseModel?: string;
  usage?: ProviderTokenUsage;
  rawUsage?: unknown;
  limitWarnings?: ProviderLimitWarning[];
}

/** Adapt a successful provider response. `toolCallCount` is what the orchestrator accounts for this turn. */
export function sourceFromResponse(
  response: ProviderChatResponse,
  toolCallCount: number,
  hasContent: boolean
): IModelResponseSource {
  return {
    stopReason: response.stopReason,
    hasContent,
    toolCallCount,
    modelCalls: response.reportedModelCalls,
    responseModel: response.responseModel,
    usage: response.usage,
    rawUsage: response.rawUsage,
    limitWarnings: response.limitWarnings,
  };
}

/**
 * The persisted `MODEL_RESPONSE` payload. `usage_query`'s turn grain is derived from it, so every
 * field a turn row exposes must be written here. Pure.
 *
 * `failed: true` marks the usage of a call that threw (CLI error result, abort, timeout) or whose
 * response the engine discarded; `unmeasured: true` marks a zero-token placeholder whose cost is
 * UNKNOWN. (afa37093)
 */
export function buildModelResponsePayload(
  src: IModelResponseSource,
  computeMs: number,
  mark: { failed?: boolean; failure?: string } = {}
): Record<string, unknown> {
  const u = src.usage;
  return {
    stopReason: src.stopReason,
    hasContent: src.hasContent,
    toolCallCount: src.toolCallCount,
    modelCalls: src.modelCalls,
    responseModel: src.responseModel,
    inputTokens: u?.inputTokens,
    outputTokens: u?.outputTokens,
    cacheReadTokens: u?.cacheReadTokens,
    cacheCreationTokens: u?.cacheCreationTokens,
    // b726a987: 1h-TTL subset of cacheCreationTokens (priced at the 1h rate on re-pricing).
    cacheCreation1hTokens: u?.cacheCreation1hTokens,
    // Provider-normalized full-price input (NOT derived here — the provider layer already
    // reconstructs this correctly per-provider). Needed at turn grain so usage_query's turn rows
    // don't have to re-derive it from inputTokens - cacheReadTokens - cacheCreationTokens.
    uncachedInputTokens: u?.uncachedInputTokens,
    reasoningTokens: u?.reasoningTokens,
    // Per-model usage when one response spans several models / resolved an alias (claudecli
    // `modelUsage`): lets usage_query's turn grain re-price each model at its own rate card
    // instead of pricing the whole turn at the task's primary model. (79aebb26 BK8)
    ...(u?.modelBreakdown?.length ? { modelBreakdown: u.modelBreakdown } : {}),
    // Largest single-turn context inside this response (claudecli folds several turns into one
    // summed inputTokens); absent => inputTokens IS the context. (7ead5eaa BK4)
    ...(u?.peakContextTokens !== undefined ? { peakContextTokens: u.peakContextTokens } : {}),
    // Context of the FIRST turn and a bounded per-turn breakdown of a folded response. (debd934d)
    ...(u?.firstTurnContextTokens !== undefined ? { firstTurnContextTokens: u.firstTurnContextTokens } : {}),
    ...(u?.perTurnUsage?.length ? { perTurnUsage: u.perTurnUsage } : {}),
    ...(u?.perTurnUsageTruncated ? { perTurnUsageTruncated: true } : {}),
    // The provider's own dollar figure for this response (claudecli total_cost_usd), beside the estimate. (8333f755)
    ...(u?.cliReportedCostUsd !== undefined ? { cliReportedCostUsd: u.cliReportedCostUsd } : {}),
    rawUsage: src.rawUsage,
    // Window warnings the call succeeded despite (claudecli allowed_warning). (de6bee5d FLT-4)
    ...(src.limitWarnings?.length ? { limitWarnings: src.limitWarnings } : {}),
    ...(mark.failed ? { failed: true } : {}),
    ...(mark.failure ? { failure: mark.failure } : {}),
    ...(u?.unmeasured ? { unmeasured: true } : {}),
    // The figures may undercount real spend (stream-rebuilt output tokens, or a folded unreported attempt). afa37093
    ...(u?.usageLowerBound ? { usageLowerBound: true } : {}),
    computeMs,
  };
}
