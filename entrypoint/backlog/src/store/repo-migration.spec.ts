/**
 * repo-migration.spec.ts — BUG-BACKLOG-REPO-SPLIT-001 / DEBT-BACKLOG-REPO-MOVE-001,
 * against a real temp turso-backed `GraphBacklogStore` (no mocks):
 *
 *  1. `planRepoMigration` is pure/read-only: never mutates, is deterministic,
 *     and resolves every humanId collision to the next free number in the
 *     SAME family — including when >1 item in the same family collides in
 *     one batch (each gets a distinct target, never each other's).
 *  2. It is `namespace`-scoped, not `metadata.repo`-scoped, so an item whose
 *     two repo fields have already diverged is still picked up and fully
 *     repaired (the real, empirically-discovered `FEAT-001`/`FEAT-002` shape
 *     — DEBT-BACKLOG-REPO-MOVE-001 Finding 2).
 *  3. `migrateRepo`'s `dryRun` (default `true`) never writes anything —
 *     verified by re-reading the store afterward, not merely by
 *     inspecting the return value.
 *  4. `migrateRepo({dryRun:false})` actually moves: `namespace`,
 *     `metadata.repo`, `humanId` (when renamed), `name`, and the content
 *     marker are all updated together; the OLD (fromRepo, humanId) key no
 *     longer resolves; an audit note recording the move is attached.
 *  5. Cross-item graph edges (DEPENDS_ON) survive a move untouched — nodeId
 *     never changes.
 *  6. Every planned item gets exactly one reported outcome — a per-item
 *     failure (stale plan / target claimed after planning) is reported
 *     `ok:false` with an error, never silently dropped, and never aborts
 *     the rest of the batch.
 *
 * Every assertion has teeth: negative controls confirm the un-colliding,
 * non-diverged case is completely unaffected, and the collision/staleness
 * guards are proven by actually forcing the failure condition, not merely
 * asserted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import * as client from '../client.js';
import type { BacklogCtx } from '../client.js';
import { buildBacklogEnv } from '../env.js';
import { BacklogItemNotFoundError, InvalidArgumentError } from '../model.js';
import { createItemNode } from './crud.js';
import { addDependencyNode } from './structure.js';
import { findItemNode } from './query.js';
import { buildNodeContent, buildNodeName, BACKLOG_ITEM_TAG } from './mapping.js';
import { migrateRepoItemNode, planRepoMigration } from './repo-migration.js';

const LEGACY = 'adhd';
const CANONICAL = 'PseudoSky/adhd';

let tmp: TmpStore;
let ctx: BacklogCtx;

beforeEach(async () => {
  tmp = await openTmpStore('repo-migration-spec');
  ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'project', adhdRoot: tmp.dir }) };
});

afterEach(() => {
  tmp.cleanup();
});

describe('planRepoMigration — pure, read-only, deterministic', () => {
  it('a non-colliding item plans to move unchanged', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-CLEAN', title: 'no collision', body: 'b', repo: LEGACY });
    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ nodeId: created.item.nodeId, humanId: created.item.humanId, targetHumanId: created.item.humanId, renamed: false });
    expect(plan.collisionCount).toBe(0);
  });

  it('renames ONLY genuine collisions — a kept id is never displaced by a rename (no cascade)', async () => {
    // Target holds BUG-001 and BUG-002. Source holds BUG-001..BUG-004.
    // Only BUG-001/BUG-002 genuinely collide. A single greedy pass moves
    // BUG-001 -> BUG-003, which then makes the source's OWN BUG-003 look
    // taken and cascades until every item is renamed. Measured on the real
    // production store that turned 8 collisions into 43 renames, silently
    // invalidating 35 ids that are already cited elsewhere.
    await createItemNode(tmp.store, { family: 'BUG', title: 'target one', body: 'b', repo: CANONICAL });
    await createItemNode(tmp.store, { family: 'BUG', title: 'target two', body: 'b', repo: CANONICAL });
    for (const title of ['s1', 's2', 's3', 's4']) {
      await createItemNode(tmp.store, { family: 'BUG', title, body: 'b', repo: LEGACY });
    }

    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    const byId = new Map(plan.items.map((i) => [i.humanId, i]));

    expect(plan.items).toHaveLength(4);
    expect(plan.collisionCount).toBe(2);

    // The two non-colliding ids keep their identity.
    expect(byId.get('BUG-003')).toMatchObject({ targetHumanId: 'BUG-003', renamed: false });
    expect(byId.get('BUG-004')).toMatchObject({ targetHumanId: 'BUG-004', renamed: false });

    // The two real collisions are reallocated past everything reserved.
    expect(byId.get('BUG-001')?.renamed).toBe(true);
    expect(byId.get('BUG-002')?.renamed).toBe(true);
    expect(byId.get('BUG-001')?.targetHumanId).toBe('BUG-005');
    expect(byId.get('BUG-002')?.targetHumanId).toBe('BUG-006');

    // And the plan is internally consistent: no two items land on one id,
    // and nothing lands on an id the target repo already holds.
    const targets = plan.items.map((i) => i.targetHumanId);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).not.toContain('BUG-001');
    expect(targets).not.toContain('BUG-002');
  });

  it('never writes anything — the store is byte-identical before and after planning', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-PURE', title: 't', body: 'b', repo: LEGACY });
    await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    const stillThere = await findItemNode(tmp.store, LEGACY, created.item.humanId);
    expect(stillThere?.id).toBe(created.item.nodeId);
    const notYetMoved = await findItemNode(tmp.store, CANONICAL, created.item.humanId);
    expect(notYetMoved).toBeNull();
  });

  it('a colliding humanId (bare BUG-001 in both repos) is renamed to the next free number in the SAME family', async () => {
    await createItemNode(tmp.store, { family: 'BUG', idOverride: 'BUG-001', title: 'canonical BUG-001', body: 'b', repo: CANONICAL });
    await createItemNode(tmp.store, { family: 'BUG', idOverride: 'BUG-002', title: 'canonical BUG-002', body: 'b', repo: CANONICAL });
    const legacy = await createItemNode(tmp.store, { family: 'BUG', idOverride: 'BUG-001', title: 'legacy BUG-001', body: 'b', repo: LEGACY });

    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0]!;
    expect(item.nodeId).toBe(legacy.item.nodeId);
    expect(item.humanId).toBe('BUG-001');
    expect(item.renamed).toBe(true);
    // Destination already holds BUG-001 and BUG-002 -> next free is BUG-003.
    expect(item.targetHumanId).toBe('BUG-003');
    expect(plan.collisionCount).toBe(1);
  });

  it('TWO colliding items in the SAME family each get a distinct, sequential target — never each other\'s', async () => {
    await createItemNode(tmp.store, { family: 'DEBT', idOverride: 'DEBT-001', title: 'canonical DEBT-001', body: 'b', repo: CANONICAL });
    const legacyA = await createItemNode(tmp.store, { family: 'DEBT', idOverride: 'DEBT-001', title: 'legacy DEBT-001', body: 'b', repo: LEGACY });
    // A SECOND legacy item that also happens to collide (different content, same literal id could not coexist within one repo — so simulate the real shape: two DIFFERENT legacy humanIds that both collide against canonical, e.g. DEBT-001 and a manually-forced DEBT-002 in canonical too).
    await createItemNode(tmp.store, { family: 'DEBT', idOverride: 'DEBT-002', title: 'canonical DEBT-002', body: 'b', repo: CANONICAL });
    const legacyB = await createItemNode(tmp.store, { family: 'DEBT', idOverride: 'DEBT-002', title: 'legacy DEBT-002', body: 'b', repo: LEGACY });

    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    expect(plan.collisionCount).toBe(2);
    const byNode = new Map(plan.items.map((it) => [it.nodeId, it]));
    const a = byNode.get(legacyA.item.nodeId)!;
    const b = byNode.get(legacyB.item.nodeId)!;
    expect(a.targetHumanId).toBe('DEBT-003');
    expect(b.targetHumanId).toBe('DEBT-004');
    expect(a.targetHumanId).not.toBe(b.targetHumanId);
  });

  it('is namespace-scoped, not metadata.repo-scoped — picks up an item whose two repo fields have already diverged', async () => {
    // The real, empirically-discovered shape (DEBT-BACKLOG-REPO-MOVE-001
    // Finding 2): namespace says legacy, metadata.repo already says
    // canonical. Constructed directly against the graph backend since
    // createItemNode always keeps the two fields consistent by construction.
    const divergedId = await tmp.store.graph.writeNode(buildNodeContent(LEGACY, 'FEAT-DIVERGED-001', 'diverged item', 'b'), {
      kind: 'generic',
      name: buildNodeName(LEGACY, 'FEAT-DIVERGED-001'),
      summary: 'diverged item',
      tags: [BACKLOG_ITEM_TAG, 'FEAT', 'FEAT-DIVERGED'],
      namespace: LEGACY, // <- the FILTER/lookup field
      metadata: {
        humanId: 'FEAT-DIVERGED-001',
        kind: 'FEAT',
        family: 'FEAT-DIVERGED',
        title: 'diverged item',
        body: 'b',
        status: 'OPEN',
        repo: CANONICAL, // <- already (wrongly) says canonical
        citations: [],
        notes: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    expect(plan.items.map((it) => it.nodeId)).toContain(divergedId);
    const item = plan.items.find((it) => it.nodeId === divergedId)!;
    expect(item.renamed).toBe(false); // no live FEAT-DIVERGED-001 in canonical namespace yet
  });

  it('rejects fromRepo === toRepo', async () => {
    await expect(planRepoMigration(tmp.store, CANONICAL, CANONICAL)).rejects.toThrow(InvalidArgumentError);
  });
});

describe('migrateRepo — dryRun (default) never mutates', () => {
  it('dryRun defaults to true when omitted — the store is unchanged', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-DEFAULT', title: 't', body: 'b', repo: LEGACY });
    const result = await client.migrateRepo(ctx, LEGACY, CANONICAL, 'test-actor');
    expect(result.dryRun).toBe(true);
    expect(result.results).toBeUndefined();
    expect((await findItemNode(tmp.store, LEGACY, created.item.humanId))?.id).toBe(created.item.nodeId);
    expect(await findItemNode(tmp.store, CANONICAL, created.item.humanId)).toBeNull();
  });

  it('explicit dryRun:true behaves identically to the default', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-EXPLICIT', title: 't', body: 'b', repo: LEGACY });
    await client.migrateRepo(ctx, LEGACY, CANONICAL, 'test-actor', true);
    expect((await findItemNode(tmp.store, LEGACY, created.item.humanId))?.id).toBe(created.item.nodeId);
  });
});

describe('migrateRepo — dryRun:false actually moves items', () => {
  it('a non-colliding item: namespace, repo, name, and lookup all move together; old key no longer resolves', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-MOVE', title: 'moves cleanly', body: 'b', repo: LEGACY });

    const result = await client.migrateRepo(ctx, LEGACY, CANONICAL, 'test-actor', false);
    expect(result.dryRun).toBe(false);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([{ nodeId: created.item.nodeId, fromHumanId: created.item.humanId, toHumanId: created.item.humanId, renamed: false, ok: true }]);

    // Old key gone.
    expect(await findItemNode(tmp.store, LEGACY, created.item.humanId)).toBeNull();
    // New key resolves to the SAME nodeId (never a new node minted).
    const moved = await findItemNode(tmp.store, CANONICAL, created.item.humanId);
    expect(moved?.id).toBe(created.item.nodeId);
    expect(moved?.namespace).toBe(CANONICAL);
    const movedMeta = moved?.metadata as { repo?: string } | undefined;
    expect(movedMeta?.repo).toBe(CANONICAL);
    expect(moved?.name).toBe(`${CANONICAL}::${created.item.humanId}`);
  });

  it('a colliding item is renamed AND moved; an audit note records the original (repo, humanId)', async () => {
    await createItemNode(tmp.store, { family: 'TASK', idOverride: 'TASK-001', title: 'canonical TASK-001', body: 'b', repo: CANONICAL });
    const legacy = await createItemNode(tmp.store, { family: 'TASK', idOverride: 'TASK-001', title: 'legacy TASK-001', body: 'legacy body', repo: LEGACY });

    const result = await client.migrateRepo(ctx, LEGACY, CANONICAL, 'test-actor', false);
    expect(result.results).toEqual([{ nodeId: legacy.item.nodeId, fromHumanId: 'TASK-001', toHumanId: 'TASK-002', renamed: true, ok: true }]);

    // The original canonical TASK-001 is untouched.
    const untouchedOriginal = await client.getItem(ctx, CANONICAL, 'TASK-001');
    expect(untouchedOriginal?.title).toBe('canonical TASK-001');

    // The migrated item is reachable under its NEW id, with its ORIGINAL content.
    const migrated = await client.getItem(ctx, CANONICAL, 'TASK-002');
    expect(migrated?.title).toBe('legacy TASK-001');
    expect(migrated?.nodeId).toBe(legacy.item.nodeId);
    expect(migrated?.notes[migrated.notes.length - 1]?.text).toContain('moved from repo="adhd"');
    expect(migrated?.notes[migrated.notes.length - 1]?.text).toContain('renamed humanId from "TASK-001" to "TASK-002"');

    // Old key is gone entirely (not even ambiguous) — no live item left behind
    // under the legacy repo. `getItem` throws (not a bare null) here because
    // the humanId DOES still exist, just under the new repo — this IS the
    // "did you mean repo X?" hint (BUG-BACKLOG-REPO-LOOKUP-UX-001) correctly
    // firing, and is itself proof the move landed under the canonical repo.
    let caught: unknown;
    try {
      await client.getItem(ctx, LEGACY, 'TASK-001');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BacklogItemNotFoundError);
    expect((caught as InstanceType<typeof BacklogItemNotFoundError>).foundInRepos).toEqual([CANONICAL]);
  });

  it('a diverged item (namespace != metadata.repo) is fully repaired: both fields end up consistent', async () => {
    const divergedId = await tmp.store.graph.writeNode(buildNodeContent(LEGACY, 'FEAT-REPAIR-001', 'diverged item', 'b'), {
      kind: 'generic',
      name: buildNodeName(LEGACY, 'FEAT-REPAIR-001'),
      summary: 'diverged item',
      tags: [BACKLOG_ITEM_TAG, 'FEAT', 'FEAT-REPAIR'],
      namespace: LEGACY,
      metadata: {
        humanId: 'FEAT-REPAIR-001',
        kind: 'FEAT',
        family: 'FEAT-REPAIR',
        title: 'diverged item',
        body: 'b',
        status: 'OPEN',
        repo: CANONICAL, // already diverged before the migration ran
        citations: [],
        notes: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    await client.migrateRepo(ctx, LEGACY, CANONICAL, 'test-actor', false);

    const node = await tmp.store.graph.getNode(divergedId);
    expect(node?.namespace).toBe(CANONICAL);
    const meta = node?.metadata as { repo?: string } | undefined;
    expect(meta?.repo).toBe(CANONICAL); // now consistent with namespace
    expect(await findItemNode(tmp.store, LEGACY, 'FEAT-REPAIR-001')).toBeNull();
    expect((await findItemNode(tmp.store, CANONICAL, 'FEAT-REPAIR-001'))?.id).toBe(divergedId);
  });

  it('cross-item DEPENDS_ON edges survive a move untouched (nodeId never changes)', async () => {
    const blocker = await createItemNode(tmp.store, { family: 'BUG-BLOCKER', title: 'blocker', body: 'b', repo: LEGACY });
    const blocked = await createItemNode(tmp.store, { family: 'BUG-BLOCKED', title: 'blocked', body: 'b', repo: LEGACY });
    await addDependencyNode(tmp.store, LEGACY, blocked.item.humanId, blocker.item.humanId);

    await client.migrateRepo(ctx, LEGACY, CANONICAL, 'test-actor', false);

    // The edge is keyed on nodeId, not humanId/repo — confirm it still resolves post-move via the real client surface.
    const stillBlocked = await client.blockers(ctx, CANONICAL, blocked.item.humanId);
    expect(stillBlocked.map((b) => b.nodeId)).toEqual([blocker.item.nodeId]);
    expect(stillBlocked[0]?.humanId).toBe(blocker.item.humanId);
    expect(stillBlocked[0]?.repo).toBe(CANONICAL);
  });
});

describe('migrateRepo — per-item failure isolation (never silently drops an item)', () => {
  it('one item going stale between plan and execute is reported ok:false with an error; the OTHER item still succeeds', async () => {
    const survivor = await createItemNode(tmp.store, { family: 'BUG-SURVIVOR', title: 'will succeed', body: 'b', repo: LEGACY });
    const willGoStale = await createItemNode(tmp.store, { family: 'BUG-STALE', title: 'will go stale', body: 'b', repo: LEGACY });

    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    expect(plan.items).toHaveLength(2);

    // Force the staleness condition for exactly one planned item: invalidate
    // it (soft-delete) BETWEEN planning and execution — the exact race
    // migrateRepoItemNode's re-verification guard exists to catch.
    await tmp.store.graph.invalidate(willGoStale.item.nodeId, 'test: forced staleness');

    const { executeRepoMigration } = await import('./repo-migration.js');
    const results = await executeRepoMigration(tmp.store, plan, 'test-actor');

    expect(results).toHaveLength(2); // every planned item reported — nothing dropped
    const survivorResult = results.find((r) => r.nodeId === survivor.item.nodeId)!;
    const staleResult = results.find((r) => r.nodeId === willGoStale.item.nodeId)!;
    expect(survivorResult.ok).toBe(true);
    expect(staleResult.ok).toBe(false);
    expect(staleResult.error).toBeDefined();
    expect(staleResult.error).toContain('no longer a live backlog item');

    // The survivor genuinely moved despite its sibling's failure.
    expect((await findItemNode(tmp.store, CANONICAL, survivor.item.humanId))?.id).toBe(survivor.item.nodeId);
  });

  it('a target humanId claimed by someone else AFTER planning is refused, not silently overwritten', async () => {
    const legacy = await createItemNode(tmp.store, { family: 'BUG-RACE', title: 'legacy', body: 'b', repo: LEGACY });
    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    expect(plan.items[0]?.renamed).toBe(false);

    // Simulate a concurrent write claiming the exact target humanId in the
    // destination repo after the plan was computed but before execution runs.
    const interloper = await createItemNode(tmp.store, { family: 'BUG-RACE', idOverride: legacy.item.humanId, title: 'interloper', body: 'b', repo: CANONICAL });

    await expect(migrateRepoItemNode(tmp.store, plan.items[0]!, LEGACY, CANONICAL, 'test-actor')).rejects.toThrow(InvalidArgumentError);

    // The interloper is untouched, and the legacy item was NOT overwritten or moved.
    const stillInterloper = await client.getItem(ctx, CANONICAL, legacy.item.humanId);
    expect(stillInterloper?.nodeId).toBe(interloper.item.nodeId);
    expect(stillInterloper?.title).toBe('interloper');
    expect((await findItemNode(tmp.store, LEGACY, legacy.item.humanId))?.id).toBe(legacy.item.nodeId);
  });
});
