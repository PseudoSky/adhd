/** Ticket 5e72d493 (PF-1) — covers 5e72d493 AC3. */
import { describe, it, expect } from 'vitest';
import {
  parseRetryAfter,
  capRetryWaitMs,
  exceedsRetryWaitCap,
  RETRY_AFTER_WAIT_CAP_MS,
  classifyProviderError,
} from '../../failure/index.js';
import { NOW, anthropicBody, raw } from './helpers.js';

const httpDate = (offsetMs: number) => new Date(NOW + offsetMs).toUTCString();

/** Naive parser with no HTTP-date branch: the AC3 negative control. */
function naive(h: Record<string, string>, now: number) {
  const p = parseRetryAfter(h, now);
  return p.source === 'retry-after-date' ? {} : p;
}

describe('5e72d493 AC3 - retry-after parse order', () => {
  const assertAC3 = (parse: (h: Record<string, string>, now: number) => { retryAfterMs?: number }) => {
    expect(parse({ 'retry-after': httpDate(7_000) }, NOW).retryAfterMs).toBe(7_000);
  };
  it('parses an HTTP-date retry-after as max(0, date-now)', () => {
    assertAC3(parseRetryAfter);
    expect(parseRetryAfter({ 'retry-after': httpDate(-5_000) }, NOW).retryAfterMs).toBe(0);
    expect(parseRetryAfter({ 'retry-after': httpDate(7_000) }, NOW).source).toBe('retry-after-date');
  });
  it('NC: dropping the HTTP-date branch goes RED on the same assertion', () => {
    expect(() => assertAC3(naive)).toThrow();
  });
  it('order: retry-after-ms beats retry-after seconds beats HTTP-date beats reset hints', () => {
    const all = { 'retry-after-ms': '1500', 'retry-after': '9', 'x-ratelimit-reset-requests': '20s' };
    expect(parseRetryAfter(all, NOW)).toEqual({ retryAfterMs: 1500, source: 'retry-after-ms' });
    expect(parseRetryAfter({ 'retry-after': '9', 'x-ratelimit-reset-requests': '20s' }, NOW)).toEqual({ retryAfterMs: 9000, source: 'retry-after' });
    expect(parseRetryAfter({ 'retry-after': httpDate(3000), 'x-ratelimit-reset-requests': '20s' }, NOW).source).toBe('retry-after-date');
    expect(parseRetryAfter({ 'x-ratelimit-reset-requests': '20s' }, NOW)).toEqual({ retryAfterMs: 20_000, source: 'reset-hint' });
  });
  it('seconds may be fractional; header names are case-insensitive', () => {
    expect(parseRetryAfter({ 'Retry-After': '1.5' }, NOW).retryAfterMs).toBe(1500);
    expect(parseRetryAfter({ 'RETRY-AFTER-MS': '40' }, NOW).retryAfterMs).toBe(40);
  });
  it('reset hints: Go durations, RFC3339 anthropic resets; soonest wins', () => {
    expect(parseRetryAfter({ 'x-ratelimit-reset-tokens': '6m0s' }, NOW).retryAfterMs).toBe(360_000);
    expect(parseRetryAfter({ 'x-ratelimit-reset-requests': '20ms' }, NOW).retryAfterMs).toBe(20);
    const iso = (o: number) => new Date(NOW + o).toISOString();
    expect(
      parseRetryAfter({ 'anthropic-ratelimit-tokens-reset': iso(30_000), 'anthropic-ratelimit-requests-reset': iso(10_000) }, NOW).retryAfterMs
    ).toBe(10_000);
  });
  it('x-should-retry:false is surfaced alongside any wait, and the classifier honours it', () => {
    expect(parseRetryAfter({ 'x-should-retry': 'false', 'retry-after': '2' }, NOW)).toEqual({ shouldRetry: false, retryAfterMs: 2000, source: 'retry-after' });
    expect(parseRetryAfter({ 'x-should-retry': 'true' }, NOW)).toEqual({});
    const f = classifyProviderError(raw('anthropic', { status: 429, headers: { 'x-should-retry': 'false' }, body: anthropicBody('rate_limit_error', 'r') }));
    expect(f.class).toBe('rate_limited');
    expect(f.retryable).toBe(false);
  });
  it('raw values above the 60s cap are preserved; the wait is capped and flagged exhausted', () => {
    const p = parseRetryAfter({ 'retry-after': '3600' }, NOW);
    expect(p.retryAfterMs).toBe(3_600_000);
    expect(capRetryWaitMs(3_600_000)).toBe(RETRY_AFTER_WAIT_CAP_MS);
    expect(RETRY_AFTER_WAIT_CAP_MS).toBe(60_000);
    expect(exceedsRetryWaitCap(3_600_000)).toBe(true);
    expect(exceedsRetryWaitCap(60_000)).toBe(false);
    expect(exceedsRetryWaitCap(undefined)).toBe(false);
    expect(capRetryWaitMs(-5)).toBe(0);
    const f = classifyProviderError(raw('anthropic', { status: 429, headers: { 'retry-after': '3600' }, body: anthropicBody('rate_limit_error', 'r') }));
    expect(f.retryAfterMs).toBe(3_600_000);
  });
  it('is total on garbage', () => {
    for (const h of [undefined, {}, { 'retry-after': 'soon' }, { 'retry-after': '-3' }, { 'retry-after-ms': 'NaN' }, { 'retry-after': ['4', '5'] }, null as never]) {
      expect(() => parseRetryAfter(h as never, NOW)).not.toThrow();
    }
    expect(parseRetryAfter({ 'retry-after': '-3' }, NOW)).toEqual({});
    expect(parseRetryAfter({ 'retry-after': ['4', '5'] }, NOW).retryAfterMs).toBe(4000);
  });
});
