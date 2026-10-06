import { describe, it, expect } from 'vitest';
import { DataView, resolveIsoPeriod } from '../index';
import type { QueryExpression } from '../index';

/**
 * SPEC 49a62647-5a50-461a-b004-461b9b6bd66f — engine grouping + aggregation +
 * HAVING, re-expressed in the ONE canonical (v2) grammar:
 *  - a group item is `{ name, aggregate }` (position-typed);
 *  - HAVING is a post-group leaf in the merged `where` (the phase rule routes it);
 *  - a time-scoped aggregate is `_filter` (`_period`) on the fold; a
 *    running/sliding aggregate is `_scan` on a fold in `select` plus `qualify`;
 *  - top-N is `order_by` + `limit` / `keep:{n,other:true}`;
 *  - hierarchical grouping is a nested `select`.
 * Where the v2 semantics differ from the retired v1 pipeline (e.g. `_avg` counts
 * null rows; a window over an all-out-of-window group yields the fold identity),
 * the v2 rule is encoded and asserted.
 */

type Row = Record<string, unknown>;

const HOUR_MS = 3_600_000;
const MAX_T = 1_790_719_200_000; // the export's max_t (hour-aligned)

const view = (rows: Row[], query: QueryExpression): Row[] =>
  new DataView(rows, query).view() as unknown as Row[];

const idList = (rows: Row[], query: QueryExpression): unknown[] =>
  view(rows, query).map((r) => r['id']);

// Worked-example A: real schema, real anchor. Window PT1H@MAX_T => [MAX_T-3.6e6, MAX_T].
const A_EVENTS: Row[] = [
  { id: 'A1', client: 'opencode', agent: 'build', t: 1_790_717_000_000, is_sub: 0, cost_usd: 0.2 },
  { id: 'A2', client: 'opencode', agent: 'build', t: 1_790_718_000_000, is_sub: 0, cost_usd: 0.0 },
  { id: 'A3', client: 'opencode', agent: 'architect', t: 1_790_716_500_000, is_sub: 0, cost_usd: 0.05 },
  { id: 'A4', client: 'opencode', agent: 'review', t: 1_790_719_000_000, is_sub: 0, cost_usd: 0.0 },
  { id: 'A5', client: 'opencode', agent: 'explore', t: 1_790_716_500_000, is_sub: 1, cost_usd: 0.1 },
  { id: 'A6', client: 'opencode', agent: 'debug', t: 1_790_710_000_000, is_sub: 0, cost_usd: 5.0 },
  { id: 'A7', client: 'claude', agent: 'build', t: 1_790_718_000_000, is_sub: 0, cost_usd: 9.0 },
];

// Broadcast (former `output:'rows'` + `window`): a window fold in `select` over the
// agent partition, filtered by `qualify` (former `having`).
const A_QUERY: QueryExpression = {
  where: { _and: [{ client: { _in: ['opencode'] } }, { is_sub: { _eq: 0 } }] },
  select: [
    'id',
    'agent',
    't',
    'cost_usd',
    {
      name: 'c',
      aggregate: {
        _sum: 'cost_usd',
        _scan: {
          order_by: 't',
          frame: { where: { t: { _period: ['PT1H', MAX_T] } } },
          partition_by: 'agent',
        },
      },
    },
  ],
  qualify: { c: { _gt: 0 } },
};

