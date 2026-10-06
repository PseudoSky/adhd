import { describe, it, expect } from 'vitest';
import { DataView } from '../index';
import type { QueryExpression } from '../index';

type Row = Record<string, unknown>;

const view = (rows: Row[], query: QueryExpression): Row[] =>
  new DataView(rows, query).view() as unknown as Row[];

/**
 * Guard specs for the six approved gap items on SPEC 49a62647 / ADR-0005,
 * re-expressed in the ONE canonical grammar (`group_by` items are position-typed;
 * nested grouping is a nested `select`; the aggregate surface is the fold
 * vocabulary). Every `it` is binary.
 */

describe('GAP-1 — select is a pure FINAL projection', () => {
  it('projects to the selected fields only', () => {
    expect(view([{ a: 1, b: 2 }], { select: ['a'] })).toEqual([{ a: 1 }]);
  });

  it('is applied AFTER order_by/limit, so non-selected sort keys are allowed', () => {
    const rows = [
      { a: 'x', rank: 3 },
      { a: 'y', rank: 1 },
      { a: 'z', rank: 2 },
    ];
    expect(
      view(rows, { order_by: [{ rank: 'asc' }], limit: 2, select: ['a'] })
    ).toEqual([{ a: 'y' }, { a: 'z' }]);
  });

  it('resolves grouped-key output refs and aggregate output names', () => {
    const rows = [
      { g: 'a', x: 1 },
      { g: 'a', x: 2 },
      { g: 'b', x: 5 },
    ];
    expect(
      view(rows, {
        group_by: ['g', { name: 's', aggregate: { _sum: 'x' } }],
        order_by: [{ g: 'asc' }],
        select: ['g', 's'],
      })
    ).toEqual([
      { g: 'a', s: 3 },
      { g: 'b', s: 5 },
    ]);
  });

  it('a select projection deliberately reshapes rows', () => {
    const rows = [{ a: 1, b: 2 }];
    expect(view(rows, {})).toEqual([{ a: 1, b: 2 }]);
    expect(view(rows, { select: ['a'] })).toEqual([{ a: 1 }]);
  });
});

describe('GAP-2 — hierarchical grouping is a nested select (roots-with-children)', () => {
  const rows = [
    { region: 'eu', country: 'fr', cost: 10 },
    { region: 'eu', country: 'fr', cost: 5 },
    { region: 'eu', country: 'de', cost: 7 },
    { region: 'us', country: 'ny', cost: 3 },
  ];

  it('produces a two-level tree with per-node aggregates', () => {
    const result = view(rows, {
      group_by: ['region', { name: 'total', aggregate: { _sum: 'cost' } }],
      select: [
        'region',
        'total',
        {
          name: 'children',
          group_by: ['country', { name: 'total', aggregate: { _sum: 'cost' } }],
        },
      ],
      order_by: [{ region: 'asc' }],
    });

    expect(result).toEqual([
      {
        region: 'eu',
        total: 22,
        children: [
          { country: 'fr', total: 15 },
          { country: 'de', total: 7 },
        ],
      },
      {
        region: 'us',
        total: 3,
        children: [{ country: 'ny', total: 3 }],
      },
    ]);
  });

  it('applies top-N to a level via order_by + keep (merged _other)', () => {
    const result = view(rows, {
      group_by: ['region', { name: 'total', aggregate: { _sum: 'cost' } }],
      select: [
        'region',
        'total',
        {
          name: 'children',
          group_by: ['country', { name: 'total', aggregate: { _sum: 'cost' } }],
          order_by: [{ total: 'desc' }],
          keep: { n: 1, other: true },
        },
      ],
      order_by: [{ region: 'asc' }],
    });

    expect(result).toEqual([
      {
        region: 'eu',
        total: 22,
        children: [
          { country: 'fr', total: 15 },
          { _other: true, total: 7 },
        ],
      },
      {
        region: 'us',
        total: 3,
        children: [{ country: 'ny', total: 3 }],
      },
    ]);
  });
});

describe('GAP-3 — comma/bracket path notation on the aggregation surface', () => {
  it('a fold over x,y[0] resolves the nested value', () => {
    expect(
      view([{ x: { y: [5] } }, { x: { y: [7] } }], {
        group_by: [{ name: 's', aggregate: { _sum: 'x,y[0]' } }],
      })
    ).toEqual([{ s: 12 }]);
  });

  it('group_by accepts comma/bracket notation', () => {
    const rows = [
      { x: { y: [1] }, v: 10 },
      { x: { y: [2] }, v: 20 },
    ];
    expect(
      view(rows, {
        group_by: ['x,y[0]', { name: 's', aggregate: { _sum: 'v' } }],
        order_by: [{ 'x,y[0]': 'asc' }],
      })
    ).toEqual([
      { 'x,y[0]': 1, s: 10 },
      { 'x,y[0]': 2, s: 20 },
    ]);
  });
});

