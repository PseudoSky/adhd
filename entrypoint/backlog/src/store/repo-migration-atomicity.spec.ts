/**
 * BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC — a repo move must be all-or-nothing.
 *
 * `migrateRepoItemNode` writes a backlog item's repo identity to TWO places
 * that can diverge:
 *   - `node.namespace`  — what every repo-scoped FILTER and lookup keys on
 *   - `metadata.repo`   — what every RENDERED `BacklogItem.repo` reads
 *
 * plus the node's name/tags and its `content`/`content_hash` uniqueness marker.
 *
 * Before the fix these went out as THREE separate awaited mutations with no
 * transaction around them (`mutateMetadata`, then `graph.touch`, then a raw
 * `UPDATE node SET namespace = ...`). An interruption between any two left the
 * node in precisely the split state this module exists to REPAIR — its own
 * top-of-file comment cites real production examples of that divergence as the
 * reason it was written. Interrupted mid-item, the repair tool manufactured a
 * fresh instance of the corruption it repairs.
 *
 * That is not a hypothetical failure mode on this system. The production store
 * took a native turso panic twice in three days, and a native panic is
 * uncatchable from JS — "the process dies between step 1 and step 3" is a
 * demonstrated event class here.
 *
 * The fix wraps all three writes in ONE `adapter.transaction(..., { mode:
 * 'immediate' })`. `mutateMetadata` could not be reused because it opens its own
 * transaction and SQLite/turso cannot nest BEGIN, so its body is inlined.
 *
 * RED→GREEN staging (BL-225): the arms below inject a failure at the LAST write
 * (the namespace UPDATE) and assert nothing survives. Against the pre-fix
 * three-separate-writes version the metadata write has already committed by
 * then, so `metadata.repo` reads as the NEW repo while `namespace` still reads
 * as the old one — the exact divergence — and these fail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';
import { findItemNode } from './query.js';
import { migrateRepoItemNode, planRepoMigration } from './repo-migration.js';

const LEGACY = 'adhd';
const CANONICAL = 'PseudoSky/adhd';

let tmp: TmpStore;

beforeEach(async () => {
  tmp = await openTmpStore('repo-migration-atomicity');
});

afterEach(() => {
  tmp.cleanup();
});

/** Read the two fields that must never disagree, straight off the row. */
async function identityOf(nodeId: number): Promise<{ namespace: string; metaRepo: unknown }> {
  const node = await tmp.store.graph.getNode(nodeId);
  if (!node) throw new Error(`node ${nodeId} vanished`);
  const meta = (node.metadata ?? {}) as { repo?: unknown };
  return { namespace: node.namespace, metaRepo: meta.repo };
}

describe('BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC', () => {
  it('rolls back the metadata write when the namespace UPDATE fails', async () => {
    const created = await createItemNode(tmp.store, {
      family: 'BUG-ATOMIC',
      title: 'atomicity',
      body: 'b',
      repo: LEGACY,
    });
    const nodeId = created.item.nodeId;
    const before = await identityOf(nodeId);
    expect(before.namespace).toBe(LEGACY);
    expect(before.metaRepo).toBe(LEGACY);

    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    const planItem = plan.items.find((i) => i.nodeId === nodeId);
    if (!planItem) throw new Error('plan did not include the seeded item');

    // Fail the LAST of the three writes — the raw namespace UPDATE. Everything
    // before it has already been issued at this point, so this is exactly the
    // window that used to leave the row split.
    const realExecuteRun = tmp.store.adapter.executeRun.bind(tmp.store.adapter);
    let injected = 0;
    tmp.store.adapter.executeRun = (async (sql: string, args?: unknown[]) => {
      if (/UPDATE\s+node\s+SET\s+namespace/i.test(sql)) {
        injected++;
        throw new Error('injected failure at the namespace write');
      }
      return realExecuteRun(sql, args);
    }) as typeof tmp.store.adapter.executeRun;

    try {
      await expect(
        migrateRepoItemNode(tmp.store, planItem, LEGACY, CANONICAL, 'atomicity-test'),
      ).rejects.toThrow(/injected failure at the namespace write/);
    } finally {
      tmp.store.adapter.executeRun = realExecuteRun;
    }
    expect(injected).toBe(1); // the injection actually fired — not a vacuous pass

    // THE POINT: the item is byte-for-byte where it started. Pre-fix,
    // `metaRepo` here was CANONICAL while `namespace` was still LEGACY.
    const after = await identityOf(nodeId);
    expect(after.namespace).toBe(LEGACY);
    expect(after.metaRepo).toBe(LEGACY);
  });

  it('leaves the item findable under its ORIGINAL repo after a failed move', async () => {
    const created = await createItemNode(tmp.store, {
      family: 'BUG-FINDABLE',
      title: 'still here',
      body: 'b',
      repo: LEGACY,
    });
    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    const planItem = plan.items.find((i) => i.nodeId === created.item.nodeId);
    if (!planItem) throw new Error('plan did not include the seeded item');

    const realExecuteRun = tmp.store.adapter.executeRun.bind(tmp.store.adapter);
    tmp.store.adapter.executeRun = (async (sql: string, args?: unknown[]) => {
      if (/UPDATE\s+node\s+SET\s+namespace/i.test(sql)) throw new Error('injected');
      return realExecuteRun(sql, args);
    }) as typeof tmp.store.adapter.executeRun;
    try {
      await expect(
        migrateRepoItemNode(tmp.store, planItem, LEGACY, CANONICAL, 'atomicity-test'),
      ).rejects.toThrow(/injected/);
    } finally {
      tmp.store.adapter.executeRun = realExecuteRun;
    }

    // A half-applied move used to strand the item: renamed in metadata, still
    // namespaced to the old repo, so neither repo's lookup found it cleanly.
    const underOld = await findItemNode(tmp.store, LEGACY, created.item.humanId);
    expect(underOld?.id).toBe(created.item.nodeId);
    const underNew = await findItemNode(tmp.store, CANONICAL, created.item.humanId);
    expect(underNew).toBeNull();
  });

  it('a SUCCESSFUL move still commits both fields together (control)', async () => {
    const created = await createItemNode(tmp.store, {
      family: 'BUG-SUCCESS',
      title: 'moves cleanly',
      body: 'b',
      repo: LEGACY,
    });
    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    const planItem = plan.items.find((i) => i.nodeId === created.item.nodeId);
    if (!planItem) throw new Error('plan did not include the seeded item');

    await migrateRepoItemNode(tmp.store, planItem, LEGACY, CANONICAL, 'atomicity-test');

    const after = await identityOf(created.item.nodeId);
    expect(after.namespace).toBe(CANONICAL);
    expect(after.metaRepo).toBe(CANONICAL);

    // And it is findable under the new repo, not the old one.
    expect((await findItemNode(tmp.store, CANONICAL, planItem.targetHumanId))?.id).toBe(
      created.item.nodeId,
    );
    expect(await findItemNode(tmp.store, LEGACY, created.item.humanId)).toBeNull();
  });
});
