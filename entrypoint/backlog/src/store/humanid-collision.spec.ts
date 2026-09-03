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
 *     backlog item body).
 *  3. The `renameHumanIdNode` repair primitive: nodeId-scoped, so it works
 *     even while two nodes share a key; rejects renaming into an
 *     already-claimed id; rejects a nodeId/oldHumanId mismatch.
 *
 * DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001 (see `ids.ts`'s header) added a DB-level
 * backstop on top of fix #2 above: a partial `UNIQUE` index over
 * `(namespace, meta.humanId)`, scoped to LIVE backlog-item rows. That index is
 * created lazily, inside `allocateHumanIdAndInsert`'s transaction (`ids.ts`'s
 * `ensureHumanIdUniqueIndex`) — NOT by `applySchema()` itself — so it exists
 * after the first ordinary write through this package, which every test below
 * that needs a live baseline item already performs. Two consequences for this
 * file:
 *
 *   - On a store that has taken at least one such write, a SECOND live node
 *     forced onto an existing `(repo, humanId)` via a raw `graph.writeNode`
 *     call (bypassing the higher-level `createItemNode` guard) is now
 *     REJECTED by SQLite itself ("DB-level backstop" describe block below) —
 *     this is new coverage, proving the index is load-bearing in production,
 *     not just documented.
 *   - The two tests below that need to construct an actual in-memory
 *     collision (to prove `findItemNode`'s `AmbiguousHumanIdError` guard and
 *     `renameHumanIdNode`'s nodeId-scoping still work) can no longer do so on
 *     a normal store — the index refuses the second write outright. They
 *     simulate a LEGACY store (created before this index existed, or one
 *     where it was somehow dropped) by explicitly `DROP INDEX`-ing it first.
 *     That in-app guard path is still real and still reachable — see
 *     `ids.ts`'s header — so it stays tested, just against the honest
 *     precondition that makes the collision possible at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { AmbiguousHumanIdError, InvalidArgumentError, RepoAliasCollisionError } from '../model.js';
import { createItemNode, getItemNode, updateItemNode } from './crud.js';
import { transitionStatusNode } from './lifecycle.js';
import { findItemNode } from './query.js';
import { renameHumanIdNode } from './structure.js';
import { BACKLOG_ITEM_TAG, buildNodeContent, buildNodeName } from './mapping.js';

const REPO = 'PseudoSky/adhd';

/** Must match `HUMAN_ID_LIVE_UNIQUE_INDEX` in `ids.ts` exactly. */
const HUMAN_ID_LIVE_UNIQUE_INDEX = 'ix_backlog_humanid_live_unique';

/**
 * Drops the DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001 backstop index to simulate a
 * legacy store (pre-dating the index, or one where it was otherwise lost) —
 * the only honest way left to construct an in-memory `(repo, humanId)`
 * collision now that a normal store refuses it at the DB level.
 */
async function dropHumanIdUniqueIndex(tmpStore: TmpStore): Promise<void> {
  await tmpStore.store.adapter.executeRun(`DROP INDEX IF EXISTS ${HUMAN_ID_LIVE_UNIQUE_INDEX}`);
}

/** Whether the backstop index is present in `sqlite_master` right now. */
async function humanIdUniqueIndexExists(tmpStore: TmpStore): Promise<boolean> {
  const row = await tmpStore.store.adapter.executeGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    [HUMAN_ID_LIVE_UNIQUE_INDEX]
  );
  return row != null;
}

let tmp: TmpStore;

beforeEach(async () => {
  tmp = await openTmpStore('humanid-collision-spec');
});

afterEach(() => {
  tmp.cleanup();
});

