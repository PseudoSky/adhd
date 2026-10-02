import { describe, it, expect, vi } from 'vitest';
import type { QueryExpression } from '../index';
import { DataView, resolveIsoPeriod, isCalendarPeriod } from '../index';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Build the `[duration, anchor]` tuple the `_period` operator accepts. */
const at = (duration: string, anchorMs: number): [string, number] => [duration, anchorMs];
const iso = (ms: number): string => new Date(ms).toISOString();

const MAR_31_2026 = Date.UTC(2026, 2, 31); // 2026-03-31T00:00:00Z
const MAR_31_2026_NOON = Date.UTC(2026, 2, 31, 12); // 2026-03-31T12:00:00Z

const ids = (rows: Array<Record<string, unknown>>, query: QueryExpression): string[] =>
  new DataView(rows, query)
    .view()
    .map((r) => (r as { id: string }).id);

describe('resolveIsoPeriod — fixed (non-calendar) durations', () => {
  it('P1D is exactly 24h', () => {
    const b = resolveIsoPeriod('P1D', MAR_31_2026);
    expect(iso(b.from)).toBe('2026-03-30T00:00:00.000Z');
    expect(b.durationMs).toBe(DAY);
  });

  it('PT1H is exactly 1h', () => {
    const b = resolveIsoPeriod('PT1H', MAR_31_2026);
    expect(iso(b.from)).toBe('2026-03-30T23:00:00.000Z');
    expect(b.durationMs).toBe(HOUR);
  });

  it('resolves the dashboard duration set', () => {
    expect(resolveIsoPeriod('PT3H', MAR_31_2026).durationMs).toBe(3 * HOUR);
    expect(resolveIsoPeriod('PT12H', MAR_31_2026).durationMs).toBe(12 * HOUR);
    expect(resolveIsoPeriod('P7D', MAR_31_2026).durationMs).toBe(7 * DAY);
    expect(resolveIsoPeriod('P30D', MAR_31_2026).durationMs).toBe(30 * DAY);
    expect(resolveIsoPeriod('P90D', MAR_31_2026).durationMs).toBe(90 * DAY);
    expect(resolveIsoPeriod('P1W', MAR_31_2026).durationMs).toBe(7 * DAY);
    expect(resolveIsoPeriod('PT30M', MAR_31_2026).durationMs).toBe(1_800_000);
  });
});

describe('resolveIsoPeriod — P1M is a CALENDAR month, not 30 days', () => {
  it('from 2026-03-31 lands on the previous month’s last day (2026-02-28), spanning 31 days', () => {
    const b = resolveIsoPeriod('P1M', MAR_31_2026);
    expect(iso(b.from)).toBe('2026-02-28T00:00:00.000Z');
    expect(b.durationMs).toBe(31 * DAY); // March has 31 days
  });

  it('is provably NOT P30D: same anchor, different bound and length', () => {
    const month = resolveIsoPeriod('P1M', MAR_31_2026);
    const thirty = resolveIsoPeriod('P30D', MAR_31_2026);
    expect(iso(thirty.from)).toBe('2026-03-01T00:00:00.000Z');
    expect(month.from).not.toBe(thirty.from);
    expect(month.durationMs).toBe(31 * DAY);
    expect(thirty.durationMs).toBe(30 * DAY);
  });

  it('its length VARIES with the anchor month (28-day Feb proof)', () => {
    // Anchor on the last day of the 28-day February: -1M clamps to 2026-01-28.
    const fromFeb = resolveIsoPeriod('P1M', Date.UTC(2026, 1, 28));
    expect(iso(fromFeb.from)).toBe('2026-01-28T00:00:00.000Z');
    expect(fromFeb.durationMs).toBe(31 * DAY); // January has 31 days
    // Anchor 2026-04-30: -1M -> 2026-03-30 (March has 31 days).
    const fromApr = resolveIsoPeriod('P1M', Date.UTC(2026, 3, 30));
    expect(iso(fromApr.from)).toBe('2026-03-30T00:00:00.000Z');
    // 28 vs 31: the two month windows are NOT the same length.
    expect(resolveIsoPeriod('P1M', Date.UTC(2026, 1, 1)).durationMs).toBe(31 * DAY);
    expect(resolveIsoPeriod('P1M', Date.UTC(2026, 2, 1)).durationMs).toBe(28 * DAY);
  });

  it('P1Y subtracts a calendar year', () => {
    const b = resolveIsoPeriod('P1Y', MAR_31_2026);
    expect(iso(b.from)).toBe('2025-03-31T00:00:00.000Z');
    expect(b.durationMs).toBe(365 * DAY);
  });
});