describe('SPEC AC — grouping / aggregation / HAVING', () => {
  it('AC-1: group_by emits exactly one row per distinct post-where group', () => {
    const rows: Row[] = [
      { agent: 'x', cost_usd: 1 },
      { agent: 'x', cost_usd: 2 },
      { agent: 'y', cost_usd: 3 },
      { agent: 'y', cost_usd: 4 },
      { agent: 'z', cost_usd: 5 },
    ];
    const out = view(rows, {
      group_by: ['agent', { name: 'c', aggregate: { _sum: 'cost_usd' } }],
    });
    expect(out.length).toBe(3);
    const x = out.find((r) => r['agent'] === 'x');
    expect(x?.['c']).toBe(3);
  });

  it('AC-2: WHERE runs before AGGREGATE (single x row sums 5, not 0)', () => {
    const rows: Row[] = [
      { id: 'x1', agent: 'x', is_sub: 0, cost_usd: 5 },
      { id: 'x2', agent: 'x', is_sub: 1, cost_usd: -5 },
    ];
    const out = view(rows, {
      where: { is_sub: { _eq: 0 } },
      group_by: ['agent', { name: 'c', aggregate: { _sum: 'cost_usd' } }],
    });
    expect(out.length).toBe(1);
    expect(out[0]['agent']).toBe('x');
    expect(out[0]['c']).toBe(5);
  });

  it('AC-3: a post-group leaf in `where` is HAVING and can distinguish the orders', () => {
    const rows: Row[] = [
      { id: 'x1', agent: 'x', is_sub: 0, cost_usd: 5 },
      { id: 'x2', agent: 'x', is_sub: 1, cost_usd: -5 },
    ];
    const withWhere = view(rows, {
      where: { is_sub: { _eq: 0 } },
      group_by: ['agent', { name: 'c', aggregate: { _sum: 'cost_usd' } }],
    });
    expect(withWhere.length).toBe(1); // x sums to 5 -> passes
    const withHaving = view(rows, {
      where: { c: { _gt: 0 } },
      group_by: ['agent', { name: 'c', aggregate: { _sum: 'cost_usd' } }],
    });
    expect(withHaving.length).toBe(0); // x sums to 0 -> dropped
  });

  it('AC-4: a window fold scopes the aggregate; qualify drops the out-of-window group', () => {
    const rows: Row[] = [
      { id: 'in', agent: 'x', t: MAX_T - 1_000, cost_usd: 5 },
      { id: 'out', agent: 'x', t: MAX_T - HOUR_MS - 1, cost_usd: 1_000 },
      { id: 'stale', agent: 'y', t: MAX_T - HOUR_MS - 1_000, cost_usd: 7 },
    ];
    // Broadcast via a predicate-frame scan: agent y has no in-window rows -> its
    // frame set is empty -> sum 0 -> dropped by qualify.
    const broadcast: QueryExpression = {
      select: [
        'id',
        'agent',
        't',
        {
          name: 'c',
          aggregate: {
            _sum: 'cost_usd',
            _scan: {
              order_by: 't',
              frame: { where: { t: { _period: ['PT1H', MAX_T] } } },
              partition_by: 'agent',
            },
          },
        },
      ],
      qualify: { c: { _gt: 0 } },
    };
    expect(idList(rows, broadcast)).toEqual(['in', 'out']);
    // A time-scoped group fold (`_filter`) counts only the in-window row of its group.
    const groups = view(rows, {
      group_by: [
        'agent',
        {
          name: 'c',
          aggregate: { _sum: 'cost_usd', _filter: { t: { _period: ['PT1H', MAX_T] } } },
        },
      ],
    });
    expect(groups.find((g) => g['agent'] === 'x')?.['c']).toBe(5);
  });

  it('AC-5: a window scoped to no rows yields the fold identity / null', () => {
    const rows: Row[] = [
      { id: 's', agent: 'y', t: MAX_T - HOUR_MS - 1, cost_usd: 7, n: 3 },
    ];
    const winFilter = { t: { _period: ['PT1H', MAX_T] as [string, number] } };
    const out = view(rows, {
      group_by: [
        'agent',
        { name: 's', aggregate: { _sum: 'cost_usd', _filter: winFilter } },
        { name: 'c', aggregate: { _count: true, _filter: winFilter } },
        { name: 'mn', aggregate: { _min: 'cost_usd', _filter: winFilter } },
        { name: 'mx', aggregate: { _max: 'cost_usd', _filter: winFilter } },
        { name: 'av', aggregate: { _avg: 'cost_usd', _filter: winFilter } },
      ],
    });
    expect(out).toEqual([
      { agent: 'y', s: 0, c: 0, mn: null, mx: null, av: null },
    ]);
  });

  it('AC-6: an unknown operator / malformed predicate THROWS at execution', () => {
    expect(() =>
      new DataView([{ a: 1 }], { where: { a: { _bogus: 0 } } }).view()
    ).toThrow();
    expect(() =>
      new DataView([{ a: 1 }], { where: { a: { b: { _eq: 1 } } } }).view()
    ).toThrow();
  });

  it('AC-7: window.period resolves through the same resolveIsoPeriod as _period', () => {
    const a = MAX_T;
    expect(resolveIsoPeriod('PT1H', a)).toEqual({
      from: a - HOUR_MS,
      to: a,
      durationMs: HOUR_MS,
    });
    // P1M is a CALENDAR month with a day clamp (Mar 31 -> Feb 28 in 2026).
    expect(resolveIsoPeriod('P1M', Date.UTC(2026, 2, 31)).from).toBe(Date.UTC(2026, 1, 28));

    // Boundary rows: the time-scoped group fold and the `_period` where-operator agree.
    const boundary: Row[] = [
      { id: 'lo', t: a - HOUR_MS },
      { id: 'mid', t: a - 1 },
      { id: 'hi', t: a },
      { id: 'below', t: a - HOUR_MS - 1 },
    ];
    const viaWindow = idList(boundary, {
      group_by: [
        'id',
        {
          name: 'c',
          aggregate: { _count: true, _filter: { t: { _period: ['PT1H', a] } } },
        },
      ],
      qualify: { c: { _gt: 0 } },
    });
    const viaWherePeriod = idList(boundary, {
      where: { t: { _period: ['PT1H', a] } },
    });
    expect(viaWindow).toEqual(['lo', 'mid', 'hi']);
    expect(viaWherePeriod).toEqual(['lo', 'mid', 'hi']);
  });

  it('AC-8: broadcast preserves the source rows (and input order)', () => {
    const rows: Row[] = [
      { id: 'first', agent: 'x', is_sub: 0, cost_usd: 5 },
      { id: 'second', agent: 'x', is_sub: 0, cost_usd: 1 },
    ];
    const out = new DataView(rows, {
      where: { is_sub: { _eq: 0 } },
      select: [
        'id',
        'agent',
        'is_sub',
        'cost_usd',
        {
          name: 'c',
          aggregate: {
            _sum: 'cost_usd',
            _scan: { order_by: 'id', frame: { where: {} }, partition_by: 'agent' },
          },
        },
      ],
      qualify: { c: { _gt: 0 } },
    }).view() as unknown as Row[];
    expect(out.map((r) => r['id'])).toEqual(['first', 'second']);
    expect(out[0]['c']).toBe(6);
  });

  it('AC-10: _bucket maps to floor(t/seconds*1000)*seconds*1000 (+offset)', () => {
    const t = Date.UTC(2026, 0, 1, 5, 37, 12); // local-independent: epoch arithmetic
    const rows: Row[] = [
      { t, v: 1 },
      { t: t + 3_600_000, v: 2 },
    ];
    const out = view(rows, {
      group_by: [
        { _bucket: { field: 't', seconds: 3600 } },
        { name: 'c', aggregate: { _count: true } },
      ],
    });
    const expected = Math.floor(t / 3_600_000) * 3_600_000;
    expect(out.length).toBe(2);
    expect(out[0]['t']).toBe(expected);
    expect(out[1]['t']).toBe(expected + 3_600_000);

    const offset = 1_800_000;
    const shifted = view([{ t, v: 1 }], {
      group_by: [
        { _bucket: { field: 't', seconds: 3600, offset } },
        { name: 'c', aggregate: { _count: true } },
      ],
    });
    expect(shifted[0]['t']).toBe(
      Math.floor((t - offset) / 3_600_000) * 3_600_000 + offset
    );
  });

  it('AC-11: top_n keeps N groups and merges the dropped tail into one _other', () => {
    const rows: Row[] = [
      { agent: 'a', v: 1 },
      { agent: 'b', v: 2 },
      { agent: 'c', v: 3 },
      { agent: 'd', v: 4 },
    ];
    const base: QueryExpression = {
      group_by: ['agent', { name: 'cost_usd', aggregate: { _sum: 'v' } }],
      order_by: [{ cost_usd: 'desc' }],
      keep: { n: 2, other: true },
    };
    const withOther = view(rows, base);
    expect(withOther.length).toBe(3);
    expect(withOther[0]['agent']).toBe('d');
    expect(withOther[1]['agent']).toBe('c');
    const other = withOther.find((r) => r['_other'] === true);
    expect(other).toBeDefined();
    expect(other?.['cost_usd']).toBe(3); // merged tail a+b

    const withoutOther = view(rows, { ...base, keep: undefined, limit: 2 });
    expect(withoutOther.length).toBe(2);
    expect(withoutOther.some((r) => r['_other'] === true)).toBe(false);
  });

  it('AC-12/AC-13: DISCRIMINATING — [A1,A2,A3]; A2 kept on the set-level sum', () => {
    const out = view(A_EVENTS, A_QUERY);
    expect(out.map((r) => r['id'])).toEqual(['A1', 'A2', 'A3']);
    // A4 (review, in-window sum 0.00) and A6 (debug, zero in-window rows) absent.
    expect(out.map((r) => r['id'])).not.toContain('A4');
    expect(out.map((r) => r['id'])).not.toContain('A6');
    // AC-13: A2 is INCLUDED although its own cost_usd is 0.00.
    const a2 = out.find((r) => r['id'] === 'A2');
    expect(a2).toBeDefined();
    expect(a2?.['cost_usd']).toBe(0);
  });

  it('AC-14: DISCRIMINATING — phase-order pair gives [B1] not []', () => {
    const rows: Row[] = [
      { id: 'B1', agent: 'x', is_sub: 0, cost_usd: 5 },
      { id: 'B2', agent: 'x', is_sub: 1, cost_usd: -5 },
    ];
    const out = idList(rows, {
      where: { is_sub: { _eq: 0 } }, // PRE
      select: [
        'id',
        'cost_usd',
        {
          name: 'c',
          aggregate: {
            _sum: 'cost_usd',
            _scan: { order_by: 'id', frame: { where: {} }, partition_by: 'agent' },
          },
        },
      ],
      qualify: { c: { _gt: 0 } }, // POST-scan
    });
    expect(out).toEqual(['B1']);
  });

  it('AC-15: an aggregate node placed under `where` THROWS (no silent no-op)', () => {
    expect(() =>
      new DataView(A_EVENTS, {
        where: { _having: { group_by: ['agent'], aggregate: { c: { _sum: 'cost_usd' } }, _gt: 0 } },
      } as unknown as QueryExpression).view()
    ).toThrow();

    expect(() =>
      new DataView(A_EVENTS, {
        where: { cost_usd: { _sum: true } },
      } as unknown as QueryExpression).view()
    ).toThrow();
  });
});

