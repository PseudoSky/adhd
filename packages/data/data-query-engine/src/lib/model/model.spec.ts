import { describe, it, expect } from 'vitest';
import { DataView, PhaseRuleError, execute, splitWhere, zsetAdd, zsetNegate, zsetTotal, zsetUnion } from './index';
import type { Predicate, QueryExpression, Row } from './index';

const rows: Row[] = [
  { id: 1, agent: 'a', model: 'm1', cost_usd: 1, tokens_in: 10, tokens_cache_read: 5, is_sub: false },
  { id: 2, agent: 'a', model: 'm1', cost_usd: 2, tokens_in: 20, tokens_cache_read: 0, is_sub: false },
  { id: 3, agent: 'b', model: 'm2', cost_usd: 4, tokens_in: 40, tokens_cache_read: 10, is_sub: true },
];

describe('phase rule', () => {
  it('splits conjuncts into pre/post by reference', () => {
    const where: Predicate = { _and: [{ is_sub: { _eq: false } }, { cost: { _gt: 0 } }] };
    const { pre, post } = splitWhere(where, new Set(['cost']));
    expect(pre).toEqual({ is_sub: { _eq: false } });
    expect(post).toEqual({ cost: { _gt: 0 } });
  });

  it('rejects a mixed-phase disjunction (no WHERE-then-HAVING form)', () => {
    const where: Predicate = { _or: [{ is_sub: { _eq: false } }, { cost: { _gt: 0 } }] };
    expect(() => splitWhere(where, new Set(['cost']))).toThrow(PhaseRuleError);
  });

  it('allows a pure disjunction on either phase', () => {
    const where: Predicate = { _or: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] };
    const { pre, post } = splitWhere(where, new Set(['cost']));
    expect(post).toBeUndefined();
    expect(pre).toEqual(where);
  });
});

describe('execute', () => {
  it('filters, groups and sums (§15.3)', () => {
    const q: QueryExpression = {
      where: { is_sub: { _eq: false } },
      group_by: [
        'agent',
        { name: 'cost', aggregate: { _sum: 'cost_usd' } },
        { name: 'n', aggregate: { _count: true } },
      ],
      order_by: [{ agent: 'asc' }],
    };
    expect(execute(q, rows)).toEqual([{ agent: 'a', cost: 3, n: 2 }]);
  });

  it('computes derived metrics topologically (§15.4)', () => {
    const q: QueryExpression = {
      group_by: [
        'agent',
        { name: 'sum_in', aggregate: { _sum: 'tokens_in' } },
        { name: 'sum_cr', aggregate: { _sum: 'tokens_cache_read' } },
        { name: 'rate', aggregate: { _div: ['sum_cr', { _add: ['sum_in', 'sum_cr'] }] } },
      ],
      order_by: [{ agent: 'asc' }],
    };
    const out = execute(q, rows);
    expect(out).toEqual([
      { agent: 'a', sum_in: 30, sum_cr: 5, rate: 5 / 35 },
      { agent: 'b', sum_in: 40, sum_cr: 10, rate: 10 / 50 },
    ]);
  });

  it('applies a post-group conjunct as HAVING inside one where tree', () => {
    const q: QueryExpression = {
      where: { _and: [{ is_sub: { _eq: false } }, { cost: { _gt: 0 } }] },
      group_by: ['agent', { name: 'cost', aggregate: { _sum: 'cost_usd' } }],
    };
    expect(execute(q, rows)).toEqual([{ agent: 'a', cost: 3 }]);
  });

  it('nests a relation-valued select (§6)', () => {
    const q: QueryExpression = {
      group_by: ['agent', { name: 'cost', aggregate: { _sum: 'cost_usd' } }],
      select: [
        'agent',
        'cost',
        {
          name: 'models',
          group_by: ['model', { name: 'cost', aggregate: { _sum: 'cost_usd' } }],
          order_by: [{ model: 'asc' }],
        },
      ],
      order_by: [{ agent: 'asc' }],
    };
    expect(execute(q, rows)).toEqual([
      { agent: 'a', cost: 3, models: [{ model: 'm1', cost: 3 }] },
      { agent: 'b', cost: 4, models: [{ model: 'm2', cost: 4 }] },
    ]);
  });

  it('collapses the tail into one `_other` row (§2.5)', () => {
    const q: QueryExpression = {
      group_by: ['agent', { name: 'cost', aggregate: { _sum: 'cost_usd' } }],
      order_by: [{ cost: 'desc' }],
      keep: { n: 1, other: true },
    };
    const out = execute(q, rows);
    expect(out).toEqual([
      { agent: 'b', cost: 4 },
      { _other: true, cost: 3 },
    ]);
  });

  it('computes a window column and qualifies on it (§15.7)', () => {
    const sessions: Row[] = [
      { session_id: 's1', agent: 'a', t: 100, cost_usd: 1, is_sub: false },
      { session_id: 's2', agent: 'a', t: 200, cost_usd: 2, is_sub: false },
      { session_id: 's3', agent: 'b', t: 150, cost_usd: 5, is_sub: false },
      { session_id: 's4', agent: 'a', t: 300, cost_usd: 3, is_sub: true },
    ];
    const q: QueryExpression = {
      where: { is_sub: { _eq: false } },
      select: [
        'session_id',
        'agent',
        't',
        {
          name: 'cost_scan',
          aggregate: {
            _sum: 'cost_usd',
            _scan: { order_by: 't', frame: 'running', partition_by: 'agent' },
          },
        },
      ],
      qualify: { cost_scan: { _gt: 0 } },
      order_by: [{ t: 'asc' }],
    };
    expect(execute(q, sessions)).toEqual([
      { session_id: 's1', agent: 'a', t: 100, cost_scan: 1 },
      { session_id: 's3', agent: 'b', t: 150, cost_scan: 5 },
      { session_id: 's2', agent: 'a', t: 200, cost_scan: 3 },
    ]);
  });

  it('resolves a subquery operand for `_in` (§2.4)', () => {
    const events: Row[] = [
      { id: 1, outcome: 'ok' },
      { id: 2, outcome: 'fail' },
      { id: 3, outcome: 'fail' },
    ];
    const q: QueryExpression = {
      where: {
        id: { _in: { name: 'failed', where: { outcome: { _eq: 'fail' } }, select: ['id'] } },
      },
      select: ['id'],
    };
    expect(execute(q, events)).toEqual([{ id: 2 }, { id: 3 }]);
  });
});

