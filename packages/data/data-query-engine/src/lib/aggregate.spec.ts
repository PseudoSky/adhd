import { describe, it, expect } from 'vitest';
import { DataView, QueryValidationError, resolveIsoPeriod } from '../index';
import type { QueryExpression } from '../index';

/**
 * SPEC 49a62647-5a50-461a-b004-461b9b6bd66f — engine group-by + aggregation +
 * HAVING. Each `it` name carries the acceptance-criterion id it discharges.
 *
 * The fixtures use the worked example's EXACT field vocabulary and anchor
 * (`98a0a7d0-b992-4552-b950-8847b53eb8b6`) so AC-12/AC-13/AC-14 are the same
 * rows the design was argued over.
 */

type Row = Record<string, unknown>;

const HOUR_MS = 3_600_000;
const MAX_T = 1_790_719_200_000; // the export's max_t (hour-aligned)

// The engine's DataView types `view()` as `T[]`; grouped views are structurally
// different rows, so tests use a loose accessor.
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

const A_QUERY: QueryExpression = {
  where: { _and: [{ client: { _in: ['opencode'] } }, { is_sub: { _eq: 0 } }] },
  group_by: ['agent'],
  window: { field: 't', period: ['PT1H', MAX_T] },
  aggregate: { c: { _sum: 'cost_usd' } },
  having: { c: { _gt: 0 } },
  output: 'rows',
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
    const out = view(rows, { group_by: ['agent'], aggregate: { c: { _sum: 'cost_usd' } } });
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
      group_by: ['agent'],
      aggregate: { c: { _sum: 'cost_usd' } },
    });
    expect(out.length).toBe(1);
    expect(out[0]['agent']).toBe('x');
    expect(out[0]['c']).toBe(5);
  });

  it('AC-3: HAVING runs after AGGREGATE and can distinguish the orders', () => {
    const rows: Row[] = [
      { id: 'x1', agent: 'x', is_sub: 0, cost_usd: 5 },
      { id: 'x2', agent: 'x', is_sub: 1, cost_usd: -5 },
    ];
    const withWhere = view(rows, {
      where: { is_sub: { _eq: 0 } },
      group_by: ['agent'],
      aggregate: { c: { _sum: 'cost_usd' } },
      having: { c: { _gt: 0 } },
    });
    expect(withWhere.length).toBe(1); // x sums to 5 -> passes
    const withoutWhere = view(rows, {
      group_by: ['agent'],
      aggregate: { c: { _sum: 'cost_usd' } },
      having: { c: { _gt: 0 } },
    });
    expect(withoutWhere.length).toBe(0); // x sums to 0 -> dropped
  });

  it('AC-4: window scopes the aggregate, never row emission (output:rows)', () => {
    const rows: Row[] = [
      { id: 'in', agent: 'x', t: MAX_T - 1_000, cost_usd: 5 },
      { id: 'out', agent: 'x', t: MAX_T - HOUR_MS - 1, cost_usd: 1_000 },
      { id: 'stale', agent: 'y', t: MAX_T - HOUR_MS - 1_000, cost_usd: 7 },
    ];
    const q: QueryExpression = {
      group_by: ['agent'],
      window: { field: 't', period: ['PT1H', MAX_T] },
      aggregate: { c: { _sum: 'cost_usd' } },
      output: 'rows',
    };
    // `out` is emitted even though its own t is outside the window; `stale`'s
    // group has ZERO in-window rows and is absent, not c=0.
    expect(idList(rows, q)).toEqual(['in', 'out']);
    // and the group's aggregate counts only the in-window row
    const groups = view(rows, { ...q, output: 'groups' });
    expect(groups.length).toBe(1);
    expect(groups[0]['c']).toBe(5);
  });

  it('AC-5: every aggregate over an empty window yields ABSENT, never an identity', () => {
    const rows: Row[] = [
      { id: 's', agent: 'y', t: MAX_T - HOUR_MS - 1, cost_usd: 7, n: 3 },
    ];
    const aggs: QueryExpression['aggregate'][] = [
      { s: { _sum: 'cost_usd' } },
      { c: { _count: true } },
      { m: { _min: 'cost_usd' } },
      { m: { _max: 'cost_usd' } },
      { m: { _avg: 'cost_usd' } },
    ];
    for (const aggregate of aggs) {
      const out = view(rows, {
        group_by: ['agent'],
        window: { field: 't', period: ['PT1H', MAX_T] },
        aggregate,
      });
      expect(out.length).toBe(0);
    }
  });

  it('AC-6: unknown aggregate function and unknown having field THROW', () => {
    expect(
      () =>
        new DataView([{ a: 1 }], {
          group_by: ['a'],
          aggregate: { c: { _frobnicate: 'x' } },
        } as unknown as QueryExpression)
    ).toThrow(QueryValidationError);

    expect(
      () =>
        new DataView([{ a: 1 }], {
          group_by: ['a'],
          aggregate: { c: { _sum: 'x' } },
          having: { nope: { _gt: 0 } },
        } as unknown as QueryExpression)
    ).toThrow(QueryValidationError);

    // an unknown operator *inside having* also throws (via compileWhere)
    expect(
      () =>
        new DataView([{ a: 1 }], {
          group_by: ['a'],
          aggregate: { c: { _sum: 'x' } },
          having: { c: { _bogus: 0 } },
        } as unknown as QueryExpression)
    ).toThrow(QueryValidationError);
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

    // Boundary rows: the engine window and the `_period` where-operator agree.
    const boundary: Row[] = [
      { id: 'lo', t: a - HOUR_MS },
      { id: 'mid', t: a - 1 },
      { id: 'hi', t: a },
      { id: 'below', t: a - HOUR_MS - 1 },
    ];
    const viaWindow = idList(boundary, {
      group_by: ['id'],
      window: { field: 't', period: ['PT1H', a] },
      aggregate: { c: { _count: true } },
    });
    const viaWherePeriod = idList(boundary, {
      where: { t: { _period: ['PT1H', a] } },
    });
    expect(viaWindow).toEqual(['lo', 'mid', 'hi']);
    expect(viaWherePeriod).toEqual(['lo', 'mid', 'hi']);
  });

  it('AC-8: output:rows preserves the input row (and input order)', () => {
    const rows: Row[] = [
      { id: 'first', agent: 'x', is_sub: 0, cost_usd: 5 },
      { id: 'second', agent: 'x', is_sub: 0, cost_usd: 1 },
    ];
    const out = new DataView(rows, {
      where: { is_sub: { _eq: 0 } },
      group_by: ['agent'],
      aggregate: { c: { _sum: 'cost_usd' } },
      having: { c: { _gt: 0 } },
      output: 'rows',
    }).view() as unknown as Row[];
    expect(out.map((r) => r['id'])).toEqual(['first', 'second']);
    expect(out[0]).toBe(rows[0]); // the very input row, not a grouped row
  });

  it('AC-9: _rollup / _cube emit grouping sets with a _grouping marker and conserve totals', () => {
    const rows: Row[] = [
      { a: 'a1', b: 'b1', v: 1 },
      { a: 'a1', b: 'b2', v: 2 },
      { a: 'a2', b: 'b1', v: 4 },
    ];
    const rollup = view(rows, {
      group_by: { _rollup: ['a', 'b'] },
      aggregate: { s: { _sum: 'v' } },
    });
    // {a,b}=3 rows, {a}=2, {}=1
    expect(rollup.length).toBe(6);
    const groupingOf = (r: Row): string[] =>
      Array.isArray(r['_grouping']) ? (r['_grouping'] as string[]) : [];
    const full = rollup.filter((r) => groupingOf(r).length === 0);
    const byA = rollup.filter((r) => groupingOf(r).length === 1);
    const grandTotal = rollup.find((r) => groupingOf(r).length === 2);
    expect(full.length).toBe(3);
    expect(byA.length).toBe(2);
    const sumFull = full.reduce((s, r) => s + (r['s'] as number), 0);
    const sumByA = byA.reduce((s, r) => s + (r['s'] as number), 0);
    expect(grandTotal?.['s']).toBe(7);
    expect(sumFull).toBe(7);
    expect(sumByA).toBe(7);

    const cube = view(rows, {
      group_by: { _cube: ['a', 'b'] },
      aggregate: { s: { _sum: 'v' } },
    });
    // {a,b},{a},{b},{} => 3+2+2+1
    expect(cube.length).toBe(8);
    const byB = cube.filter((r) => groupingOf(r).length === 1 && r['b'] !== undefined);
    expect(byB.length).toBe(2);
    const cubeTotal = cube.find((r) => groupingOf(r).length === 2);
    expect(cubeTotal?.['s']).toBe(7);
  });

  it('AC-10: _bucket maps to floor(t/seconds*1000)*seconds*1000 (+offset)', () => {
    const t = Date.UTC(2026, 0, 1, 5, 37, 12); // local-independent: epoch arithmetic
    const rows: Row[] = [
      { t, v: 1 },
      { t: t + 3_600_000, v: 2 },
    ];
    const out = view(rows, {
      group_by: [{ _bucket: { field: 't', seconds: 3600 } }],
      aggregate: { c: { _count: true } },
    });
    const expected = Math.floor(t / 3_600_000) * 3_600_000;
    expect(out.length).toBe(2);
    expect(out[0]['t']).toBe(expected);
    expect(out[1]['t']).toBe(expected + 3_600_000);

    const offset = 1_800_000;
    const shifted = view([{ t, v: 1 }], {
      group_by: [{ _bucket: { field: 't', seconds: 3600, offset } }],
      aggregate: { c: { _count: true } },
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
      group_by: ['agent'],
      aggregate: { cost_usd: { _sum: 'v' } },
      top_n: { n: 2, by: 'cost_usd', other: true },
    };
    const withOther = view(rows, base);
    expect(withOther.length).toBe(3);
    expect(withOther[0]['agent']).toBe('d');
    expect(withOther[1]['agent']).toBe('c');
    const other = withOther.find((r) => r['_other'] === true);
    expect(other).toBeDefined();
    expect(other?.['cost_usd']).toBe(3); // merged tail a+b

    const withoutOther = view(rows, {
      ...base,
      top_n: { n: 2, by: 'cost_usd', other: false },
    });
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
      where: { is_sub: { _eq: 0 } },
      group_by: ['agent'],
      aggregate: { c: { _sum: 'cost_usd' } },
      having: { c: { _gt: 0 } },
      output: 'rows',
    });
    expect(out).toEqual(['B1']);
  });

  it('AC-15: an aggregate node placed under `where` THROWS (no silent no-op)', () => {
    expect(
      () =>
        new DataView(A_EVENTS, {
          where: { _having: { group_by: ['agent'], aggregate: { c: { _sum: 'cost_usd' } }, _gt: 0 } },
        } as unknown as QueryExpression)
    ).toThrow(QueryValidationError);

    expect(
      () =>
        new DataView(A_EVENTS, {
          where: { cost_usd: { _sum: true } },
        } as unknown as QueryExpression)
    ).toThrow(QueryValidationError);
  });
});

