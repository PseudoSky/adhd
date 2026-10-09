import { OPENROUTER_SNAPSHOT } from './pricing-snapshot.js';
import { parseOpenRouterFeed, type IParsedFeed } from './feed.js';
import type { CostBasis, ICostEstimate, IPriceSource, IUsageTokens } from './price-source.js';

export interface ModelRate {
  /** Full-price (cache-miss / uncached) input, $ per million tokens. */
  inputPerM: number;
  /** Cache-hit input, $ per million tokens. */
  cacheReadPerM: number;
  /** Cache-write/creation input (5-minute tier), $ per million tokens. */
  cacheWritePerM: number;
  /**
   * Cache-write/creation input, 1-HOUR tier, $ per million tokens (Anthropic: 2x base input).
   * Optional: a model with no 1h rate bills its 1h-tier tokens at `cacheWritePerM` (the 5-minute
   * rate) -- the documented fallback, never a fabricated number. (b726a987)
   */
  cacheWrite1hPerM?: number;
  /** Output tokens (reasoning_tokens is a SUBSET of this, never billed separately), $ per million tokens. */
  outputPerM: number;
}

// Sourced 2026-07-16 directly from vendor docs (Anthropic: platform.claude.com/docs/en/about-claude/pricing;
// DeepSeek: api-docs.deepseek.com/quick_start/pricing). DeepSeek numbers cross-corroborated against
// independent prior research. See memory episode 01KXPWEVY0DXBD75Y2MJ1QTY68.
export const RATE_CARD: Record<string, ModelRate> = {
  claude_sonnet_4_6: { inputPerM: 3.00, cacheReadPerM: 0.30, cacheWritePerM: 3.75, cacheWrite1hPerM: 6.00, outputPerM: 15.00 },
  claude_opus_4_8:   { inputPerM: 5.00, cacheReadPerM: 0.50, cacheWritePerM: 6.25, cacheWrite1hPerM: 10.00, outputPerM: 25.00 },
  claude_haiku_4_5:  { inputPerM: 1.00, cacheReadPerM: 0.10, cacheWritePerM: 1.25, cacheWrite1hPerM: 2.00, outputPerM: 5.00 },
  // 79aebb26 BK8. `claude --model haiku` resolves to claude-haiku-5-5 in the current CLI; it is ~10x cheaper
  // than 4.5 per token, which is why the A0 run cost $0.0203 for ~96k context (priced at 4.5 it would be ~$0.2).
  // Verifiable two ways: (1) the OpenRouter feed snapshot (pricing.json, fetched 2026-10-08) lists
  // anthropic/claude-haiku-5.5 at prompt 1e-7 / completion 5e-7 / cache_read 1e-8 / cache_write 1.25e-7 /
  // cache_write_1h 2e-7 per token; (2) these rates reproduce the CLI's own total_cost_usd for the recorded A0
  // stream (0.02025881) to 8 digits. The feed's >100k-prompt 5x override tier is deliberately not applied
  // (same rule as every other model).
  claude_haiku_5_5:  { inputPerM: 0.10, cacheReadPerM: 0.01, cacheWritePerM: 0.125, cacheWrite1hPerM: 0.20, outputPerM: 0.50 },
  claude_fable_5:    { inputPerM: 10.00, cacheReadPerM: 1.00, cacheWritePerM: 12.50, cacheWrite1hPerM: 20.00, outputPerM: 50.00 },
  'deepseek-v4-flash': { inputPerM: 0.14, cacheReadPerM: 0.0028, cacheWritePerM: 0, outputPerM: 0.28 },
  'deepseek-v4-pro':   { inputPerM: 0.435, cacheReadPerM: 0.003625, cacheWritePerM: 0, outputPerM: 0.87 },
};

// 37f6c511 — OpenRouter price snapshot (pricing.json, projected to pricing-snapshot.ts, GET https://openrouter.ai/api/v1/models).
// Values are per-TOKEN USD strings; ModelRate is $/MILLION tokens. The conversion happens in
// exactly one place (`perMillion`, feed.ts). Layering: RATE_CARD above holds vendor-verified direct
// rates and keeps priority for every key/normalization it already resolved; the snapshot adds the
// ~470 OpenRouter ids that previously priced as null. A model's `pricing.overrides` (time-of-day
// pricing) is deliberately NOT applied — only the base prompt/completion/cache fields are.
const SNAPSHOT = OPENROUTER_SNAPSHOT;

/** Provenance of the committed OpenRouter snapshot (source URL + fetch timestamp). */
export const PRICING_SNAPSHOT_META: { source: string; fetchedAt: string; modelCount: number } = {
  source: SNAPSHOT.source,
  fetchedAt: SNAPSHOT.fetched_at,
  modelCount: SNAPSHOT.models.length,
};

const PARSED_SNAPSHOT: IParsedFeed = parseOpenRouterFeed(SNAPSHOT);

/**
 * The committed snapshot parsed through the same validator as a live pull, for seeding a
 * price-history store (`source:'bundled'`, observed at `fetchedAt`).
 */