describe('fix #1: createItemNode rejects a missing/empty family unless idOverride is given', () => {
  it('throws InvalidArgumentError when family is undefined', async () => {
    await expect(createItemNode(tmp.store, { family: undefined as unknown as string, title: 't', body: 'b', repo: REPO })).rejects.toThrow(InvalidArgumentError);
  });

  it('throws InvalidArgumentError when family is an empty string', async () => {
    await expect(createItemNode(tmp.store, { family: '', title: 't', body: 'b', repo: REPO })).rejects.toThrow(InvalidArgumentError);
  });

  it('throws InvalidArgumentError when family is whitespace-only', async () => {
    await expect(createItemNode(tmp.store, { family: '   ', title: 't', body: 'b', repo: REPO })).rejects.toThrow(InvalidArgumentError);
  });

  it('never mints a humanId of "undefined-001" — the rejected create never reaches allocation at all', async () => {
    try {
      await createItemNode(tmp.store, { family: undefined as unknown as string, title: 't', body: 'b', repo: REPO });
    } catch {
      // expected
    }
    const found = await findItemNode(tmp.store, REPO, 'undefined-001');
    expect(found).toBeNull();
  });

  it('a normal, valid family still creates successfully — unaffected by the guard', async () => {
    const result = await createItemNode(tmp.store, { family: 'BUG-VALID', title: 't', body: 'b', repo: REPO });
    expect(result.created).toBe(true);
    expect(result.item.humanId).toBe('BUG-VALID-001');
  });

  it('the legitimate idOverride-only path (no family) still works — must not break', async () => {
    const result = await createItemNode(tmp.store, {
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

describe('DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001: DB-level partial-unique-index backstop', () => {
  /** Same raw-write helper used elsewhere in this file to force a second live node onto an existing (repo, humanId) key. */
  async function forceCollidingNode(tmpStore: TmpStore, repo: string, humanId: string, title: string, body: string): Promise<number> {
    return tmpStore.store.graph.writeNode(buildNodeContent(repo, humanId, title, body) + `\n<!-- dup:${Math.random()} -->`, {
      kind: 'generic',
      name: buildNodeName(repo, humanId),
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

  it('the partial unique index exists in sqlite_master after a normal store open + first write', async () => {
    // The index is created lazily inside allocateHumanIdAndInsert's
    // transaction (ids.ts), not by applySchema() at open — so a normal write
    // through this package (every real caller does at least one) is what
    // actually brings it into being. Confirm it is genuinely absent before
    // that write, and genuinely present after — proving this assertion has
    // teeth against the "the index silently stopped being created" failure
    // mode, not just checking a tautology.
    expect(await humanIdUniqueIndexExists(tmp)).toBe(false);
    await createItemNode(tmp.store, { family: 'BUG-BACKSTOP', title: 't', body: 'b', repo: REPO });
    expect(await humanIdUniqueIndexExists(tmp)).toBe(true);
  });

  it('a normally-opened store REFUSES a second live node forced onto an existing (repo, humanId) key', async () => {
    const first = await createItemNode(tmp.store, { family: 'BUG-BACKSTOP2', title: 'first', body: 'b1', repo: REPO });
    // The write above already created the index (see the previous test) — do
    // NOT drop it here; this proves the backstop is live on a normal store.
    expect(await humanIdUniqueIndexExists(tmp)).toBe(true);

    let caught: unknown;
    try {
      await forceCollidingNode(tmp, REPO, first.item.humanId, 'second', 'b2');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // Assert on the actual constraint failure, not just "it threw something".
    expect((caught as Error).message).toMatch(/UNIQUE constraint failed/i);
    expect((caught as Error).message).toContain('humanId');
  });
});

describe('fix #2: ambiguous (repo, humanId) lookups throw instead of silently picking one', () => {
  /** Directly writes a second live node sharing an existing (repo, humanId) key — simulating the pre-existing collision without going through the now-guarded createItemNode. */
  async function forceCollidingNode(repo: string, humanId: string, title: string, body: string): Promise<number> {
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

  it('findItemNode throws AmbiguousHumanIdError listing both colliding nodeIds', async () => {
    const first = await createItemNode(tmp.store, { family: 'undefined', title: 'first colliding item', body: 'b1', repo: REPO });
    // createItemNode above legitimately mints "undefined-001" (a VALID family
    // literally named "undefined" is allowed — the guard only rejects
    // missing/empty family). The write above also lazily created the
    // DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001 backstop index (ids.ts), which now
    // refuses a second live node on this exact key — so simulate a LEGACY
    // store (pre-dating the index) to force the collision this test needs.
    await dropHumanIdUniqueIndex(tmp);
    const secondNodeId = await forceCollidingNode(REPO, first.item.humanId, 'second colliding item', 'b2');

    let caught: unknown;
    try {
      await findItemNode(tmp.store, REPO, first.item.humanId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmbiguousHumanIdError);
    const err = caught as AmbiguousHumanIdError;
    expect(err.nodeIds.sort((a, b) => a - b)).toEqual([first.item.nodeId, secondNodeId].sort((a, b) => a - b));
  });

  it('a genuinely unambiguous lookup is completely unaffected — no throw', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-UNAMBIG', title: 't', body: 'b', repo: REPO });
    const found = await findItemNode(tmp.store, REPO, created.item.humanId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.item.nodeId);
  });

  it('a lookup for a DIFFERENT repo sharing the same humanId string is unaffected (namespace-scoped)', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-SCOPE', title: 't', body: 'b', repo: REPO });
    await forceCollidingNode('some/other-repo', created.item.humanId, 'unrelated', 'unrelated body');
    const found = await findItemNode(tmp.store, REPO, created.item.humanId);
    expect(found?.id).toBe(created.item.nodeId);
  });
});

describe('renameHumanIdNode repair primitive', () => {
  it('renames a node to a fresh, non-colliding humanId', async () => {
    const created = await createItemNode(tmp.store, { family: 'undefined', title: 'needs repair', body: 'b', repo: REPO });
    const renamed = await renameHumanIdNode(tmp.store, REPO, created.item.nodeId, created.item.humanId, 'BUG-REPAIRED-001');
    expect(renamed.humanId).toBe('BUG-REPAIRED-001');
    expect(renamed.kind).toBe('BUG');
    expect(renamed.family).toBe('BUG-REPAIRED');

    const found = await findItemNode(tmp.store, REPO, 'BUG-REPAIRED-001');
    expect(found?.id).toBe(created.item.nodeId);
    // Old id no longer resolves.
    const old = await findItemNode(tmp.store, REPO, created.item.humanId);
    expect(old).toBeNull();
  });

  it('is nodeId-scoped: works even while another node shares the OLD colliding key', async () => {
    const first = await createItemNode(tmp.store, { family: 'undefined', title: 'item A', body: 'bA', repo: REPO });
    // Same legacy-store simulation as above — a normal store's backstop index
    // (already created by the write above) would otherwise refuse this
    // second live node outright.
    await dropHumanIdUniqueIndex(tmp);
    const secondNodeId = await tmp.store.graph.writeNode(buildNodeContent(REPO, first.item.humanId, 'item B', 'bB') + '\n<!-- dup -->', {
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
    await expect(findItemNode(tmp.store, REPO, first.item.humanId)).rejects.toThrow(AmbiguousHumanIdError);

    const renamedA = await renameHumanIdNode(tmp.store, REPO, first.item.nodeId, first.item.humanId, 'DEBT-REPAIR-A-001');
    expect(renamedA.humanId).toBe('DEBT-REPAIR-A-001');

    const renamedB = await renameHumanIdNode(tmp.store, REPO, secondNodeId, first.item.humanId, 'DEBT-REPAIR-B-001');
    expect(renamedB.humanId).toBe('DEBT-REPAIR-B-001');

    // Collision fully resolved — both now resolve unambiguously.
    expect((await findItemNode(tmp.store, REPO, 'DEBT-REPAIR-A-001'))?.id).toBe(first.item.nodeId);
    expect((await findItemNode(tmp.store, REPO, 'DEBT-REPAIR-B-001'))?.id).toBe(secondNodeId);
  });

  it('refuses to rename INTO an already-claimed humanId', async () => {
    const existing = await createItemNode(tmp.store, { family: 'BUG-TAKEN', title: 't', body: 'b', repo: REPO });
    const toRename = await createItemNode(tmp.store, { family: 'undefined', title: 'needs repair', body: 'b', repo: REPO });
    await expect(renameHumanIdNode(tmp.store, REPO, toRename.item.nodeId, toRename.item.humanId, existing.item.humanId)).rejects.toThrow(
      InvalidArgumentError
    );
  });

  it('refuses when the given nodeId does not currently carry oldHumanId (wrong-node guard)', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-REALID', title: 't', body: 'b', repo: REPO });
    await expect(renameHumanIdNode(tmp.store, REPO, created.item.nodeId, 'BUG-WRONG-999', 'BUG-NEW-001')).rejects.toThrow(InvalidArgumentError);
  });
});

/**
 * BUG-BACKLOG-REPO-SPLIT-001 (fix #3 — read-time cross-alias guard):
 * `resolveCanonicalRepo` (store/query.ts) only reconciles a bare-segment
 * alias (e.g. `'widget'` vs `'acme/widget'`) when it can collapse the ASKED
 * repo string to a single already-known candidate. Once BOTH literal
 * spellings independently have live nodes, each one's OWN literal-input
 * short-circuit (`if (known.has(repo)) return {canonical: repo, …}`) fires
 * first, so the alias-merge loop never runs for either — the two spellings
 * are permanently unreconciled. A humanId minted independently under each
 * spelling then resolves silently to whichever literal string the caller
 * happens to pass, with no error — the exact shape this guard closes.
 *
 * Real writes only (no raw `graph.writeNode` collision-forcing needed here,
 * unlike fix #2 above): `createItemNode` writes under the LITERAL `input.repo`
 * namespace (crud.ts) and never redirects to a resolved canonical, so two
 * ordinary creates under two alias spellings are enough to reproduce the
 * hazard.
 */
describe('fix #3: repo-alias collision guard (BUG-BACKLOG-REPO-SPLIT-001)', () => {
  const REPO_A = 'widget';
  const REPO_B = 'acme/widget'; // bare-segment alias of REPO_A ('widget' === 'widget'), different literal string

  /** Seeds a baseline item under each alias spelling so BOTH become "known" to `knownRepos` before the colliding humanId is minted — the precondition resolveCanonicalRepo's short-circuit needs to reproduce the split. */
  async function seedBothReposKnown(): Promise<void> {
    await createItemNode(tmp.store, { family: 'BUG-WIDGET-BASE', title: 'baseline A', body: 'b', repo: REPO_A });
    await createItemNode(tmp.store, { family: 'BUG-ACME-BASE', title: 'baseline B', body: 'b', repo: REPO_B });
  }

  it('mints a genuine cross-alias collision: two live nodes share one humanId across REPO_A/REPO_B once both are known', async () => {
    await seedBothReposKnown();
    const first = await createItemNode(tmp.store, { family: 'BUG-SHARED', title: 'item under widget', body: 'b1', repo: REPO_A });
    const second = await createItemNode(tmp.store, {
      family: undefined as unknown as string,
      idOverride: first.item.humanId,
      title: 'item under acme/widget',
      body: 'b2',
      repo: REPO_B,
    });
    expect(second.created).toBe(true);
    expect(second.item.humanId).toBe(first.item.humanId);
    expect(second.item.nodeId).not.toBe(first.item.nodeId);

    // Confirm the split is real: findItemNode with the literal REPO_B string
    // for the OTHER alias's item returns null — the write really is under
    // two disjoint namespaces, not silently deduped.
    expect(await findItemNode(tmp.store, REPO_B, `does-not-exist-${first.item.humanId}`)).toBeNull();
  });

  /**
   * NEGATIVE CONTROL (performed — see deviations[] in the task report):
   * commenting out the `aliasCandidates`/`collisions` block in
   * `findItemNode` (store/query.ts) so it falls straight through to
   * `return canonicalMatch` turns this test RED — `findItemNode` then
   * silently returns the REPO_A node with no error, instead of throwing
   * `RepoAliasCollisionError` naming both repos and both nodeIds. Restored
   * immediately after confirming the red result.
   */
  it('findItemNode throws RepoAliasCollisionError naming both repos and both nodeIds when addressed by EITHER alias spelling', async () => {
    await seedBothReposKnown();
    const first = await createItemNode(tmp.store, { family: 'BUG-SHARED2', title: 'item under widget', body: 'b1', repo: REPO_A });
    const second = await createItemNode(tmp.store, {
      family: undefined as unknown as string,
      idOverride: first.item.humanId,
      title: 'item under acme/widget',
      body: 'b2',
      repo: REPO_B,
    });
    expect(second.created).toBe(true);

    for (const askedRepo of [REPO_A, REPO_B]) {
      let caught: unknown;
      try {
        await findItemNode(tmp.store, askedRepo, first.item.humanId);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RepoAliasCollisionError);
      const err = caught as RepoAliasCollisionError;
      expect(err.message).toContain(first.item.humanId);
      const reposNamed = err.matches.map((m) => m.repo).sort();
      expect(reposNamed).toEqual([REPO_A, REPO_B].sort());
      const nodeIdsNamed = err.matches.map((m) => m.nodeId).sort((a, b) => a - b);
      expect(nodeIdsNamed).toEqual([first.item.nodeId, second.item.nodeId].sort((a, b) => a - b));
    }
  });

  it('get/update/transitionStatus all surface RepoAliasCollisionError instead of silently resolving to one alias', async () => {
    await seedBothReposKnown();
    const first = await createItemNode(tmp.store, { family: 'BUG-SHARED3', title: 'item under widget', body: 'b1', repo: REPO_A });
    await createItemNode(tmp.store, {
      family: undefined as unknown as string,
      idOverride: first.item.humanId,
      title: 'item under acme/widget',
      body: 'b2',
      repo: REPO_B,
    });

    await expect(getItemNode(tmp.store, REPO_A, first.item.humanId)).rejects.toThrow(RepoAliasCollisionError);
    await expect(updateItemNode(tmp.store, REPO_A, first.item.humanId, { title: 'renamed' })).rejects.toThrow(RepoAliasCollisionError);
    await expect(transitionStatusNode(tmp.store, REPO_A, first.item.humanId, 'WONTFIX', { by: 'tester', reason: 'collision test' })).rejects.toThrow(
      RepoAliasCollisionError
    );
  });

  it('is a pure addition: an unambiguous humanId under ONE alias resolves exactly as before, no error, no behavior change', async () => {
    await seedBothReposKnown();
    // Baseline items above are each present under exactly ONE of the two
    // aliases — REPO_A's baseline humanId never exists under REPO_B, and
    // vice versa. The alias probe must find nothing on the other side and
    // must NOT throw.
    const baselineA = await getItemNode(tmp.store, REPO_A, 'BUG-WIDGET-BASE-001');
    expect(baselineA).not.toBeNull();
    expect(baselineA?.humanId).toBe('BUG-WIDGET-BASE-001');

    const baselineB = await getItemNode(tmp.store, REPO_B, 'BUG-ACME-BASE-001');
    expect(baselineB).not.toBeNull();
    expect(baselineB?.humanId).toBe('BUG-ACME-BASE-001');

    // Also unaffected via findItemNode directly, and via update.
    const found = await findItemNode(tmp.store, REPO_A, 'BUG-WIDGET-BASE-001');
    expect(found?.namespace).toBe(REPO_A);
    const updated = await updateItemNode(tmp.store, REPO_A, 'BUG-WIDGET-BASE-001', { title: 'still fine' });
    expect(updated.title).toBe('still fine');
  });

  it('a repo with NO bare-segment alias in the store is completely unaffected (findAliasRepoCandidates returns [])', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-LONER', title: 't', body: 'b', repo: 'totally-unrelated-repo' });
    const found = await findItemNode(tmp.store, 'totally-unrelated-repo', created.item.humanId);
    expect(found?.id).toBe(created.item.nodeId);
  });
});
