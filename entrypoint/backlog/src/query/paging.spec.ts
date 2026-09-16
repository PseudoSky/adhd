/**
 * paging.spec.ts — `queryIssues`'s keyset pagination contract (SPEC.md
 * AC-8, AC-20; `src/query/query.ts:64-76`/`:296-313`).
 *
 * Nothing in the surviving suite ever calls `queryIssues`/`query()` with
 * `after` set at all (`rg -n "after:" src/query/*.spec.ts` is empty before
 * this file). Three claims have zero coverage:
 *
 *  - AC-8: paging `view:'list'` via `after`/`limit`, feeding each response's
 *    `nextCursor` into the next call's `after`, visits every created issue
 *    exactly once — no duplicate uid, no gap — and the unpaged default
 *    order is insertion order.
 *  - AC-20: `after` + `sort` throws `InvalidArgumentError('sort', ...)`
 *    naming the incompatibility; the identical call WITHOUT `sort` succeeds
 *    and pages in insertion order.
 *
 * Real components throughout: a real store via `openTestIssueStore`/
 * `seedProject`, real `createIssue` writes, `queryIssues` driven exactly as
 * `api.ts`'s mounted `query` verb drives it.
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
import { InvalidArgumentError } from '../write/errors.js';
import { queryIssues } from './query.js';

describe('queryIssues — keyset pagination (AC-8, AC-20; real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-paging');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'paging-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mkIssue(title: string): Promise<string> {
    const created = await createIssue(store, { project: projectUid, title, body: `${title} body`, by: 'filer' });
    return created.uid;
  }

  it('AC-8: pages through N issues by after/limit with no duplicate and no gap', async () => {
    const N = 17;
    const k = 5; // deliberately not a divisor of N, to exercise a short final page
    const created: string[] = [];
    for (let i = 0; i < N; i++) {
      created.push(await mkIssue(`paging issue ${String(i).padStart(2, '0')}`));
    }

    const collected: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const result = await queryIssues(store, { view: 'list', limit: k, after });
      if (result.view !== 'list') throw new Error(`expected view 'list', got '${result.view}'`);
      pages++;
      // Every page that reports more to come must be EXACTLY full. This is
      // the assertion with real teeth against an off-by-one truncation:
      // `pages === ceil(N/k)` below looks like it covers that, but it does
      // not on its own. With N=17/k=5 a `slice(0, limit - 1)` yields pages
      // of 4, 4, 4, and then a final short-circuited page of 5 (the last
      // fetch finds fewer rows than the limit, so it is returned unsliced)
      // — 4 pages, exactly what ceil(17/5) demands. The page-count check
      // passes on a genuinely broken implementation; this one does not.
      if (result.hasMore) expect(result.items).toHaveLength(k);
      else expect(result.items.length).toBeLessThanOrEqual(k);
      for (const item of result.items) collected.push(item.uid);
      if (!result.hasMore) {
        expect(result.nextCursor).toBeUndefined();
        break;
      }
      expect(result.nextCursor).toBeDefined();
      after = result.nextCursor;
      // Bounded loop — a broken cursor (e.g. one that never advances) must
      // not hang this test; it must fail loudly instead.
      if (pages > N) throw new Error(`paging did not terminate after ${pages} pages — cursor is not advancing`);
    }

    // No gap: every created uid was returned.
    expect(new Set(collected)).toEqual(new Set(created));
    // No duplicate: the collected list has exactly N entries, matching the
    // set size — a duplicate would inflate collected.length past N while
    // leaving the Set the same size.
    expect(collected).toHaveLength(N);
    // Page count is exactly what ceil(N/k) demands — proves pages were
    // actually k-sized (not, say, one page returning everything because
    // `after` was silently ignored).
    expect(pages).toBe(Math.ceil(N / k));

    // Default ordering claim: with no `sort` given, paging visits issues in
    // INSERTION order — the same order they were created in.
    expect(collected).toEqual(created);
  });

  it('AC-8: a single page (limit >= N) has no continuation and matches insertion order', async () => {
    const created = [await mkIssue('solo a'), await mkIssue('solo b'), await mkIssue('solo c')];

    const result = await queryIssues(store, { view: 'list', limit: 10 });
    if (result.view !== 'list') throw new Error(`expected view 'list', got '${result.view}'`);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeUndefined();
    expect(result.items.map((i) => i.uid)).toEqual(created);
  });

  it('AC-20: after + sort throws InvalidArgumentError naming "sort"', async () => {
    await mkIssue('any issue');

    const attempt = queryIssues(store, { view: 'list', after: '0', sort: 'created' });
    await expect(attempt).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(attempt).rejects.toMatchObject({ field: 'sort' });
    await expect(attempt).rejects.toThrow(/sort/i);
  });

  it('AC-20: the identical call WITHOUT sort succeeds and pages in insertion order', async () => {
    const created = [await mkIssue('unsorted a'), await mkIssue('unsorted b'), await mkIssue('unsorted c')];

    // First page, no `after`, no `sort` — establishes the cursor.
    const first = await queryIssues(store, { view: 'list', limit: 2 });
    if (first.view !== 'list') throw new Error(`expected view 'list', got '${first.view}'`);
    expect(first.hasMore).toBe(true);
    expect(first.items.map((i) => i.uid)).toEqual(created.slice(0, 2));

    // Second page via the SAME shape of call the AC-20 throw-case used
    // (after set, sort omitted) — must succeed, not throw.
    const second = await queryIssues(store, { view: 'list', limit: 2, after: first.nextCursor });
    if (second.view !== 'list') throw new Error(`expected view 'list', got '${second.view}'`);
    expect(second.hasMore).toBe(false);
    expect(second.items.map((i) => i.uid)).toEqual(created.slice(2));
  });
});
