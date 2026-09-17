/**
 * stale-limit.spec.ts — `view:'stale'` honors `input.limit` (SPEC.md §6.3.5 /
 * `query/query.ts`'s `queryStale`).
 *
 * `queryStale` applied no limit at all — a caller asking for `limit: 2` got
 * EVERY stale claim in the store. This mirrors `paging.spec.ts`'s `view:'list'`
 * proof and `AGENTS.md §7`'s "assertions must have teeth" bar: a passing test
 * against the pre-fix code is impossible here (the negative-control run below
 * demonstrates the fix's own regression signature).
 *
 * Real components throughout: a real store via `openTestIssueStore`/
 * `seedProject`, real `createIssue`/`claim` writes; the only non-verb write is
 * a direct SQL patch of `claimedAt` into the past — a real store mutation, not
 * a mock of `queryStale` or of anything under test — following the SAME
 * precedent `claim.spec.ts`'s "genuinely stale" test already uses to avoid
 * waiting real wall-clock minutes.
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
import { claim } from '../write/claim.js';
import { queryIssues } from './query.js';

describe('queryIssues — view:"stale" honors limit (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-stale-limit');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'stale-limit-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  /** Claims `uid` then force-ages the claim well past the default 30-minute threshold via a direct, real SQL write — the same technique `write/claim.spec.ts`'s own "genuinely stale" test uses to avoid a real wall-clock wait. */
  async function claimAndAge(uid: string, by: string): Promise<void> {
    await claim(store, { uid, by, action: 'claim' });
    const ancient = new Date(Date.now() - 1_000 * 60_000).toISOString(); // 1000 minutes ago
    const row = await store.adapter.executeGet<{ meta: string | null }>('SELECT meta FROM node WHERE uid = ?', [uid]);
    const meta = row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    await store.adapter.executeRun('UPDATE node SET meta = ? WHERE uid = ?', [
      JSON.stringify({ ...meta, claimedAt: ancient }),
      uid,
    ]);
  }

  it('a store with 5 stale claims and limit:2 returns exactly 2, not all 5', async () => {
    const N = 5;
    const uids: string[] = [];
    for (let i = 0; i < N; i++) {
      const created = await createIssue(store, { project: projectUid, title: `stale issue ${i}`, body: 'body', by: 'filer' });
      uids.push(created.uid);
      await claimAndAge(created.uid, `agent-${i}`);
    }

    // Prove the fixture is genuinely 5-stale-wide BEFORE limiting, so a
    // 2-length result below is provably a real cap, not an accidental match.
    const unlimited = await queryIssues(store, { view: 'stale' });
    if (unlimited.view !== 'stale') throw new Error(`expected view 'stale', got '${unlimited.view}'`);
    expect(unlimited.items).toHaveLength(N);

    const limited = await queryIssues(store, { view: 'stale', limit: 2 });
    if (limited.view !== 'stale') throw new Error(`expected view 'stale', got '${limited.view}'`);
    expect(limited.items).toHaveLength(2);
    // Every returned item really is one of the stale claims — proves the cap
    // truncated the real set rather than returning unrelated rows.
    for (const item of limited.items) expect(uids).toContain(item.uid);
  });

  it('an out-of-range limit is REJECTED by the same assertQueryLimit every sibling view uses, not silently clamped', async () => {
    const created = await createIssue(store, { project: projectUid, title: 'one stale issue', body: 'body', by: 'filer' });
    await claimAndAge(created.uid, 'agent-0');

    await expect(queryIssues(store, { view: 'stale', limit: 0 })).rejects.toMatchObject({ field: 'limit' });
    await expect(queryIssues(store, { view: 'stale', limit: 1001 })).rejects.toMatchObject({ field: 'limit' });
  });
});
