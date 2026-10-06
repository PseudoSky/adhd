import { describe, expect, it } from 'vitest';
import { canonicalizePredicate, computeKey, planKey } from './canonical';
import { computeAccessPath, planQuery } from './plan';
import { IndexStore } from './indexing';
import { DataView } from './dataview';
import { execute, type EvalCtx } from './execute';
import type { Predicate, QueryExpression, Row } from './types';

const store = (rows: Row[], fields: Array<{ field: string; kind: 'eq' | 'range' | 'bitmap' }>): IndexStore => {
  const s = new IndexStore(fields);
  for (const r of rows) s.add(r);
  return s;
};

describe('canonicalization (§13)', () => {
  it('is order-independent for object keys and commutative arrays', () => {
    expect(canonicalizePredicate({ a: { _eq: 1 }, b: { _eq: 2 } })).toBe(
      canonicalizePredicate({ b: { _eq: 2 }, a: { _eq: 1 } })
    );
    expect(canonicalizePredicate({ _and: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] })).toBe(
      canonicalizePredicate({ _and: [{ b: { _eq: 2 } }, { a: { _eq: 1 } }] })
    );
    expect(canonicalizePredicate({ a: { _in: [2, 1] } })).toBe(
      canonicalizePredicate({ a: { _in: [1, 2, 2] } })
    );
  });

  it('preserves order where evaluation depends on it (arithmetic)', () => {
    expect(canonicalizePredicate({ a: { _eq: { _add: ['x', 'y'] } } })).not.toBe(
      canonicalizePredicate({ a: { _eq: { _add: ['y', 'x'] } } })
    );
  });

  it('`planKey` distinguishes `name`, `computeKey` normalizes it away', () => {
    const a: QueryExpression = { source: 's', name: 'x', select: ['k'] };
    const b: QueryExpression = { source: 's', name: 'y', select: ['k'] };
    expect(planKey(a)).not.toBe(planKey(b));
    expect(computeKey(a)).toBe(computeKey(b));
  });
});

describe('access-path selection (§11)', () => {
  const rows: Row[] = [
    { a: 'x', v: 1 },
    { a: 'y', v: 5 },
    { a: 'x', v: 9 },
  ];

  it('picks an index for an indexable predicate, scan otherwise', () => {
    const s = store(rows, [
      { field: 'a', kind: 'eq' },
      { field: 'v', kind: 'range' },
    ]);
    expect(computeAccessPath({ a: { _eq: 'x' } }, s)).toEqual({ kind: 'index', ids: new Set([0, 2]) });
    expect(computeAccessPath({ nope: { _eq: 1 } }, s).kind).toBe('scan');
    expect(computeAccessPath(undefined, s).kind).toBe('scan');
    expect(computeAccessPath({ a: { _eq: 'x' } }, undefined).kind).toBe('scan');
  });

  it('intersects an `_and`, unions a fully-indexable `_or`, scans a partial `_or`', () => {
    const s = store(rows, [
      { field: 'a', kind: 'eq' },
      { field: 'v', kind: 'range' },
    ]);
    expect(computeAccessPath({ _and: [{ a: { _eq: 'x' } }, { v: { _gte: 5 } }] }, s)).toEqual({
      kind: 'index',
      ids: new Set([2]),
    });
    expect(computeAccessPath({ _or: [{ a: { _eq: 'x' } }, { v: { _gt: 4 } }] }, s)).toEqual({
      kind: 'index',
      ids: new Set([0, 1, 2]),
    });
    expect(computeAccessPath({ _or: [{ a: { _eq: 'x' } }, { nope: { _eq: 1 } }] }, s).kind).toBe('scan');
  });

  it('keeps narrowing when a `_not` sits beside an indexable conjunct', () => {
    const s = store(rows, [
      { field: 'a', kind: 'eq' },
      { field: 'v', kind: 'range' },
    ]);
    // `X AND NOT Y` is still ⊆ X — the fix from the older `return undefined on _not`.
    expect(computeAccessPath({ _and: [{ a: { _eq: 'x' } }, { _not: { v: { _lt: 0 } } }] }, s)).toEqual({
      kind: 'index',
      ids: new Set([0, 2]),
    });
    expect(computeAccessPath({ _not: { a: { _eq: 'x' } } }, s).kind).toBe('scan'); // pure negation
  });

  it('a POST-only where yields a scan (access uses the PRE predicate only)', () => {
    const range = store([{ cost: 1 }], [{ field: 'cost', kind: 'range' }]);
    const plan = planQuery(
      { source: 's', group_by: [{ name: 'cost', aggregate: { _sum: 'cost' } }], where: { cost: { _gt: 0 } } },
      { indexFor: () => range, defaultSource: 's' }
    );
    expect(plan.root.access.kind).toBe('scan');
  });
});

