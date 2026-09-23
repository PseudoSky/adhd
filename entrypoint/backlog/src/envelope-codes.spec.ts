/**
 * envelope-codes.spec.ts — distinct failures must produce DISTINCT envelope
 * error codes, through the real mounted verbs against a real store.
 *
 * The defect this exists to prevent: the envelope's code was derived from the
 * write layer's coarse `E_*` retry bucket, and NINE error classes share
 * `E_VALIDATION`. So asking for a uid that does not exist, and passing a
 * malformed argument, both returned `validation` — and because the CLI keys
 * its process exit code off that code, both exited 2, telling a caller "you
 * typed something wrong" when the truth was "that issue isn't here."
 *
 * A test that asserted only `ok === false` stays green through all of that.
 * These assert the codes are DIFFERENT from each other, which is the property
 * that actually failed.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from './test/helpers/open-test-issue-store.js';
import { freshTmpDir } from './test/helpers/tmp-store.js';
import {
  BACKLOG_ERROR_CODES,
  BACKLOG_EXIT_CODE,
  exitCodeForEnvelope,
  isOutcomeError,
} from './envelope.js';
import { createIssue } from './write/create-issue.js';
import { queryIssues } from './query/query.js';
import {
  IssueNotFoundError,
  InvalidArgumentError,
  CatalogNotFoundError,
} from './write/errors.js';

describe('envelope error codes — distinct failures stay distinguishable', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('envelope-codes');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'envelope-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('the exit-code table covers EVERY code in the union, and no others', () => {
    // A code with no exit-code row would throw `undefined` into a process
    // exit at runtime; a stale row for a deleted code is dead weight that
    // makes the union look larger than it is. Both directions are asserted.
    expect(Object.keys(BACKLOG_EXIT_CODE).sort()).toEqual(
      [...BACKLOG_ERROR_CODES].sort()
    );
  });

  it('item_not_found and internal are DISTINCT codes despite sharing exit code 1', () => {
    // This is the pairing most likely to be "simplified" away by someone
    // reading only the exit-code table: they look identical there.
    expect(BACKLOG_EXIT_CODE['item_not_found']).toBe(
      BACKLOG_EXIT_CODE['internal']
    );
    expect('item_not_found').not.toBe('internal');
    expect(BACKLOG_ERROR_CODES).toContain('item_not_found');
    expect(BACKLOG_ERROR_CODES).toContain('internal');
  });

  it('a missing issue and a malformed argument produce DIFFERENT codes and DIFFERENT exit codes', async () => {
    // Both of these throw classes carrying `E_VALIDATION`. Before the
    // class-based mapping, both produced `validation` / exit 2 — this is the
    // negative control: it goes red the moment the mapping regresses to the
    // coarse bucket.
    const missing = new IssueNotFoundError('no-such-uid');
    const malformed = new InvalidArgumentError(
      'limit',
      'must be a positive integer'
    );
    const absentCatalog = new CatalogNotFoundError(
      'project',
      'no-such-project'
    );
    expect(missing.code).toBe('E_VALIDATION');
    expect(malformed.code).toBe('E_VALIDATION');
    expect(absentCatalog.code).toBe('E_VALIDATION');

    const { get, query, create } = await import('./api.js');
    // ZERO-CONFIG ctx: no `embedding` block at all. This is the default shape,
    // and it is deliberately used here rather than a fully-populated config --
    // dereferencing an absent embedding config threw a TypeError that surfaced
    // as `internal` on EVERY verb, which is precisely the failure this file
    // exists to make visible.
    const ctx = { store, env: { config: {} } } as never;

    const missingEnv = await get(ctx, { uid: 'definitely-not-a-real-uid' });
    const malformedEnv = await query(ctx, { view: 'list', limit: -5 } as never);

    expect(isOutcomeError(missingEnv)).toBe(true);
    expect(isOutcomeError(malformedEnv)).toBe(true);
    if (!isOutcomeError(missingEnv) || !isOutcomeError(malformedEnv)) return;

    // The load-bearing assertion. Equality here is the bug.
    expect(missingEnv.error.code).not.toBe(malformedEnv.error.code);
    expect(missingEnv.error.code).toBe('item_not_found');
    expect(exitCodeForEnvelope(missingEnv)).toBe(1);
    expect(exitCodeForEnvelope(malformedEnv)).toBe(2);

    // And a real issue still succeeds, so the above is not "everything fails".
    const ok = await create(ctx, {
      project: projectUid,
      title: 'a real issue',
      body: 'body',
      by: 'filer',
    });
    expect(ok.ok).toBe(true);
  });

  it('a ZERO-CONFIG store (no embedding block) serves every verb instead of failing internal', async () => {
    // Negative control for the absent-config crash: with no `embedding` key,
    // a create and a query must both SUCCEED. Before the optional-chaining
    // guard both returned `{code:'internal'}` -- a valid store reporting a
    // server crash purely because the operator had not configured embeddings.
    const { create, query, get } = await import('./api.js');
    const ctx = { store, env: { config: {} } } as never;

    const created = await create(ctx, {
      project: projectUid,
      title: 'zero config',
      body: 'b',
      by: 'filer',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const listed = await query(ctx, { view: 'list', limit: 10 });
    expect(listed.ok).toBe(true);

    const fetched = await get(ctx, {
      uid: (created.data as { uid: string }).uid,
    });
    expect(fetched.ok).toBe(true);
  });

  it('a live issue round-trips, proving the store wiring under these failures is real', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'round trip',
      body: 'b',
      by: 'filer',
    });
    const listed = await queryIssues(store, { view: 'list', limit: 10 });
    if (listed.view !== 'list')
      throw new Error(`expected list view, got ${listed.view}`);
    expect(listed.items.map((i) => i.uid)).toContain(created.uid);
  });
});