export function parseBundledSnapshot(): { fetchedAt: string; source: string } & IParsedFeed {
  return {
    fetchedAt: SNAPSHOT.fetched_at,
    source: SNAPSHOT.source,
    models: PARSED_SNAPSHOT.models.map((m) => ({ ...m })),
    invalid: [...PARSED_SNAPSHOT.invalid],
  };
}

/** Routers (`-1`) are "unknown", never a rate: they are absent from this map. */
const OPENROUTER_RATES: ReadonlyMap<string, ModelRate> = new Map(
  PARSED_SNAPSHOT.models.flatMap((m): Array<[string, ModelRate]> =>
    m.kind === 'model' && m.inputPerM !== null && m.outputPerM !== null
      ? [[m.modelId, {
          inputPerM: m.inputPerM,
          // No published cache-read price => cache hits bill as ordinary input.
          cacheReadPerM: m.cacheReadPerM ?? m.inputPerM,
          cacheWritePerM: m.cacheWritePerM ?? 0,
          ...(m.cacheWrite1hPerM != null ? { cacheWrite1hPerM: m.cacheWrite1hPerM } : {}),
          outputPerM: m.outputPerM,
        }]]
      : []
  )
);

export interface IProviderModelAlias {
  /** OpenRouter id the provider-side name is priced as. */
  target: string;
  /** Always `owner-assumption`: an alias is a decision, not evidence. */
  basis: 'owner-assumption';
  /** Date (YYYY-MM-DD) the owner set it. */
  setAt: string;
  setBy: string;
  /** Backlog ticket that recorded the decision. */
  ticket: string;
}

/**
 * Explicit provider-model-name -> OpenRouter id aliases. OpenRouter ids are the canonical
 * "true" model names for pricing.
 *
 * The anthropic and openai adapters capture the response `model` field as `responseModel` in the
 * hook payload and `task_usage`, but `estimateCost` receives only the CONFIGURED model name. The
 * alias therefore ALWAYS applies: every call is priced from the configured model (through this
 * alias when one exists), whether or not a response model was reported. `responseModel` is
 * recorded for grouping and provenance only and never changes the price. Pricing off
 * `responseModel` when present is an open owner decision, not current behavior.
 *
 * `deepseek-flash` (what the sox agents are configured with; provider type `openai`, DeepSeek
 * secret) -> `deepseek/deepseek-v4.1-flash`. OWNER-DIRECTED ASSUMPTION (2026-10-08, ticket
 * 37f6c511): the owner decided DeepSeek-direct `deepseek-flash` traffic is V4.1 Flash. It is NOT
 * evidence-derived for legacy rows: they carry no response model, so nothing persisted pins which
 * revision served those calls. Other candidates considered, base prompt/completion $/token:
 * `~deepseek/deepseek-flash-latest` (2.83e-8/1.2e-6), `deepseek/deepseek-v4-flash`
 * (9.9e-9/1.28e-6), `deepseek/deepseek-v4-flash-0731` (1.8e-8/1.28e-6).
 */
export const PROVIDER_MODEL_ALIASES: Readonly<Record<string, IProviderModelAlias>> = {
  'deepseek-flash': {
    target: 'deepseek/deepseek-v4.1-flash',
    basis: 'owner-assumption',
    setAt: '2026-10-08',
    setBy: 'owner',
    ticket: '37f6c511',
  },
};

/** Own-property check (target lib predates `Object.hasOwn`); guards `toString`-style prototype keys. */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function aliasFor(model: string): IProviderModelAlias | undefined {
  const key = model.trim().toLowerCase();
  return hasOwn(PROVIDER_MODEL_ALIASES, key) ? PROVIDER_MODEL_ALIASES[key] : undefined;
}

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

/** Latest-possible instant, used when a caller supplies a source but no `asOf`. */
const FAR_FUTURE_ISO = '9999-12-31T23:59:59.999Z';

/**
 * Cost of one usage. Cache-write tokens split by TTL tier (b726a987): the 1-hour subset
 * (`cacheCreation1hTokens`, clamped to `[0, cacheCreationTokens]`) bills at `cacheWrite1hPerM`,
 * falling back to the 5-minute `cacheWritePerM` when the model publishes no 1h rate; the rest
 * bills at `cacheWritePerM`. Unsplit usage (no `cacheCreation1hTokens`) is all 5-minute.
 */
function costOf(rate: ModelRate, usage: IUsageTokens): number {
  const write1h = Math.min(Math.max(usage.cacheCreation1hTokens ?? 0, 0), usage.cacheCreationTokens);
  const write5m = usage.cacheCreationTokens - write1h;
  return (
    (usage.uncachedInputTokens * rate.inputPerM +
      usage.cacheReadTokens * rate.cacheReadPerM +
      write5m * rate.cacheWritePerM +
      write1h * (rate.cacheWrite1hPerM ?? rate.cacheWritePerM) +
      usage.outputTokens * rate.outputPerM) /
    1_000_000
  );
}