describe('planQuery structure (§13)', () => {
  it('registers the root, a select-nested query, and an `_in` subquery', () => {
    const q: QueryExpression = {
      source: 's',
      where: { f: { _in: { name: 'sub', select: ['id'], where: { flag: { _eq: true } } } } },
      select: [{ name: 'nested', select: ['x'] }],
    };
    const plan = planQuery(q, { indexFor: () => undefined, defaultSource: 's' });
    expect(plan.nodes.size).toBe(3);
    expect(plan.root.readsSource).toBe(true);
    expect(plan.root.childKeys).toHaveLength(2);
  });
});

describe('index-accelerated execution matches a scan (§11/§13)', () => {
  const data: Row[] = [
    { agent: 'a', cost: -5 },
    { agent: 'a', cost: 8 },
    { agent: 'b', cost: 10 },
  ];

  it('NEGATIVE CONTROL: access uses the PRE predicate only — a post-group name never picks an index', () => {
    // `cost` is BOTH a raw field and a group-output name. The `cost` where-leaf is
    // POST (the aggregated sum), so the access path may use only `agent` (PRE).
    // A wrong planner that indexes on the full where would drop the raw `-5` row and
    // compute sum=8 instead of the correct (-5 + 8) = 3.
    const q: QueryExpression = {
      source: 's',
      group_by: ['agent', { name: 'cost', aggregate: { _sum: 'cost' } }],
      where: { _and: [{ agent: { _eq: 'a' } }, { cost: { _gt: 0 } }] },
    };
    const indexed = new DataView([{ name: 's', data: [...data] }], {
      indexes: {
        s: [
          { field: 'agent', kind: 'eq' },
          { field: 'cost', kind: 'range' },
        ],
      },
    });
    const plain = new DataView([{ name: 's', data: [...data] }]);
    expect(indexed.query(q)).toEqual([{ agent: 'a', cost: 3 }]);
    expect(indexed.query(q)).toEqual(plain.query(q));
  });

  it('keys the `_in` subquery memo canonically (structurally-equal operands compute once)', () => {
    const rows: Row[] = [{ k: 1 }, { k: 2 }, { k: 3 }];
    const ctx: EvalCtx = { sourceRows: rows, sources: new Map(), memo: new Map() };
    const subA: QueryExpression = { name: 'sub', select: ['k'], where: { a: { _eq: 1 }, b: { _eq: 2 } } };
    const subB: QueryExpression = { select: ['k'], name: 'sub', where: { b: { _eq: 2 }, a: { _eq: 1 } } };
    const q: QueryExpression = { where: { _and: [{ k: { _in: subA } }, { k: { _nin: subB } }] } };
    execute(q, rows, ctx);
    expect(ctx.memo.size).toBe(1); // JSON.stringify would key these two differently
  });

  it('canonical plan key makes group_by-order-equivalent queries share the incremental cache', () => {
    const q1: QueryExpression = { source: 's', group_by: ['k', { name: 'total', aggregate: { _sum: 'v' } }] };
    const q2: QueryExpression = { source: 's', group_by: [{ name: 'total', aggregate: { _sum: 'v' } }, 'k'] };
    expect(planKey(q1)).toBe(planKey(q2));
    const dv = new DataView([{ name: 's', data: [{ k: 'x', v: 1 }, { k: 'y', v: 2 }, { k: 'x', v: 3 }] }]);
    expect(dv.query(q1)).toEqual(dv.query(q2));
  });
});

describe('audit fixes (§11/§7) — access & order soundness', () => {
  it('B1: a non-finite or non-number value in a range-indexed field matches a scan', () => {
    const data: Row[] = [{ v: 0 }, { v: NaN }, { v: Infinity }, { v: -Infinity }, { v: 'z' }];
    const indexed = new DataView([{ name: 's', data: [...data] }], {
      indexes: { s: [{ field: 'v', kind: 'range' }] },
    });
    const plain = new DataView([{ name: 's', data: [...data] }]);
    const wheres: Predicate[] = [
      { v: { _gte: 0 } },
      { v: { _gt: 0 } },
      { v: { _lt: 0 } },
      { v: { _lte: 0 } },
    ];
    for (const where of wheres) {
      expect(indexed.query({ source: 's', where })).toEqual(plain.query({ source: 's', where }));
    }
  });

  it('B7: order_by honours the null-ordering variants', () => {
    const data: Row[] = [{ v: 1 }, { v: null }, { v: 2 }];
    const vals = (q: QueryExpression): unknown[] => execute(q, data).map((r) => r['v']);
    expect(vals({ select: ['v'], order_by: [{ v: 'asc' }] })).toEqual([1, 2, null]);
    expect(vals({ select: ['v'], order_by: [{ v: 'asc_nulls_first' }] })).toEqual([null, 1, 2]);
    expect(vals({ select: ['v'], order_by: [{ v: 'desc' }] })).toEqual([null, 2, 1]);
    expect(vals({ select: ['v'], order_by: [{ v: 'desc_nulls_last' }] })).toEqual([2, 1, null]);
  });
});