describe('GAP-4 — dotted group keys are addressable downstream (exact-name-first)', () => {
  it('order_by can address a flat dotted group key', () => {
    const rows = [{ a: { b: 'x' } }, { a: { b: 'y' } }, { a: { b: 'z' } }];
    expect(
      view(rows, { group_by: ['a.b'], order_by: [{ 'a.b': 'desc' }] })
    ).toEqual([{ 'a.b': 'z' }, { 'a.b': 'y' }, { 'a.b': 'x' }]);
  });

  it('distinct_on can address a flat dotted group key', () => {
    const rows = [{ a: { b: 'x' } }, { a: { b: 'x' } }, { a: { b: 'y' } }];
    expect(view(rows, { distinct_on: ['a.b'] })).toEqual([
      { a: { b: 'x' } },
      { a: { b: 'y' } },
    ]);
  });

  it('prefers an exact property named like a path over the nested path', () => {
    // A row literally carrying the key "a.b" wins over row.a.b.
    const rows = [{ 'a.b': 'flat', a: { b: 'nested' } }];
    expect(view(rows, { order_by: [{ 'a.b': 'asc' }] })).toEqual(rows);
  });
});

describe('GAP-5 — absolute date-time range operators', () => {
  const A = Date.UTC(2026, 0, 1, 0, 0, 0);
  const B = Date.UTC(2026, 0, 1, 1, 0, 0);
  const rows = [
    { id: 1, t: A - 1 },
    { id: 2, t: A },
    { id: 3, t: (A + B) / 2 },
    { id: 4, t: B },
    { id: 5, t: B + 1 },
  ];
  const ids = (r: Row[]) => r.map((x) => x['id']);

  it('_in_datetimerange includes both ends', () => {
    expect(ids(view(rows, { where: { t: { _in_datetimerange: [[A, B]] } } }))).toEqual([
      2, 3, 4,
    ]);
  });

  it('_nin_datetimerange is the complement', () => {
    expect(ids(view(rows, { where: { t: { _nin_datetimerange: [[A, B]] } } }))).toEqual([
      1, 5,
    ]);
  });

  it('null / non-coercible row values are false for _in and true for _nin', () => {
    const withNull = [{ id: 1, t: null }, { id: 2, t: A }];
    expect(ids(view(withNull, { where: { t: { _in_datetimerange: [[A, B]] } } }))).toEqual([2]);
    expect(ids(view(withNull, { where: { t: { _nin_datetimerange: [[A, B]] } } }))).toEqual([1]);
  });

  it('an empty range list is false for _in and true for _nin', () => {
    expect(ids(view(rows, { where: { t: { _in_datetimerange: [] } } }))).toEqual([]);
    expect(ids(view(rows, { where: { t: { _nin_datetimerange: [] } } }))).toEqual([1, 2, 3, 4, 5]);
  });

  it('a malformed bound contributes false without throwing', () => {
    expect(ids(view(rows, { where: { t: { _in_datetimerange: [['not-a-date', B]] } } }))).toEqual([]);
    expect(ids(view(rows, { where: { t: { _nin_datetimerange: [['not-a-date', B]] } } }))).toEqual([1, 2, 3, 4, 5]);
  });

  it('a reversed range matches nothing (no auto-swap)', () => {
    expect(ids(view(rows, { where: { t: { _in_datetimerange: [[B, A]] } } }))).toEqual([]);
  });

  it('DIVERGENCE — the _between sugar returns identical rows to the general form', () => {
    const sugar = view(rows, { where: { t: { _between: [A, B] } } });
    const general = view(rows, { where: { t: { _in_datetimerange: [[A, B]] } } });
    expect(sugar).toEqual(general);
    expect(ids(sugar)).toEqual([2, 3, 4]);

    const nSugar = view(rows, { where: { t: { _nbetween: [A, B] } } });
    const nGeneral = view(rows, { where: { t: { _nin_datetimerange: [[A, B]] } } });
    expect(nSugar).toEqual(nGeneral);
    expect(ids(nSugar)).toEqual([1, 5]);
  });

  it('_overlaps tests an interval row value, unlike the point test', () => {
    const spans = [
      { id: 1, span: [A - 1000, A + 1000] },
      { id: 2, span: [B + 1, B + 2] },
    ];
    expect(ids(view(spans, { where: { span: { _overlaps: [[A, B]] } } }))).toEqual([1]);
    // A point test on the same interval value would look at span[0], not the
    // interval, and would be a different predicate entirely.
  });
});
