/**
 * lifecycle.spec.ts — S02 AC14: the item lifecycle `remove`/`restore`
 * (retire/unretire) plus the explicit production-write gate.
 *
 * Cluster: `backlog-lifecycle-model` (`0b0df8f3-cf19-45e6-a00f-486dc8b74a88`),
 * absorbed into SPEC-SET S02 AC14. This file is the behavioral proof the
 * audit's `cluster-ship-audit-head.md` row 8 records as absent at HEAD:
 * `entrypoint/backlog/src/vocabulary.ts:49-79` had no `remove`/`restore` and
 * `write/delete.ts:103` was soft-only with no production-write gate.
 *
 * RED-BEFORE / GREEN-AFTER: before this change `restore`/`remove` do not exist
 * and no `productionWrite` gate is consulted, so every `it` below fails. After
 * the change every `it` passes. Proven live (exit codes in the task return),
 * never by assertion shape alone.
 *
 * CONSUMER-VISIBLE OUTCOMES ONLY. Each assertion drives the real store the way
 * a consumer does — `createIssue` → `deleteIssue`/`removeIssue` →
 * `restoreIssue` → re-read the node through `resolveLiveIssueTx` (the exact
 * resolver `get`/`query` use) — never a mock, and never an implementation
 * shape. `restore` is proved by a node that DISAPPEARS from the live resolver
 * and REAPPEARS; `remove` by one that never comes back.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { deleteIssue } from './delete.js';
import {
  IssueNotFoundError,
  IssueNotRestorableError,
  RemoveConfirmationRequiredError,
  ProductionWriteRefusedError,
} from './errors.js';
import { assertProductionWriteAllowed } from './production-gate.js';
import { removeIssue } from './remove.js';
import { restoreIssue } from './restore.js';
import {
  getNodeByUidTx,
  resolveLiveIssueTx,
  type ITxNodeRow,
  type IWriteStoreHandle,
} from './tx.js';

/** Cluster id this spec proves. */
const CLUSTER_UID = '0b0df8f3-cf19-45e6-a00f-486dc8b74a88';

async function readNode(
  store: TestIssueStore,
  uid: string
): Promise<ITxNodeRow | null> {
  return store.adapter.transaction(async (tx) => getNodeByUidTx(tx, uid));
}

/** The exact live-resolution every read verb (`get`/`query`) funnels through. */
async function resolvesLive(
  store: TestIssueStore,
  uid: string
): Promise<boolean> {
  try {
    await store.adapter.transaction(async (tx) => resolveLiveIssueTx(tx, uid));
    return true;
  } catch {
    return false;
  }
}

/** A write handle that declares the store to be the LIVE production store. */
function productionHandle(
  store: TestIssueStore,
  allow: boolean
): IWriteStoreHandle {
  return {
    adapter: store.adapter,
    typePolicy: store.typePolicy,
    productionWrite: { isProductionStore: true, allowProductionWrite: allow },
  };
}

