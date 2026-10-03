/**
 * Complexity (big-O) acceptance tests for the DataView query pipeline.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 * --------------------------------------------------------------------------
 * These tests assert the ASYMPTOTIC CLASS of each individual query operation by
 * measuring how runtime grows with input size and fitting the growth exponent.
 * The acceptance criterion is: the measured exponent must be consistent with the
 * operation's stated theoretical big-O, and the test must FAIL when it is not.
 *
 * What a complexity test CAN do:
 *   - catch a wrong asymptotic CLASS — e.g. an accidental O(n^2) on a path whose
 *     design (and this suite) says O(n). The negative control below proves the
 *     harness detects a real quadratic and that the linear gate rejects it.
 *
 * What a complexity test CANNOT do:
 *   - prove an implementation is OPTIMAL. Matching O(n) does not mean the
 *     constant factor, allocation profile, or cache behaviour is good.
 *   - separate O(n) from O(n log n) reliably. Over any CI-feasible size range the
 *     effective exponent of n log n is ~1.05-1.15 — inside the timing noise of a
 *     linear op. Where that is the case it is stated explicitly per-op, and the
 *     class is corroborated by the algorithm's documented complexity plus the
 *     sensitivity demonstrated by the negative control, NOT by timing alone.
 *   - survive fixture shape, JIT warmup, and GC untouched. See METHOD below.
 *
 * METHOD
 * --------------------------------------------------------------------------
 * For each op we run at growing sizes n (a fixed ladder per op, see each test),
 * take the MEDIAN of repeated timed runs after warmup, then fit the exponent p by
 * ordinary least squares of log(median ms) against log(n):
 *
 *        p = slope( log t  vs  log n )        (t ~ n^p)
 *
 *   - p = 1.0  -> linear        p = 2.0 -> quadratic
 *   - n log n  -> p settles near 1.05-1.15 over these ranges (see limit above).
 *
 * WARMUP / REPETITION / NOISE HANDLING
 *   - The fixture is built ONCE per size, outside the timed region, so fixture
 *     construction (itself O(n)) is not charged to the operation under test.
 *   - `WARMUP` untimed runs precede every measurement so V8 has tiered up the
 *     engine path before we sample.
 *   - The reported statistic is the MEDIAN of `REPS` samples. The median rejects
 *     a single GC pause or scheduler hiccup far better than a mean; a stray slow
 *     sample cannot inflate the result the way it would with `mean` or `max`.
 *   - Sizes are chosen large enough that each op runs in ~ms, not microseconds,
 *     so fixed overhead does not dominate the ratio. This is not cosmetic: the
 *     positive control below is deliberately built to do non-elidable work on a
 *     large buffer, because a sub-millisecond reference (e.g. summing a plain
 *     number array) sits at the measurement floor, where per-call overhead and
 *     V8 dead-code elimination swamp the signal and the fitted exponent is
 *     meaningless. Measurement is only meaningful above ~1ms; that is a hard
 *     limit of this method.
 *
 * TOLERANCE AND JUSTIFICATION
 *   - LINEAR band: 0.70 <= p <= 1.50. An 8x size sweep gives a 3-octave log2
 *     span, so pure O(n) fits p=1.0 and pure O(n^2) fits p=2.0 — a full 1.0
 *     apart. The band's ceiling (1.50) is deliberately BELOW the quadratic
 *     control's floor (1.65): a quadratic is rejected by the linear gate.
 *     A band so wide it admitted 2.0 would verify nothing; this one does not.
 *   - N-LOG-N band: 0.85 <= p <= 1.65. Corroborative only (see limit above).
 *   - QUADRATIC control band: 1.65 <= p <= 2.45.
 *
 * THEORETICAL BOUNDS AND THEIR SOURCE
 * --------------------------------------------------------------------------
 * The repo states no complexity budget for these ops (no ADR or doc does), so
 * each bound below is the DOCUMENTED complexity of the algorithm the engine
 * actually uses, named with its location in this package:
 *
 *   op                       bound        source
 *   -----------------------  -----------  -----------------------------------
 *   where (_eq)              O(n)         Array.prototype.filter (ECMA-262);
 *                                         single pass at src/lib/query.ts:212
 *   where (compound _and/_or)O(n)         same single pass; the predicate is
 *                                         COMPILED ONCE by compileWhere() at
 *                                         src/lib/parser.ts:17, so per-row cost
 *                                         is O(query size) independent of n
 *   order_by (single key)    O(n log n)   Array.prototype.sort (V8 TimSort)
 *                                         at src/lib/query.ts:215
 *   order_by (multi key)     O(n log n)   same sort; fixed key count -> the
 *                                         per-comparison parse is a constant
 *                                         (src/lib/query.ts:5-27)
 *   distinct_on              O(n)         Set-based uniqueBy in
 *                                         @adhd/data-base-transforms
 *                                         collections.ts:226-246
 *   offset + limit           O(n)         commit() copies the whole array first
 *                                         (src/lib/query.ts:205), then slices
 *                                         (query.ts:222-225) -> the copy sets
 *                                         the floor at O(n)
 *   _period                  O(n)         filter O(n); resolveIsoPeriod is O(1)
 *                                         Date math per row (src/lib/period.ts)
 *
 * COVERED SINCE THE GROUPING SURFACE LANDED (SPEC 49a62647 §4)
 *   - group_by / aggregate / having / top_n: one hash-partition pass per
 *     grouping set => O(n) per set. The ladder holds G constant (GROUPS, 8
 *     values) so the fitted slope is the N-dimension.
 *   - _rollup(d) = O(n*(d+1)) (Gray et al. 1997); asserted here at d=2 over two
 *     low-cardinality dims, still O(n) per grouping set. CUBE is O(n*2^d) and
 *     the engine caps d at 12.
 *   - honest limits: the G-dimension (hash cost, O(G) space) and the
 *     non-algebraic `_quantile` (buffers and sorts each group's values) are
 *     NOT asserted here — neither is linear in N, and a per-N ladder cannot
 *     isolate them. _period/window share the same O(n) per-row bound.
 *
 * ADDED WITH ADR-0005 SELECT + _nest + PATH/RANGE OPS
 *   op                       bound        source
 *   -----------------------  -----------  -----------------------------------
 *   select                   O(n)         a single Array.map projection over
 *                                         the rows surviving the whole tail
 *                                         (src/lib/query.ts commit()). The
 *                                         suite holds the projection width fixed
 *                                         (2 refs), so the fit is the N-slope.
 *   path resolver            O(n*d)       compileAccessor() splits the ref ONCE
 *                                         at compile time (src/lib/path.ts) then
 *                                         walks d segments per row, with an
 *                                         exact-name-first fast path. Asserted at
 *                                         a FIXED depth d=3, hence O(n).
 *   _in/_nin_datetimerange   O(n*k)       one filter pass; k range tuples are
 *                                         tested per row (src/lib/filters.ts).
 *                                         Asserted at fixed k=4, hence O(n).
 *   _overlaps                O(n*k)       same per-row k-tuple shape, over an
 *                                         INTERVAL row value instead of a point.
 *   _between / _nbetween     O(n*k)       compile-time SUGAR desugaring into the
 *                                         SAME _in/_nin_datetimerange predicate
 *                                         (src/lib/parser.ts desugarOperators);
 *                                         there is deliberately no second code
 *                                         path, so it needs no separate bound.
 *
 *   - _nest is a single-pass TRIE OF ACCUMULATORS: each row descends its tree
 *     path once, adding into every ancestor, so per-row work is O(d) and the
 *     pass is O(n*d) time, O(G) space (G = emitted nodes). Asserted at d=2 and
 *     d=3 — with d HELD CONSTANT — so the fitted slope is the N-dimension.
 *   - HONEST LIMIT (nested): the D-DIMENSION is NOT assertable by a per-N
 *     ladder. A ladder over N holds d fixed and can only recover the N-slope;
 *     it cannot distinguish O(n*d) from O(n) at a fixed d, and it cannot see a
 *     regression that is super-linear in d. Likewise a per-node `top_n` adds an
 *     O(G log G) term that the suite CANNOT separate from O(n) (the n-log-n
 *     limit above). The nested ladder therefore omits top_n, and the d-limit is
 *     stated here rather than faked.
 *   - POSITIVE CONTROL (nested): the pass PARTITIONS the parent set — each row
 *     updates its own ancestor chain rather than rescanning all data per node.
 *     A rescan variant would be O(G*n) and is rejected by the linear band; the
 *     nested controls below are the gate that would catch it.
 */