describe('isCalendarPeriod', () => {
  it('is true only when the duration carries a Y or M date component', () => {
    expect(isCalendarPeriod('P1M')).toBe(true);
    expect(isCalendarPeriod('P1Y')).toBe(true);
    expect(isCalendarPeriod('P1Y2M')).toBe(true);
    expect(isCalendarPeriod('P1M15D')).toBe(true);
    expect(isCalendarPeriod('P30D')).toBe(false);
    expect(isCalendarPeriod('P1W')).toBe(false);
    expect(isCalendarPeriod('PT1H')).toBe(false);
    expect(isCalendarPeriod('P1DT2H')).toBe(false);
  });
});

describe('resolveIsoPeriod — invalid input', () => {
  it('throws on non-ISO / empty durations', () => {
    expect(() => resolveIsoPeriod('30days', MAR_31_2026)).toThrow(TypeError);
    expect(() => resolveIsoPeriod('', MAR_31_2026)).toThrow(TypeError);
    expect(() => resolveIsoPeriod('P', MAR_31_2026)).toThrow(TypeError);
    expect(() => resolveIsoPeriod('PT', MAR_31_2026)).toThrow(TypeError);
  });

  it('throws on a non-finite anchor', () => {
    expect(() => resolveIsoPeriod('P1D', Number.NaN)).toThrow(TypeError);
  });
});

describe('_period where-operator', () => {
  it('P1M matches the calendar month inclusively; coerces Date and ISO strings; rejects non-timestamps', () => {
    const rows = [
      { id: 'mar-in', t: Date.UTC(2026, 2, 15) },
      { id: 'feb-edge', t: Date.UTC(2026, 1, 28) }, // == lower bound
      { id: 'feb-before', t: Date.UTC(2026, 1, 27) },
      { id: 'apr-after', t: Date.UTC(2026, 3, 1) },
      { id: 'null', t: null },
      { id: 'date-obj', t: new Date(Date.UTC(2026, 2, 10)) },
      { id: 'iso-str', t: '2026-03-05T00:00:00.000Z' },
    ];
    const query: QueryExpression = { where: { t: { _period: at('P1M', MAR_31_2026) } } };
    expect(ids(rows, query)).toEqual(['mar-in', 'feb-edge', 'date-obj', 'iso-str']);
  });

  it('P1D matches exactly the trailing 24h before the anchor (inclusive edge)', () => {
    const anchor = MAR_31_2026_NOON;
    const rows = [
      { id: 'in', t: anchor },
      { id: 'edge', t: anchor - DAY },
      { id: 'out', t: anchor - DAY - 1 },
    ];
    expect(ids(rows, { where: { t: { _period: at('P1D', anchor) } } })).toEqual(['in', 'edge']);
  });

  it('PT1H matches exactly 1h and P1Y a calendar year', () => {
    const anchor = MAR_31_2026_NOON;
    const hourly = [
      { id: 'in', t: anchor },
      { id: 'edge', t: anchor - HOUR },
      { id: 'out', t: anchor - HOUR - 1 },
    ];
    expect(ids(hourly, { where: { t: { _period: at('PT1H', anchor) } } })).toEqual([
      'in',
      'edge',
    ]);

    const yearly = [
      { id: 'in', t: Date.UTC(2025, 4, 1) },
      { id: 'edge', t: Date.UTC(2025, 2, 31, 12) },
      { id: 'out', t: Date.UTC(2025, 2, 31, 12) - 1 },
    ];
    expect(ids(yearly, { where: { t: { _period: at('P1Y', anchor) } } })).toEqual(['in', 'edge']);
  });

  it('a bare duration string anchors at Date.now()', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(MAR_31_2026_NOON));
      const rows = [
        { id: 'now', t: MAR_31_2026_NOON },
        { id: 'two-days-ago', t: MAR_31_2026_NOON - 2 * DAY },
      ];
      expect(ids(rows, { where: { t: { _period: 'P1D' } } })).toEqual(['now']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a malformed duration matches nothing rather than throwing', () => {
    const rows = [
      { id: 'a', t: 1_000 },
      { id: 'b', t: 2_000 },
    ];
    expect(ids(rows, { where: { t: { _period: 'not-a-duration-please' } } })).toEqual([]);
  });
});
