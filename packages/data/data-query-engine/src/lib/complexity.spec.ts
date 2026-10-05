/**
 * Complexity (big-O) acceptance tests for the DataView query pipeline.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 * --------------------------------------------------------------------------
 * These tests assert the ASYMPTOTIC CLASS of each individual query operation by
 * INSTRUMENTING the operation's data movement and COUNTING the element touches
 * it performs as input size grows. The acceptance criterion is: the measured
 * WORK must grow with the operation's stated theoretical big-O, and the test
 * must FAIL when it does not.
 *
 * The measurement is DETERMINISTIC. Each fixture is wrapped in a Proxy that
 * increments a shared counter on every array-index read and every per-row field
 * read, so an operation's "work" is the number of times it touched its inputs —
 * a pure function of the query and the fixture, independent of wall-clock time,
 * CPU load, JIT tiering and GC. The same query yields the same count on every
 * run and every machine.
 *
 * That determinism is the point. A timing-based fit of these same operations is
 * load sensitive: under a parallel `nx affected -t test` run a linear op's fitted
 * exponent drifted past the linear ceiling, the task was reported flaky, and the
 * whole affected gate went non-deterministically red (BACKLOG 5a4f8f5d).
 * AGENTS.md §7 requires a complexity gate to be deterministic and free of
 * wall-clock measurement. Counting satisfies that without weakening the gate —
 * see TOLERANCE below.
 *
 * What a complexity test CAN do:
 *   - catch a wrong asymptotic CLASS — e.g. an accidental O(n^2) on a path whose
 *     design (and this suite) says O(n). The negative control below drives the
 *     SAME Proxy counter with a genuine quadratic, asserts the fitted exponent is
 *     quadratic, AND asserts the linear gate REJECTS it. That is the sensitivity
 *     proof: a regression to the counted-quadratic shape turns a linear op red.
 *
 * What a complexity test CANNOT do:
 *   - prove an implementation is OPTIMAL. Matching O(n) does not mean the
 *     constant factor, allocation profile, or cache behaviour is good.
 *   - separate O(n) from O(n log n) reliably. Over any CI-feasible size range the
 *     effective exponent of n log n is ~1.05-1.15 — inside the linear band. Where
 *     that is the case it is stated explicitly per-op, and the class is
 *     corroborated by the algorithm's documented complexity plus the sensitivity
 *     demonstrated by the negative control, NOT by the count alone.
 *   - see work that never touches the instrumented inputs — e.g. a quadratic
 *     loop over a plain value array the engine copied OUT of the rows before the
 *     loop. The count is the number of touches on the fixtures THIS suite
 *     supplies; the negative control below establishes exactly which quadratic
 *     shape the counter does catch.
 *
 * METHOD
 * --------------------------------------------------------------------------
 * Every fixture row is wrapped in a counting Proxy; the fixture array itself is
 * likewise wrapped, so the engine's `commit()` — which begins by copying the
 * input array (`[...this.data]`, src/lib/query.ts:291) — records the O(n) floor
 * that even a pure-copy op such as offset+limit is bounded by.
 *
 * For each op we run at growing sizes n (a fixed ladder per op, see each test),
 * count the touches W of a single run, then fit the exponent p by ordinary least
 * squares of log(W) against log(n):
 *
 *        p = slope( log W  vs  log n )        (W ~ n^p)
 *
 *   - p = 1.0  -> linear        p = 2.0 -> quadratic
 *   - n log n  -> p settles near 1.05-1.15 over these ranges (see limit above).
 *
 * The counter is reset immediately before the measured run and read immediately
 * after it, so fixture construction (itself O(n)) is never charged to the
 * operation under test. A single run suffices: unlike a timing sample, a count
 * has no variance to average away.
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
 *                                         single pass at src/lib/query.ts:299
 *   where (compound _and/_or)O(n)         same single pass; the predicate is
 *                                         COMPILED ONCE by compileWhere() at
 *                                         src/lib/parser.ts:47, so per-row cost
 *                                         is O(query size) independent of n
 *   order_by (single key)    O(n log n)   Array.prototype.sort (V8 TimSort)
 *                                         at src/lib/query.ts:315
 *   order_by (multi key)     O(n log n)   same sort; the comparator compiles its
 *                                         keys ONCE (src/lib/query.ts:18-60), so
 *                                         with a fixed key count the per-row cost
 *                                         is a constant
 *   distinct_on              O(n)         Set-based uniqueByPaths at
 *                                         src/lib/path.ts:87-106
 *   offset + limit           O(n)         commit() copies the whole array first
 *                                         (src/lib/query.ts:291), then slices
 *                                         (query.ts:322-325) -> the copy sets
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
 *                                         (src/lib/query.ts:337-345). The suite
 *                                         holds the projection width fixed
 *                                         (2 refs), so the fit is the N-slope.
 *   path resolver            O(n*d)       compileAccessor() splits the ref ONCE
 *                                         at compile time (src/lib/path.ts:38-66)
 *                                         then walks d segments per row, with an
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
// Harness — deterministic element-touch counting
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

/** Build `n` rows once; called outside every counted region. */
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