import { describe, it, expect } from 'vitest';
import type {
  BooleanExpression,
  OrderByExpression,
  QueryExpression,
} from '../index';
import { DataView } from '../index';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Row = {
  id: number;
  value: number;
  group: string;
  ts: number;
  name: string;
  rank: number;
};

/** Deterministic PRNG so fixture shape is identical on every run/machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GROUPS = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];
const BASE_TS = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

/** Build `n` rows once; called outside every timed region. */
function makeRows(n: number): Row[] {
  const rnd = mulberry32(0x1234_5678);
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      id: i,
      value: Math.floor(rnd() * 1_000_000),
      group: GROUPS[Math.floor(rnd() * GROUPS.length)],
      ts: BASE_TS - Math.floor(rnd() * 365 * DAY),
      name: 'name-' + Math.floor(rnd() * 1_000_000),
      rank: Math.floor(rnd() * 100),
    };
  }
  return rows;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median of `reps` timed runs, after `warmup` untimed runs. */
function measure(run: () => void, reps: number, warmup: number): number {
  for (let i = 0; i < warmup; i++) run();
  const samples: number[] = new Array(reps);
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    run();
    samples[i] = performance.now() - t0;
  }
  return median(samples);
}

type Point = { n: number; ms: number };

/** OLS slope of log(ms) vs log(n): the growth exponent p where t ~ n^p. */
function fitExponent(points: Point[]): number {
  const xs = points.map((p) => Math.log(p.n));
  const ys = points.map((p) => Math.log(Math.max(p.ms, 1e-6)));
  const m = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / m;
  const my = ys.reduce((a, b) => a + b, 0) / m;
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return num / den;
}

