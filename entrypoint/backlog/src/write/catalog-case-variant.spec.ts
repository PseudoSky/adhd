/**
 * catalog-case-variant.spec.ts — the write-path proof for the decided fix:
 * a flat-catalog write whose NAME differs from an EXISTING LIVE row of the
 * same kind only by letter case is REFUSED, not fold-resolved and not minted
 * as a twin.
 *
 * THE DEFECT (the outage). Catalog identity is EXACT-case
 * (`DATA_MODEL.md:70-78`; `write/catalog.ts` `mintOrResolveCatalogTx` resolves
 * `WHERE name = ?`). A caller-typed `IN_PROGRESS` when canonical `in_progress`
 * was live was therefore an EXACT miss, so the mint created a SECOND live row.
 * That pair folds to one token, which is exactly the case-fragment the
 * uniqueness guard (`store/catalog-invariant-guard.ts`, check 2) refuses to
 * serve — the guard then aborted EVERY read and write of the store.
 *
 * THE FIX. On the exact miss, still inside the SAME `immediate`-mode
 * transaction, `mintOrResolveCatalogTx` runs a fold-collision SELECT over the
 * live rows of the same kind (folding in JS via `catalogNameFold`, never SQL
 * `lower()`/`NOCASE`) and throws `CaseVariantNameError` — naming both spellings
 * and the one to use — when a live row folds to the requested name but is
 * spelled differently. The ambiguity is stopped at this one write call site
 * instead of aborting every read.
 *
 * TEETH. The positive test drives the REAL `createIssue` verb against a REAL
 * store and reads the rows back with direct SQL. The NEGATIVE CONTROL bypasses
 * the collision check with the same low-level `writeNodeTx` primitive the mint
 * uses — reproducing the twin, and the guard firing on it — which is precisely
 * what an ordinary write would do if the collision check were removed; so the
 * `.rejects` assertion above is falsifiable, not vacuous.
 *
 * A `.spec.ts` (not `.e2e.ts`): `vite.config.ts` includes only
 * `src/**\/*.spec.ts`, so this runs in the default `nx affected -t test` lane.
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
import { transition } from './transition.js';
import { CaseVariantNameError } from './errors.js';
import { executeWriteTransaction, writeNodeTx } from './tx.js';
import { inspectCatalogInvariants } from '../store/catalog-invariant-guard.js';
import { queryIssues } from '../query/query.js';

/** `createIssue`'s `uid` is optional (a duplicate reports `commentedOn`) — assert it and narrow. */
function createdUid(result: { created: boolean; uid?: string }): string {
  if (result.uid === undefined) {
    throw new Error('test setup: createIssue returned no uid (treated as a duplicate?)');
  }
  return result.uid;
}

/** Every LIVE row name of a catalog kind, in rowid order — read with direct SQL, never from a returned object. */
async function liveNames(
  store: TestIssueStore,
  kind: 'status' | 'priority'
): Promise<string[]> {
  const { rows } = await store.adapter.executeAll<{ name: string | null }>(
    'SELECT name FROM node WHERE kind = ? AND t_invalid IS NULL ORDER BY rowid ASC',
    [kind]
  );
  return rows.map((row) => row.name ?? '');
}

/** The `view:'list'` uids for a status selector; throws on any other view so a wrong shape fails loudly. */
async function listedUids(
  store: TestIssueStore,
  filter: { status: 'open' | 'closed' }
): Promise<string[]> {
  const result = await queryIssues(store, { filter, limit: 100 });
  if (result.view !== 'list') {
    throw new Error(`expected view:'list', got ${result.view}`);
  }
  return result.items.map((item) => item.uid);
}

