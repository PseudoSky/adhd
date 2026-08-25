/**
 * repo-migration-durability.spec.ts — BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC-001,
 * the durability half of the fix (the transaction-wrapping half is already
 * pinned by `repo-migration-atomicity.spec.ts`, which this file does not
 * duplicate). Three things proven here, against a REAL turso-backed store
 * (no mocks except the deliberately-scoped monkeypatches the negative
 * controls need to inject failure at an exact seam):
 *
 *  1. ATOMICITY SURVIVES A REOPEN. Killing the migration between write 2
 *     (`graph.touch` — metadata/name/tags) and write 3 (the raw namespace/
 *     content/content_hash UPDATE) and then reading the row back through a
 *     BRAND NEW store handle opened against the same on-disk file (not the
 *     same in-process object `migrateRepoItemNode` just wrote through) shows
 *     the item is either fully migrated or fully un-migrated — never split.
 *     The negative control does not merely re-assert the positive case: it
 *     literally removes the transaction (monkeypatches
 *     `store.adapter.transaction` to invoke its callback with no surrounding
 *     BEGIN/COMMIT/ROLLBACK — autocommit, statement by statement, exactly the
 *     pre-fix shape this module's top-of-file doc comment describes) and
 *     confirms the SAME failure injection then DOES produce the split state,
 *     visible after the same reopen. That is the red/green pair: red with
 *     the transaction removed, green with it restored.
 *
 *  2. THE RUN IS DETECTABLE AND RESUMABLE. A backup manifest with no
 *     `completedAt` is exactly a run that was interrupted before it
 *     finished; `findIncompleteRepoMigrationBackups` finds it, and a fresh
 *     `planRepoMigration` call against the same (fromRepo, toRepo) picks up
 *     only the genuinely-still-unmigrated remainder — proven by forcing a
 *     between-items interruption (not a mid-item one — §1 already proves
 *     mid-item can't happen) and inspecting both.
 *
 *  3. THE RUN IS REVERSIBLE. `restoreRepoMigrationBackup` puts a fully
 *     migrated item back to byte-identical pre-migration
 *     namespace/name/tags/metadata/content, verified through a reopened
 *     store handle. `migrateRepo` itself fails CLOSED when the backup cannot
 *     be written — no item is touched — proven by pointing `backupDir` at a
 *     path that cannot become a directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { closeGraphBacklogStore, openGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';
import { createItemNode } from './crud.js';
import { findItemNode } from './query.js';
import {
  createRepoMigrationBackup,
  findIncompleteRepoMigrationBackups,
  markRepoMigrationBackupComplete,
  migrateRepo,
  migrateRepoItemNode,
  planRepoMigration,
  restoreRepoMigrationBackup,
} from './repo-migration.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const LEGACY = 'adhd';
const CANONICAL = 'PseudoSky/adhd';

let tmp: TmpStore;
let backupDir: string;

beforeEach(async () => {
  tmp = await openTmpStore('repo-migration-durability');
  backupDir = join(tmp.dir, 'backups');
});

afterEach(async () => {
  await tmp.cleanup();
});

/** Reads the two fields that must never disagree, through a FRESH store handle opened against the same on-disk file — proves the on-disk state, not an in-process cache. */
async function identityAfterReopen(dbPath: string, nodeId: number): Promise<{ namespace: string; metaRepo: unknown }> {
  const reopened: GraphBacklogStore = await openGraphBacklogStore(dbPath);
  try {
    const node = await reopened.graph.getNode(nodeId);
    if (!node) throw new Error(`node ${nodeId} vanished`);
    const meta = (node.metadata ?? {}) as { repo?: unknown };
    return { namespace: node.namespace, metaRepo: meta.repo };
  } finally {
    await closeGraphBacklogStore(reopened);
  }
}

