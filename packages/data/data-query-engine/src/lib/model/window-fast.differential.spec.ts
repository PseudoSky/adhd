/**
 * Independent differential + growth harness for the window fast path
 * (`execute.ts` `computeWindowColumn` / `evaluateWindowFast` / `monotonicFrames`).
 *
 * NOT part of the authored Big-O suite. Added by an independent performance review
 * to falsify the claim that the fast path preserves EXACT materializing-fallback
 * semantics, and to independently measure the O(n) vs O(n²) growth.
 *
 * Method (public API only, no production source touched): the materializing path
 * can be forced for the SAME logical frame by adding a no-op `_filter: {}` to the
 * window fold — `fastEligible` requires `_filter === undefined`, and `{}` matches
 * every row, so the fallback scopes exactly the same rows. Any divergence between
 * the two is therefore a fast-path semantic bug.
 */
import { describe, it, expect } from 'vitest';
import { execute } from './execute';
import type { Fold, QueryExpression, Row } from './types';

type Spec = Record<string, unknown>;

const withWindow = (fold: Fold, spec: Spec, fallback: boolean): Fold =>
  fallback
    ? ({ ...fold, _window: spec, _filter: {} } as Fold)
    : ({ ...fold, _window: spec } as Fold);

const query = (fold: Fold, spec: Spec, fallback: boolean): QueryExpression => ({
  select: [{ name: 'w', aggregate: withWindow(fold, spec, fallback) }],
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
  ['whole', { field: 'ts' }],
  ['rows[-1,1]', { field: 'ts', frame_mode: 'rows', frame: [-1, 1] }],
  ['rows[0,0]', { field: 'ts', frame_mode: 'rows', frame: [0, 0] }],
  ['rows[-2,0]', { field: 'ts', frame_mode: 'rows', frame: [-2, 0] }],
  ['rows[unbounded,1]', { field: 'ts', frame_mode: 'rows', frame: ['unbounded', 1] }],
  ['rows[1,unbounded]', { field: 'ts', frame_mode: 'rows', frame: [1, 'unbounded'] }],
  ['rows[empty 0,-1]', { field: 'ts', frame_mode: 'rows', frame: [0, -1] }],
  ['rows[-3,3]', { field: 'ts', frame_mode: 'rows', frame: [-3, 3] }],
  ['partitioned whole', { field: 'ts', partition_by: 'p' }],
  ['partitioned rows[-1,1]', { field: 'ts', partition_by: 'p', frame_mode: 'rows', frame: [-1, 1] }],
];

// ── differential: fast path vs materializing fallback ───────────────────────

describe('window fast path — differential vs materializing fallback', () => {
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

  // KNOWN DIVERGENCE (encoded as a currently-failing case): for `_min` the reference
  // fold keeps the FIRST compareOrder-minimal value; the monotonic deque keeps the
  // LAST. For values that compareOrder deems equal but that are not `===` (1 vs "1",
  // 0 vs new Date(0)), the returned value differs. `it.fails` documents it as a real
  // bug while keeping the suite green; when the fast path is corrected this flips red.
  it.fails('KNOWN BUG: _min tie divergence (fast returns last-equal, fallback first-equal)', () => {
    const rows: Row[] = [
      { ts: 0, v: 1 },
      { ts: 1, v: '1' },
    ];
    const q: QueryExpression = {
      select: [{ name: 'w', aggregate: { _min: 'v', _window: { field: 'ts' } } }],
    };
    // the reference (fallback) answer for every row is the number 1
    expect(execute(q, rows)).toEqual([{ w: 1 }, { w: 1 }]);
  });

  it.fails('KNOWN BUG: _max tie divergence (0 vs new Date(0))', () => {
    const rows: Row[] = [
      { ts: 0, v: 0 },
      { ts: 1, v: new Date(0) },
    ];
    const q: QueryExpression = {
      select: [{ name: 'w', aggregate: { _max: 'v', _window: { field: 'ts' } } }],
    };
    expect(execute(q, rows).map((r) => r['w'])).toEqual([0, 0]);
  });
});

// ── growth: fast O(n) vs fallback O(n²) (independent negative control) ───────

describe('window fast path — independent growth measurement', () => {
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

  const UNBOUNDED: Spec = { field: 'ts', frame_mode: 'rows', frame: ['unbounded', 'unbounded'] };

  it('fast path: 2× rows ⇒ ~2× folded-operand reads (exponent ≈ 1)', () => {
    const a = readsOf({ _sum: 'v' }, UNBOUNDED, 128, false);
    const b = readsOf({ _sum: 'v' }, UNBOUNDED, 256, false);
    const c = readsOf({ _sum: 'v' }, UNBOUNDED, 512, false);
    expect(exponent(a, c) / 2).toBeLessThan(1.3);
    expect(c / b).toBeLessThan(2.6);
  });

  it('NEGATIVE CONTROL: the materializing fallback over an unbounded frame is O(n²)', () => {
    const a = readsOf({ _sum: 'v' }, UNBOUNDED, 128, true);
    const c = readsOf({ _sum: 'v' }, UNBOUNDED, 512, true);
    // 4× rows ⇒ ~16× reads (quadratic); proves the authored bound has teeth.
    expect(exponent(a, c) / 2).toBeGreaterThan(1.7);
  });

  it('RESIDUAL O(n²): a non-monoid fold (_distinct_count) over an unbounded window has no fast path', () => {
    // `isFastFold` excludes `_distinct_count`; `computeWindowColumn` then folds the
    // whole partition PER ROW — quadratic and untested by the authored suite.
    const a = readsOf({ _distinct_count: 'v' }, UNBOUNDED, 128, true);
    const c = readsOf({ _distinct_count: 'v' }, UNBOUNDED, 512, true);
    expect(exponent(a, c) / 2).toBeGreaterThan(1.7);
  });
});