describe(`S02 AC14 — lifecycle remove/restore + production gate (cluster ${CLUSTER_UID})`, () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;
  let issueUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('lifecycle-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    const seeded = await seedProject(store, 'lifecycle-spec-project');
    projectUid = seeded.projectUid;
    const created = await createIssue(store, {
      project: projectUid,
      title: 'lifecycle target',
      body: 'body must survive every retire/unretire round-trip verbatim',
      by: 'filer',
    });
    if (!created.uid) throw new Error('setup: createIssue returned no uid');
    issueUid = created.uid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('restore reverses a soft `delete`: the item disappears from the live resolver and comes back', async () => {
    expect(await resolvesLive(store, issueUid)).toBe(true);

    await deleteIssue(store, {
      uid: issueUid,
      reason: 'accidental sweep',
      by: 'closer',
    });
    expect(await resolvesLive(store, issueUid)).toBe(false);

    const restored = await restoreIssue(store, {
      uid: issueUid,
      by: 'rescuer',
    });
    expect(restored).toEqual({ uid: issueUid, restored: true });

    // Consumer-visible: the SAME resolver `get`/`query` use finds it again.
    expect(await resolvesLive(store, issueUid)).toBe(true);

    // And the content is intact — a restore un-invalidates, never re-creates.
    const row = await readNode(store, issueUid);
    expect(row?.tInvalid).toBeNull();
    expect(row?.content).toContain('verbatim');
    // The soft-delete provenance is stripped so the row is genuinely live.
    expect(row?.metadata?.['invalidatedReason']).toBeUndefined();
    expect(row?.metadata?.['invalidatedAt']).toBeUndefined();
  });

  it('restore of a NEVER-deleted (live) issue is refused with IssueNotRestorableError — nothing is written', async () => {
    await expect(
      restoreIssue(store, { uid: issueUid, by: 'rescuer' })
    ).rejects.toThrow(IssueNotRestorableError);
    expect(await resolvesLive(store, issueUid)).toBe(true);
  });

  it('restore of a permanently removed issue is refused — remove does not come back', async () => {
    await removeIssue(store, {
      uid: issueUid,
      confirm: true,
      reason: 'mis-filed junk',
      by: 'cleaner',
    });
    await expect(
      restoreIssue(store, { uid: issueUid, by: 'rescuer' })
    ).rejects.toThrow(IssueNotRestorableError);
    // Permanent retire is never a hard delete: the row and its content survive.
    const row = await readNode(store, issueUid);
    expect(row).not.toBeNull();
    expect(row?.tInvalid).not.toBeNull();
    expect(row?.content).toContain('verbatim');
  });

  it('remove without confirm:true is refused with RemoveConfirmationRequiredError and mutates nothing', async () => {
    await expect(
      removeIssue(store, {
        uid: issueUid,
        confirm: false,
        by: 'cleaner',
      })
    ).rejects.toThrow(RemoveConfirmationRequiredError);

    expect(await resolvesLive(store, issueUid)).toBe(true);
  });

  it('remove with confirm:true permanently retires: the item leaves the live surface', async () => {
    const outcome = await removeIssue(store, {
      uid: issueUid,
      confirm: true,
      reason: 'duplicate',
      by: 'cleaner',
    });
    expect(outcome).toEqual({ uid: issueUid, removed: true });
    expect(await resolvesLive(store, issueUid)).toBe(false);
  });

  it('restore resolves a unique uid PREFIX, not only the full uid', async () => {
    await deleteIssue(store, {
      uid: issueUid,
      reason: 'accidental sweep',
      by: 'closer',
    });
    const short = issueUid.slice(0, 12);
    const restored = await restoreIssue(store, { uid: short, by: 'rescuer' });
    expect(restored.uid).toBe(issueUid);
    expect(await resolvesLive(store, issueUid)).toBe(true);
  });

  it('restore of a uid that never existed is IssueNotFoundError', async () => {
    await expect(
      restoreIssue(store, { uid: 'deadbeef', by: 'rescuer' })
    ).rejects.toThrow(IssueNotFoundError);
  });

  it('PRODUCTION GATE: a write into the live production store is refused without the explicit gate', async () => {
    // Consumer-visible: a real write verb is refused BEFORE any mutation.
    await expect(
      deleteIssue(productionHandle(store, false), {
        uid: issueUid,
        reason: 'x',
        by: 'closer',
      })
    ).rejects.toThrow(ProductionWriteRefusedError);
    expect(await resolvesLive(store, issueUid)).toBe(true);
  });

  it('PRODUCTION GATE: the explicit gate (allowProductionWrite:true) opens the write; a non-production store needs no gate', async () => {
    await expect(
      deleteIssue(productionHandle(store, true), {
        uid: issueUid,
        reason: 'gated but allowed',
        by: 'closer',
      })
    ).resolves.toEqual({ uid: issueUid, invalidated: true });

    // A non-production store (the direct-handle default) is never gated.
    expect(() => assertProductionWriteAllowed(store, 'delete')).not.toThrow();
  });

  it('restore of a SUPERSEDED (body-edited) uid is refused with reason "superseded" — un-deleting is not a supersede inverse', async () => {
    // Mark the row superseded directly — the exact end-state `update`'s
    // supersede CAS produces (`is_superseded = 1` with `t_invalid` UNTOUCHED).
    // Same fixture technique `create-duplicate-gate.spec.ts` uses.
    await store.adapter.transaction(async (tx) => {
      await tx.executeRun('UPDATE node SET is_superseded = 1 WHERE uid = ?', [
        issueUid,
      ]);
    });

    let caught: unknown;
    try {
      await restoreIssue(store, { uid: issueUid, by: 'rescuer' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IssueNotRestorableError);
    expect((caught as IssueNotRestorableError).reason).toBe('superseded');

    // Nothing was re-livened: still superseded, `t_invalid` still NULL.
    const row = await readNode(store, issueUid);
    expect(row?.isSuperseded).toBe(true);
    expect(row?.tInvalid).toBeNull();
  });
});
