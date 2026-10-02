/**
 * ISO-8601 duration period resolution.
 *
 * A period is a DURATION anchored at an instant `to`, evaluating to the window
 * `[to - duration, to]`. Calendar components (years/months) are resolved against
 * the calendar with day-of-month clamping, so `P1M` is a CALENDAR month
 * (28-31 days) and NOT a fixed 30 days. Fixed components
 * (weeks/days/hours/minutes/seconds) are exact milliseconds.
 *
 * This is the ONE place ISO-8601 period arithmetic lives; the `_period`
 * where-operator (see ./filters) resolves through it.
 */

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;
/** Milliseconds in an hour. */
const HOUR_MS = 3_600_000;

/** The resolved bounds of an ISO-8601 period. */
export interface IsoPeriodBounds {
  /** Lower bound, inclusive (epoch ms). */
  from: number;
  /** Anchor / upper bound, inclusive (epoch ms). */
  to: number;
  /** The realised length in milliseconds (`to - from`). */
  durationMs: number;
}

/** Parsed ISO-8601 duration components. */
interface ParsedDuration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

// PnYnMnWnD T nHnMnS — fractions are permitted on the seconds term only.
const ISO_DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/u;

function parseDuration(duration: string): ParsedDuration {
  const m = typeof duration === 'string' ? ISO_DURATION_RE.exec(duration) : null;
  if (m === null) {
    throw new TypeError(`Invalid ISO-8601 duration: ${String(duration)}`);
  }
  const [, y, mo, w, d, h, mi, s] = m;
  if ([y, mo, w, d, h, mi, s].every((part) => part === undefined)) {
    // `P` or `PT` carrying no component is not a duration.
    throw new TypeError(`Invalid ISO-8601 duration: ${String(duration)}`);
  }
  return {
    years: y === undefined ? 0 : Number(y),
    months: mo === undefined ? 0 : Number(mo),
    weeks: w === undefined ? 0 : Number(w),
    days: d === undefined ? 0 : Number(d),
    hours: h === undefined ? 0 : Number(h),
    minutes: mi === undefined ? 0 : Number(mi),
    seconds: s === undefined ? 0 : Number(s),
  };
}

/** Days in a UTC calendar month (`monthIdx` is 0-based). */
function daysInUtcMonth(year: number, monthIdx: number): number {
  // Day 0 of the NEXT month is the last day of THIS one.
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

/**
 * Subtract `months` calendar months from `ms`, clamping the day-of-month to the
 * target month's length (2026-03-31 minus 1M = 2026-02-28), in UTC.
 */
function subtractUtcMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = daysInUtcMonth(d.getUTCFullYear(), d.getUTCMonth());
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/**
 * True when the duration carries a CALENDAR component (years or months), so its
 * length depends on the anchor — a calendar month, not a fixed 30 days.
 */
export function isCalendarPeriod(duration: string): boolean {
  const p = parseDuration(duration);
  return p.years !== 0 || p.months !== 0;
}

/**
 * Resolve an ISO-8601 duration to the window `[to - duration, to]`.
 *
 * Calendar components (Y/M) are applied first, against the calendar (with
 * day-of-month clamping); the fixed components (W/D/H/M/S) are then applied as
 * exact milliseconds. Throws `TypeError` on a non-ISO or empty duration, and on
 * a non-finite anchor.
 */
export function resolveIsoPeriod(duration: string, to: number): IsoPeriodBounds {
  if (!Number.isFinite(to)) {
    throw new TypeError(`resolveIsoPeriod requires a finite anchor, got ${String(to)}`);
  }
  const p = parseDuration(duration);
  let from = to;
  const totalMonths = p.years * 12 + p.months;
  if (totalMonths !== 0) from = subtractUtcMonths(from, totalMonths);
  const fixedMs =
    (p.weeks * 7 + p.days) * DAY_MS +
    p.hours * HOUR_MS +
    p.minutes * 60_000 +
    Math.round(p.seconds * 1000);
  from -= fixedMs;
  return { from, to, durationMs: to - from };
}
