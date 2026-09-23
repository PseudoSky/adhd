/**
 * unknown-filter-value.spec.ts — `query`'s `filter.kind`/`filter.status`/
 * `filter.priority` catalog-membership validation
 * (BUG-BACKLOG-QUERY-UNKNOWN-FILTER-SILENT-001).
 *
 * `kind`/`status`/`priority` are open string vocabularies (DATA_MODEL.md
 * §0.2/§2) — there is no fixed enum to validate a filter value against. But
 * a value that matches NO live catalog row at all is a typo, not a
 * legitimate "no issues currently have this value" read; before this fix,
 * BOTH cases returned the byte-identical `{total:0, items:[]}`, with zero
 * signal which one happened.
 *
 * Real components throughout: a real store via `openTestIssueStore`/
 * `seedProject`, real `createIssue`/catalog-minting writes, `queryIssues`
 * driven exactly as `api.ts`'s mounted `query` verb drives it.
 *
 * Negative-control-proven: reverting `resolveEdgeScopedFilterIds`'s use of
 * `resolveValidatedCatalogFilter` back to the old `resolveMultiValuedEdgeScoped`
 * (silently-contributes-nothing) turns every "unknown value" assertion below
 * red — verified by hand during this fix.
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
import { createIssue } from '../write/create-issue.js';
import { BacklogValidationError } from '../write/errors.js';
import { queryIssues } from './query.js';

describe('query — unknown kind/status/priority filter values (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-unknown-filter');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'unknown-filter-project')).projectUid;
    // Mints the 'issue' kind and 'open' status catalog rows, and (via an
    // explicit priority) a 'p1' priority row — so this store has a REAL,
    // non-empty catalog to validate against and to suggest from.
    await createIssue(store, {
      project: projectUid,
      title: 'seed issue',
      body: 'seed body',
      by: 'filer',
      priority: 'p1',
    });
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('an unknown filter.kind value throws BacklogValidationError naming it, never a silent {total:0}', async () => {
    await expect(
      queryIssues(store, { filter: { kind: 'typo-not-a-real-kind' } })
    ).rejects.toThrow(BacklogValidationError);
    await expect(
      queryIssues(store, { filter: { kind: 'typo-not-a-real-kind' } })
    ).rejects.toThrow(/unknown kind value.*typo-not-a-real-kind/);
  });

  it('an unknown filter.status value throws, but the real open/closed selector is untouched', async () => {
    await expect(
      queryIssues(store, { filter: { status: 'typo-not-a-real-status' } })
    ).rejects.toThrow(/unknown status value.*typo-not-a-real-status/);
    // 'open'/'closed'/'all' are a different (closed) selector, never routed
    // through catalog validation at all.
    const openResult = await queryIssues(store, { filter: { status: 'open' } });
    if (openResult.view !== 'list') throw new Error('expected list view');
    expect(openResult.items.length).toBe(1);
  });

  it('an unknown filter.priority value throws, naming it', async () => {
    await expect(
      queryIssues(store, { filter: { priority: 'typo-not-a-real-priority' } })
    ).rejects.toThrow(/unknown priority value.*typo-not-a-real-priority/);
  });

  it('a REAL, sparse (currently zero-issue) kind/status/priority value still returns cleanly empty — never rejected', async () => {
    // Mint a second, genuinely real but currently-unused priority row by
    // filing a second issue under it, then filter for a DIFFERENT real value
    // that legitimately has zero issues: 'issue' kind exists but nothing has
    // kind 'epic' yet — minting 'epic' via `update`'s catalog-mint rule so it
    // is a REAL catalog row with zero owning issues.
    const { update } = await import('../write/update.js');
    const created = await createIssue(store, {
      project: projectUid,
      title: 'second issue',
      body: 'body',
      by: 'filer',
      kind: 'epic',
    });
    // Mint a THIRD real kind ('task') that ends up owning zero issues: rewrite
    // this issue's kind to 'task' (minting the row), then rewrite it straight
    // back to 'epic' — the 'task' catalog row persists even though no issue
    // currently carries it.
    await update(store, { uid: created.uid, by: 'filer', kind: 'task' });
    await update(store, { uid: created.uid, by: 'filer', kind: 'epic' });

    const result = await queryIssues(store, { filter: { kind: 'task' } });
    if (result.view !== 'list') throw new Error('expected list view');
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('the error message suggests the nearest existing catalog name for a close typo', async () => {
    await expect(
      queryIssues(store, { filter: { kind: 'isue' } })
    ).rejects.toThrow(/did you mean "issue"/);
  });
});
