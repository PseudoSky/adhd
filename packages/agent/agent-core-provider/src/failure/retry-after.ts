/**
 * Retry-After parsing (docs/plan/provider-failure/SPEC.md §2.3). Pure.
 *
 * Order: `x-should-retry` (false => not retryable) -> `retry-after-ms` ->
 * `retry-after` seconds (float) -> `retry-after` HTTP-date (`max(0, date-now)`) ->
 * provider reset headers (hint) -> none.
 *
 * The value is a FLOOR for the wait. The raw value is preserved uncapped so a
 * root can report "retry at T"; callers cap the actual wait with
 * {@link capRetryWaitMs}.
 */

/** Longest a single retry sleep will honour a provider hint; above this the call is exhausted. */
export const RETRY_AFTER_WAIT_CAP_MS = 60_000;

export type RetryHeaders = Readonly<Record<string, string | readonly string[] | number | undefined | null>>;

export type RetryAfterSource =
  | 'retry-after-ms'
  | 'retry-after'
  | 'retry-after-date'
  | 'reset-hint';

export interface ParsedRetryAfter {
  /** Raw, uncapped, `>= 0`; absent when no usable header was present. */
  retryAfterMs?: number;
  /** `false` when the provider sent `x-should-retry: false`. */
  shouldRetry?: false;
  source?: RetryAfterSource;
}

function header(headers: RetryHeaders | undefined, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== want) continue;
    const v = headers[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (s === undefined || s === null) return undefined;
    return String(s).trim();
  }
  return undefined;
}

const NUMERIC = /^\d+(?:\.\d+)?$/;

/** Date.parse accepts bare numbers ("-3" is a year); a real HTTP-date / RFC3339 always has letters. */
function parseDate(v: string): number {
  return /[A-Za-z]/.test(v) ? Date.parse(v) : NaN;
}

/** `"1.5"` -> 1500; undefined for anything that is not a plain non-negative number. */
function seconds(v: string | undefined): number | undefined {
  if (v === undefined || !NUMERIC.test(v)) return undefined;
  const n = Number(v) * 1000;
  return Number.isFinite(n) ? n : undefined;
}

function millis(v: string | undefined): number | undefined {
  if (v === undefined || !NUMERIC.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** OpenAI-style durations: `1s`, `6m0s`, `20ms`, `1h2m3.5s`. */
function goDuration(v: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const m of v.matchAll(re)) {
    const n = Number(m[1]);
    total += n * DURATION_UNIT_MS[m[2]];
    consumed += m[0].length;
  }
  return consumed > 0 && consumed === v.length && Number.isFinite(total) ? total : undefined;
}

const RESET_HEADERS = [
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-reset',
] as const;

function resetHint(headers: RetryHeaders | undefined, nowMs: number): number | undefined {
  const found: number[] = [];
  for (const name of RESET_HEADERS) {
    const v = header(headers, name);
    if (v === undefined) continue;
    const dur = goDuration(v);
    if (dur !== undefined) {
      found.push(dur);
      continue;
    }
    const t = parseDate(v);
    if (!Number.isNaN(t)) found.push(Math.max(0, t - nowMs));
  }
  // Hint only: the soonest bucket reset is the earliest a retry could plausibly pass.
  return found.length ? Math.min(...found) : undefined;
}

/** Parse the provider's retry hints. Total: never throws. */
export function parseRetryAfter(
  headers: RetryHeaders | undefined,
  nowMs: number = Date.now()
): ParsedRetryAfter {
  const out: ParsedRetryAfter = {};
  try {
    if (header(headers, 'x-should-retry')?.toLowerCase() === 'false') out.shouldRetry = false;

    const ms = millis(header(headers, 'retry-after-ms'));
    if (ms !== undefined) return { ...out, retryAfterMs: ms, source: 'retry-after-ms' };

    const ra = header(headers, 'retry-after');
    const secs = seconds(ra);
    if (secs !== undefined) return { ...out, retryAfterMs: secs, source: 'retry-after' };
    if (ra !== undefined) {
      const t = parseDate(ra);
      if (!Number.isNaN(t)) {
        return { ...out, retryAfterMs: Math.max(0, t - nowMs), source: 'retry-after-date' };
      }
    }

    const hint = resetHint(headers, nowMs);
    if (hint !== undefined) return { ...out, retryAfterMs: hint, source: 'reset-hint' };
  } catch {
    // total by contract
  }
  return out;
}

/** The wait actually slept: the raw hint capped at {@link RETRY_AFTER_WAIT_CAP_MS}. */
export function capRetryWaitMs(rawMs: number): number {
  return Math.min(Math.max(0, rawMs), RETRY_AFTER_WAIT_CAP_MS);
}

/** True when the raw hint is longer than the wait cap (SPEC §2.1: exhausted, fail over at once). */
export function exceedsRetryWaitCap(rawMs: number | undefined): boolean {
  return rawMs !== undefined && rawMs > RETRY_AFTER_WAIT_CAP_MS;
}
