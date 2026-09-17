/**
 * delete-listing.spec.ts — closes SPEC.md §9 AC-18's un-proven half:
 * "...the issue disappears from a default `query` listing but
 * `getNodeByUid(uid)` still resolves it (bi-temporal, never a hard
 * delete)."
 *
 * `delete.spec.ts` already proves the soft-delete mechanics against raw
 * `getNodeByUidTx` reads (t_invalid stamped, content untouched, one audit
 * row, non-resurrection). What no existing spec composes is the real
 * `deleteIssue` write with a real `queryIssues(store, {view:'list'})`
 * default-listing read — the exact pairing AC-18 names. Both halves are
 * load-bearing: disappearing from the listing alone is also what a hard
 * delete looks like, so this file asserts BOTH the disappearance from the
 * listing AND the continued addressability by uid via
 * `store.graph.getNodeByUid`, against the SAME deleted issue, in the SAME
 * test.
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
import { queryIssues } from '../query/query.js';

describe('deleteIssue + queryIssues default listing (SPEC.md §9 AC-18, real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('delete-listing-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'delete-listing-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('AC-18: a deleted issue drops out of a default list query, while getNodeByUid still resolves the (invalidated) row', async () => {
    const created = await createIssue(store, {
      project: projectUid, title: 'listed then deleted', body: 'body', by: 'filer',
    });
    const uid = created.uid;

    const before = await queryIssues(store, { view: 'list' });
    if (before.view !== 'list') throw new Error(`expected view 'list', got '${before.view}'`);
    expect(before.items.map((i) => i.uid)).toContain(uid);

    const beforeNode = await store.graph.getNodeByUid(uid);
    expect(beforeNode).not.toBeNull();
    expect(beforeNode?.tInvalid ?? null).toBeNull();

    const outcome = await deleteIssue(store, { uid, reason: 'no longer relevant', by: 'closer' });
    expect(outcome.invalidated).toBe(true);

    // Half one: the deleted uid is ABSENT from the default listing.
    const after = await queryIssues(store, { view: 'list' });
    if (after.view !== 'list') throw new Error(`expected view 'list', got '${after.view}'`);
    expect(after.items.map((i) => i.uid)).not.toContain(uid);

    // Half two: the row is STILL addressable by uid, with tInvalid set —
    // proving this is a soft invalidate, never a hard row deletion. Disappearing
    // from the listing alone (half one) is also what a hard delete looks like,
    // so this half is what tells the two apart.
    const afterNode = await store.graph.getNodeByUid(uid);
    expect(afterNode).not.toBeNull();
    expect(afterNode?.tInvalid).toBeDefined();
    expect(afterNode?.tInvalid).not.toBeNull();
    expect(afterNode?.content).toBe(beforeNode?.content);
  });
});
