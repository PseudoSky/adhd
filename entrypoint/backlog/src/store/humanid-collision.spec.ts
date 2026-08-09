/**
 * humanid-collision.spec.ts — BUG-BACKLOG-HUMANID-COLLISION-001, against a
 * real temp SQLite-backed `GraphBacklogStore` (no mocks):
 *
 *  1. Fix #1 (write-time): `createItem` REJECTS a missing/empty/whitespace
 *     `family` when `idOverride` is not also given — the exact input shape
 *     that used to silently mint `humanId: "undefined-001"`. The legitimate
 *     `idOverride`-only creation path (no `family` needed) must still work.
 *  2. Fix #2 (read-time): a lookup that finds MORE THAN ONE live node
 *     sharing the same `(repo, humanId)` key throws `AmbiguousHumanIdError`
 *     listing every colliding nodeId, instead of silently picking one (the
 *     exact failure mode that caused a real mis-transition — see the
 *     backlog item body). The ambiguous state is constructed directly
 *     against the graph backend (bypassing the now-fixed `createItemNode`
 *     guard) to simulate the pre-existing collision.
 *  3. The `renameHumanIdNode` repair primitive: nodeId-scoped, so it works
 *     even while two nodes share a key; rejects renaming into an
 *     already-claimed id; rejects a nodeId/oldHumanId mismatch.
 *
 * Every assertion has teeth: negative controls confirm the un-ambiguous,
 * non-empty-family path is completely unaffected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { AmbiguousHumanIdError, InvalidArgumentError } from '../model.js';
import { createItemNode } from './crud.js';
import { findItemNode } from './query.js';
import { renameHumanIdNode } from './structure.js';
import { BACKLOG_ITEM_TAG, buildNodeContent, buildNodeName } from './mapping.js';

const REPO = 'PseudoSky/adhd';

let tmp: TmpStore;

beforeEach(() => {
  tmp = openTmpStore('humanid-collision-spec');
});

afterEach(() => {
  tmp.cleanup();
});

describe('fix #1: createItemNode rejects a missing/empty family unless idOverride is given', () => {
  it('throws InvalidArgumentError when family is undefined', () => {
    expect(() =>
      createItemNode(tmp.store, { family: undefined as unknown as string, title: 't', body: 'b', repo: REPO })
    ).toThrow(InvalidArgumentError);
  });

  it('throws InvalidArgumentError when family is an empty string', () => {
    expect(() => createItemNode(tmp.store, { family: '', title: 't', body: 'b', repo: REPO })).toThrow(InvalidArgumentError);
  });

  it('throws InvalidArgumentError when family is whitespace-only', () => {
    expect(() => createItemNode(tmp.store, { family: '   ', title: 't', body: 'b', repo: REPO })).toThrow(InvalidArgumentError);
  });

  it('never mints a humanId of "undefined-001" — the rejected create never reaches allocation at all', () => {
    try {
      createItemNode(tmp.store, { family: undefined as unknown as string, title: 't', body: 'b', repo: REPO });
    } catch {
      // expected
    }
    const found = findItemNode(tmp.store, REPO, 'undefined-001');
    expect(found).toBeNull();
  });

  it('a normal, valid family still creates successfully — unaffected by the guard', () => {
    const result = createItemNode(tmp.store, { family: 'BUG-VALID', title: 't', body: 'b', repo: REPO });
    expect(result.created).toBe(true);
    expect(result.item.humanId).toBe('BUG-VALID-001');
  });

  it('the legitimate idOverride-only path (no family) still works — must not break', () => {
    const result = createItemNode(tmp.store, {
      family: undefined as unknown as string,
      idOverride: 'BUG-IMPORTED-042',
      title: 't',
      body: 'b',
      repo: REPO,
    });
    expect(result.created).toBe(true);
    expect(result.item.humanId).toBe('BUG-IMPORTED-042');
  });
});

describe('fix #2: ambiguous (repo, humanId) lookups throw instead of silently picking one', () => {
  /** Directly writes a second live node sharing an existing (repo, humanId) key — simulating the pre-existing collision without going through the now-guarded createItemNode. */
  function forceCollidingNode(repo: string, humanId: string, title: string, body: string): number {
    return tmp.store.graph.writeNode(buildNodeContent(repo, humanId, title, body) + `\n<!-- dup:${Math.random()} -->`, {
      kind: 'generic',
      name: buildNodeName(repo, humanId), // deliberately colliding name too
      summary: title,
      tags: [BACKLOG_ITEM_TAG, 'undefined', 'undefined'],
      namespace: repo,
      metadata: {
        humanId,
        kind: 'undefined',
        family: 'undefined',
        title,
        body,
        status: 'OPEN',
        repo,
        citations: [],
        notes: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  }

  it('findItemNode throws AmbiguousHumanIdError listing both colliding nodeIds', () => {
    const first = createItemNode(tmp.store, { family: 'undefined', title: 'first colliding item', body: 'b1', repo: REPO });
    // createItemNode above legitimately mints "undefined-001" (a VALID family
    // literally named "undefined" is allowed — the guard only rejects
    // missing/empty family). Force a SECOND live node onto the exact same key.
    const secondNodeId = forceCollidingNode(REPO, first.item.humanId, 'second colliding item', 'b2');

    let caught: unknown;
    try {
      findItemNode(tmp.store, REPO, first.item.humanId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmbiguousHumanIdError);
    const err = caught as AmbiguousHumanIdError;
    expect(err.nodeIds.sort((a, b) => a - b)).toEqual([first.item.nodeId, secondNodeId].sort((a, b) => a - b));
  });

  it('a genuinely unambiguous lookup is completely unaffected — no throw', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-UNAMBIG', title: 't', body: 'b', repo: REPO });
    const found = findItemNode(tmp.store, REPO, created.item.humanId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.item.nodeId);
  });

  it('a lookup for a DIFFERENT repo sharing the same humanId string is unaffected (namespace-scoped)', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-SCOPE', title: 't', body: 'b', repo: REPO });
    forceCollidingNode('some/other-repo', created.item.humanId, 'unrelated', 'unrelated body');
    const found = findItemNode(tmp.store, REPO, created.item.humanId);
    expect(found?.id).toBe(created.item.nodeId);
  });
});