describe('DataView (multi-source + incremental append)', () => {
  it('maintains a grouped monoid result under append, matching a full recompute', () => {
    const dv = new DataView([
      { name: 'sessions', data: [{ agent: 'a', cost: 1 }, { agent: 'b', cost: 5 }] },
      { name: 'agents', data: [{ id: 'a' }] },
    ]);
    const q: QueryExpression = { source: 'sessions', group_by: ['agent', { name: 'cost', aggregate: { _sum: 'cost' } }] };

    const first = dv.query(q).sort((a, b) => String(a['agent']).localeCompare(String(b['agent'])));
    expect(first).toEqual([
      { agent: 'a', cost: 1 },
      { agent: 'b', cost: 5 },
    ]);

    dv.insert('sessions', { agent: 'a', cost: 10 });
    const incremental = dv.query(q).sort((a, b) => String(a['agent']).localeCompare(String(b['agent'])));
    const recomputed = execute(q, dv.get('sessions'));

    expect(incremental).toEqual([
      { agent: 'a', cost: 11 },
      { agent: 'b', cost: 5 },
    ]);
    expect(incremental).toEqual(recomputed);
  });

  it('reads and appends a named dataset', () => {
    const dv = new DataView([{ name: 'x', data: [{ n: 1 }] }]);
    dv.append('x', [{ n: 2 }, { n: 3 }]);
    expect(dv.get('x')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

describe('review fixes (regression guards)', () => {
  it('applies a fold `_filter` (scoped aggregate)', () => {
    const q: QueryExpression = {
      group_by: [
        'agent',
        { name: 'cost', aggregate: { _sum: 'cost_usd', _filter: { is_sub: { _eq: false } } } },
      ],
      order_by: [{ agent: 'asc' }],
    };
    expect(execute(q, rows)).toEqual([
      { agent: 'a', cost: 3 },
      { agent: 'b', cost: 0 },
    ]);
  });

  it('does not let a nullish operand pass `_gt`', () => {
    const data: Row[] = [{ a: 5 }, { b: 5 }];
    const q: QueryExpression = { where: { a: { _gt: 0 } }, select: ['a'] };
    expect(execute(q, data)).toEqual([{ a: 5 }]);
  });

  it('splits a leaf + a phase-pure `_or` into pre and post conjuncts', () => {
    const where: Predicate = { dept: { _eq: 'x' }, _or: [{ cost: { _gt: 0 } }] };
    const { pre, post } = splitWhere(where, new Set(['cost']));
    expect(pre).toEqual({ dept: { _eq: 'x' } });
    expect(post).toEqual({ _or: [{ cost: { _gt: 0 } }] });
  });

  it('rejects a malformed predicate leaf instead of ignoring it', () => {
    const where: Predicate = { a: { b: { _eq: 1 } } };
    expect(() => splitWhere(where, new Set<string>())).toThrow();
  });

  it('nests relation-valued selects once over the source when there is no group_by (§15.10)', () => {
    const q: QueryExpression = {
      select: [
        { name: 'before', where: { is_sub: { _eq: false } }, group_by: [{ name: 'cost', aggregate: { _sum: 'cost_usd' } }] },
        { name: 'after', where: { is_sub: { _eq: true } }, group_by: [{ name: 'cost', aggregate: { _sum: 'cost_usd' } }] },
      ],
    };
    const out = execute(q, rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ before: [{ cost: 3 }], after: [{ cost: 4 }] });
  });

  it('computes a scan fold in select beside a group_by', () => {
    const data: Row[] = [
      { agent: 'a', t: 1, c: 1 },
      { agent: 'a', t: 2, c: 2 },
      { agent: 'b', t: 1, c: 5 },
    ];
    const q: QueryExpression = {
      group_by: ['agent', { name: 'c', aggregate: { _sum: 'c' } }],
      select: [
        'agent',
        'c',
        { name: 'r', aggregate: { _sum: 'c', _scan: { order_by: 't', frame: 'running', partition_by: 'agent' } } },
      ],
      order_by: [{ agent: 'asc' }],
    };
    expect(execute(q, data)).toEqual([
      { agent: 'a', c: 3, r: 3 },
      { agent: 'b', c: 5, r: 5 },
    ]);
  });

  it('does not share an incremental cache across queries with the same keys but different folds', () => {
    const dv = new DataView([{ name: 's', data: [{ a: 'x', c: 1 }, { a: 'x', c: 5 }] }]);
    const sumQ: QueryExpression = { source: 's', group_by: ['a', { name: 'v', aggregate: { _sum: 'c' } }] };
    const maxQ: QueryExpression = { source: 's', group_by: ['a', { name: 'v', aggregate: { _max: 'c' } }] };
    expect(dv.query(sumQ)).toEqual([{ a: 'x', v: 6 }]);
    expect(dv.query(maxQ)).toEqual([{ a: 'x', v: 5 }]);
  });

  it('buckets a group key by unit (§15.5)', () => {
    const data: Row[] = [
      { t: 0, c: 1 },
      { t: 60_000, c: 2 },
      { t: 3_600_000, c: 3 },
    ];
    const q: QueryExpression = {
      group_by: [{ _bucket: { field: 't', unit: 'hour' } }, { name: 'c', aggregate: { _sum: 'c' } }],
      order_by: [{ t: 'asc' }],
    };
    expect(execute(q, data)).toEqual([
      { t: 0, c: 3 },
      { t: 3_600_000, c: 3 },
    ]);
  });

  it('honors a declared ddsketch quantile', () => {
    const data: Row[] = Array.from({ length: 100 }, (_, i) => ({ v: i + 1 }));
    const q: QueryExpression = {
      group_by: [
        { name: 'p50', aggregate: { _quantile: { field: 'v', q: 0.5, sketch: 'ddsketch', relativeAccuracy: 0.01 } } },
      ],
    };
    const v = execute(q, data)[0]['p50'] as number;
    expect(v).toBeGreaterThan(45);
    expect(v).toBeLessThan(55);
  });

  it('rejects a scalar-operand subquery that does not select exactly one item', () => {
    const data: Row[] = [{ id: 1, x: 1 }];
    const q: QueryExpression = { where: { id: { _in: { select: ['id', 'x'] } } } };
    expect(() => execute(q, data)).toThrow(/exactly one item/);
  });
});

describe('residuals closed', () => {
  const byA = (p: Row, r: Row): number => String(p['a']).localeCompare(String(r['a']));

  it('retracts a row (Z-set -1) for an invertible monoid', () => {
    const dv = new DataView([{ name: 's', data: [{ a: 'x', c: 1 }, { a: 'x', c: 5 }, { a: 'y', c: 2 }] }]);
    const q: QueryExpression = { source: 's', group_by: ['a', { name: 'v', aggregate: { _sum: 'c' } }] };
    expect([...dv.query(q)].sort(byA)).toEqual([{ a: 'x', v: 6 }, { a: 'y', v: 2 }]);
    dv.remove('s', { a: 'x', c: 5 });
    expect([...dv.query(q)].sort(byA)).toEqual([{ a: 'x', v: 1 }, { a: 'y', v: 2 }]);
    dv.remove('s', { a: 'x', c: 1 }); // group 'x' empties → gone
    expect(dv.query(q)).toEqual([{ a: 'y', v: 2 }]);
  });

  it('recomputes a non-invertible (`_max`) result after a retraction (§12.3)', () => {
    const dv = new DataView([{ name: 's', data: [{ a: 'x', c: 1 }, { a: 'x', c: 5 }] }]);
    const q: QueryExpression = { source: 's', group_by: ['a', { name: 'v', aggregate: { _max: 'c' } }] };
    expect(dv.query(q)).toEqual([{ a: 'x', v: 5 }]);
    dv.remove('s', { a: 'x', c: 5 });
    expect(dv.query(q)).toEqual([{ a: 'x', v: 1 }]);
  });

  it('rejects a name/field collision (§2.3)', () => {
    const q: QueryExpression = { group_by: ['cost', { name: 'cost', aggregate: { _sum: 'c' } }] };
    expect(() => execute(q, [])).toThrow(/collision/);
  });

  it('rejects an empty `_or`', () => {
    const q: QueryExpression = { where: { _or: [] }, select: ['a'] };
    expect(() => execute(q, [{ a: 1 }])).toThrow(/empty/);
  });

  it('implements the Z-set delta algebra (§12.3)', () => {
    const z = new Map<string, number>();
    zsetAdd(z, 'r1');
    zsetAdd(z, 'r1');
    zsetAdd(z, 'r2');
    expect(zsetTotal(z)).toBe(3);
    expect(zsetTotal(zsetUnion(z, zsetNegate(z)))).toBe(0);
    zsetAdd(z, 'r2', -1); // weight returns to zero → dropped
    expect(z.get('r1')).toBe(2);
    expect(z.has('r2')).toBe(false);
  });
});

describe('index acceleration (§11/§13)', () => {
  it('uses an equality index and matches a full scan', () => {
    const data: Row[] = [
      { agent: 'a', cost: 1 },
      { agent: 'b', cost: 2 },
      { agent: 'a', cost: 3 },
      { agent: 'c', cost: 4 },
    ];
    const indexed = new DataView([{ name: 's', data: [...data] }], { indexes: { s: [{ field: 'agent', kind: 'eq' }] } });
    const plain = new DataView([{ name: 's', data: [...data] }]);
    const q: QueryExpression = { source: 's', where: { agent: { _eq: 'a' } } };
    expect(indexed.query(q)).toEqual(plain.query(q));
    expect(indexed.query(q)).toEqual([
      { agent: 'a', cost: 1 },
      { agent: 'a', cost: 3 },
    ]);
  });

  it('uses a range index and maintains it across insert/remove', () => {
    const dv = new DataView([{ name: 's', data: [{ v: 1 }, { v: 5 }, { v: 9 }] }], {
      indexes: { s: [{ field: 'v', kind: 'range' }] },
    });
    const q: QueryExpression = { source: 's', where: { v: { _gte: 5 } }, order_by: [{ v: 'asc' }] };
    expect(dv.query(q)).toEqual([{ v: 5 }, { v: 9 }]);
    dv.insert('s', { v: 7 });
    expect(dv.query(q)).toEqual([{ v: 5 }, { v: 7 }, { v: 9 }]);
    dv.remove('s', { v: 5 });
    expect(dv.query(q)).toEqual([{ v: 7 }, { v: 9 }]);
  });

  it('narrows an `_and` of indexed leaves, and scans a non-indexable one', () => {
    const dv = new DataView([{ name: 's', data: [{ a: 'x', b: 1 }, { a: 'x', b: 9 }, { a: 'y', b: 9 }] }], {
      indexes: { s: [{ field: 'a', kind: 'eq' }, { field: 'b', kind: 'range' }] },
    });
    const q: QueryExpression = { source: 's', where: { _and: [{ a: { _eq: 'x' } }, { b: { _gt: 5 } }] } };
    expect(dv.query(q)).toEqual([{ a: 'x', b: 9 }]);
  });
});
