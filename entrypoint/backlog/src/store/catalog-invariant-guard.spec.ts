/**
 * catalog-invariant-guard.spec.ts — proof for
 * `store/catalog-invariant-guard.ts`, the fail-loud guard over the
 * status/priority catalog's two read-critical invariants.
 *
 * THE TWO INVARIANTS.
 *  1. TERMINALITY. A live `status` whose name is a reserved terminal name
 *     (`RESERVED_TERMINAL_STATUS_NAMES`) must carry `metadata.terminal ===
 *     true` — the flag is the read-time source of truth, and the read layer is
 *     deliberately name-blind (ADR-0002 D1).
 *  2. UNIQUENESS. No two live rows of the SAME catalog kind may share a
 *     case-folded name (`HIGH`/`high` are one priority split across two rows).
 *
 * THE POSTURE. A violation throws `CatalogInvariantError` naming EVERY
 * offending row (uid + name; fold + both spellings for a duplicate) AND the
 * repair that resolves it — never a bare abort, never a read-time shim.
 *
 * TEETH. Each assertion drives the REAL guard against a REAL store opened via
 * `openTestIssueStore` (or the real `openGraphBacklogStore` for the open-path
 * case), then reads the seeded rows back to prove the fixture is genuinely
 * two live rows / an unflagged row. The negative control (last `it`) makes the
 * dependency explicit: bypassing the throw leaves the violation reported, so
 * every `.rejects` assertion here is falsifiable — temporarily removing the
 * `throw` in `assertCatalogInvariants` turns the terminality and duplicate
 * cases RED (verified; see the task report).
 *
 * The `.spec.ts` suffix is load-bearing: `vite.config.ts` includes ONLY
 * `src/**\/*.spec.ts`, so an `.e2e.ts` file would be invisible to
 * `nx affected -t test` (AGENTS.md §7).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openTestIssueStore, removeTestIssueStoreDir, seedProject, type TestIssueStore } from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { openGraphBacklogStore } from './graph-backlog-store.js';
import {
  assertCatalogInvariants,
  inspectCatalogInvariants,
  renderCatalogInvariantViolations,
  CatalogInvariantError,
} from './catalog-invariant-guard.js';
import { executeWriteTransaction, writeNodeTx } from '../write/tx.js';
import { CaseVariantNameError } from '../write/errors.js';
import { createIssue } from '../write/create-issue.js';
import { transition } from '../write/transition.js';
import { queryIssuesWithMeta, type IQueryStoreHandle } from '../query/query.js';

/** `createIssue`'s `uid` is optional (a duplicate reports `commentedOn` instead) — assert it and narrow to `string`. */
function createdUid(result: { created: boolean; uid?: string }): string {
  if (result.uid === undefined) {
    throw new Error('test setup: createIssue returned no uid (treated as a duplicate?)');
  }
  return result.uid;
}

/** Mint a bare catalog row with caller-chosen metadata — the same `writeNodeTx` primitive every verb uses. */
async function mintCatalog(
  store: TestIssueStore,
  kind: 'status' | 'priority',
  name: string,
  metadata: Record<string, unknown>
): Promise<{ rowid: number; uid: string }> {
  return executeWriteTransaction(store, (tx) =>
    writeNodeTx(tx, { kind, name, metadata })
  );
}

/**
 * Seed the exact drift the guard exists to catch: a live `status` whose name is
 * a reserved terminal name, with NO `terminal` flag at all.
 */
async function seedFlaglessReserved(
  store: TestIssueStore,
  name = 'closed'
): Promise<string> {
  const row = await mintCatalog(store, 'status', name, {});
  return row.uid;
}

