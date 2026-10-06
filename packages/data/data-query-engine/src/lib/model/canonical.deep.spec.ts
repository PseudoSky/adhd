/**
 * dqe-canonical-b7d4 AC2 — canonicalization must not consume native call-stack
 * proportional to query nesting depth.
 *
 * Root cause (release-3 `data-query-engine:test` RangeError): `canon` recursed
 * natively (canon -> keys.map -> canon -> value.map -> canon ...), ~O(depth) V8
 * frames. Measured in a vitest worker on node 24 / default --stack-size=984: the
 * max `_and` nesting survivable was ~1171 while the interpreter was cold and
 * ~3717 once JIT-optimized. `model.big-o.spec.ts` canonicalizes depth 1024, i.e.
 * ~87% of the cold limit, so whether it passed depended on JIT tier / worker
 * load (it passed in release-2, overflowed in release-3 with identical source).
 * These tests use depths beyond even the JIT-warm limit (6k-8k > ~3.7k), so the red state is
 * deterministic, and they pin byte-identical output against a recursive reference.
 */
import { describe, it, expect } from 'vitest';
import { canonicalizePredicate, computeKey, planKey } from './canonical';
import type { Predicate, QueryExpression } from './types';

const deepAnd = (k: number): Predicate => {
  let node: Predicate = { a: { _eq: 0 } };
  for (let i = 1; i < k; i++) node = { _and: [node, { a: { _eq: i } }] };
  return node;
};

/** The pre-fix recursive algorithm, kept as an oracle for output parity. */
function referenceCanon(value: unknown, key: string | undefined, memo: Map<unknown, string>): string {
  const SORT_DEDUP = new Set(['_and', '_or', '_in', '_nin']);
  const SORT_KEEP = new Set(['group_by']);
  if (Array.isArray(value)) {
    const items = value.map((v) => referenceCanon(v, undefined, memo));
    if (key !== undefined && SORT_DEDUP.has(key)) return `[${[...new Set(items)].sort().join(',')}]`;
    if (key !== undefined && SORT_KEEP.has(key)) return `[${[...items].sort().join(',')}]`;
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    const hit = memo.get(rec);
    if (hit !== undefined) return hit;
    const keys = Object.keys(rec).sort();
    const out = `{${keys.map((k) => `${JSON.stringify(k)}:${referenceCanon(rec[k], k, memo)}`).join(',')}}`;
    memo.set(rec, out);
    return out;
  }
  const out = JSON.stringify(value);
  return out === undefined ? 'null' : out;
}

describe('canonicalization is depth-safe (dqe-canonical-b7d4 AC2)', () => {
  for (const depth of [6_000, 8_000]) {
    it(`canonicalizes ${depth}-deep _and nesting without a native stack overflow, in linear size`, () => {
      const key = canonicalizePredicate(deepAnd(depth));
      expect(key.length).toBeLessThan(40 * depth);
      expect(key.startsWith('{"_and":[')).toBe(true);
    });
  }

  it('planKey and computeKey are depth-safe too', () => {
    const q = { source: 's', where: deepAnd(6_000) } as unknown as QueryExpression;
    expect(planKey(q).length).toBeGreaterThan(6_000);
    expect(computeKey({ ...q, name: 'x' } as QueryExpression)).toBe(computeKey({ ...q, name: 'y' } as QueryExpression));
  });

  it('a depth-safe key still grows linearly (O(n) guarantee)', () => {
    const a = canonicalizePredicate(deepAnd(2_000)).length;
    const b = canonicalizePredicate(deepAnd(8_000)).length;
    expect(b / a).toBeLessThan(6);
  });

  it('is byte-identical to the recursive reference (sorting, dedupe, order-sensitive slots, undefined, DAG sharing)', () => {
    const shared: Predicate = { z: { _eq: 1 }, a: { _in: [3, 1, 2, 1] } };
    const fixtures: unknown[] = [
      { b: 1, a: [1, 2, { y: undefined, x: null }] },
      { _and: [{ b: { _eq: 2 } }, { a: { _eq: 1 } }, { b: { _eq: 2 } }] },
      { _or: [{ _nin: ['b', 'a', 'b'] }], group_by: ['k2', 'k1', 'k2'], order_by: ['z', 'a'], select: ['q', 'p'] },
      { _add: [3, 1, 2], _coalesce: [null, 2] },
      { _and: [shared, shared, { w: shared }] },
      [],
      'scalar',
      undefined,
    ];
    for (const f of fixtures) {
      expect(canonicalizePredicate(f as Predicate)).toBe(referenceCanon(f, undefined, new Map()));
    }
    const dag = deepAnd(300);
    expect(canonicalizePredicate(dag)).toBe(referenceCanon(dag, undefined, new Map()));
  });

  it('shares one memo across calls and reuses a shared subexpression by identity', () => {
    const memo = new Map<unknown, string>();
    const shared: Predicate = { a: { _eq: 1 } };
    const k1 = canonicalizePredicate({ _and: [shared, shared] }, memo);
    expect(memo.has(shared)).toBe(true);
    expect(k1).toBe('{"_and":[{"a":{"_eq":1}}]}');
  });

  it('rejects a cyclic query with a TypeError instead of looping or overflowing', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = [cyc];
    expect(() => canonicalizePredicate(cyc as Predicate)).toThrow(TypeError);
  });
});
