export interface ModelRate {
  /** Full-price (cache-miss / uncached) input, $ per million tokens. */
  inputPerM: number;
  /** Cache-hit input, $ per million tokens. */
  cacheReadPerM: number;
  /** Cache-write/creation input (5-minute tier), $ per million tokens. */
  cacheWritePerM: number;
  /** Output tokens (reasoning_tokens is a SUBSET of this, never billed separately), $ per million tokens. */
  outputPerM: number;
}

// Sourced 2026-07-16 directly from vendor docs (Anthropic: platform.claude.com/docs/en/about-claude/pricing;
// DeepSeek: api-docs.deepseek.com/quick_start/pricing). DeepSeek numbers cross-corroborated against
// independent prior research. See memory episode 01KXPWEVY0DXBD75Y2MJ1QTY68.
export const RATE_CARD: Record<string, ModelRate> = {
  claude_sonnet_4_6: { inputPerM: 3.00, cacheReadPerM: 0.30, cacheWritePerM: 3.75, outputPerM: 15.00 },
  claude_opus_4_8:   { inputPerM: 5.00, cacheReadPerM: 0.50, cacheWritePerM: 6.25, outputPerM: 25.00 },
  claude_haiku_4_5:  { inputPerM: 1.00, cacheReadPerM: 0.10, cacheWritePerM: 1.25, outputPerM: 5.00 },
  claude_fable_5:    { inputPerM: 10.00, cacheReadPerM: 1.00, cacheWritePerM: 12.50, outputPerM: 50.00 },
  'deepseek-v4-flash': { inputPerM: 0.14, cacheReadPerM: 0.0028, cacheWritePerM: 0, outputPerM: 0.28 },
  'deepseek-v4-pro':   { inputPerM: 0.435, cacheReadPerM: 0.003625, cacheWritePerM: 0, outputPerM: 0.87 },
};

/**
 * Estimate dollar cost for one model call (or a cumulative rollup, since cost is linear/additive
 * — this is valid to call with either a single turn's token counts or a pre-summed total).
 * Returns null (never 0) when the model has no rate-card entry — an unknown model's cost must
 * never be silently reported as $0.
 */
export function estimateCostUsd(
  model: string,
  usage: { uncachedInputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number }
): number | null {
  const rate = RATE_CARD[model];
  if (!rate) return null;
  return (
    (usage.uncachedInputTokens * rate.inputPerM +
      usage.cacheReadTokens * rate.cacheReadPerM +
      usage.cacheCreationTokens * rate.cacheWritePerM +
      usage.outputTokens * rate.outputPerM) /
    1_000_000
  );
}