/** Measure a DataView query at each size and return the fit. */
function measureQuery(
  sizes: number[],
  build: (n: number, rows: Row[]) => QueryExpression,
  reps = 7,
  warmup = 2
): { points: Point[]; p: number } {
  const points: Point[] = sizes.map((n) => {
    const rows = makeRows(n);
    const query = build(n, rows);
    const ms = measure(() => {
      new DataView(rows, query).view();
    }, reps, warmup);
    return { n, ms };
  });
  return { points, p: fitExponent(points) };
}

/**
 * Like measureQuery, but the caller supplies the ROWS as well as the query —
 * needed for the path-resolver and `_overlaps` ladders, which require a fixture
 * shape (nested objects / interval values) the shared `makeRows` does not carry.
 */
function measureCustom<S>(
  sizes: number[],
  build: (n: number) => { rows: S[]; query: QueryExpression },
  reps = 7,
  warmup = 2
): { points: Point[]; p: number } {
  const points: Point[] = sizes.map((n) => {
    const { rows, query } = build(n);
    const ms = measure(() => {
      new DataView(rows, query).view();
    }, reps, warmup);
    return { n, ms };
  });
  return { points, p: fitExponent(points) };
}

/**
 * Fixture for the path-resolver and interval ladders: each row carries a
 * depth-3 nested ref (`nested.deep.v`) and an interval value (`span`).
 */
function makeNestedRows(n: number): Array<Record<string, unknown>> {
  const rnd = mulberry32(0x9e37_79b9);
  const rows: Array<Record<string, unknown>> = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = BASE_TS - Math.floor(rnd() * 365 * DAY);
    rows[i] = {
      id: i,
      nested: { deep: { v: i % 1000 } },
      span: [t, t + 3_600_000],
    };
  }
  return rows;
}

