/**
 * Independent review harness (NOT part of the authored Big-O suite).
 *
 * 1. IndexStore soundness: `candidates` must be a PURE SUPERSET — no row that the
 *    exact predicate matches may be missing from a returned id-set (the impure
 *    range fallback is the risk). Checked against the real `matches` evaluator.
 * 2. Incremental grouped cache: after each insert/remove the incremental result must
 *    equal a full reference `execute` over the live source.
 * 3. Planner: is `planQuery` really O(query size)? Probed with a shared-reference
 *    DAG (the same subexpression object reused), which the planner does not memoize.
 */
import { describe, it, expect } from 'vitest';
import { IndexStore, type IndexField } from './indexing';
import { matches, execute, type EvalCtx } from './execute';
import { DataView } from './dataview';
import { planQuery } from './plan';
import type { Predicate, QueryExpression, Row } from './types';

// ── 1. IndexStore — candidates is a pure superset ───────────────────────────

describe('IndexStore — candidates never drops a row the predicate matches', () => {
  const rows: Row[] = [
    { a: 'x', g: 3, v: 1 },
    { a: 'y', g: 1, v: 5 },
    { a: 'x', g: 3, v: '3' }, // impure: a string in the range field
    { a: 'z', g: 2, v: 10 },
    { a: 'x', g: 1, v: -2 },
    { a: 'y', g: 3, v: new Date('2020-01-01') }, // impure: a Date
    { a: 'x', g: 3, v: 0 },
    { a: 'y', g: 2, v: 7 },
  ];
  const fields: IndexField[] = [
    { field: 'a', kind: 'eq' },
    { field: 'g', kind: 'bitmap' },
    { field: 'v', kind: 'range' },
  ];
  const store = new IndexStore(fields);
  for (const r of rows) store.add(r);
  const ctx: EvalCtx = { sourceRows: rows, sources: new Map(), memo: new Map() };

  const predicates: Predicate[] = [
    { g: { _eq: 3 } },
    { g: { _in: [1, 3] } },
    { a: { _eq: 'x' } },
    { a: { _in: ['x', 'z'] } },
    { v: { _between: [2, 8] } },
    { v: { _gt: 3 } },
    { v: { _gte: 0 } },
    { v: { _lt: 5 } },
    { v: { _lte: 7 } },
    { _and: [{ v: { _gt: -1 } }, { g: { _eq: 3 } }] },
    { _or: [{ v: { _lt: 6 } }, { g: { _eq: 2 } }] },
    { _not: { g: { _eq: 1 } } },
    { v: { _gt: 0 }, g: { _eq: 2 } }, // implicit AND of a range leaf + a bitmap leaf
  ];

  it('every true match is contained in candidates (or candidates is undefined)', () => {
    for (const pred of predicates) {
      const trueIds = rows.map((r, i) => (matches(pred, r, ctx) ? i : -1)).filter((i) => i >= 0);
      const cand = store.candidates(pred);
      if (cand === undefined) continue; // no narrowing — sound by definition
      for (const id of trueIds) {
        expect(cand.has(id), `predicate ${JSON.stringify(pred)} dropped id ${id}`).toBe(true);
      }
    }
  });

  it('an impure range field disables range narrowing (never a wrong exact set)', () => {
    // `v` held a string and a Date, so `rangeImpure` is set: a range-only predicate
    // must return undefined (fall back to scan), NOT a set missing those rows.
    expect(store.candidates({ v: { _gt: 0 } })).toBeUndefined();
  });

  it('a pure numeric range field narrows exactly', () => {
    const pureRows: Row[] = [{ v: 1 }, { v: 5 }, { v: 10 }, { v: -2 }, { v: 0 }, { v: 7 }];
    const pure = new IndexStore([{ field: 'v', kind: 'range' }]);
    for (const r of pureRows) pure.add(r);
    const ids = pure.candidates({ v: { _between: [2, 8] } });
    expect(ids).toBeDefined();
    const trueIds = pureRows
      .map((r, i) => (matches({ v: { _between: [2, 8] } }, r, ctx) ? i : -1))
      .filter((i) => i >= 0);
    expect([...(ids as Set<number>)].sort((x, y) => x - y)).toEqual(trueIds);
  });
});

// ── 2. Incremental grouped cache — retraction differential ──────────────────

