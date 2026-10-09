/**
 * 1f1c8598 / 37f6c511 — pure pricing contracts. No DB, no clock, no network: a store package
 * implements {@link IPriceSource} structurally and `estimateCost` consumes it.
 */

/** Which price list a cost was derived from. */
export type CostBasis = 'vendor-direct' | 'openrouter-estimate' | 'owner-assumption';

/** Per-row cost status persisted by consumers (`partial` = some turns priced, some not). */
export type CostStatus = 'priced' | 'unpriced_model' | 'partial';

/** Token counts for one call (or a pre-summed rollup; cost is linear). */
export interface IUsageTokens {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

/** One observed price record for a model (a history row, or a bundled-snapshot row). */
export interface IPriceRecord {
  /** History row id, or `bundled:<fetchedAt>:<modelId>`. */
  id: string;
  /** Lowercased OpenRouter id. */
  modelId: string;
  /** ISO-8601 UTC instant this price was observed. */
  observedAt: string;
  /** `router` => rates are null => unpriced. */
  kind: 'model' | 'router';
  /** $ per million tokens; null = absent. 0 is a real free price. */
  inputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
  outputPerM: number | null;
  source: 'bundled' | 'openrouter-live';
  /** True when the instant predates our first observation and the earliest row was used. */
  beforeFirstObservation?: boolean;
}

/** As-of price lookup. Implemented by the runtime store; core-provider never imports it. */
export interface IPriceSource {
  /** Price record in force for `modelId` at `instantIso`, or undefined if the model was never observed. */
  priceAt(modelId: string, instantIso: string): IPriceRecord | undefined;
}

/** Result of {@link estimateCost}: the cost plus how it was derived. */
export interface ICostEstimate {
  /** null (never 0) when unpriced. */
  costUsd: number | null;
  status: 'priced' | 'unpriced_model';
  basis: CostBasis | null;
  /** `rate-card:<key>` | history row id | `bundled:<fetchedAt>:<id>`; null when unpriced. */
  pricingRef: string | null;
  resolvedId: string | null;
}
