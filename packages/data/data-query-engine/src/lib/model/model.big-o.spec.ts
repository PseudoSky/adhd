/**
 * Big-O complexity specs for the v2 query model (`packages/data/data-query-engine/src/lib/model`).
 *
 * Deterministic, structural observables only: backing-Map operation counts, per-row
 * value-access counts, and cache-update counts. No wall-clock gates. Each assertion
 * has teeth — the linear/recompute variant fails it (see the negative-control proof
 * in the change report).
 */
import { describe, it, expect } from 'vitest';
import { execute, type EvalCtx } from './execute';
import { IndexStore, type IndexField } from './indexing';
import { DataView } from './dataview';
import { planQuery } from './plan';
import { canonicalizePredicate, planKey } from './canonical';
import type { Predicate, QueryExpression, Row } from './types';

// ── deterministic instrumentation ───────────────────────────────────────────

interface MapGetMeter<K, V> { proxy: Map<K, V>; get: () => number }

/** Wrap a Map so `get` calls are counted (other methods bound to the real Map). */
function meterMapGet<K, V>(map: Map<K, V>): MapGetMeter<K, V> {
  let gets = 0;
  const proxy = new Proxy(map, {
    get(target, prop) {
      if (prop === 'get') return (key: K): V | undefined => { gets += 1; return target.get(key); };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, get: () => gets };
}

interface RowMeter { rows: Row[]; v: () => number; ts: () => number }

/** Proxy each row so reads of `v` (the folded operand) and `ts` (the order key) count. */
function meterRows(raw: Row[]): RowMeter {
  let v = 0;
  let ts = 0;
  const rows = raw.map(
    (row) =>
      new Proxy(row, {
        get(target, prop) {
          if (prop === 'v') v += 1;
          else if (prop === 'ts') ts += 1;
          return Reflect.get(target, prop, target);
        },
      })
  );
  return { rows, v: () => v, ts: () => ts };
}

const buildStore = (rows: Row[], fields: IndexField[]): IndexStore => {
  const store = new IndexStore(fields);
  for (const row of rows) store.add(row);
  return store;
};

interface RawIndexStore { rows: Map<number, Row> }
interface RawIncrementalGrouped { applyRow(row: Row, weight: number): void }
interface RawDataView { caches: Map<string, Map<string, RawIncrementalGrouped>> }

// ── IndexStore — index-accelerated access is sublinear in n ─────────────────

describe('IndexStore — candidates/rowsFor are index-bound, not scan-bound', () => {
  const n = 20_000;
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({ g: i % 100, v: i }));

  it('rowsFor touches exactly |ids| rows, independent of n', () => {
    const store = buildStore(rows, [{ field: 'g', kind: 'eq' }]);
    const meter = meterMapGet((store as unknown as RawIndexStore).rows);
    (store as unknown as RawIndexStore).rows = meter.proxy;
    const ids = [0, 1, 2, 3, 4, 5, 6, 7];
    const out = store.rowsFor(ids);
    expect(meter.get()).toBe(ids.length); // O(k), never O(n)
    expect(out.map((r) => r['v'])).toEqual(ids);
  });

  it('an equality candidate narrows through the index without touching the row store', () => {
    const store = buildStore(rows, [{ field: 'g', kind: 'eq' }]);
    const meter = meterMapGet((store as unknown as RawIndexStore).rows);
    (store as unknown as RawIndexStore).rows = meter.proxy;
    const before = meter.get();
    const ids = store.candidates({ g: { _eq: 7 } });
    expect(meter.get() - before).toBe(0); // zero row reads — a fallback scan would read n
    if (ids === undefined) throw new Error('expected index candidates');
    const expected = rows.map((r, i) => (r['g'] === 7 ? i : -1)).filter((i) => i >= 0);
    expect([...ids].sort((a, b) => a - b)).toEqual(expected);
  });

  it('a range candidate narrows through the B+ tree without touching the row store', () => {
    const store = buildStore(rows, [{ field: 'v', kind: 'range' }]);
    const meter = meterMapGet((store as unknown as RawIndexStore).rows);
    (store as unknown as RawIndexStore).rows = meter.proxy;
    const before = meter.get();
    const ids = store.candidates({ v: { _between: [100, 109] } });
    expect(meter.get() - before).toBe(0);
    if (ids === undefined) throw new Error('expected index candidates');
    expect([...ids].sort((a, b) => a - b)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  });

  it('a low-cardinality bitmap candidate narrows without touching the row store', () => {
    const store = buildStore(rows, [{ field: 'g', kind: 'bitmap' }]);
    const meter = meterMapGet((store as unknown as RawIndexStore).rows);
    (store as unknown as RawIndexStore).rows = meter.proxy;
    const before = meter.get();
    const ids = store.candidates({ g: { _eq: 5 } });
    expect(meter.get() - before).toBe(0);
    if (ids === undefined) throw new Error('expected index candidates');
    expect(ids.size).toBe(n / 100);
  });

  it('returns undefined for a non-indexable predicate (the caller scans)', () => {
    const store = buildStore(rows, [{ field: 'g', kind: 'eq' }]);
    expect(store.candidates({ nope: { _eq: 1 } })).toBeUndefined();
  });
});

// ── canonicalization / planner — linear in query size ───────────────────────

describe('canonicalization & planner — O(query size)', () => {
  const deepAnd = (k: number): Predicate => {
    let node: Predicate = { a: { _eq: 0 } };
    for (let i = 1; i < k; i++) node = { _and: [node, { a: { _eq: i } }] };
    return node;
  };

  it('a canonical key grows linearly, never exponentially, with nesting', () => {
    for (const k of [64, 256, 1024]) {
      expect(canonicalizePredicate(deepAnd(k)).length).toBeLessThan(40 * k);
    }
    const a = canonicalizePredicate(deepAnd(256)).length;
    const b = canonicalizePredicate(deepAnd(1024)).length; // 4× the leaves
    expect(b / a).toBeLessThan(6); // linear ⇒ ~4; exponential would explode
  });

  it('CSE dedupes structurally-identical nodes instead of planning 64 copies', () => {
    const nested: QueryExpression[] = Array.from({ length: 64 }, (_, i) => ({
      name: `n${i}`, // distinct names, identical compute shape
      select: ['x'],
    }));
    const plan = planQuery({ source: 's', select: nested }, { indexFor: () => undefined, defaultSource: 's' });
    expect(plan.nodes.size).toBe(2); // root + ONE deduped child
  });
});

// ── DataView — incremental grouped maintenance is O(1) per inserted row ─────

describe('DataView IncrementalGrouped — O(1) per folded row', () => {
  const n = 10_000;
  const data: Row[] = Array.from({ length: n }, (_, i) => ({ g: i % 2 === 0 ? 'a' : 'b', v: 1 }));
  const groupQuery: QueryExpression = {
    source: 's',
    group_by: ['g', { name: 'total', aggregate: { _sum: 'v' } }],
  };

  const warm = (): { dv: DataView; byPlan: Map<string, RawIncrementalGrouped>; cache: RawIncrementalGrouped } => {
    const dv = new DataView([{ name: 's', data: [...data] }]);
    dv.query(groupQuery);
    const byPlan = (dv as unknown as RawDataView).caches.get('s');
    if (byPlan === undefined) throw new Error('expected an incremental cache for the source');
    const cache = [...byPlan.values()][0];
    if (cache === undefined) throw new Error('expected a warmed IncrementalGrouped cache');
    return { dv, byPlan, cache };
  };

  it('insert folds only the new row, not the existing dataset', () => {
    const { dv, cache } = warm();
    const orig = cache.applyRow.bind(cache);
    let calls = 0;
    cache.applyRow = (row, weight) => { calls += 1; return orig(row, weight); };
    dv.insert('s', { g: 'a', v: 5 });
    expect(calls).toBe(1); // a full recompute would fold all n+1 rows
    dv.append('s', Array.from({ length: 7 }, () => ({ g: 'b', v: 2 })));
    expect(calls).toBe(8); // +7, still independent of n
  });

  it('retracting an invertible monoid applies one -1 delta and keeps the cache', () => {
    const { dv, byPlan, cache } = warm();
    const orig = cache.applyRow.bind(cache);
    const weights: number[] = [];
    cache.applyRow = (row, weight) => { weights.push(weight); return orig(row, weight); };
    dv.remove('s', { g: 'b', v: 1 });
    expect(weights).toEqual([-1]);
    expect(byPlan.has(planKey(groupQuery))).toBe(true);
  });

  it('a non-invertible (`_max`) retraction drops the cache for a bounded recompute', () => {
    const dv = new DataView([{ name: 's', data: [{ g: 'a', v: 1 }, { g: 'a', v: 5 }] }]);
    const q: QueryExpression = { source: 's', group_by: ['g', { name: 'm', aggregate: { _max: 'v' } }] };
    dv.query(q);
    const byPlan = (dv as unknown as RawDataView).caches.get('s');
    if (byPlan === undefined) throw new Error('expected a cache');
    const cache = [...byPlan.values()][0];
    if (cache === undefined) throw new Error('expected a cache entry');
    const orig = cache.applyRow.bind(cache);
    let calls = 0;
    cache.applyRow = (row, weight) => { calls += 1; return orig(row, weight); };
    dv.remove('s', { g: 'a', v: 5 });
    expect(calls).toBe(0); // no delta fold for a non-invertible fold
    expect(byPlan.has(planKey(q))).toBe(false); // dropped → recomputed next query
    expect(dv.query(q)).toEqual([{ g: 'a', m: 1 }]);
  });

  it('the incremental result matches a reference recompute', () => {
    const { dv } = warm();
    dv.insert('s', { g: 'a', v: 5 });
    dv.remove('s', { g: 'b', v: 1 });
    const source = dv.get('s');
    const ctx: EvalCtx = { sourceRows: source, sources: new Map([['s', source]]), memo: new Map() };
    const sortKey = (r: Row): string => String(r['g']);
    expect([...dv.query(groupQuery)].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
      [...execute(groupQuery, source, ctx)].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    );
  });
});

// ── window evaluation — a bounded frame bounds the fold work ────────────────

describe('execute window phase — bounded frame bounds fold work', () => {
  const windowQuery = (frame: [number, number] | ['unbounded', 'unbounded']): QueryExpression => ({
    select: [
      { name: 'w', aggregate: { _sum: 'v', _window: { field: 'ts', frame_mode: 'rows', frame } } },
    ],
  });

  /** The number of reads of the folded operand `v` across one windowed execute. */
  const vReads = (n: number, frame: [number, number] | ['unbounded', 'unbounded']): number => {
    const raw: Row[] = Array.from({ length: n }, (_, i) => ({ ts: i, v: 1 }));
    const meter = meterRows(raw);
    execute(windowQuery(frame), meter.rows);
    return meter.v();
  };

  it('a constant ROWS frame is linear in n (exponent ≈ 1)', () => {
    const a = vReads(256, [-1, 1]);
    const b = vReads(512, [-1, 1]);
    const exponent = Math.log2(b / a);
    expect(exponent).toBeGreaterThan(0.6);
    expect(exponent).toBeLessThan(1.5);
    expect(a).toBeLessThan(256 * 3 + 256); // ≈ (window + spread) per row, not n²
  });

  it('an unbounded frame is quadratic — the frame is what bounds the work', () => {
    const a = vReads(256, ['unbounded', 'unbounded']);
    const b = vReads(512, ['unbounded', 'unbounded']);
    expect(Math.log2(b / a)).toBeGreaterThan(1.5); // ~4× work for 2× rows
  });

  it('a bounded ROWS frame computes the correct moving sum', () => {
    const values = [10, 20, 30, 40];
    const out = execute(windowQuery([-1, 1]), values.map((v, i) => ({ ts: i, v })));
    const naive = values.map((_, i) =>
      values.slice(Math.max(0, i - 1), Math.min(values.length, i + 2)).reduce((s, x) => s + x, 0)
    );
    expect(out.map((r) => r['w'])).toEqual(naive);
  });

  it('partitions the window by the partition key', () => {
    const data: Row[] = [
      { p: 'a', ts: 1, v: 1 },
      { p: 'b', ts: 1, v: 10 },
      { p: 'a', ts: 2, v: 2 },
    ];
    const q: QueryExpression = {
      select: [
        { name: 'w', aggregate: { _sum: 'v', _window: { field: 'ts', partition_by: 'p', frame: ['unbounded', 0] } } },
      ],
    };
    expect(execute(q, data).map((r) => r['w'])).toEqual([1, 10, 3]);
  });
});