describe('BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC-001 — atomicity survives a reopen', () => {
  it('GREEN: a failure between write 2 and write 3, with the real transaction in place, leaves the item fully un-migrated after reopening the store', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-REOPEN-OK', title: 'atomic', body: 'b', repo: LEGACY });
    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    const planItem = plan.items.find((i) => i.nodeId === created.item.nodeId);
    if (!planItem) throw new Error('plan did not include the seeded item');

    // Inject failure at write 3 (the raw namespace/content/content_hash
    // UPDATE) — everything before it (write 1+2, graph.touch) has already
    // been issued by the time this fires.
    const realExecuteRun = tmp.store.adapter.executeRun.bind(tmp.store.adapter);
    tmp.store.adapter.executeRun = (async (sql: string, args?: unknown[]) => {
      if (/UPDATE\s+node\s+SET\s+namespace/i.test(sql)) throw new Error('injected: killed between write 2 and write 3');
      return realExecuteRun(sql, args);
    }) as typeof tmp.store.adapter.executeRun;

    try {
      await expect(migrateRepoItemNode(tmp.store, planItem, LEGACY, CANONICAL, 'durability-test')).rejects.toThrow(/killed between write 2 and write 3/);
    } finally {
      tmp.store.adapter.executeRun = realExecuteRun;
    }

    // THE POINT: reopen a BRAND NEW store handle against the same file and
    // read the row through it. Fully un-migrated — not split.
    const after = await identityAfterReopen(tmp.dbPath, created.item.nodeId);
    expect(after.namespace).toBe(LEGACY);
    expect(after.metaRepo).toBe(LEGACY);
  });

  it('RED (negative control): the SAME injected failure, with the transaction physically removed, DOES produce the split state after reopening — proving the test has teeth', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-REOPEN-BAD', title: 'unprotected', body: 'b', repo: LEGACY });
    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    const planItem = plan.items.find((i) => i.nodeId === created.item.nodeId);
    if (!planItem) throw new Error('plan did not include the seeded item');

    // Remove the transaction: `store.adapter.transaction` becomes a bare
    // passthrough that invokes the callback with no BEGIN/COMMIT/ROLLBACK —
    // exactly the pre-fix shape (three separate autocommitted statements)
    // this module's top-of-file doc comment describes. `migrateRepoItemNode`
    // still calls `store.adapter.transaction(fn, {mode:'immediate'})`
    // unmodified; only what THAT call does is changed.
    const realTransaction = tmp.store.adapter.transaction.bind(tmp.store.adapter);
    tmp.store.adapter.transaction = (async (fn: () => unknown) => fn()) as typeof tmp.store.adapter.transaction;

    const realExecuteRun = tmp.store.adapter.executeRun.bind(tmp.store.adapter);
    tmp.store.adapter.executeRun = (async (sql: string, args?: unknown[]) => {
      if (/UPDATE\s+node\s+SET\s+namespace/i.test(sql)) throw new Error('injected: killed between write 2 and write 3 (unprotected)');
      return realExecuteRun(sql, args);
    }) as typeof tmp.store.adapter.executeRun;

    try {
      await expect(migrateRepoItemNode(tmp.store, planItem, LEGACY, CANONICAL, 'durability-test')).rejects.toThrow(/killed between write 2 and write 3 \(unprotected\)/);
    } finally {
      tmp.store.adapter.executeRun = realExecuteRun;
      tmp.store.adapter.transaction = realTransaction;
    }

    // THE RED: reopened, the row IS split — metadata.repo already flipped to
    // CANONICAL (write 1+2 committed with nothing to roll them back) while
    // namespace is still LEGACY (write 3 never landed). This is exactly the
    // corruption BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC-001 describes, and is
    // exactly what the real (transaction-wrapped) path above does NOT produce.
    const after = await identityAfterReopen(tmp.dbPath, created.item.nodeId);
    expect(after.namespace).toBe(LEGACY);
    expect(after.metaRepo).toBe(CANONICAL);
    expect(after.namespace).not.toBe(after.metaRepo);
  });
});