describe('assertCatalogInvariants — the two catalog invariants', () => {
  let dir: string;
  let store: TestIssueStore;

  beforeEach(async () => {
    dir = freshTmpDir('catalog-invariant-guard');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('passes on an EMPTY store (a fresh store violates nothing)', async () => {
    await expect(assertCatalogInvariants(store.adapter)).resolves.toBeUndefined();
    expect(await inspectCatalogInvariants(store.adapter)).toEqual([]);
  });

  it('passes on a healthy catalog produced by ORDINARY writes after the mint fix (createIssue + transition)', async () => {
    const { projectUid } = await seedProject(store, 'guard-healthy');
    // createIssue mints `open` (not a reserved terminal name) and `HIGH`.
    const issue = await createIssue(store, {
      project: projectUid,
      title: 'healthy item',
      body: 'b',
      priority: 'HIGH',
      by: 'agent:t',
    });
    // transition mints `closed` — a reserved terminal name, seeded terminal:true
    // by the source fix (`mintOrResolveStatusTx`), NOT hardcoded false.
    await transition(store, {
      uid: createdUid(issue),
      toStatus: 'closed',
      by: 'agent:t',
      note: 'closing',
    });

    await expect(assertCatalogInvariants(store.adapter)).resolves.toBeUndefined();
    expect(await inspectCatalogInvariants(store.adapter)).toEqual([]);
  });

  it('THROWS on an unflagged reserved terminal status, naming `closed` + its uid + the repair', async () => {
    const uid = await seedFlaglessReserved(store, 'closed');

    const err = await assertCatalogInvariants(store.adapter).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CatalogInvariantError);
    const violations = (err as CatalogInvariantError).violations;
    expect(violations).toEqual([
      { kind: 'unflagged-terminal', name: 'closed', uid },
    ]);

    const message = (err as Error).message;
    expect(message).toContain('unflagged-terminal (1)');
    expect(message).toContain('status "closed"');
    expect(message).toContain(`uid ${uid}`);
    // The remediation names the module AND functions that resolve it — a
    // reader can act without opening source.
    expect(message).toContain('planTerminalBackfill');
    expect(message).toContain('applyTerminalBackfill');
    expect(message).toContain('write/catalog-repair.ts');
  });

  it('THROWS on a same-kind case-fragment duplicate (HIGH/high), naming the fold and BOTH uids', async () => {
    const upper = await mintCatalog(store, 'priority', 'HIGH', { rank: 1 });
    const lower = await mintCatalog(store, 'priority', 'high', { rank: 2 });

    const err = await assertCatalogInvariants(store.adapter).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CatalogInvariantError);
    const violations = (err as CatalogInvariantError).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'case-fragment-duplicate',
      fold: 'high',
      names: ['HIGH', 'high'],
      uids: [upper.uid, lower.uid],
    });

    const message = (err as Error).message;
    expect(message).toContain('case-fragment-duplicate (1)');
    expect(message).toContain('fold "high"');
    expect(message).toContain(`"HIGH" (uid ${upper.uid})`);
    expect(message).toContain(`"high" (uid ${lower.uid})`);
    // The remediation names the case-fragment repair.
    expect(message).toContain('planCaseFragmentMerge');
    expect(message).toContain('applyCaseFragmentMerge');
    expect(message).toContain('write/catalog-merge.ts');
  });

  it('does NOT throw when two DIFFERENT kinds share a fold (per-kind grouping, not across kinds)', async () => {
    // A status `open` and a priority `open` are two catalogs reached by two
    // different edges — an ordinary write can legitimately create the pair. A
    // fold-blind cross-kind grouping would fire here; the guard must not.
    const { projectUid } = await seedProject(store, 'guard-cross-kind');
    await createIssue(store, {
      project: projectUid,
      title: 'mints status open',
      body: 'b',
      by: 'agent:t',
    });
    await mintCatalog(store, 'priority', 'open', { rank: 0 });

    await expect(assertCatalogInvariants(store.adapter)).resolves.toBeUndefined();
    expect(await inspectCatalogInvariants(store.adapter)).toEqual([]);
  });

  it('NEGATIVE CONTROL: bypassing the throw leaves the violation reported — every `.rejects` here is falsifiable', async () => {
    const uid = await seedFlaglessReserved(store, 'closed');

    // The guard throws (the green assertion the suite rests on).
    await expect(assertCatalogInvariants(store.adapter)).rejects.toBeInstanceOf(
      CatalogInvariantError
    );

    // Bypass the throw by reading the inspector directly. The violation is
    // STILL reported, so if the `throw` in `assertCatalogInvariants` were
    // removed, the `.rejects` above would FAIL (it would resolve) — the teeth
    // are real, not vacuous.
    const reported = await inspectCatalogInvariants(store.adapter);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      kind: 'unflagged-terminal',
      uid,
      name: 'closed',
    });
    expect(renderCatalogInvariantViolations(reported)).toContain(
      'planTerminalBackfill'
    );
  });

  it('WIRING (query path): queryIssuesWithMeta rejects through the guard instead of serving a mis-classified read', async () => {
    await seedFlaglessReserved(store, 'closed');
    // The exact handle shape `api.ts`'s `queryHandle` builds for every host.
    const handle: IQueryStoreHandle = {
      graph: store.graph,
      assertCatalogInvariants: () => assertCatalogInvariants(store.adapter),
    };
    await expect(queryIssuesWithMeta(handle, {})).rejects.toBeInstanceOf(
      CatalogInvariantError
    );
  });

  it('FINDING FIXED: an ordinary createIssue with a non-canonical case status spelling is REFUSED at write time (no write-time twin)', async () => {
    // The write-time gap this test used to characterize is closed. The mint
    // resolves by EXACT `(kind, name)` (`write/catalog.ts` `mintOrResolveCatalogTx`),
    // and now, on that exact miss, it runs a fold-collision check over the live
    // rows of the SAME kind inside the SAME immediate transaction: a
    // caller-typed `status:'Open'` that folds to the live `open` is REFUSED
    // with `CaseVariantNameError` (naming both spellings) rather than minting a
    // second live row. The guard's check 2 can no longer be tripped by an
    // ordinary write.
    const { projectUid } = await seedProject(store, 'guard-finding');
    await createIssue(store, {
      project: projectUid,
      title: 'canonical spelling',
      body: 'mints status open',
      by: 'agent:t',
    });

    const err = await createIssue(store, {
      project: projectUid,
      title: 'non-canonical spelling',
      body: 'must be refused, not minted as a second status row',
      status: 'Open',
      by: 'agent:t',
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CaseVariantNameError);
    const variantErr = err as CaseVariantNameError;
    expect(variantErr.catalogKind).toBe('status');
    expect(variantErr.canonicalName).toBe('open');
    expect(variantErr.offendingName).toBe('Open');
    expect((err as Error).message).toContain('"Open"');
    expect((err as Error).message).toContain('"open"');

    // Exactly one live row per folded token: the canonical `open` only, no
    // `Open` twin. The catalog invariant holds, so the guard serves this store
    // instead of aborting every read (the outage).
    const live = await store.adapter.executeAll<{ name: string }>(
      "SELECT name FROM node WHERE kind = 'status' AND t_invalid IS NULL ORDER BY rowid ASC"
    );
    expect(live.rows.map((r) => r.name)).toEqual(['open']);
    expect(await inspectCatalogInvariants(store.adapter)).toEqual([]);
    await expect(assertCatalogInvariants(store.adapter)).resolves.toBeUndefined();
  });

  it('WIRING (store open): openGraphBacklogStore refuses to open a catalog-violating store and closes the adapter it opened', async () => {
    const openDir = freshTmpDir('catalog-invariant-open');
    const dbPath = join(openDir, 'backlog.db');
    const raw = await openTestIssueStore(dbPath);
    await seedFlaglessReserved(raw, 'closed');
    await raw.close();

    try {
      await expect(openGraphBacklogStore(dbPath)).rejects.toBeInstanceOf(
        CatalogInvariantError
      );
    } finally {
      removeTestIssueStoreDir(openDir);
    }
  });
});
