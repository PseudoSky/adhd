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

// agent-mcp-005 — real callers never pass a bare RATE_CARD key. usage-plugin.ts passes
// whatever a human typed into an agent's `provider.model` config ("claude-haiku-4-5",
// "sonnet", "haiku", "claude-sonnet-5"); usage.ts passes the provider-reported string off
// a live event (e.g. claudecli's dated snapshot id "claude-haiku-4-5-20251001"). Without
// normalization, `estimateCostUsd` silently returned null for essentially every production
// call. `normalizeModelKey` + the family-alias fallback below close that gap without ever
// inventing a price: an alias only ever resolves to a rate that's already in RATE_CARD.

// Bare generation/family aliases ("sonnet", "haiku", "opus", "fable" — with or without a
// trailing version number, e.g. "claude-sonnet-5") resolve to the newest RATE_CARD entry
// for that family. NOTE: there is no verified `claude_sonnet_5` pricing yet (see rate-card
// header for the sourcing rule — never fabricate a number), so "sonnet"/"claude-sonnet-5"
// intentionally resolve to `claude_sonnet_4_6`, the newest *priced* sonnet entry, until a
// cited claude_sonnet_5 rate is added to RATE_CARD.
const FAMILY_ALIASES: Record<string, keyof typeof RATE_CARD> = {
  sonnet: 'claude_sonnet_4_6',
  opus: 'claude_opus_4_8',
  haiku: 'claude_haiku_4_5',
  fable: 'claude_fable_5',
};

/**
 * Derive candidate RATE_CARD keys for a real, provider-reported (or human-typed) model
 * string, most-specific first. Handles: an org/provider prefix ("anthropic/claude-haiku-4-5"),
 * a trailing dated snapshot suffix ("-20251001"), and hyphen/underscore key-style variants
 * (RATE_CARD mixes `claude_x_y_z` and `deepseek-x-y` styles, so both directions are tried).
 * Does NOT include family-alias resolution — that's a separate, lower-confidence fallback
 * applied only after every candidate here misses (see `estimateCostUsd`).
 */
function normalizeModelKeyCandidates(model: string): string[] {
  const raw = model.trim().toLowerCase();
  const afterPrefix = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const dateStripped = afterPrefix.replace(/[-_]\d{8}$/, '');

  return [
    model,
    raw,
    afterPrefix,
    dateStripped,
    dateStripped.replace(/-/g, '_'),
    dateStripped.replace(/_/g, '-'),
  ];
}

/**
 * Resolve a real model string to its RATE_CARD family alias (e.g. "haiku", "claude-sonnet-5")
 * when no exact/normalized key matched. Token-matches against known family names so it
 * never fires on an unrelated model that merely contains a substring collision.
 */
function resolveFamilyAlias(model: string): ModelRate | undefined {
  const tokens = model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const [family, canonicalKey] of Object.entries(FAMILY_ALIASES)) {
    if (tokens.includes(family)) return RATE_CARD[canonicalKey];
  }
  return undefined;
}

/**
 * Estimate dollar cost for one model call (or a cumulative rollup, since cost is linear/additive
 * — this is valid to call with either a single turn's token counts or a pre-summed total).
 * `model` is normalized (see `normalizeModelKeyCandidates` / `resolveFamilyAlias`) against
 * real-world provider-reported and human-typed model strings before falling back to null.
 * Returns null (never 0) when the model has no rate-card entry (even after normalization) —
 * an unknown model's cost must never be silently reported as $0.
 */
export function estimateCostUsd(
  model: string,
  usage: { uncachedInputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number }
): number | null {
  let rate: ModelRate | undefined = RATE_CARD[model];
  if (!rate) {
    for (const candidate of normalizeModelKeyCandidates(model)) {
      rate = RATE_CARD[candidate];
      if (rate) break;
    }
  }
  if (!rate) rate = resolveFamilyAlias(model);
  if (!rate) return null;
  return (
    (usage.uncachedInputTokens * rate.inputPerM +
      usage.cacheReadTokens * rate.cacheReadPerM +
      usage.cacheCreationTokens * rate.cacheWritePerM +
      usage.outputTokens * rate.outputPerM) /
    1_000_000
  );
}