describe('DataView incremental cache — matches a reference recompute after mutations', () => {
  const sortRows = (rs: Row[]): Row[] =>
    [...rs].sort((x, y) => String(x['g']).localeCompare(String(y['g'])) || JSON.stringify(x).localeCompare(JSON.stringify(y)));

  const q: QueryExpression = {
    source: 's',
    group_by: [
      'g',
      { name: 'total', aggregate: { _sum: 'v' } },
      { name: 'n', aggregate: { _count: true } },
      { name: 'nn', aggregate: { _count: 'v' } },
      { name: 'avg', aggregate: { _avg: 'v' } },
    ],
  };

  it('sum/count/avg stay exact across a randomized insert/remove sequence', () => {
    const initial: Row[] = Array.from({ length: 20 }, (_, i) => ({ g: `g${i % 3}`, v: i % 5 }));
    const dv = new DataView([{ name: 's', data: initial.map((r) => ({ ...r })) }]);
    dv.query(q); // warm the incremental cache

    const ref = (): Row[] => {
      const src = dv.get('s');
      const ctx: EvalCtx = { sourceRows: src, sources: new Map([['s', src]]), memo: new Map() };
      return sortRows(execute(q, src, ctx));
    };

    const ops: Array<() => void> = [
      () => dv.insert('s', { g: 'g0', v: 9 }),
      () => dv.insert('s', { g: 'g1', v: 1 }),
      () => dv.remove('s', { g: 'g0', v: 0 }),
      () => dv.append('s', [{ g: 'g2', v: 2 }, { g: 'g2', v: 3 }]),
      () => dv.remove('s', { g: 'g1', v: 1 }),
      () => dv.remove('s', { g: 'g2', v: 3 }),
      () => dv.insert('s', { g: 'g0', v: 4 }),
    ];
    for (const op of ops) {
      op();
      expect(sortRows(dv.query(q)), `after op`).toEqual(ref());
    }
  });

  it('a _min/_max fold: incremental inserts are exact, and a retraction recomputes exactly', () => {
    const qm: QueryExpression = {
      source: 's',
      group_by: ['g', { name: 'm', aggregate: { _min: 'v' } }, { name: 'x', aggregate: { _max: 'v' } }],
    };
    const dv = new DataView([
      { name: 's', data: [{ g: 'a', v: 5 }, { g: 'a', v: 2 }, { g: 'b', v: 9 }] },
    ]);
    dv.query(qm);
    const ref = (): Row[] => {
      const src = dv.get('s');
      const ctx: EvalCtx = { sourceRows: src, sources: new Map([['s', src]]), memo: new Map() };
      return sortRows(execute(qm, src, ctx));
    };
    dv.insert('s', { g: 'a', v: 1 });
    expect(sortRows(dv.query(qm))).toEqual(ref());
    dv.remove('s', { g: 'a', v: 1 }); // non-invertible → cache dropped + recomputed
    expect(sortRows(dv.query(qm))).toEqual(ref());
    dv.remove('s', { g: 'b', v: 9 });
    expect(sortRows(dv.query(qm))).toEqual(ref());
  });
});

// ── 3. Planner — shared subexpressions ──────────────────────────────────────

describe('planner — shared-reference subexpressions', () => {
  /** visit-count via a Proxy counting `select` reads. */
  function countPlanReads(depth: number): number {
    let reads = 0;
    const wrap = (obj: Record<string, unknown>): Record<string, unknown> =>
      new Proxy(obj, {
        get(t, p) {
          if (p === 'select') reads += 1;
          return Reflect.get(t, p, t);
        },
      });
    let cur = wrap({ select: ['x'] });
    for (let d = 0; d < depth; d++) cur = wrap({ select: [cur, cur] });
    planQuery(cur as unknown as QueryExpression, { indexFor: () => undefined, defaultSource: 's' });
    return reads;
  }

  it.fails('planQuery is O(query size) even when the same subexpression object is reused', () => {
    // The planner has no memo: a shared node is re-visited once per reference, so a
    // depth-d self-similar DAG costs ~2^d. A linear planner would grow ~4× per +2
    // depth; assert <4 to document the expected bound — it throws (exponential).
    const small = countPlanReads(10);
    const large = countPlanReads(14);
    expect(large / small).toBeLessThan(4);
  });

  it('measurement: the same DAG grows ~16× per +4 depth (exponential)', () => {
    const small = countPlanReads(10);
    const large = countPlanReads(14);
    // 2^4 = 16; this PASSES and records the observed blow-up as evidence.
    expect(large / small).toBeGreaterThan(8);
  });
});
