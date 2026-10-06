/**
 * `_scan` — the windowed/running/sliding aggregate as a fold-mode — and its
 * combinations with every other clause, the incremental `DataView`, and
 * index-accelerated access. Drives the real `DataView`/`execute` seam.
 */
import { describe, it, expect } from 'vitest';
import { DataView, type Fold, type QueryExpression } from '../index';
import { execute } from './model/execute';
import { planQuery } from './model/plan';
import { IndexStore } from './model/indexing';

type Row = Record<string, unknown>;

const view = (rows: Row[], query: QueryExpression): Row[] =>
  new DataView(rows, query).view() as unknown as Row[];

const scanOf = (rows: Row[], query: QueryExpression): unknown[] =>
  execute(query, rows).map((r) => r['w']);

describe('_scan alone — running, sliding, partitioned, per fold op', () => {
  const rows = [
    { t: 1, v: 10 },
    { t: 2, v: 20 },
    { t: 3, v: 30 },
  ];
  const scan = (fold: Fold): QueryExpression => ({
    select: [{ name: 'w', aggregate: { ...fold, _scan: { order_by: 't' } } }],
  });

  it('running _sum / _count / _avg / _min / _max', () => {
    expect(scanOf(rows, scan({ _sum: 'v' }))).toEqual([10, 30, 60]);
    expect(scanOf(rows, scan({ _count: true }))).toEqual([1, 2, 3]);
    expect(scanOf(rows, scan({ _avg: 'v' }))).toEqual([10, 15, 20]);
    expect(scanOf(rows, scan({ _min: 'v' }))).toEqual([10, 10, 10]);
    expect(scanOf(rows, scan({ _max: 'v' }))).toEqual([10, 20, 30]);
  });

  it('running _count on a field skips nullish operands', () => {
    const withNull: Row[] = [
      { t: 1, v: 1 },
      { t: 2, v: null },
      { t: 3, v: 3 },
    ];
    expect(scanOf(withNull, scan({ _count: 'v' }))).toEqual([1, 1, 2]);
  });

  it('running _ratio_of_sums (prefix num / prefix den)', () => {
    const r: Row[] = [
      { t: 1, v: 2, w: 1 },
      { t: 2, v: 4, w: 3 },
      { t: 3, v: 6, w: 2 },
    ];
    // num prefix: 2,6,12 ; den prefix: 1,4,6
    expect(scanOf(r, scan({ _ratio_of_sums: { num: 'v', den: 'w' } }))).toEqual([2, 1.5, 2]);
  });

  it('sliding size 2 sums the last two rows (two-pointer)', () => {
    expect(scanOf(rows, { select: [{ name: 'w', aggregate: { _sum: 'v', _scan: { order_by: 't', frame: 2 } } }] })).toEqual([
      10, 30, 50,
    ]);
  });

  it('sliding min/max via a monotonic deque', () => {
    const r: Row[] = [
      { t: 1, v: 5 },
      { t: 2, v: 1 },
      { t: 3, v: 3 },
      { t: 4, v: 2 },
    ];
    expect(scanOf(r, { select: [{ name: 'w', aggregate: { _min: 'v', _scan: { order_by: 't', frame: 2 } } }] })).toEqual([
      5, 1, 1, 2,
    ]);
    expect(scanOf(r, { select: [{ name: 'w', aggregate: { _max: 'v', _scan: { order_by: 't', frame: 2 } } }] })).toEqual([
      5, 5, 3, 3,
    ]);
  });

  it('partitions by the partition key', () => {
    const data: Row[] = [
      { p: 'a', t: 1, v: 1 },
      { p: 'b', t: 1, v: 10 },
      { p: 'a', t: 2, v: 2 },
    ];
    expect(
      scanOf(data, {
        select: [{ name: 'w', aggregate: { _sum: 'v', _scan: { order_by: 't', partition_by: 'p' } } }],
      })
    ).toEqual([1, 10, 3]);
  });

  it('a predicate frame aggregates the (position-independent) matching set, broadcast', () => {
    const data: Row[] = [
      { t: 1, v: 1 },
      { t: 2, v: 5 },
      { t: 3, v: 2 },
    ];
    // rows with v >= 2 are {5,2} -> sum 7 for every row
    expect(
      scanOf(data, {
        select: [{ name: 'w', aggregate: { _sum: 'v', _scan: { order_by: 't', frame: { where: { v: { _gte: 2 } } } } } }],
      })
    ).toEqual([7, 7, 7]);
  });
});

