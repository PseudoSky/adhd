/**
 * 37f6c511 — `pricing_refresh` and `pricing_history` MCP tools (pure handlers + zod schemas).
 * Registered by `server.ts` in both the in-process descriptor list and the MCP tool list.
 */
import { z } from 'zod';

import { PRICE_ANOMALY_THRESHOLDS, type IPullResult } from './pull.js';
import type { IPricingService } from './service.js';

const isoInstant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 timestamp' });

export const pricingRefreshInputSchema = z.object({
  accept: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'OpenRouter model ids whose HELD price move (>= 20x, or input > $1000/M) should be applied by this pull.'
    ),
});

/**
 * Input of the IN-PROCESS (sub-agent) `pricing_refresh`: deliberately has NO `accept`. Releasing a
 * held >= 20x anomaly is an operator decision and is only available on the top-level host tool.
 * Strict, so a sub-agent passing `accept` gets a validation error instead of a silent no-op.
 */
export const pricingRefreshInProcessInputSchema = z.object({}).strict();

export const pricingHistoryInputSchema = z.object({
  model: z.string().min(1).describe('OpenRouter model id, e.g. "deepseek/deepseek-v4.1-flash" (case-insensitive).'),
  from: isoInstant.optional().describe('Inclusive ISO-8601 lower bound on observed_at.'),
  to: isoInstant.optional().describe('Inclusive ISO-8601 upper bound on observed_at.'),
});

export const PRICING_REFRESH_DESCRIPTION =
  'Pull live model prices from https://openrouter.ai/api/v1/models now (public feed, no API key), bypassing the 24h schedule. ' +
  'Appends a price-history row only for models whose price changed; a failed or rejected pull changes nothing and last good prices keep serving. ' +
  `Forced pulls are limited to one per 10 minutes. A price move of >= ${PRICE_ANOMALY_THRESHOLDS.holdFactor}x (or input > $${PRICE_ANOMALY_THRESHOLDS.maxInputPerM}/M) is HELD and reported in anomalies; pass accept:[modelId] on the next refresh to apply it. ` +
  'Returns {status, ledger_id, fetched_at, models, new, changed, unchanged, anomalies, duration_ms, error?}.';

/** Sub-agent variant: no `accept` (an operator releases held prices from the top-level tool). */
export const PRICING_REFRESH_IN_PROCESS_DESCRIPTION =
  'Pull live model prices from https://openrouter.ai/api/v1/models now (public feed, no API key), bypassing the 24h schedule (at most one forced pull per 10 minutes). ' +
  `Appends a price-history row only for models whose price changed; a failed or rejected pull changes nothing. A price move of >= ${PRICE_ANOMALY_THRESHOLDS.holdFactor}x is HELD and reported in anomalies; releasing a held price is an operator action and is not available here.`;

export const PRICING_HISTORY_DESCRIPTION =
  'Observed price series for one model (observed_at order, $ per million tokens) with source and ledger_id, plus pull status ' +
  '{last_ok, last_failed, price_age_hours, next_scheduled}. Prices are as OBSERVED by this server, so the accuracy bound is the pull cadence (24h).';

/** `pricing_refresh` result in the tool's snake_case wire shape. */
export function pricingRefresh(
  input: z.infer<typeof pricingRefreshInputSchema>,
  service: Pick<IPricingService, 'refresh'>
): Promise<Record<string, unknown>> {
  return service.refresh(input.accept).then(toRefreshWire);
}

/** In-process (sub-agent) `pricing_refresh`: never forwards `accept`; rejects it at validation. */
export async function pricingRefreshInProcess(
  args: unknown,
  service: Pick<IPricingService, 'refresh'>
): Promise<Record<string, unknown>> {
  pricingRefreshInProcessInputSchema.parse(args ?? {});
  return toRefreshWire(await service.refresh(undefined));
}

function toRefreshWire(r: IPullResult): Record<string, unknown> {
  return {
    status: r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    ledger_id: r.ledgerId ?? null,
    fetched_at: r.fetchedAt ?? null,
    models: r.models,
    new: r.new,
    changed: r.changed,
    unchanged: r.unchanged,
    anomalies: r.anomalies,
    duration_ms: r.durationMs,
    ...(r.httpStatus !== undefined ? { http_status: r.httpStatus } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

type LedgerWire = {
  ledger_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  http_status: number | null;
  models_seen: number | null;
  error: string | null;
} | null;

function ledgerWire(
  r: { id: string; status: string; startedAt: string; finishedAt: string | null; httpStatus: number | null; modelsSeen: number | null; error: string | null } | undefined
): LedgerWire {
  return r
    ? {
        ledger_id: r.id,
        status: r.status,
        started_at: r.startedAt,
        finished_at: r.finishedAt,
        http_status: r.httpStatus,
        models_seen: r.modelsSeen,
        error: r.error,
      }
    : null;
}

/** `pricing_history` result: the observed series plus pull status. Pure read. */
export function pricingHistory(
  input: z.infer<typeof pricingHistoryInputSchema>,
  service: Pick<IPricingService, 'store' | 'now' | 'nextScheduled'>
): Record<string, unknown> {
  const rows = service.store.history(input.model, input.from, input.to);
  const ledger = service.store.lastLedger(service.now());
  return {
    model: input.model.toLowerCase(),
    unit: 'usd_per_million_tokens',
    rows: rows.map((r) => ({
      id: r.id,
      observed_at: r.observedAt,
      source: r.source,
      ledger_id: r.ledgerId,
      kind: r.kind,
      input_per_m: r.inputPerM,
      cache_read_per_m: r.cacheReadPerM,
      cache_write_per_m: r.cacheWritePerM,
      cache_write_1h_per_m: r.cacheWrite1hPerM,
      output_per_m: r.outputPerM,
      overrides_json: r.overridesJson,
    })),
    status: {
      last_ok: ledgerWire(ledger.lastOk),
      last_failed: ledgerWire(ledger.lastFailed),
      price_age_hours: ledger.priceAgeHours,
      next_scheduled: service.nextScheduled(),
      anomaly_thresholds: PRICE_ANOMALY_THRESHOLDS,
    },
  };
}
