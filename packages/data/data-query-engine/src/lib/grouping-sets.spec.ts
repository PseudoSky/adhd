/**
 * `rollup(...)` / `cube(...)` grouping-set verbs and the completed fluent surface.
 *
 * A grouping set is a relation-valued `select` item: a parent query with NO
 * `group_by` sees the whole dataset and emits one row keyed by each set's name.
 * These specs assert the numbers from the owner's live proof and that the fluent
 * verbs round-trip to the equivalent `setQuery(...)` / `query({...})` idiom.
 */
import { describe, it, expect } from 'vitest';
import { DataView, type QueryExpression } from '../index';

type Row = Record<string, unknown>;

// region sums: east=3, west=4  |  product sums: x=5, y=2  |  total=7
const ROWS: Row[] = [
  { region: 'east', product: 'x', amount: 2 },
  { region: 'east', product: 'y', amount: 1 },
  { region: 'west', product: 'x', amount: 3 },
  { region: 'west', product: 'y', amount: 1 },
];

const AGG = { name: 'amount', aggregate: { _sum: 'amount' } };
const asObj = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

describe('rollup(...) — hierarchical grouping sets as select relations', () => {
  it('emits the full set, the prefix set, and the grand total', () => {
    const out = new DataView(ROWS).groupBy([AGG]).rollup('region', 'product').view();
    const o = asObj(out[0]);
    expect(Object.keys(o)).toEqual(['region_product', 'region', 'total']);
    expect(o['region']).toEqual([
      { region: 'east', amount: 3 },
      { region: 'west', amount: 4 },
    ]);
    expect(o['total']).toEqual([{ amount: 7 }]);
    expect(o['region_product'] as unknown[]).toHaveLength(4);
  });

  it('matches the explicit select-relation idiom', () => {
    const explicit = new DataView(ROWS).query({
      select: [
        { name: 'region_product', group_by: ['region', 'product', AGG] },
        { name: 'region', group_by: ['region', AGG] },
        { name: 'total', group_by: [AGG] },
      ],
    });
    const fluent = new DataView(ROWS).groupBy([AGG]).rollup('region', 'product').view();
    expect(fluent).toEqual(explicit);
  });
});

describe('cube(...) — every subset as a select relation', () => {
  it('emits all subsets (full, each single dim, grand total)', () => {
    const out = new DataView(ROWS).groupBy([AGG]).cube('region', 'product').view();
    const o = asObj(out[0]);
    expect(Object.keys(o)).toEqual(['region_product', 'region', 'product', 'total']);
    expect(o['region']).toEqual([
      { region: 'east', amount: 3 },
      { region: 'west', amount: 4 },
    ]);
    expect(o['product']).toEqual([
      { product: 'x', amount: 5 },
      { product: 'y', amount: 2 },
    ]);
    expect(o['total']).toEqual([{ amount: 7 }]);
  });

  it('matches the explicit select-relation idiom', () => {
    const explicit = new DataView(ROWS).query({
      select: [
        { name: 'region_product', group_by: ['region', 'product', AGG] },
        { name: 'region', group_by: ['region', AGG] },
        { name: 'product', group_by: ['product', AGG] },
        { name: 'total', group_by: [AGG] },
      ],
    });
    const fluent = new DataView(ROWS).groupBy([AGG]).cube('region', 'product').view();
    expect(fluent).toEqual(explicit);
  });

  it('defaults to a `_count` aggregate when none is set', () => {
    const out = new DataView(ROWS).cube('region').view();
    const o = asObj(out[0]);
    expect(o['region']).toEqual([
      { region: 'east', count: 2 },
      { region: 'west', count: 2 },
    ]);
    expect(o['total']).toEqual([{ count: 4 }]);
  });
});

describe('the completed fluent surface', () => {
  it('each new slot method round-trips to the equivalent setQuery', () => {
    const fluent = new DataView(ROWS)
      .from('data')
      .as('x')
      .aggregate({ _count: true })
      .toJson();
    const explicit: QueryExpression = new DataView(ROWS)
      .setQuery({ source: 'data', name: 'x', aggregate: { _count: true } })
      .toJson();
    expect(fluent).toEqual(explicit);
    expect(fluent).toEqual({ source: 'data', name: 'x', aggregate: { _count: true } });
  });

  it('`from(source)` binds the input dataset for query()', () => {
    const dv = new DataView([
      { name: 'a', data: [{ v: 1 }] },
      { name: 'b', data: [{ v: 2 }] },
    ]);
    expect(dv.from('b').query()).toEqual([{ v: 2 }]);
    expect(dv.from('a').query()).toEqual([{ v: 1 }]);
  });

  it('every slot method composes into the same query a setQuery would build', () => {
    const fluent = new DataView(ROWS)
      .where({ amount: { _gt: 0 } })
      .groupBy([AGG])
      .select([{ name: 'region', group_by: ['region', AGG] }])
      .qualify({ amount: { _gt: 0 } })
      .orderBy([{ region: 'asc' }])
      .limit(10)
      .offset(0)
      .toJson();
    const explicit: QueryExpression = new DataView(ROWS)
      .setQuery({
        where: { amount: { _gt: 0 } },
        group_by: [AGG],
        select: [{ name: 'region', group_by: ['region', AGG] }],
        qualify: { amount: { _gt: 0 } },
        order_by: [{ region: 'asc' }],
        limit: 10,
        offset: 0,
      })
      .toJson();
    expect(fluent).toEqual(explicit);
  });
});
