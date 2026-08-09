import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';
import { addDependencyNode } from './structure.js';
import { topoOrder } from './query.js';

const REPO = 'PseudoSky/query-spec';

describe('topoOrder — real dependency-cycle detection', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('query-spec-topo');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns a valid dependency-first order for an acyclic graph', async () => {
    const a = await createItemNode(tmp.store, { family: 'BUG-TOPO', title: 'a', body: 'x', repo: REPO });
    const b = await createItemNode(tmp.store, { family: 'BUG-TOPO', title: 'b', body: 'x', repo: REPO });
    const c = await createItemNode(tmp.store, { family: 'BUG-TOPO', title: 'c', body: 'x', repo: REPO });
    await addDependencyNode(tmp.store, REPO, b.item.humanId, a.item.humanId);
    await addDependencyNode(tmp.store, REPO, c.item.humanId, b.item.humanId);

    const result = await topoOrder(tmp.store, { repo: REPO });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const idxA = result.order.indexOf(a.item.humanId);
    const idxB = result.order.indexOf(b.item.humanId);
    const idxC = result.order.indexOf(c.item.humanId);
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it('detects a real A -> B -> C -> A dependency cycle and names all three ids', async () => {
    const a = await createItemNode(tmp.store, { family: 'BUG-CYCLE', title: 'a', body: 'x', repo: REPO });
    const b = await createItemNode(tmp.store, { family: 'BUG-CYCLE', title: 'b', body: 'x', repo: REPO });
    const c = await createItemNode(tmp.store, { family: 'BUG-CYCLE', title: 'c', body: 'x', repo: REPO });

    await addDependencyNode(tmp.store, REPO, a.item.humanId, b.item.humanId);
    await addDependencyNode(tmp.store, REPO, b.item.humanId, c.item.humanId);
    await addDependencyNode(tmp.store, REPO, c.item.humanId, a.item.humanId);

    const result = await topoOrder(tmp.store, { repo: REPO });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(new Set(result.cycle)).toEqual(new Set([a.item.humanId, b.item.humanId, c.item.humanId]));
  });

  it('a cycle among a subset does not prevent ordering the rest of the graph from crashing (does not throw)', async () => {
    const a = await createItemNode(tmp.store, { family: 'BUG-PARTCYCLE', title: 'a', body: 'x', repo: REPO });
    const b = await createItemNode(tmp.store, { family: 'BUG-PARTCYCLE', title: 'b', body: 'x', repo: REPO });
    const solo = await createItemNode(tmp.store, { family: 'BUG-PARTCYCLE', title: 'solo', body: 'x', repo: REPO });
    await addDependencyNode(tmp.store, REPO, a.item.humanId, b.item.humanId);
    await addDependencyNode(tmp.store, REPO, b.item.humanId, a.item.humanId);
    void solo;

    await expect(topoOrder(tmp.store, { repo: REPO })).resolves.toBeDefined();
    const result = await topoOrder(tmp.store, { repo: REPO });
    expect(result.ok).toBe(false);
  });
});