describe('renameHumanIdNode repair primitive', () => {
  it('renames a node to a fresh, non-colliding humanId', () => {
    const created = createItemNode(tmp.store, { family: 'undefined', title: 'needs repair', body: 'b', repo: REPO });
    const renamed = renameHumanIdNode(tmp.store, REPO, created.item.nodeId, created.item.humanId, 'BUG-REPAIRED-001');
    expect(renamed.humanId).toBe('BUG-REPAIRED-001');
    expect(renamed.kind).toBe('BUG');
    expect(renamed.family).toBe('BUG-REPAIRED');

    const found = findItemNode(tmp.store, REPO, 'BUG-REPAIRED-001');
    expect(found?.id).toBe(created.item.nodeId);
    // Old id no longer resolves.
    const old = findItemNode(tmp.store, REPO, created.item.humanId);
    expect(old).toBeNull();
  });

  it('is nodeId-scoped: works even while another node shares the OLD colliding key', () => {
    const first = createItemNode(tmp.store, { family: 'undefined', title: 'item A', body: 'bA', repo: REPO });
    const secondNodeId = tmp.store.graph.writeNode(buildNodeContent(REPO, first.item.humanId, 'item B', 'bB') + '\n<!-- dup -->', {
      kind: 'generic',
      name: buildNodeName(REPO, first.item.humanId),
      summary: 'item B',
      tags: [BACKLOG_ITEM_TAG, 'undefined', 'undefined'],
      namespace: REPO,
      metadata: {
        humanId: first.item.humanId,
        kind: 'undefined',
        family: 'undefined',
        title: 'item B',
        body: 'bB',
        status: 'OPEN',
        repo: REPO,
        citations: [],
        notes: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    // Plain findItemNode is now ambiguous — confirm the repair primitive
    // does NOT go through it and succeeds anyway, nodeId-scoped.
    expect(() => findItemNode(tmp.store, REPO, first.item.humanId)).toThrow(AmbiguousHumanIdError);

    const renamedA = renameHumanIdNode(tmp.store, REPO, first.item.nodeId, first.item.humanId, 'DEBT-REPAIR-A-001');
    expect(renamedA.humanId).toBe('DEBT-REPAIR-A-001');

    const renamedB = renameHumanIdNode(tmp.store, REPO, secondNodeId, first.item.humanId, 'DEBT-REPAIR-B-001');
    expect(renamedB.humanId).toBe('DEBT-REPAIR-B-001');

    // Collision fully resolved — both now resolve unambiguously.
    expect(findItemNode(tmp.store, REPO, 'DEBT-REPAIR-A-001')?.id).toBe(first.item.nodeId);
    expect(findItemNode(tmp.store, REPO, 'DEBT-REPAIR-B-001')?.id).toBe(secondNodeId);
  });

  it('refuses to rename INTO an already-claimed humanId', () => {
    const existing = createItemNode(tmp.store, { family: 'BUG-TAKEN', title: 't', body: 'b', repo: REPO });
    const toRename = createItemNode(tmp.store, { family: 'undefined', title: 'needs repair', body: 'b', repo: REPO });
    expect(() => renameHumanIdNode(tmp.store, REPO, toRename.item.nodeId, toRename.item.humanId, existing.item.humanId)).toThrow(
      InvalidArgumentError
    );
  });

  it('refuses when the given nodeId does not currently carry oldHumanId (wrong-node guard)', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-REALID', title: 't', body: 'b', repo: REPO });
    expect(() => renameHumanIdNode(tmp.store, REPO, created.item.nodeId, 'BUG-WRONG-999', 'BUG-NEW-001')).toThrow(InvalidArgumentError);
  });
});