describe('mintOrResolveCatalogTx — a case-variant of a live catalog row is refused', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('catalog-case-variant');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'case-variant-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('REFUSES `IN_PROGRESS` against a live `in_progress`, naming both spellings — and mints no twin', async () => {
    await createIssue(store, {
      project: projectUid,
      title: 'canonical spelling',
      body: 'mints the canonical lowercase in_progress',
      status: 'in_progress',
      by: 'agent:t',
    });

    const err = await createIssue(store, {
      project: projectUid,
      title: 'variant spelling',
      body: 'must be refused, never minted as a second live status',
      status: 'IN_PROGRESS',
      by: 'agent:t',
    }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(CaseVariantNameError);
    const variantErr = err as CaseVariantNameError;
    expect(variantErr.catalogKind).toBe('status');
    expect(variantErr.canonicalName).toBe('in_progress');
    expect(variantErr.offendingName).toBe('IN_PROGRESS');
    expect(variantErr.code).toBe('E_VALIDATION');
    expect(variantErr.retryable).toBe(false);
    // The message names BOTH spellings, so a caller can fix the payload without
    // opening source.
    expect(variantErr.message).toContain('"IN_PROGRESS"');
    expect(variantErr.message).toContain('"in_progress"');

    // Exactly one live row per folded token — no `IN_PROGRESS` twin.
    expect(await liveNames(store, 'status')).toEqual(['in_progress']);
    expect(await inspectCatalogInvariants(store.adapter)).toEqual([]);
  });

  it('REFUSES a priority that case-folds to a live row (`high` against `HIGH`)', async () => {
    await createIssue(store, {
      project: projectUid,
      title: 'canonical priority',
      body: 'mints the canonical uppercase HIGH',
      priority: 'HIGH',
      by: 'agent:t',
    });

    const err = await createIssue(store, {
      project: projectUid,
      title: 'variant priority',
      body: 'must be refused',
      priority: 'high',
      by: 'agent:t',
    }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(CaseVariantNameError);
    expect((err as CaseVariantNameError).catalogKind).toBe('priority');
    expect((err as CaseVariantNameError).canonicalName).toBe('HIGH');
    expect((err as CaseVariantNameError).offendingName).toBe('high');
    expect(await liveNames(store, 'priority')).toEqual(['HIGH']);
  });

  it('NEGATIVE CONTROL (teeth): bypassing the collision check reproduces the twin — and the catalog guard refuses to serve it', async () => {
    await createIssue(store, {
      project: projectUid,
      title: 'canonical',
      body: 'mints in_progress',
      status: 'in_progress',
      by: 'agent:t',
    });

    // Bypass `mintOrResolveCatalogTx` entirely and write the variant with the
    // SAME low-level primitive it uses — exactly what the code path would do if
    // the fold-collision check were removed. The twin appears ...
    await executeWriteTransaction(store, (tx) =>
      writeNodeTx(tx, { kind: 'status', name: 'IN_PROGRESS', metadata: {} })
    );
    expect((await liveNames(store, 'status')).sort()).toEqual([
      'IN_PROGRESS',
      'in_progress',
    ]);

    // ... and the uniqueness guard then reports the case-fragment duplicate
    // (the outage). Because the ordinary write path now refuses the variant,
    // no ordinary write can reach this state; the `.rejects` assertion above
    // would go green-as-success (mint a twin) the moment the check was removed.
    const violations = await inspectCatalogInvariants(store.adapter);
    expect(
      violations.some((v) => v.kind === 'case-fragment-duplicate')
    ).toBe(true);
  });

  it('lowercase `fixed`/`resolved`/`done` seed terminal:true — asserted via the flag, not the name', async () => {
    for (const name of ['fixed', 'resolved', 'done'] as const) {
      const created = await createIssue(store, {
        project: projectUid,
        title: `closed via ${name}`,
        body: 'a first-ever lowercase reserved spelling must close the item',
        status: name,
        by: 'agent:t',
      });
      const uid = createdUid(created);

      const { rows } = await store.adapter.executeAll<{ meta: string | null }>(
        "SELECT meta FROM node WHERE kind = 'status' AND name = ? AND t_invalid IS NULL",
        [name]
      );
      expect(rows).toHaveLength(1);
      expect(
        (JSON.parse(rows[0]!.meta ?? '{}') as { terminal?: boolean }).terminal
      ).toBe(true);

      // Consumer-visible: absent from `open`, present under `closed`.
      expect(await listedUids(store, { status: 'open' })).not.toContain(uid);
      expect(await listedUids(store, { status: 'closed' })).toContain(uid);
    }
  });

  it('REFUSES a case-variant `transition` toStatus against a live canonical (the path the write waves used)', async () => {
    // The exact shape the corpus waves hit: `resolved` is live, and a caller
    // transitions to the UPPERCASE `RESOLVED`. `transition` resolves the target
    // through the SAME `mintOrResolveStatusTx`, so the refusal must hold here
    // too — an ordinary `create`-only test would leave this path unproven.
    const created = createdUid(
      await createIssue(store, {
        project: projectUid,
        title: 'canonical resolved',
        body: 'mints the lowercase reserved terminal status',
        status: 'resolved',
        by: 'agent:t',
      })
    );

    const err = await transition(store, {
      uid: created,
      by: 'agent:t',
      toStatus: 'RESOLVED',
      note: 'close',
    }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(CaseVariantNameError);
    const variantErr = err as CaseVariantNameError;
    expect(variantErr.catalogKind).toBe('status');
    expect(variantErr.canonicalName).toBe('resolved');
    expect(variantErr.offendingName).toBe('RESOLVED');

    // No `RESOLVED` twin: exactly one live status row, still the lowercase
    // canonical, and the store's reserved-terminal flag is intact (a fresh
    // uppercase twin minted `terminal:false` is exactly the unflagged-terminal
    // row `store-check` refuses).
    expect(await liveNames(store, 'status')).toEqual(['resolved']);
    expect(await inspectCatalogInvariants(store.adapter)).toEqual([]);

    // NEGATIVE CONTROL (teeth): bypass the refusal with the same low-level
    // primitive and reproduce precisely the drift it prevents — the twin AND
    // its unflagged terminal flag — so the assertions above are falsifiable
    // rather than vacuous.
    await executeWriteTransaction(store, (tx) =>
      writeNodeTx(tx, {
        kind: 'status',
        name: 'RESOLVED',
        metadata: { terminal: false },
      })
    );
    const violations = await inspectCatalogInvariants(store.adapter);
    expect(
      violations.some(
        (v) =>
          v.kind === 'case-fragment-duplicate' &&
          v.names.includes('RESOLVED') &&
          v.names.includes('resolved')
      )
    ).toBe(true);
    expect(
      violations.some(
        (v) => v.kind === 'unflagged-terminal' && v.name === 'RESOLVED'
      )
    ).toBe(true);
  });

  it('preserves existing resolution: the exact spelling still resolves and a genuinely new name still mints', async () => {
    const first = createdUid(
      await createIssue(store, {
        project: projectUid,
        title: 'first',
        body: 'mints triage',
        status: 'triage',
        by: 'agent:t',
      })
    );
    // Same exact spelling on a second write resolves the SAME live row — no
    // throw, no twin.
    const second = createdUid(
      await createIssue(store, {
        project: projectUid,
        title: 'second',
        body: 'resolves the existing triage row',
        status: 'triage',
        by: 'agent:t',
      })
    );

    expect(await liveNames(store, 'status')).toEqual(['triage']);
    // `triage` is not a reserved terminal name → both items stay open.
    expect(await listedUids(store, { status: 'open' })).toEqual(
      expect.arrayContaining([first, second])
    );
  });
});
