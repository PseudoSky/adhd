import { describe, it, expect } from 'vitest';
import { DataView, QueryValidationError } from '../index';
import type { QueryExpression } from '../index';

type Row = Record<string, unknown>;

const view = (rows: Row[], query: QueryExpression): Row[] =>
  new DataView(rows, query).view() as unknown as Row[];

/**
 * Guard specs for the six approved gap items on SPEC 49a62647 / ADR-0005.
 *
 * Every `it` in this file is written so that it FAILS against the pre-change
 * implementation and PASSES once the item is implemented:
 *  - `select` was ignored entirely (GAP-1)
 *  - `_nest` did not exist and threw from resolveGroupKeys (GAP-2)
 *  - the aggregation surface used `fastGet`, which read `x,y[0]` as a literal
 *    property => undefined (GAP-3)
 *  - dotted group keys were stored flat but resolved as paths downstream
 *    (GAP-4)
 *  - the date-range operators threw `unknown operator ...` (GAP-5)
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
        group_by: ['g'],
        aggregate: { s: { _sum: 'x' } },
        order_by: [{ g: 'asc' }],
        select: ['g', 's'],
      })
    ).toEqual([
      { g: 'a', s: 3 },
      { g: 'b', s: 5 },
    ]);
  });

  it('keeps the output:rows identity guarantee only when select is absent', () => {
    const rows = [{ a: 1, b: 2 }];
    // With no select, rows pass through unchanged (identity) ...
    expect(view(rows, {})).toEqual([{ a: 1, b: 2 }]);
    // ... and with a select the projection intentionally breaks identity.
    expect(view(rows, { select: ['a'] })).toEqual([{ a: 1 }]);
  });
});

describe('GAP-2 — nested group-by (_nest) builds roots-with-children in one pass', () => {
  const rows = [
    { region: 'eu', country: 'fr', cost: 10 },
    { region: 'eu', country: 'fr', cost: 5 },
    { region: 'eu', country: 'de', cost: 7 },
    { region: 'us', country: 'ny', cost: 3 },
  ];

  it('produces a two-level tree with per-node aggregates', () => {
    const result = view(rows, {
      group_by: {
        _nest: [
          {
            key: 'region',
            aggregate: { total: { _sum: 'cost' } },
            children: [
              { key: 'country', aggregate: { total: { _sum: 'cost' } } },
            ],
          },
        ],
      },
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

  it('applies per-node top_n to a node\u2019s own children with a merged _other', () => {
    const result = view(rows, {
      group_by: {
        _nest: [
          {
            key: 'region',
            aggregate: { total: { _sum: 'cost' } },
            top_n: { n: 1, by: 'total', other: true },
            children: [
              { key: 'country', aggregate: { total: { _sum: 'cost' } } },
            ],
          },
        ],
      },
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

  it('makes top-level aggregate/having/top_n mutually exclusive with _nest', () => {
    expect(
      () =>
        new DataView(rows, {
          group_by: { _nest: [{ key: 'region' }] },
          aggregate: { total: { _sum: 'cost' } },
        })
    ).toThrow(QueryValidationError);

    expect(
      () =>
        new DataView(rows, {
          group_by: { _nest: [{ key: 'region' }] },
          top_n: { n: 2, by: 'region' },
        })
    ).toThrow(QueryValidationError);
  });

  it('rejects output:rows on a nested query (nested emits groups only)', () => {
    expect(
      () =>
        new DataView(rows, {
          group_by: { _nest: [{ key: 'region' }] },
          output: 'rows',
        })
    ).toThrow(QueryValidationError);
  });
});

describe('GAP-3 — comma/bracket path notation on the aggregation surface', () => {
  it('aggregate._sum resolves x,y[0] against the nested value', () => {
    expect(
      view([{ x: { y: [5] } }, { x: { y: [7] } }], {
        aggregate: { s: { _sum: 'x,y[0]' } },
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
        group_by: ['x,y[0]'],
        aggregate: { s: { _sum: 'v' } },
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
  const ids = (r: Row[]) => r.map((x) => x.id);

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
