/**
 * identity-by-name.spec.ts — SPEC.md AC-1: identity in this application
 * layer is `uid` alone; no field or code path resolves an issue by a
 * human-readable name of any kind.
 *
 * The claim was previously unproven: `get.spec.ts`'s existing
 * "unresolvable uid" tests pass a synthetic string
 * (`'issue-does-not-exist-anywhere'`) that never was a real issue's title —
 * so they prove "an arbitrary string is not a uid", not "a REAL issue's
 * title is never itself accepted as an identity token". This file closes
 * that gap by creating a real issue with a distinctive title, then feeding
 * that exact title string into `getIssue`'s `uid` field. If any code path
 * anywhere resolved issues by title (a name-based fallback, a lenient
 * lookup, a fuzzy match), this would silently succeed and return the very
 * card this test creates. It must instead throw.
 *
 * Real components throughout: a real store via
 * `openTestIssueStore`/`seedProject`, a real `createIssue` write, `getIssue`
 * called exactly as `api.ts`'s mounted `get` verb calls it.
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
import { IssueNotFoundError } from '../write/errors.js';
import { getIssue } from './get.js';

describe('identity is `uid` alone (SPEC.md AC-1; real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('identity-by-name');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'identity-by-name-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it("a real issue's own title, passed as `uid`, is never silently accepted as an identity token", async () => {
    const distinctiveTitle = 'zzz-totally-distinctive-issue-title-for-ac-1-identity-proof-9f3c1a';
    const created = await createIssue(store, {
      project: projectUid,
      title: distinctiveTitle,
      body: 'body text is irrelevant to this proof',
      by: 'filer',
    });

    // Sanity: the real uid DOES resolve — proves the store/harness works and
    // that the negative assertion below isn't vacuously true because the
    // issue was never actually created.
    const byUid = await getIssue(store.graph, { uid: created.uid });
    expect(byUid.title).toBe(distinctiveTitle);

    // The claim under test: feeding the issue's own TITLE into the `uid`
    // field must throw, never resolve the same card by name.
    const attempt = getIssue(store.graph, { uid: distinctiveTitle });
    await expect(attempt).rejects.toBeInstanceOf(IssueNotFoundError);
  });
});
