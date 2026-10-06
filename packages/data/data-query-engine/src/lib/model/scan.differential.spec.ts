/**
 * Independent differential + growth harness for the `_scan` fast path
 * (`execute.ts` `computeScanColumn` / `evaluateScanFast` / `monotonicFrames`).
 *
 * Correctness requirement: the fast path is BIT-IDENTICAL to a naive per-row fold
 * over the frame. Method (public API only, no production source touched): force
 * the naive path for the SAME logical frame by adding a no-op `_filter: {}` to the
 * scan fold — `fastEligible` requires `_filter === undefined`, and `{}` matches
 * every row, so the fallback scopes exactly the same rows. Any divergence is a
 * fast-path semantic bug.
 */
import { describe, it, expect } from 'vitest';
import { execute } from './execute';
import type { Fold, QueryExpression, Row, ScanSpec } from './types';

type Spec = ScanSpec;

const withScan = (fold: Fold, spec: Spec, fallback: boolean): Fold =>
  fallback
    ? ({ ...fold, _scan: spec, _filter: {} } as Fold)
    : ({ ...fold, _scan: spec } as Fold);

const query = (fold: Fold, spec: Spec, fallback: boolean): QueryExpression => ({
  select: [{ name: 'w', aggregate: withScan(fold, spec, fallback) }],
});

const run = (fold: Fold, spec: Spec, rows: Row[], fallback: boolean): unknown[] =>
  execute(query(fold, spec, fallback), rows).map((r) => r['w']);

// ── deterministic data ──────────────────────────────────────────────────────
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

const NUMERIC = [0, 1, 2, -1, 3.5, -2.5, 10];
/** Deliberately mixed: `1` and `"1"`, and `0` vs `new Date(0)` — compareOrder-equal
 *  but distinct JS values (the tie class that distinguishes a first-min from a last-min). */
const MIXED: unknown[] = [1, '1', 2, '2', 0, null, undefined, 3.5, '3.5'];

const makeRows = (seed: number, n: number, mixed: boolean): Row[] => {
  const rnd = mulberry32(seed);
  const pool = mixed ? MIXED : NUMERIC;
  return Array.from({ length: n }, (_, i) => ({
    ts: i,
    // a monotonic/duplicate order key mixed in
    v: pool[Math.floor(rnd() * pool.length)],
    w: 1 + Math.floor(rnd() * 3),
    p: i % 2 === 0 ? 'a' : 'b',
  }));
};

const FOLDS: Array<[string, Fold]> = [
  ['_sum', { _sum: 'v' }],
  ['_count:true', { _count: true }],
  ['_count:v', { _count: 'v' }],
  ['_avg', { _avg: 'v' }],
  ['_min', { _min: 'v' }],
  ['_max', { _max: 'v' }],
  ['_ratio_of_sums', { _ratio_of_sums: { num: 'v', den: 'w' } }],
];

const SPECS: Array<[string, Spec]> = [
  ['running', { order_by: 'ts' }],
  ['running partitioned', { order_by: 'ts', partition_by: 'p' }],
  ['sliding 1', { order_by: 'ts', frame: 1 }],
  ['sliding 2', { order_by: 'ts', frame: 2 }],
  ['sliding 3', { order_by: 'ts', frame: 3 }],
  ['sliding 3 partitioned', { order_by: 'ts', frame: 3, partition_by: 'p' }],
  ['rows centered [-1,1]', { order_by: 'ts', frame: { rows: [-1, 1] } }],
  ['rows lookahead [1,unbounded]', { order_by: 'ts', frame: { rows: [1, 'unbounded'] } }],
  ['rows tail [unbounded,1]', { order_by: 'ts', frame: { rows: ['unbounded', 1] } }],
  ['rows [-2,0]', { order_by: 'ts', frame: { rows: [-2, 0] } }],
  ['range [-2,0]', { order_by: 'ts', frame: { range: [-2, 0] } }],
  ['groups [-1,1]', { order_by: 'w', frame: { groups: [-1, 1] } }],
  ['predicate all', { order_by: 'ts', frame: { where: {} } }],
  ['predicate w>=2', { order_by: 'ts', frame: { where: { w: { _gte: 2 } } } }],
];

// ── differential: fast path vs naive per-row fold ───────────────────────────