const UNPRICED: ICostEstimate = {
  costUsd: null,
  status: 'unpriced_model',
  basis: null,
  pricingRef: null,
  resolvedId: null,
};

function priced(rate: ModelRate, usage: IUsageTokens, basis: CostBasis, pricingRef: string, resolvedId: string): ICostEstimate {
  return { costUsd: costOf(rate, usage), status: 'priced', basis, pricingRef, resolvedId };
}

function rateCardKey(model: string): string | undefined {
  if (hasOwn(RATE_CARD, model)) return model;
  for (const candidate of normalizeModelKeyCandidates(model)) {
    if (hasOwn(RATE_CARD, candidate)) return candidate;
  }
  return undefined;
}

/**
 * Estimate the dollar cost of one model call (or a pre-summed rollup — cost is linear) AND say
 * how it was derived (1f1c8598). Pure: no clock, no I/O.
 *
 * Resolution order (unchanged from `estimateCostUsd`): exact RATE_CARD key (`vendor-direct`) >
 * OpenRouter lookup (alias hit => `owner-assumption`, plain id => `openrouter-estimate`) >
 * normalised RATE_CARD candidates (`vendor-direct`) > family alias (`vendor-direct`) > unpriced.
 *
 * With `opts.source`, the OpenRouter step asks `source.priceAt(id, asOf)` first (`asOf` defaults
 * to "latest") and falls back to the bundled snapshot only when the source returns `undefined`.
 * A source record of `kind:'router'` (or with null input/output rates) is final: unpriced, it
 * never falls through to the bundled map or later steps.
 *
 * Unpriced => `costUsd: null` (never 0), `status:'unpriced_model'`.
 *
 * `opts.strict` (79aebb26 BK8) disables the family-alias step: use it when `model` is a CONCRETE id the
 * provider reported (e.g. claudecli's `claude-haiku-5-5`). A concrete id that has no rate card must be
 * unpriced, never priced at the newest known model of the same family (that is how `claude-haiku-5-5` was
 * silently priced at haiku-4-5's rate). Human-typed aliases ("haiku", "sonnet") keep the non-strict fallback.
 */
export function estimateCost(
  model: string,
  usage: IUsageTokens,
  opts?: { asOf?: string; source?: IPriceSource; strict?: boolean }
): ICostEstimate {
  if (hasOwn(RATE_CARD, model)) {
    return priced(RATE_CARD[model] as ModelRate, usage, 'vendor-direct', `rate-card:${model}`, model);
  }

  const alias = aliasFor(model);
  const orId = (alias?.target ?? model).trim().toLowerCase();
  const orBasis: CostBasis = alias ? alias.basis : 'openrouter-estimate';
  if (opts?.source) {
    const rec = opts.source.priceAt(orId, opts.asOf ?? FAR_FUTURE_ISO);
    if (rec) {
      if (rec.kind === 'router' || rec.inputPerM === null || rec.outputPerM === null) return UNPRICED;
      return priced(
        {
          inputPerM: rec.inputPerM,
          cacheReadPerM: rec.cacheReadPerM ?? rec.inputPerM,
          cacheWritePerM: rec.cacheWritePerM ?? 0,
          ...(rec.cacheWrite1hPerM != null ? { cacheWrite1hPerM: rec.cacheWrite1hPerM } : {}),
          outputPerM: rec.outputPerM,
        },
        usage, orBasis, rec.id, orId
      );
    }
  }
  const bundled = OPENROUTER_RATES.get(orId);
  if (bundled) {
    return priced(bundled, usage, orBasis, `bundled:${SNAPSHOT.fetched_at}:${orId}`, orId);
  }

  // A full OpenRouter id ("deepseek/deepseek-v4.1-flash") is priced above before the
  // org-prefix-stripping normalization below would collapse it onto a different (bare) key.
  const key = rateCardKey(model);
  if (key !== undefined) {
    return priced(RATE_CARD[key] as ModelRate, usage, 'vendor-direct', `rate-card:${key}`, key);
  }
  if (opts?.strict) return UNPRICED;
  const tokens = model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const [family, canonicalKey] of Object.entries(FAMILY_ALIASES)) {
    if (tokens.includes(family)) {
      return priced(RATE_CARD[canonicalKey] as ModelRate, usage, 'vendor-direct', `rate-card:${canonicalKey}`, canonicalKey);
    }
  }
  return UNPRICED;
}

/**
 * Estimate dollar cost for one model call (or a cumulative rollup). Thin wrapper over
 * {@link estimateCost} returning only the number: `null` (never 0) when the model has no rate
 * (even after normalization) — an unknown model's cost must never be silently reported as $0.
 * With no `opts` the result is identical to the pre-1f1c8598 behaviour.
 */
export function estimateCostUsd(
  model: string,
  usage: IUsageTokens,
  opts?: { asOf?: string; source?: IPriceSource }
): number | null {
  return estimateCost(model, usage, opts).costUsd;
}