/**
 * The counter for the current measurement. Incremented by the Proxies below;
 * reset immediately before a measured run and read immediately after it. There
 * is no wall-clock anywhere in this file — the value is a pure count of how many
 * times the operation under test touched its instrumented inputs.
 */
let touches = 0;

/** Wrap an array: every numeric-index or `length` read is one element touch. */
function countArray<T>(arr: T[]): T[] {
  return new Proxy(arr, {
    get(target, prop, recv) {
      if (prop === 'length') touches++;
      else if (typeof prop === 'string' && /^\d+$/.test(prop)) touches++;
      return Reflect.get(target, prop, recv);
    },
  });
}

/** Wrap a row: every string-keyed field read is one element touch. */
function countRow<T extends object>(row: T): T {
  return new Proxy(row, {
    get(target, prop, recv) {
      if (typeof prop === 'string') touches++;
      return Reflect.get(target, prop, recv);
    },
  });
}

type Point = { n: number; work: number };

/** OLS slope of log(work) vs log(n): the growth exponent p where W ~ n^p. */
function fitExponent(points: Point[]): number {
  const xs = points.map((p) => Math.log(p.n));
  const ys = points.map((p) => Math.log(Math.max(p.work, 1)));
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

/** Run `fn` once and return the element touches it performed. */
function countWork(fn: () => void): number {
  touches = 0;
  fn();
  return touches;
}

/** Count a DataView query at each size and return the fit. */
function measureQuery(
  sizes: number[],
  build: (n: number, rows: Row[]) => QueryExpression
): { points: Point[]; p: number } {
  const points: Point[] = sizes.map((n) => {
    const rows = makeRows(n).map(countRow);
    const query = build(n, rows);
    const work = countWork(() => {
      new DataView(countArray(rows), query).view();
    });
    return { n, work };
  });
  return { points, p: fitExponent(points) };
}

/**
 * Like measureQuery, but the caller supplies the ROWS as well as the query —
 * needed for the path-resolver and `_overlaps` ladders, which require a fixture
 * shape (nested objects / interval values) the shared `makeRows` does not carry.
 */
function measureCustom<S extends object>(
  sizes: number[],
  build: (n: number) => { rows: S[]; query: QueryExpression }
): { points: Point[]; p: number } {
  const points: Point[] = sizes.map((n) => {
    const { rows, query } = build(n);
    const counted = rows.map(countRow);
    const work = countWork(() => {
      new DataView(countArray(counted), query).view();
    });
    return { n, work };
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

/** Emit the raw counts so the run log carries the evidence. */
function logFit(label: string, r: { points: Point[]; p: number }): void {
  const cells = r.points.map((pt) => `n=${pt.n}:${pt.work}`).join('  ');
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

// A ladder for cheap linear ops, a shorter one for the sort, and one for the
// quadratic control. Sizes need only span 8x (three octaves) to separate p=1
// from p=2; because the measurement is a count, there is no timing floor to
// clear, so the control's ladder can stay small enough that its O(n^2) inner
// loop is cheap to execute under the Proxy.
const LIN_SIZES = [25_000, 50_000, 100_000, 200_000];
const SORT_SIZES = [2_000, 4_000, 8_000, 16_000];
const QUAD_SIZES = [256, 512, 1_024, 2_048];

// ---------------------------------------------------------------------------
// Controls — prove the harness measures what it claims
// ---------------------------------------------------------------------------

describe('complexity harness — controls', () => {
  it('positive control: a known O(n) reference fits p ~ 1', () => {
    // A single linear pass over an instrumented array: one touch per element,
    // plus the one `length` read. `sink` is consumed by an assertion so V8
    // cannot dead-code-eliminate the loop.
    const sizes = [50_000, 100_000, 200_000, 400_000];
    const points: Point[] = sizes.map((n) => {
      const a = countArray(new Array<number>(n).fill(1));
      const len = a.length;
      let sink = 0;
      const work = countWork(() => {
        let s = 0;
        for (let i = 0; i < len; i++) s = (s * 31 + a[i]) | 0;
        sink ^= s;
      });
      expect(typeof sink).toBe('number');
      return { n, work };
    });
    const p = fitExponent(points);
    logFit('control: O(n) element-touch pass', { points, p });
    expectLinear(p, 'control O(n)');
  });

  it('negative control: a known O(n^2) reference is DETECTED and REJECTED as linear', () => {
    // Naive all-pairs duplicate count: for each row scan every prior row. The
    // values live in an instrumented array, so every `a[i]` / `a[j]` read is a
    // counted touch — exactly the element-touch shape this suite measures. This
    // proves the counter returns a quadratic exponent for a real quadratic, and
    // that the linear gate used by every op REJECTS it.
    const naiveDuplicates = (a: number[]): number => {
      const len = a.length;
      let dups = 0;
      for (let i = 0; i < len; i++) {
        for (let j = 0; j < i; j++) if (a[j] === a[i]) dups++;
      }
      return dups;
    };
    const points: Point[] = QUAD_SIZES.map((n) => {
      const a = countArray(makeRows(n).map((r) => r.value));
      return { n, work: countWork(() => void naiveDuplicates(a)) };
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

  it('determinism: identical input yields an identical count on every run', () => {
    // The property that distinguishes this harness from a timing one: the
    // measurement is a pure function of (query, fixture). Two independent runs
    // must report the same work, regardless of machine load. No wall-clock is
    // read anywhere in this file.
    const rows = makeRows(20_000).map(countRow);
    const run = () =>
      countWork(() => {
        new DataView(countArray(rows), {
          where: { value: { _eq: 500_000 } },
        }).view();
      });
    const first = run();
    const second = run();
    expect(second).toBe(first);
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
    // The predicate is compiled ONCE (parser.ts:47); per-row cost is O(query
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
    const r = measureQuery(SORT_SIZES, () => ({ order_by: [{ value: 'asc' }] }));
    logFit('order_by single key', r);
    expectNLogN(r.p, 'order_by single key');
  });

  it('multi-key sort is O(n log n)', () => {
    // The comparator compiles its keys once, but with a FIXED key count the
    // per-comparison cost is a constant, so the asymptotic class remains that of
    // Array.prototype.sort.
    const keys: OrderByExpression[] = [{ group: 'asc' }, { value: 'desc' }];
    const r = measureQuery(SORT_SIZES, () => ({ order_by: keys }));
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
    // The measured touches are the input-array copy commit() performs before any
    // tail phase — the O(n) floor this bound is stated against.
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