describe('scan fast path — bit-identical to the naive per-row frame fold', () => {
  it('numeric data: every monoid fold × frame is bit-identical to the fallback', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rows = makeRows(seed, 60, false);
      for (const [fname, fold] of FOLDS) {
        for (const [sname, spec] of SPECS) {
          const fast = run(fold, spec, rows, false);
          const ref = run(fold, spec, rows, true);
          expect(fast, `${fname} @ ${sname} (seed ${seed})`).toEqual(ref);
        }
      }
    }
  });

  it('mixed-type data: _sum/_count/_avg/_ratio stay identical to the fallback', () => {
    const rows = makeRows(7, 60, true);
    for (const [fname, fold] of FOLDS.filter(([n]) => n !== '_min' && n !== '_max')) {
      for (const [sname, spec] of SPECS) {
        expect(run(fold, spec, rows, false), `${fname} @ ${sname}`).toEqual(run(fold, spec, rows, true));
      }
    }
  });

  // The naive `_min`/`_max` fold keeps the FIRST compareOrder-minimal value; the
  // monotonic deque now pops only STRICTLY-worse backs, so on ties it retains the
  // earlier index too — these are bit-identical (previously a known divergence).
  it('_min keeps the first compareOrder-minimal value (no tie divergence)', () => {
    const rows: Row[] = [
      { ts: 0, v: 1 },
      { ts: 1, v: '1' },
    ];
    expect(
      execute({ select: [{ name: 'w', aggregate: { _min: 'v', _scan: { order_by: 'ts' } } }] }, rows).map(
        (r) => r['w']
      )
    ).toEqual([1, 1]);
  });

  it('_max keeps the first compareOrder-maximal value (0 vs new Date(0))', () => {
    const rows: Row[] = [
      { ts: 0, v: 0 },
      { ts: 1, v: new Date(0) },
    ];
    expect(
      execute({ select: [{ name: 'w', aggregate: { _max: 'v', _scan: { order_by: 'ts' } } }] }, rows).map((r) => r['w'])
    ).toEqual([0, 0]);
  });
});

// ── growth: fast O(n) vs naive O(n²) (independent negative control) ──────────

describe('scan fast path — independent growth measurement', () => {
  function meterRows(raw: Row[]): { rows: Row[]; v: () => number } {
    let v = 0;
    const rows = raw.map(
      (row) =>
        new Proxy(row, {
          get(target, prop) {
            if (prop === 'v') v += 1;
            return Reflect.get(target, prop, target);
          },
        })
    );
    return { rows, v: () => v };
  }

  const readsOf = (fold: Fold, spec: Spec, n: number, fallback: boolean): number => {
    const raw = Array.from({ length: n }, (_, i) => ({ ts: i, v: 1 }));
    const m = meterRows(raw);
    execute(query(fold, spec, fallback), m.rows);
    return m.v();
  };
  const exponent = (a: number, b: number): number => Math.log2(b / a);

  const RUNNING: Spec = { order_by: 'ts' };

  it('fast path: 2× rows ⇒ ~2× folded-operand reads (exponent ≈ 1)', () => {
    const a = readsOf({ _sum: 'v' }, RUNNING, 128, false);
    const b = readsOf({ _sum: 'v' }, RUNNING, 256, false);
    const c = readsOf({ _sum: 'v' }, RUNNING, 512, false);
    expect(exponent(a, c) / 2).toBeLessThan(1.3);
    expect(c / b).toBeLessThan(2.6);
  });

  it('NEGATIVE CONTROL: the naive per-row frame fold over a running frame is O(n²)', () => {
    const a = readsOf({ _sum: 'v' }, RUNNING, 128, true);
    const c = readsOf({ _sum: 'v' }, RUNNING, 512, true);
    // 4× rows ⇒ ~16× reads (quadratic); proves the authored bound has teeth.
    expect(exponent(a, c) / 2).toBeGreaterThan(1.7);
  });

  it('DOCUMENTED residual: a non-monoid fold (_distinct_count) has no fast path', () => {
    // `isFastFold` excludes `_distinct_count`, so `computeScanColumn` folds the
    // frame per row — quadratic. Documented, not silent: `isFastFold` lists the
    // fast class and `_quantile`/`_distinct_count` are the excluded holistic ops.
    const a = readsOf({ _distinct_count: 'v' }, RUNNING, 128, true);
    const c = readsOf({ _distinct_count: 'v' }, RUNNING, 512, true);
    expect(exponent(a, c) / 2).toBeGreaterThan(1.7);
  });
});