describe('SPEC section 4 — aggregate vocabulary', () => {
  const rows: Row[] = [
    { g: 'a', v: 10, n: 1, d: 1, tag: 'x', name: 'n1' },
    { g: 'a', v: 20, n: 2, d: 2, tag: 'x', name: 'n2' },
    { g: 'a', v: 30, n: 3, d: 4, tag: 'y', name: 'n3' },
    { g: 'b', v: 5, n: 0, d: 0, tag: 'z', name: 'n4' },
  ];
  const agg = (aggregate: QueryExpression['aggregate']): Row[] =>
    view(rows, { group_by: ['g'], aggregate });
  const pick = (out: Row[], g: string): Row | undefined => out.find((r) => r['g'] === g);

  it('_sum / _count(true|field) / _min / _max / _avg', () => {
    const out = agg({
      s: { _sum: 'v' },
      rows: { _count: true },
      nonNull: { _count: 'v' },
      lo: { _min: 'v' },
      hi: { _max: 'v' },
      mean: { _avg: 'v' },
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
    const out = agg({
      perUnit: { _ratio_of_sums: { num: 'v', den: 'n' } },
      tags: { _distinct_count: 'tag' },
      median: { _quantile: { field: 'v', q: 0.5 } },
      p90: { _quantile: { field: 'v', q: 0.9 } },
    });
    const a = pick(out, 'a');
    expect(a?.['perUnit']).toBe(10); // 60/6
    expect(a?.['tags']).toBe(2);
    expect(a?.['median']).toBe(20);
    expect(a?.['p90']).toBeCloseTo(28, 10); // 20 + (30-20)*0.8
  });

  it('null / missing measures are excluded from sum, avg and count(field)', () => {
    const mixed: Row[] = [
      { g: 'a', v: 10 },
      { g: 'a' }, // v missing
      { g: 'a', v: null },
      { g: 'a', v: 30 },
    ];
    const out = view(mixed, {
      group_by: ['g'],
      aggregate: {
        s: { _sum: 'v' },
        c: { _count: 'v' },
        all: { _count: true },
        mean: { _avg: 'v' },
      },
    });
    expect(out.length).toBe(1);
    expect(out[0]['s']).toBe(40);
    expect(out[0]['c']).toBe(2);
    expect(out[0]['all']).toBe(4);
    expect(out[0]['mean']).toBe(20);
  });

  it('all-null measure leaves the aggregate undefined so a HAVING comparison drops the group', () => {
    const nulls: Row[] = [
      { g: 'a', v: 10 },
      { g: 'b' }, // all-null measure for group b
    ];
    const out = view(nulls, {
      group_by: ['g'],
      aggregate: { s: { _sum: 'v' } },
      having: { s: { _gt: 0 } },
    });
    expect(out.map((r) => r['g'])).toEqual(['a']);
  });
});

describe('tail operators run on the grouped rows (SPEC phase 5)', () => {
  it('order_by + limit select the top-N groups', () => {
    const rows: Row[] = [
      { agent: 'a', v: 1 },
      { agent: 'b', v: 5 },
      { agent: 'c', v: 3 },
    ];
    const out = view(rows, {
      group_by: ['agent'],
      aggregate: { total: { _sum: 'v' } },
      order_by: [{ total: 'desc' }],
      limit: 2,
    });
    expect(out.map((r) => r['agent'])).toEqual(['b', 'c']);
  });
});
