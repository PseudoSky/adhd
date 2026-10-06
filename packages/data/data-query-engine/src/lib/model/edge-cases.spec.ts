/**
 * Edge-case regressions from the parallel test-audit. Each pins a real
 * consumer-visible bug and would FAIL against the pre-fix code.
 */
import { describe, it, expect } from 'vitest';
import { DataView, type QueryExpression } from '../../index';
import { execute } from './execute';

type Row = Record<string, unknown>;

const view = (rows: Row[], query: QueryExpression): Row[] =>
  new DataView(rows, query).view() as unknown as Row[];

// ── a7facd45 — `_eq: undefined` must not narrow (an index can never change a result)

describe('index soundness — `_eq: undefined` is a no-op, not a narrowing', () => {
  const data: Row[] = [{ a: 1 }, { b: 2 }, { a: undefined }];

  it('an equality-indexed DataView equals a plain one for `{a:{_eq:undefined}}`', () => {
    const indexed = new DataView([{ name: 's', data: [...data] }], {
      indexes: { s: [{ field: 'a', kind: 'eq' }] },
    });
    const plain = new DataView([{ name: 's', data: [...data] }]);
    const q: QueryExpression = { source: 's', where: { a: { _eq: undefined } } };
    expect(indexed.query(q)).toEqual(plain.query(q));
    // the matcher skips an undefined operand => every row survives
    expect(plain.query(q)).toEqual(data);
  });

  it('a bitmap-indexed DataView is equally sound', () => {
    const indexed = new DataView([{ name: 's', data: [...data] }], {
      indexes: { s: [{ field: 'a', kind: 'bitmap' }] },
    });
    const plain = new DataView([{ name: 's', data: [...data] }]);
    const q: QueryExpression = { source: 's', where: { a: { _eq: undefined } } };
    expect(indexed.query(q)).toEqual(plain.query(q));
  });
});

// ── 1d2ae7b5 — the incremental path must validate like the reference executor

describe('the incremental `query` path validates like the reference executor', () => {
  it('rejects a group-item name colliding with its own key (both paths)', () => {
    const dv = new DataView([{ name: 's', data: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }] }]);
    const q: QueryExpression = { source: 's', group_by: ['g', { name: 'g', aggregate: { _sum: 'v' } }] };
    expect(() => dv.query(q)).toThrow(/collision/); // incremental path
    expect(() => dv.query({ ...q, order_by: [{ g: 'asc' }] })).toThrow(/collision/); // reference path
  });

  it('rejects duplicate group-item names', () => {
    const dv = new DataView([{ name: 's', data: [{ g: 'a', v: 1 }] }]);
    const q: QueryExpression = {
      source: 's',
      group_by: [
        { name: 'x', aggregate: { _sum: 'v' } },
        { name: 'x', aggregate: { _count: true } },
      ],
    };
    expect(() => dv.query(q)).toThrow(/duplicate/);
  });
});

// ── e3c3a4f6 — a grouped scan partitions by the enclosing group_by by default

describe('a grouped scan partitions by the enclosing group_by by default', () => {
  it('default partition (no partition_by) isolates each group', () => {
    const rows: Row[] = [
      { g: 'a', t: 1, c: 1 },
      { g: 'b', t: 2, c: 5 },
    ];
    const out = view(rows, {
      group_by: ['g', { name: 'tot', aggregate: { _sum: 'c' } }],
      select: ['g', 'tot', { name: 'r', aggregate: { _sum: 'tot', _scan: { order_by: 't' } } }],
    });
    // documented default: r == tot per group (1, 5), NOT the whole-partition 6.
    expect(out).toEqual([
      { g: 'a', tot: 1, r: 1 },
      { g: 'b', tot: 5, r: 5 },
    ]);
  });
});

// ── 424045dd — a top-level `aggregate` leaf is not silently ignored

describe('a top-level `aggregate` leaf throws instead of being ignored', () => {
  it('NEGATIVE CONTROL: `.aggregate(...).view()` THROWS', () => {
    expect(() => new DataView([{ a: 1 }, { a: 2 }]).aggregate({ _count: true }).view()).toThrow(
      /top-level `aggregate`/
    );
  });

  it('`execute` throws for a bare top-level aggregate too', () => {
    expect(() => execute({ aggregate: { _count: true } }, [{ a: 1 }, { a: 2 }])).toThrow(
      /top-level `aggregate`/
    );
  });

  it('the supported spelling (a `group_by` item) still works', () => {
    expect(execute({ group_by: [{ name: 'n', aggregate: { _count: true } }] }, [{ a: 1 }, { a: 2 }])).toEqual([
      { n: 2 },
    ]);
  });
});
