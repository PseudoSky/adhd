/**
 * query.spec.ts — SPEC.md §7 DoD clause 5: dependency cycle detection. Real
 * `addDependency` calls forming an actual cycle (A -> B -> C -> A) against a
 * real store; `topoOrder` must return `{ok:false, cycle:[...]}` naming all
 * three ids — not just "does not crash".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';
import { addDependencyNode } from './structure.js';
import { topoOrder } from './query.js';

const REPO = 'PseudoSky/cycle-test';

describe('topoOrder — real dependency-cycle detection', () => {
  let tmp: TmpStore;

  beforeEach(() => {
    tmp = openTmpStore('query-spec');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('returns a valid dependency-first order for an acyclic graph', () => {
    const a = createItemNode(tmp.store, { family: 'BUG-TOPO', title: 'a', body: 'x', repo: REPO });
    const b = createItemNode(tmp.store, { family: 'BUG-TOPO', title: 'b', body: 'x', repo: REPO });
    const c = createItemNode(tmp.store, { family: 'BUG-TOPO', title: 'c', body: 'x', repo: REPO });
    // c depends on b, b depends on a: a must complete first.
    addDependencyNode(tmp.store, REPO, b.item.humanId, a.item.humanId);
    addDependencyNode(tmp.store, REPO, c.item.humanId, b.item.humanId);

    const result = topoOrder(tmp.store, { repo: REPO });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const idxA = result.order.indexOf(a.item.humanId);
    const idxB = result.order.indexOf(b.item.humanId);
    const idxC = result.order.indexOf(c.item.humanId);
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it('detects a real A -> B -> C -> A dependency cycle and names all three ids', () => {
    const a = createItemNode(tmp.store, { family: 'BUG-CYCLE', title: 'a', body: 'x', repo: REPO });
    const b = createItemNode(tmp.store, { family: 'BUG-CYCLE', title: 'b', body: 'x', repo: REPO });
    const c = createItemNode(tmp.store, { family: 'BUG-CYCLE', title: 'c', body: 'x', repo: REPO });

    addDependencyNode(tmp.store, REPO, a.item.humanId, b.item.humanId);
    addDependencyNode(tmp.store, REPO, b.item.humanId, c.item.humanId);
    addDependencyNode(tmp.store, REPO, c.item.humanId, a.item.humanId);

    const result = topoOrder(tmp.store, { repo: REPO });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(new Set(result.cycle)).toEqual(new Set([a.item.humanId, b.item.humanId, c.item.humanId]));
  });

  it('a cycle among a subset does not prevent ordering the rest of the graph from crashing (does not throw)', () => {
    const a = createItemNode(tmp.store, { family: 'BUG-PARTCYCLE', title: 'a', body: 'x', repo: REPO });
    const b = createItemNode(tmp.store, { family: 'BUG-PARTCYCLE', title: 'b', body: 'x', repo: REPO });
    const solo = createItemNode(tmp.store, { family: 'BUG-PARTCYCLE', title: 'solo', body: 'x', repo: REPO });
    addDependencyNode(tmp.store, REPO, a.item.humanId, b.item.humanId);
    addDependencyNode(tmp.store, REPO, b.item.humanId, a.item.humanId);
    void solo;

    expect(() => topoOrder(tmp.store, { repo: REPO })).not.toThrow();
    const result = topoOrder(tmp.store, { repo: REPO });
    expect(result.ok).toBe(false);
  });
});
