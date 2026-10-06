/**
 * Consumer-outcome integration specs for the fold of the v2 query features into
 * the ONE shipped `DataView`. These drive the real barrel/class the way a
 * consumer does — not mocks — and each assertion is binary.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pkg from '../index';
import * as modelIndex from './model/index';
import {
  DataView,
  QueryValidationError,
  normalizeQuery,
  type QueryExpression,
} from '../index';
import { execute, type EvalCtx } from './model/execute';

describe('one surface', () => {
  it('exposes no queryModel namespace and exactly one DataView class', () => {
    expect('queryModel' in pkg).toBe(false);
    expect(pkg.DataView).toBe(modelIndex.DataView);
    expect(typeof pkg.DataView).toBe('function');
  });

  it('the README no longer mentions the removed namespace', () => {
    const readme = fs.readFileSync(
      fileURLToPath(new URL('../../README.md', import.meta.url)),
      'utf-8'
    );
    expect(readme).not.toContain('queryModel');
  });
});

describe('one class, both constructors', () => {
  it('single-source and multi-source are the same class and interleave view()/query()', () => {
    const single = new DataView([{ id: 1 }, { id: 2 }], {
      where: { id: { _eq: 1 } },
    });
    const multi = new DataView([{ name: 'data', data: [{ id: 1 }, { id: 2 }] }], {
      indexes: { data: [{ field: 'id', kind: 'eq' }] },
    });

    expect(single).toBeInstanceOf(DataView);
    expect(multi).toBeInstanceOf(DataView);

    expect(single.view()).toEqual([{ id: 1 }]);
    // The callable query runs against a named source and does not disturb view().
    expect(multi.query({ source: 'data', where: { id: { _eq: 1 } } })).toEqual([
      { id: 1 },
    ]);
    // The fluent builder still works on the multi-source instance.
    expect(multi.where({ id: { _gt: 0 } }).view()).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe('builder + multi-source round-trip', () => {
  const sourceRows = () => [
    { k: 'a', v: 1 },
    { k: 'b', v: 2 },
  ];

  it('an insert is reflected in view() and equals an execute() recompute', () => {
    const dv = new DataView([{ name: 'data', data: sourceRows() }], {
      indexes: { data: [{ field: 'k', kind: 'eq' }] },
    });
    expect(dv.where({ v: { _gt: 0 } }).view()).toEqual(sourceRows());

    dv.insert('data', { k: 'c', v: 3 });
    const expected = [
      { k: 'a', v: 1 },
      { k: 'b', v: 2 },
      { k: 'c', v: 3 },
    ];
    expect(dv.view()).toEqual(expected);

    const q: QueryExpression = { where: { v: { _gt: 0 } } };
    const source = dv.get('data');
    const ctx: EvalCtx = {
      sourceRows: source,
      sources: new Map([['data', source]]),
      memo: new Map(),
    };
    expect(dv.view()).toEqual(
      execute(q as unknown as Parameters<typeof execute>[0], source, ctx)
    );
  });

  it('NEGATIVE CONTROL: without raising `dirty`, the view is stale', () => {
    const dv = new DataView([{ name: 'data', data: sourceRows() }]);
    dv.where({ v: { _gt: 0 } }).view();
    dv.insert('data', { k: 'd', v: 4 });
    // Simulate an insert that forgot to raise the flag: the cached view is stale.
    dv.dirty = false;
    expect(dv.view()).not.toContainEqual({ k: 'd', v: 4 });
    // The real insert DID raise it → the next view() reflects the row.
    dv.dirty = true;
    expect(dv.view()).toContainEqual({ k: 'd', v: 4 });
  });
});

describe('v2 grammar via view() equals query()', () => {
  it('runs the same grammar through both entry points', () => {
    const rows = () => [
      { agent: 'a', v: 1 },
      { agent: 'b', v: 5 },
      { agent: 'a', v: 2 },
    ];
    const q: QueryExpression = {
      group_by: ['agent', { name: 'total', aggregate: { _sum: 'v' } }],
      order_by: [{ agent: 'asc' }],
    };

    const viaView = new DataView(rows(), q).view();
    const dv = new DataView([{ name: 'data', data: rows() }]);
    const viaQuery = dv.query(q);

    expect(viaView).toEqual([
      { agent: 'a', total: 3 },
      { agent: 'b', total: 5 },
    ]);
    expect(viaView).toEqual(viaQuery);
  });
});

describe('deprecated v1 fields still produce their v1 results', () => {
  const rows = [
    { agent: 'a', v: 1 },
    { agent: 'b', v: 5 },
    { agent: 'a', v: 2 },
  ];

  it('the root aggregate-map sums per group', () => {
    expect(
      new DataView(rows, {
        group_by: ['agent'],
        aggregate: { c: { _sum: 'v' } },
      }).view()
    ).toEqual([
      { agent: 'a', c: 3 },
      { agent: 'b', c: 5 },
    ]);
  });

  it('having filters the grouped result', () => {
    expect(
      new DataView(rows, {
        group_by: ['agent'],
        aggregate: { c: { _sum: 'v' } },
        having: { c: { _gt: 3 } },
      }).view()
    ).toEqual([{ agent: 'b', c: 5 }]);
  });

  it("output:'rows' broadcasts back to the source rows", () => {
    const data = [
      { id: 'first', g: 'x', v: 5 },
      { id: 'second', g: 'x', v: 1 },
    ];
    const out = new DataView(data, {
      group_by: ['g'],
      aggregate: { c: { _sum: 'v' } },
      output: 'rows',
    }).view() as unknown as Record<string, unknown>[];
    expect(out.map((r) => r['id'])).toEqual(['first', 'second']);
  });

  it('top_n keeps N groups and folds the tail into one _other', () => {
    const data = [
      { agent: 'a', v: 1 },
      { agent: 'b', v: 2 },
      { agent: 'c', v: 3 },
    ];
    const out = new DataView(data, {
      group_by: ['agent'],
      aggregate: { cost: { _sum: 'v' } },
      top_n: { n: 2, by: 'cost', other: true },
    }).view() as unknown as Record<string, unknown>[];
    expect(out.length).toBe(3);
    expect(out[0]['agent']).toBe('c');
    expect(out.find((r) => r['_other'] === true)?.['cost']).toBe(1);
  });
});

describe('normalizeQuery — the deprecated-alias boundary', () => {
  it('translates aggregate-map + having + top_n into the canonical IR', () => {
    const n = normalizeQuery({
      group_by: ['agent'],
      aggregate: { cost: { _sum: 'v' } },
      where: { v: { _gt: 0 } },
      having: { cost: { _gt: 0 } },
      top_n: { n: 2, by: 'cost', other: true },
    });
    expect(n.group_by).toEqual([
      'agent',
      { name: 'cost', aggregate: { _sum: 'v' } },
    ]);
    expect(n.where).toEqual({ _and: [{ v: { _gt: 0 } }, { cost: { _gt: 0 } }] });
    expect(n.order_by).toEqual([{ cost: 'desc' }]);
    expect(n.keep).toEqual({ n: 2, other: true });
  });

  it('moves a query-level window onto each fold', () => {
    const n = normalizeQuery({
      group_by: ['agent'],
      aggregate: { c: { _sum: 'v' } },
      window: { field: 't', period: ['PT1H', 0] },
    });
    expect(n.group_by).toEqual([
      'agent',
      {
        name: 'c',
        aggregate: { _sum: 'v', _window: { field: 't', period: ['PT1H', 0] } },
      },
    ]);
  });

  it('rejects a shape that has no canonical form', () => {
    expect(() =>
      normalizeQuery({
        group_by: { _rollup: ['a'] },
        aggregate: { s: { _sum: 'v' } },
      })
    ).toThrow(QueryValidationError);
  });
});
