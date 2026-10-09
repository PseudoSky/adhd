/**
 * 37f6c511 — OpenRouter `/api/v1/models` feed parsing and validation. Pure: takes parsed JSON,
 * returns normalised rows. This is the ONLY place per-token strings become $/million numbers.
 */

/** $/token (decimal string or already-numeric) -> $/million tokens, cleaned of binary float noise. NaN when absent/invalid. */
export function perMillion(perToken: string | number | undefined): number {
  if (perToken === undefined) return Number.NaN;
  return Number((Number(perToken) * 1_000_000).toPrecision(12));
}

/** One validated model from a feed, shaped to be insertable as a price-history row. */
export interface IParsedModel {
  /** Lowercased OpenRouter id. */
  modelId: string;
  /** `router` when the feed serves a `-1` prompt price (no fixed price); rates are then all null. */
  kind: 'model' | 'router';
  inputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
  /** `input_cache_write_1h` ($/M); null when the feed does not publish a 1-hour tier. (b726a987) */
  cacheWrite1hPerM?: number | null;
  outputPerM: number | null;
  /** Verbatim JSON of the model's `pricing` object minus `overrides` (float-dispute defence). */
  rawJson: string;
  /** Verbatim JSON of `pricing.overrides`, or null when absent. Stored, never applied. */
  overridesJson: string | null;
}

/** Outcome of {@link parseOpenRouterFeed}. Any `invalid` entry means the whole pull must be rejected. */
export interface IParsedFeed {
  models: IParsedModel[];
  /** Human-readable reasons, one per rejected model or structural problem. */
  invalid: string[];
}

type PriceField = 'prompt' | 'completion' | 'input_cache_read' | 'input_cache_write' | 'input_cache_write_1h';

/** undefined = absent; NaN = present but not a finite number. */
function readPerToken(pricing: Record<string, unknown>, field: PriceField): number | undefined {
  const v = pricing[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v !== 'string' || v.trim() === '') return Number.NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Parse and validate a decoded OpenRouter models feed.
 *
 * - Router (`prompt === -1`): `kind:'router'`, every rate null.
 * - Otherwise `prompt` and `completion` must be finite and >= 0; cache fields, when present,
 *   must be finite and >= 0 (absent => null). Free (0) is a real price, distinct from null.
 * - A malformed shape or any invalid model is reported in `invalid` (never thrown), so the
 *   caller can reject the whole pull atomically.
 */
export function parseOpenRouterFeed(json: unknown): IParsedFeed {
  const models: IParsedModel[] = [];
  const invalid: string[] = [];
  // OpenRouter's live endpoint wraps the list as {data:[...]}; the committed snapshot uses {models:[...]}.
  const root = (typeof json === 'object' && json !== null ? json : {}) as { data?: unknown; models?: unknown };
  const list = Array.isArray(root.data) ? root.data : root.models;
  if (!Array.isArray(list)) {
    return { models, invalid: ['feed: expected an object with a "data" or "models" array'] };
  }
  for (const entry of list as unknown[]) {
    const e = entry as { id?: unknown; pricing?: unknown } | null;
    const id = e !== null && typeof e === 'object' && typeof e.id === 'string' ? e.id.trim() : '';
    if (id === '') {
      invalid.push('model: missing string id');
      continue;
    }
    const pricing = e?.pricing;
    if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing)) {
      invalid.push(`${id}: missing pricing object`);
      continue;
    }
    const p = pricing as Record<string, unknown>;
    const { overrides, ...base } = p;
    const rawJson = JSON.stringify(base);
    const overridesJson = overrides === undefined ? null : JSON.stringify(overrides);
    const modelId = id.toLowerCase();

    const prompt = readPerToken(p, 'prompt');
    const completion = readPerToken(p, 'completion');
    if (prompt === -1) {
      models.push({
        modelId, kind: 'router', inputPerM: null, cacheReadPerM: null, cacheWritePerM: null,
        outputPerM: null, rawJson, overridesJson,
      });
      continue;
    }
    const cacheRead = readPerToken(p, 'input_cache_read');
    const cacheWrite = readPerToken(p, 'input_cache_write');
    const cacheWrite1h = readPerToken(p, 'input_cache_write_1h');
    const bad: string[] = [];
    const check = (name: string, v: number | undefined, required: boolean): void => {
      if (v === undefined) {
        if (required) bad.push(`${name} missing`);
      } else if (!(v >= 0)) {
        bad.push(`${name}=${String(p[name])}`);
      }
    };
    check('prompt', prompt, true);
    check('completion', completion, true);
    check('input_cache_read', cacheRead, false);
    check('input_cache_write', cacheWrite, false);
    check('input_cache_write_1h', cacheWrite1h, false);
    if (bad.length > 0) {
      invalid.push(`${id}: invalid price (${bad.join(', ')})`);
      continue;
    }
    models.push({
      modelId,
      kind: 'model',
      inputPerM: perMillion(prompt as number),
      cacheReadPerM: cacheRead === undefined ? null : perMillion(cacheRead),
      cacheWritePerM: cacheWrite === undefined ? null : perMillion(cacheWrite),
      cacheWrite1hPerM: cacheWrite1h === undefined ? null : perMillion(cacheWrite1h),
      outputPerM: perMillion(completion as number),
      rawJson,
      overridesJson,
    });
  }
  return { models, invalid };
}