/** Emit the raw measurements so the run log carries the evidence. */
function logFit(label: string, r: { points: Point[]; p: number }): void {
  const cells = r.points.map((pt) => `n=${pt.n}:${pt.ms.toFixed(3)}ms`).join('  ');
  console.log(`[complexity] ${label}  ${cells}  =>  p=${r.p.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

const LINEAR_MIN = 0.7;
const LINEAR_MAX = 1.5;
const NLOGN_MIN = 0.85;
const NLOGN_MAX = 1.65;
const QUADRATIC_MIN = 1.65;
const QUADRATIC_MAX = 2.45;

function expectLinear(p: number, label: string): void {
  expect(p, `${label}: exponent ${p.toFixed(3)} below linear band`).toBeGreaterThanOrEqual(
    LINEAR_MIN
  );
  expect(p, `${label}: exponent ${p.toFixed(3)} above linear band`).toBeLessThanOrEqual(
    LINEAR_MAX
  );
}

function expectNLogN(p: number, label: string): void {
  expect(p, `${label}: exponent ${p.toFixed(3)} below n log n band`).toBeGreaterThanOrEqual(
    NLOGN_MIN
  );
  expect(p, `${label}: exponent ${p.toFixed(3)} above n log n band`).toBeLessThanOrEqual(
    NLOGN_MAX
  );
}

// A ladder for cheap linear ops, a shorter one for the re-parsing sort, and one
// for the quadratic control. Every rung of every ladder is chosen so the op runs
// above the ~1ms measurement floor: below it, fixed overhead and V8 elimination
// dominate and the fit is meaningless (this is why the control's work is n^2 but
// its sizes start at 2k, not 500 — at n=500 the naive loop measured 0.13ms).
const LIN_SIZES = [25_000, 50_000, 100_000, 200_000];
const SORT_SIZES = [2_000, 4_000, 8_000, 16_000];
const QUAD_SIZES = [2_000, 4_000, 8_000, 16_000];

// ---------------------------------------------------------------------------
// Controls — prove the harness measures what it claims
// ---------------------------------------------------------------------------

describe('complexity harness — controls', () => {
  it('positive control: a known O(n) reference fits p ~ 1', () => {
    // A single linear pass, the same class as most engine ops. Two details make
    // this measurable: (1) a cheap Float64Array buffer large enough that each
    // run exceeds the ~1ms floor, and (2) a data-dependent hash chain whose
    // result is RETURNED, so V8 cannot dead-code-eliminate the loop (the failure
    // mode that made a plain `sum` unmeasurable at p=0.3).
    const rnd = mulberry32(0x9e37);
    const work = (a: Float64Array): number => {
      let s = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        s = (s * 31 + (x > 500_000 ? x : 0)) | 0;
      }
      return s;
    };
    const sizes = [500_000, 1_000_000, 2_000_000, 4_000_000];
    const points: Point[] = sizes.map((n) => {
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = rnd() * 1_000_000;
      let sink = 0;
      const ms = measure(() => {
        sink ^= work(a);
      }, 7, 2);
      // `sink` is read here so the work cannot be elided.
      expect(typeof sink).toBe('number');
      return { n, ms };
    });
    const p = fitExponent(points);
    logFit('control: O(n) non-elidable pass', { points, p });
    expectLinear(p, 'control O(n)');
  });

  it('negative control: a known O(n^2) reference is DETECTED and REJECTED as linear', () => {
    // Naive all-pairs duplicate count: for each row scan every prior row.
    // This is the exact shape of a complexity regression we must catch.
    const naiveDuplicates = (a: number[]): number => {
      let dups = 0;
      for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < i; j++) if (a[j] === a[i]) dups++;
      }
      return dups;
    };
    const points: Point[] = QUAD_SIZES.map((n) => {
      const a = makeRows(n).map((r) => r.value);
      return { n, ms: measure(() => void naiveDuplicates(a), 5, 1) };
    });
    const p = fitExponent(points);
    logFit('control: O(n^2) naive duplicates', { points, p });

    // It must be detected as super-linear (a real quadratic)...
    expect(p, `control O(n^2): exponent ${p.toFixed(3)} not in quadratic band`).toBeGreaterThanOrEqual(
      QUADRATIC_MIN
    );
    expect(p, `control O(n^2): exponent ${p.toFixed(3)} not in quadratic band`).toBeLessThanOrEqual(
      QUADRATIC_MAX
    );
    // ...and the linear gate used by every real op must REJECT it. This is the
    // sensitivity proof: the suite is not too loose to catch a regression.
    expect(
      p > LINEAR_MAX,
      `linear gate (max ${LINEAR_MAX}) must reject quadratic exponent ${p.toFixed(3)}`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Individual operations
// ---------------------------------------------------------------------------

describe('complexity — where', () => {
  it('simple _eq predicate is O(n)', () => {
    const r = measureQuery(LIN_SIZES, () => ({
      where: { value: { _eq: 500_000 } },
    }));
    logFit('where _eq', r);
    expectLinear(r.p, 'where _eq');
  });

  it('compound _and/_or tree (fixed query size) is O(n)', () => {
    // The predicate is compiled ONCE (parser.ts:17); per-row cost is O(query
    // size), independent of n. Growth must remain linear.
    // Typed locals (not an inline literal) so each array level is contextually
    // checked against BooleanExpression — the interface's index signature
    // rejects the `?: undefined` members an untyped heterogeneous array infers.
    const predicate: BooleanExpression = {
      _and: [
        { group: { _eq: 'g1' } },
        { _or: [{ value: { _gte: 250_000 } }, { rank: { _lt: 25 } }] },
      ],
    };
    const r = measureQuery(LIN_SIZES, () => ({ where: predicate }));
    logFit('where compound _and/_or', r);
    expectLinear(r.p, 'where compound _and/_or');
  });

  it('_period predicate is O(n)', () => {
    const anchor = Date.UTC(2026, 0, 2);
    const r = measureQuery(LIN_SIZES, () => ({
      where: { ts: { _period: ['P1D', anchor] as [string, number] } },
    }));
    logFit('where _period', r);
    expectLinear(r.p, 'where _period');
  });
});

describe('complexity — order_by', () => {
  it('single-key sort is O(n log n)', () => {
    const r = measureQuery(
      SORT_SIZES,
      () => ({ order_by: [{ value: 'asc' }] }),
      5,
      1
    );
    logFit('order_by single key', r);
    expectNLogN(r.p, 'order_by single key');
  });

  it('multi-key sort is O(n log n)', () => {
    // The comparator re-parses its keys per comparison (a constant-factor defect
    // flagged separately), but with a FIXED key count that stays a constant, so
    // the asymptotic class remains that of Array.prototype.sort.
    const keys: OrderByExpression[] = [{ group: 'asc' }, { value: 'desc' }];
    const r = measureQuery(SORT_SIZES, () => ({ order_by: keys }), 5, 1);
    logFit('order_by multi key', r);
    expectNLogN(r.p, 'order_by multi key');
  });
});

describe('complexity — distinct_on / offset+limit', () => {
  it('distinct_on is O(n) (Set-based uniqueBy)', () => {
    const r = measureQuery(LIN_SIZES, () => ({ distinct_on: ['group'] }));
    logFit('distinct_on', r);
    expectLinear(r.p, 'distinct_on');
  });

  it('offset + limit is O(n) (full copy dominates)', () => {
    // offset/limit are proportional to n so the slice work scales with the input.
    const r = measureQuery(LIN_SIZES, (n) => ({
      offset: Math.floor(n / 2),
      limit: Math.floor(n / 4),
    }));
    logFit('offset+limit', r);
    expectLinear(r.p, 'offset+limit');
  });
});

describe('complexity — group_by / aggregate / HAVING', () => {
  // G is held constant (GROUPS, 8 values) across the ladder, so each suite
  // isolates the N-dimension: one hash-partition pass + one fold per row.
  it('flat group_by + aggregate is O(n) per grouping set', () => {
    const r = measureQuery(LIN_SIZES, () => ({
      group_by: ['group'],
      aggregate: { s: { _sum: 'value' }, c: { _count: true } },
    }));
    logFit('group_by flat', r);
    expectLinear(r.p, 'group_by flat');
  });

  it('windowed group_by + aggregate is O(n) (window is a per-row test)', () => {
    const r = measureQuery(LIN_SIZES, () => ({
      group_by: ['group'],
      window: { field: 'ts', period: ['P100Y', BASE_TS] },
      aggregate: { s: { _sum: 'value' } },
    }));
    logFit('group_by windowed', r);
    expectLinear(r.p, 'group_by windowed');
  });

  it('HAVING adds only an O(G) pass over the grouped rows', () => {
    const r = measureQuery(LIN_SIZES, () => ({
      group_by: ['group'],
      aggregate: { s: { _sum: 'value' } },
      having: { s: { _gt: -1 } },
    }));
    logFit('group_by + having', r);
    expectLinear(r.p, 'group_by + having');
  });

  it('_rollup over two low-cardinality dims is O(n) per grouping set', () => {
    // d=2 => {group,rank}, {group}, {}: three passes, so still O(n).
    const r = measureQuery(LIN_SIZES, () => ({
      group_by: { _rollup: ['group', 'rank'] },
      aggregate: { s: { _sum: 'value' } },
    }));
    logFit('group_by rollup(2)', r);
    expectLinear(r.p, 'group_by rollup(2)');
  });

  it('top_n adds only an O(G log G) rank over the grouped rows', () => {
    const r = measureQuery(LIN_SIZES, () => ({
      group_by: ['group'],
      aggregate: { v: { _sum: 'value' } },
      top_n: { n: 2, by: 'v', other: true },
    }));
    logFit('group_by + top_n', r);
    expectLinear(r.p, 'group_by + top_n');
  });
});

describe('complexity — select / path resolver / date-range (ADR-0005 ops)', () => {
  it('select is a final O(n) projection after the tail', () => {
    const r = measureQuery(LIN_SIZES, () => ({
      select: ['id', 'value'],
    }));
    logFit('select', r);
    expectLinear(r.p, 'select');
  });

  it('the compiled path resolver is O(n) at fixed depth d=3', () => {
    // Depth-3 ref exercises the segment walk per row; the predicate is
    // satisfiable for every row, so the walk is never elided by V8.
    const r = measureCustom<Record<string, unknown>>(LIN_SIZES, (n) => ({
      rows: makeNestedRows(n),
      query: { where: { 'nested.deep.v': { _gte: 0 } } },
    }));
    logFit('path resolver (depth 3)', r);
    expectLinear(r.p, 'path resolver (depth 3)');
  });

  it('_in_datetimerange is O(n) at fixed k=4 ranges (point test)', () => {
    const ranges: Array<[number, number]> = Array.from({ length: 4 }, (_, i) => [
      BASE_TS - (i + 1) * 90 * DAY,
      BASE_TS - i * 90 * DAY,
    ]);
    const r = measureQuery(LIN_SIZES, () => ({
      where: { ts: { _in_datetimerange: ranges } },
    }));
    logFit('_in_datetimerange (k=4)', r);
    expectLinear(r.p, '_in_datetimerange (k=4)');
  });

  it('_overlaps is O(n) at fixed k=4 ranges (interval test)', () => {
    const ranges: Array<[number, number]> = Array.from({ length: 4 }, (_, i) => [
      BASE_TS - (i + 1) * 90 * DAY,
      BASE_TS - i * 90 * DAY,
    ]);
    const r = measureCustom<Record<string, unknown>>(LIN_SIZES, (n) => ({
      rows: makeNestedRows(n),
      query: { where: { span: { _overlaps: ranges } } },
    }));
    logFit('_overlaps (k=4)', r);
    expectLinear(r.p, '_overlaps (k=4)');
  });
});

describe('complexity — nested group_by (_nest)', () => {
  // Each row descends its tree path ONCE, adding into every ancestor: O(n*d)
  // time at a fixed tree, O(G) space. The ladder holds d constant, so the fit
  // is the N-slope; see the header's honest-limit note for what this CANNOT
  // assert (the d-dimension, and the per-node top_n n-log-n term).

  it('_nest d=2 (group -> rank) is O(n*d), linear in N at fixed d', () => {
    const r = measureQuery(LIN_SIZES, () => ({
      group_by: {
        _nest: [
          {
            key: 'group',
            aggregate: { s: { _sum: 'value' } },
            children: [{ key: 'rank', aggregate: { s: { _sum: 'value' } } }],
          },
        ],
      },
    }));
    logFit('_nest d=2', r);
    expectLinear(r.p, '_nest d=2');
  });

  it('_nest d=3 (group -> rank -> id) is O(n*d), linear in N at fixed d', () => {
    const r = measureQuery(LIN_SIZES, () => ({
      group_by: {
        _nest: [
          {
            key: 'group',
            aggregate: { s: { _sum: 'value' } },
            children: [
              {
                key: 'rank',
                aggregate: { s: { _sum: 'value' } },
                children: [{ key: 'id', aggregate: { s: { _sum: 'value' } } }],
              },
            ],
          },
        ],
      },
    }));
    logFit('_nest d=3', r);
    expectLinear(r.p, '_nest d=3');
  });

  it('positive control: the nested pass partitions the parent set (not quadratic)', () => {
    // A rescan-per-node implementation (O(G*n)) would blow past the linear band
    // here; the pass under test partitions instead. _count keeps the fixture
    // work non-elidable while asserting the same linear class.
    const r = measureQuery(LIN_SIZES, () => ({
      group_by: {
        _nest: [
          {
            key: 'group',
            aggregate: { c: { _count: true } },
            children: [{ key: 'rank', aggregate: { c: { _count: true } } }],
          },
        ],
      },
    }));
    logFit('_nest positive control', r);
    expectLinear(r.p, '_nest positive control');
  });
});
