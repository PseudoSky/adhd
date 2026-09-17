/**
 * superseded-listing.spec.ts — a body edit must not duplicate the issue in a
 * listing, and must not inflate the reported total.
 *
 * ## The defect
 *
 * `update`'s body path supersedes the old node (`is_superseded = 1`) and
 * deliberately leaves `t_invalid` NULL (SPEC §4c). The read layer filtered on
 * `t_invalid`/`liveOnly` only, so the superseded row stayed LIVE by the only
 * predicate applied: one content edit turned one logical issue into TWO rows
 * carrying the same title, permanently, and every further edit added another.
 *
 * ## Why the predicate is pushed into SQL rather than applied here
 *
 * Both halves are asserted below, because both are the reason an
 * application-layer filter is not an equivalent workaround:
 *
 *  - `meta.total` comes from `countNodes`, computed in SQL. A caller dropping
 *    rows after the read cannot correct it — the total stays inflated.
 *  - Keyset paging fetches `limit + 1` and slices. Dropping rows after that
 *    fetch yields SHORT pages, breaking the page-size invariant.
 *
 * ## What has teeth
 *
 * Every assertion fails if `isSuperseded: false` is dropped from `query.ts`'s
 * `baseFilter`: the list returns 2 items where 1 is expected and `meta.total`
 * reports 2. Real store, real `createIssue`/`update`, real `queryIssues`.
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
import { update } from '../write/update.js';
import { queryIssuesWithMeta } from './query.js';

describe('a body edit does not duplicate the issue in a listing', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('superseded-listing');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'superseded-listing-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function seed(title: string, body: string): Promise<string> {
    return (await createIssue(store, { project: projectUid, title, body, by: 'filer' })).uid;
  }

  it('one issue edited once is ONE row, and meta.total agrees', async () => {
    const uid = await seed('the only issue', 'the original body');
    const { uid: liveUid } = await update(store, { uid, body: 'the edited body', by: 'editor' });

    const { result, meta } = await queryIssuesWithMeta(store, { fields: ['uid', 'title'] });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.uid).toBe(liveUid);
    // The half no application-layer filter can reach.
    expect(meta.total).toBe(1);
  });

  it('repeated edits do not accumulate rows', async () => {
    let uid = await seed('edited repeatedly', 'the original body');
    for (const body of ['the first revision', 'the second revision', 'the third revision']) {
      uid = (await update(store, { uid, body, by: 'editor' })).uid;
    }

    const { result, meta } = await queryIssuesWithMeta(store, { fields: ['uid', 'title'] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.uid).toBe(uid);
    expect(meta.total).toBe(1);
  });

  it('paging over edited issues yields full pages and every issue exactly once', async () => {
    // Six issues; every other one carries a superseded ancestor. Post-filtering
    // a `limit + 1` fetch would return short pages here.
    const current: string[] = [];
    for (let i = 0; i < 6; i++) {
      const uid = await seed(`issue ${i}`, `body ${i}`);
      current.push(i % 2 === 0 ? (await update(store, { uid, body: `edited body ${i}`, by: 'editor' })).uid : uid);
    }

    const PAGE = 2;
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const { result: page } = await queryIssuesWithMeta(store, {
        fields: ['uid'],
        limit: PAGE,
        ...(after !== undefined ? { after } : {}),
      });
      pages++;
      if (page.hasMore) expect(page.items).toHaveLength(PAGE);
      for (const item of page.items) seen.push(item.uid as string);
      if (!page.hasMore) break;
      after = page.nextCursor;
      expect(after).toBeTruthy();
      if (pages > 6) throw new Error(`paging did not terminate after ${pages} pages`);
    }

    expect(seen).toHaveLength(current.length);
    expect(new Set(seen).size).toBe(current.length);
    expect([...seen].sort()).toEqual([...current].sort());
  });

  it('a never-edited corpus is unaffected', async () => {
    await seed('first', 'body one');
    await seed('second', 'body two');

    const { result, meta } = await queryIssuesWithMeta(store, { fields: ['uid'] });
    expect(result.items).toHaveLength(2);
    expect(meta.total).toBe(2);
  });
});