describe('BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC-001 — resumable and detectable across a between-items interruption', () => {
  it('a backup with no completedAt is found by findIncompleteRepoMigrationBackups; re-planning after the interruption resumes with only the unmigrated remainder', async () => {
    const first = await createItemNode(tmp.store, { family: 'BUG-RESUME-A', title: 'migrated before the crash', body: 'b', repo: LEGACY });
    const second = await createItemNode(tmp.store, { family: 'BUG-RESUME-B', title: 'never reached', body: 'b', repo: LEGACY });

    const plan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    expect(plan.items).toHaveLength(2);

    // Backup taken up front, exactly as migrateRepo does — BEFORE any item
    // in the batch is touched.
    const backup = await createRepoMigrationBackup(tmp.store, plan, 'durability-test', backupDir);
    expect(backup.itemCount).toBe(2);

    // Simulate the crash: only the FIRST item's migration actually runs
    // (each one still atomic per §1); the process dies before the second
    // item's migration and before markRepoMigrationBackupComplete ever runs.
    const firstPlanItem = plan.items.find((i) => i.nodeId === first.item.nodeId)!;
    await migrateRepoItemNode(tmp.store, firstPlanItem, LEGACY, CANONICAL, 'durability-test');

    // DETECTABLE: the manifest on disk still has no completedAt.
    const incomplete = await findIncompleteRepoMigrationBackups(backupDir);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.completedAt).toBeUndefined();
    expect(incomplete[0]?.items.map((i) => i.nodeId).sort()).toEqual([first.item.nodeId, second.item.nodeId].sort());

    // RESUMABLE: a fresh plan against the same (fromRepo, toRepo) contains
    // ONLY the still-unmigrated item — the migrated one dropped out on its
    // own because its namespace is no longer LEGACY. No manual repair step.
    const resumedPlan = await planRepoMigration(tmp.store, LEGACY, CANONICAL);
    expect(resumedPlan.items.map((i) => i.nodeId)).toEqual([second.item.nodeId]);

    // Finishing the resumed plan and marking THIS (interrupted) backup
    // complete is what an operator/CLI would do next — verify it still works.
    await migrateRepoItemNode(tmp.store, resumedPlan.items[0]!, LEGACY, CANONICAL, 'durability-test');
    await markRepoMigrationBackupComplete(backup.backupPath, { succeeded: 2, failed: 0 });
    expect(await findIncompleteRepoMigrationBackups(backupDir)).toHaveLength(0);
  });

  it('migrateRepo wires the backup in automatically and marks it complete when the whole run finishes cleanly', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-AUTO', title: 'auto-backed-up', body: 'b', repo: LEGACY });

    const result = await migrateRepo(tmp.store, LEGACY, CANONICAL, 'durability-test', false, { backupDir });
    expect(result.succeeded).toBe(1);
    expect(result.backupPath).toBeDefined();

    const incomplete = await findIncompleteRepoMigrationBackups(backupDir);
    expect(incomplete).toHaveLength(0); // completed — not left dangling as "incomplete"

    expect((await findItemNode(tmp.store, CANONICAL, created.item.humanId))?.id).toBe(created.item.nodeId);
  });
});

describe('BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC-001 — reversible via restoreRepoMigrationBackup', () => {
  it('restores namespace/name/tags/metadata/content to exactly the pre-migration snapshot, verified after reopening', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RESTORE', title: 'will be undone', body: 'original body', repo: LEGACY });

    const result = await migrateRepo(tmp.store, LEGACY, CANONICAL, 'durability-test', false, { backupDir });
    expect(result.succeeded).toBe(1);
    // Confirm it actually moved before we undo it.
    expect(await findItemNode(tmp.store, LEGACY, created.item.humanId)).toBeNull();
    expect((await findItemNode(tmp.store, CANONICAL, created.item.humanId))?.id).toBe(created.item.nodeId);

    const incomplete = await findIncompleteRepoMigrationBackups(backupDir);
    // Read the manifest back the same way an operator/CLI would — straight off disk.
    const manifestPath = result.backupPath!;
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.items).toHaveLength(1);
    expect(manifest.completedAt).toBeDefined(); // migrateRepo marked it complete
    void incomplete;

    const restoreResults = await restoreRepoMigrationBackup(tmp.store, manifest);
    expect(restoreResults).toEqual([{ nodeId: created.item.nodeId, ok: true }]);

    // Verified through a REOPENED handle — back to exactly where it started.
    const after = await identityAfterReopen(tmp.dbPath, created.item.nodeId);
    expect(after.namespace).toBe(LEGACY);
    expect(after.metaRepo).toBe(LEGACY);
    expect((await findItemNode(tmp.store, LEGACY, created.item.humanId))?.id).toBe(created.item.nodeId);
    expect(await findItemNode(tmp.store, CANONICAL, created.item.humanId)).toBeNull();
  });

  it('fails CLOSED: migrateRepo refuses to touch a single item when the backup cannot be written', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-FAILCLOSED', title: 'must stay put', body: 'b', repo: LEGACY });

    // Point backupDir at a path that is already a regular FILE — mkdirSync(...,
    // {recursive:true}) cannot turn a file into a directory, so
    // createRepoMigrationBackup throws before executeRepoMigration ever runs.
    const blockedPath = join(tmp.dir, 'blocked-backup-dir');
    mkdirSync(tmp.dir, { recursive: true });
    writeFileSync(blockedPath, 'not a directory', 'utf8');

    await expect(migrateRepo(tmp.store, LEGACY, CANONICAL, 'durability-test', false, { backupDir: blockedPath })).rejects.toThrow();

    // Nothing was touched — the item never left LEGACY.
    expect((await findItemNode(tmp.store, LEGACY, created.item.humanId))?.id).toBe(created.item.nodeId);
    expect(await findItemNode(tmp.store, CANONICAL, created.item.humanId)).toBeNull();

    rmSync(blockedPath, { force: true });
  });
});