describe('_scan in combination', () => {
  it('runs AFTER a pre-`where` (the scan sees the filtered rows)', () => {
    const rows: Row[] = [
      { t: 1, v: 1 },
      { t: 2, v: 2 },
      { t: 3, v: 3 },
    ];
    const out = view(rows, {
      where: { v: { _gte: 2 } },
      select: ['t', { name: 'w', aggregate: { _sum: 'v', _scan: { order_by: 't' } } }],
    });
    expect(out).toEqual([
      { t: 2, w: 2 },
      { t: 3, w: 5 },
    ]);
  });

  it('`qualify` filters on the scan output (POST-scan)', () => {
    const rows: Row[] = [
      { t: 1, v: 1 },
      { t: 2, v: 2 },
      { t: 3, v: 3 },
    ];
    const out = view(rows, {
      select: ['t', { name: 'w', aggregate: { _sum: 'v', _scan: { order_by: 't' } } }],
      qualify: { w: { _gte: 3 } },
      order_by: [{ t: 'asc' }],
    });
    expect(out).toEqual([
      { t: 2, w: 3 },
      { t: 3, w: 6 },
    ]);
  });

  it('+ group_by, with the scan in a nested select over each group rows', () => {
    const data: Row[] = [
      { agent: 'a', t: 1, c: 1 },
      { agent: 'a', t: 2, c: 2 },
      { agent: 'b', t: 1, c: 5 },
    ];
    const out = view(data, {
      group_by: ['agent', { name: 'total', aggregate: { _sum: 'c' } }],
      select: [
        'agent',
        'total',
        {
          name: 'running',
          select: ['t', 'c', { name: 'w', aggregate: { _sum: 'c', _scan: { order_by: 't' } } }],
        },
      ],
      order_by: [{ agent: 'asc' }],
    });
    expect(out).toEqual([
      {
        agent: 'a',
        total: 3,
        running: [
          { t: 1, c: 1, w: 1 },
          { t: 2, c: 2, w: 3 },
        ],
      },
      { agent: 'b', total: 5, running: [{ t: 1, c: 5, w: 5 }] },
    ]);
  });

  it('+ group_by, with the scan in the grouped `select` (partition = the group_by)', () => {
    const data: Row[] = [
      { agent: 'a', v: 1 },
      { agent: 'b', v: 2 },
      { agent: 'a', v: 3 },
    ];
    const out = view(data, {
      group_by: ['agent', { name: 'c', aggregate: { _sum: 'v' } }],
      select: ['agent', 'c', { name: 'r', aggregate: { _sum: 'c', _scan: { order_by: 'agent' } } }],
      order_by: [{ agent: 'asc' }],
    });
    expect(out).toEqual([
      { agent: 'a', c: 4, r: 4 },
      { agent: 'b', c: 2, r: 2 },
    ]);
  });

  it('+ keep (`_other` participates in the scan)', () => {
    const data: Row[] = [
      { agent: 'a', v: 1 },
      { agent: 'b', v: 2 },
      { agent: 'c', v: 3 },
    ];
    const out = view(data, {
      group_by: ['agent', { name: 'c', aggregate: { _sum: 'v' } }],
      order_by: [{ c: 'desc' }],
      keep: { n: 1, other: true },
      select: ['agent', 'c', { name: 'r', aggregate: { _sum: 'c', _scan: { order_by: 'c' } } }],
    }) as unknown as Record<string, unknown>[];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ agent: 'c', c: 3, r: 3 });
    // The projection drops the `_other` marker, but the merged group's scan runs.
    expect(out[1]).toMatchObject({ c: 3, r: 3 });
  });

  it('+ post-group `where` (HAVING) on a scan-free aggregate beside a scan column', () => {
    const data: Row[] = [
      { agent: 'a', t: 1, c: 1 },
      { agent: 'a', t: 2, c: 1 },
      { agent: 'b', t: 1, c: 9 },
    ];
    const out = view(data, {
      group_by: ['agent', { name: 'total', aggregate: { _sum: 'c' } }],
      where: { total: { _gt: 1 } },
      select: ['agent', 'total', { name: 'r', aggregate: { _sum: 'total', _scan: { order_by: 'total' } } }],
      order_by: [{ agent: 'asc' }],
    });
    // HAVING drops agent a (total 2 is kept? 2>1 yes) -> both kept
    expect(out.map((r) => r['agent'])).toEqual(['a', 'b']);
  });
});