describe('SPEC section 4 — aggregate vocabulary', () => {
  const rows: Row[] = [
    { g: 'a', v: 10, n: 1, d: 1, tag: 'x', name: 'n1' },
    { g: 'a', v: 20, n: 2, d: 2, tag: 'x', name: 'n2' },
    { g: 'a', v: 30, n: 3, d: 4, tag: 'y', name: 'n3' },
    { g: 'b', v: 5, n: 0, d: 0, tag: 'z', name: 'n4' },
  ];
  const pick = (out: Row[], g: string): Row | undefined => out.find((r) => r['g'] === g);

  it('_sum / _count(true|field) / _min / _max / _avg', () => {
    const out = view(rows, {
      group_by: [
        'g',
        { name: 's', aggregate: { _sum: 'v' } },
        { name: 'rows', aggregate: { _count: true } },
        { name: 'nonNull', aggregate: { _count: 'v' } },
        { name: 'lo', aggregate: { _min: 'v' } },
        { name: 'hi', aggregate: { _max: 'v' } },
        { name: 'mean', aggregate: { _avg: 'v' } },
      ],
    });
    const a = pick(out, 'a');
    expect(a?.['s']).toBe(60);
    expect(a?.['rows']).toBe(3);
    expect(a?.['nonNull']).toBe(3);
    expect(a?.['lo']).toBe(10);
    expect(a?.['hi']).toBe(30);
    expect(a?.['mean']).toBe(20);
  });

  it('_ratio_of_sums / _distinct_count / _quantile', () => {
    const out = view(rows, {
      group_by: [
        'g',
        { name: 'perUnit', aggregate: { _ratio_of_sums: { num: 'v', den: 'n' } } },
        { name: 'tags', aggregate: { _distinct_count: 'tag' } },
        { name: 'median', aggregate: { _quantile: { field: 'v', q: 0.5 } } },
        { name: 'p90', aggregate: { _quantile: { field: 'v', q: 0.9 } } },
      ],
    });
    const a = pick(out, 'a');
    expect(a?.['perUnit']).toBe(10); // 60/6
    expect(a?.['tags']).toBe(2);
    expect(a?.['median']).toBe(20);
    expect(a?.['p90']).toBeCloseTo(28, 10); // 20 + (30-20)*0.8
  });

  it('null / missing measures are excluded from sum and count(field); _avg counts all rows', () => {
    const mixed: Row[] = [
      { g: 'a', v: 10 },
      { g: 'a' }, // v missing
      { g: 'a', v: null },
      { g: 'a', v: 30 },
    ];
    const out = view(mixed, {
      group_by: [
        'g',
        { name: 's', aggregate: { _sum: 'v' } },
        { name: 'c', aggregate: { _count: 'v' } },
        { name: 'all', aggregate: { _count: true } },
        { name: 'mean', aggregate: { _avg: 'v' } },
      ],
    });
    expect(out.length).toBe(1);
    expect(out[0]['s']).toBe(40);
    expect(out[0]['c']).toBe(2);
    expect(out[0]['all']).toBe(4);
    // v2 rule: `_avg` divides by the row count (nullish operands coerce to 0).
    expect(out[0]['mean']).toBe(10);
  });

  it('a zero-sum measure still drops via a HAVING comparison', () => {
    const nulls: Row[] = [
      { g: 'a', v: 10 },
      { g: 'b' }, // all-null measure for group b -> sum 0
    ];
    const out = view(nulls, {
      group_by: ['g', { name: 's', aggregate: { _sum: 'v' } }],
      where: { s: { _gt: 0 } },
    });
    expect(out.map((r) => r['g'])).toEqual(['a']);
  });
});

describe('tail operators run on the grouped rows', () => {
  it('order_by + limit select the top-N groups', () => {
    const rows: Row[] = [
      { agent: 'a', v: 1 },
      { agent: 'b', v: 5 },
      { agent: 'c', v: 3 },
    ];
    const out = view(rows, {
      group_by: ['agent', { name: 'total', aggregate: { _sum: 'v' } }],
      order_by: [{ total: 'desc' }],
      limit: 2,
    });
    expect(out.map((r) => r['agent'])).toEqual(['b', 'c']);
  });
});