describe('_scan + the incremental DataView', () => {
  const q = (): QueryExpression => ({
    source: 's',
    select: [{ name: 'w', aggregate: { _sum: 'c', _scan: { order_by: 't' } } }],
  });

  it('reflects insert / append / remove over the source', () => {
    const dv = new DataView([
      { name: 's', data: [{ t: 1, c: 1 }, { t: 2, c: 2 }] },
    ]);
    expect(dv.query(q()).map((r) => r['w'])).toEqual([1, 3]);

    dv.insert('s', { t: 3, c: 4 });
    expect(dv.query(q()).map((r) => r['w'])).toEqual([1, 3, 7]);

    dv.append('s', [{ t: 4, c: 5 }]);
    expect(dv.query(q()).map((r) => r['w'])).toEqual([1, 3, 7, 12]);

    dv.remove('s', { t: 2, c: 2 });
    expect(dv.query(q()).map((r) => r['w'])).toEqual([1, 5, 10]);
  });
});

describe('_scan + index-accelerated access', () => {
  const data: Row[] = [
    { g: 'a', t: 1, c: 1 },
    { g: 'b', t: 2, c: 2 },
    { g: 'a', t: 3, c: 3 },
    { g: 'b', t: 4, c: 4 },
    { g: 'a', t: 5, c: 5 },
  ];

  const scanQuery = (where: QueryExpression['where']): QueryExpression => ({
    source: 's',
    where,
    select: [{ name: 'w', aggregate: { _sum: 'c', _scan: { order_by: 't' } } }],
  });

  const indexedDv = () =>
    new DataView([{ name: 's', data: [...data] }], {
      indexes: { s: [{ field: 'g', kind: 'eq' }] },
    });
  const plainDv = () => new DataView([{ name: 's', data: [...data] }]);

  it('an indexed scan over a PRE predicate is identical to a plain scan (index narrows, scan correct)', () => {
    const q = scanQuery({ g: { _eq: 'a' } });
    expect(indexedDv().query(q)).toEqual(plainDv().query(q));
    expect(indexedDv().query(q).map((r) => r['w'])).toEqual([1, 4, 9]);
  });

  it('the access path is derived from the PRE predicate ONLY — the scan never breaks narrowing', () => {
    const q: QueryExpression = {
      ...scanQuery({ g: { _eq: 'a' } }),
      qualify: { w: { _gt: 3 } }, // POST-scan filter on the scan output name
    };
    const store = new IndexStore([{ field: 'g', kind: 'eq' }]);
    for (const r of data) store.add(r);
    const plan = planQuery(q, { indexFor: () => store, defaultSource: 's' });
    expect(plan.root.access.kind).toBe('index');
    // ...and the result still equals a plain scan (the exact predicate is re-checked).
    expect(indexedDv().query(q)).toEqual(plainDv().query(q));
    expect(indexedDv().query(q).map((r) => r['w'])).toEqual([4, 9]);
  });

  it('a range-indexed scan equals a plain scan', () => {
    const rangeData: Row[] = [
      { t: 1, c: 1 },
      { t: 5, c: 2 },
      { t: 9, c: 3 },
    ];
    const indexed = new DataView([{ name: 's', data: [...rangeData] }], {
      indexes: { s: [{ field: 't', kind: 'range' }] },
    });
    const plain = new DataView([{ name: 's', data: [...rangeData] }]);
    const q = scanQuery({ t: { _gte: 5 } });
    expect(indexed.query(q)).toEqual(plain.query(q));
    expect(indexed.query(q).map((r) => r['w'])).toEqual([2, 5]);
  });
});
