/**
 * sort-priority-direction.spec.ts — D3 (`9a95be96`): `query`'s
 * `sort:"priority"` must HONOR `direction`. SPEC-SET.md S03 AC2; SPEC.md §6.5
 * rule 6 ("show me the top N by priority").
 *
 * `priority.meta.rank` is INVERSE to urgency: a smaller rank is a MORE urgent
 * priority. `catalog.ts` mints a novel priority one past the current max (the
 * LOWEST urgency) — SPEC.md §6.3.2 — so rank-ASCENDING is most-urgent-first.
 * "Descending priority" (HIGH first) is therefore rank-ascending; the shipped
 * code inverted that mapping, so `direction:"desc"` returned ascending priority
 * (LOW first).
 *
 * NEGATIVE CONTROL: the `direction:"desc"` assertion below was RED before the
 * fix (desc returned `['LOW','MEDIUM','HIGH']`) and is GREEN after; the `asc`
 * assertion flips the same way. The no-direction assertion is the
 * behaviour-preservation check (the historical default was already HIGH-first).
 *
 * Real components throughout: a real store via `openTestIssueStore`/
 * `seedProject`, real `createIssue` writes, `queryIssues` driven exactly as the
 * mounted `query` verb drives it. Nothing under test is mocked.
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
import { writeNodeTx, nowISO } from '../write/tx.js';
import { queryIssues } from './query.js';

/**
 * Seed the three canonical priorities with EXPLICIT ranks so the test does not
 * depend on `createIssue`'s mint order (a fresh store has no priority rows).
 * Rank is inverse to urgency: HIGH 0 < MEDIUM 1 < LOW 2.
 */
async function seedPriorities(store: TestIssueStore): Promise<void> {
  await store.adapter.transaction(
    async (tx) => {
      const at = nowISO();
      await writeNodeTx(tx, {
        kind: 'priority',
        name: 'HIGH',
        metadata: { rank: 0 },
        at,
      });
      await writeNodeTx(tx, {
        kind: 'priority',
        name: 'MEDIUM',
        metadata: { rank: 1 },
        at,
      });
      await writeNodeTx(tx, {
        kind: 'priority',
        name: 'LOW',
        metadata: { rank: 2 },
        at,
      });
    },
    { mode: 'immediate' }
  );
}

describe('query — sort:"priority" honors direction (D3 9a95be96; real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('query-priority-direction');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'priority-direction-project'))
      .projectUid;
    await seedPriorities(store);
  });
  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function mkIssue(title: string, priority: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `${title} body`,
      priority,
      by: 'filer',
    });
    if (created.uid === undefined)
      throw new Error(`createIssue returned no uid for ${title}`);
    return created.uid;
  }

  // Created in a JUMBLED order (LOW, HIGH, MEDIUM) so insertion order differs
  // from every priority order — an ignored `sort`/`direction` cannot pass by
  // accidentally returning insertion order.
  async function seedThree(): Promise<void> {
    await mkIssue('low-item', 'LOW');
    await mkIssue('high-item', 'HIGH');
    await mkIssue('medium-item', 'MEDIUM');
  }

  async function orderFor(
    direction: 'asc' | 'desc' | undefined
  ): Promise<string[]> {
    const result = await queryIssues(store, {
      filter: { project: projectUid },
      sort: 'priority',
      ...(direction !== undefined ? { direction } : {}),
      limit: 10,
      view: 'list',
    });
    // The result union also carries a markdown arm whose `view` may be
    // `'list'`, so `view` alone is not a sufficient discriminant here — the
    // `'items' in result` conjunct narrows to the list arm.
    if (result.view !== 'list' || !('items' in result))
      throw new Error(`expected a list result, got view '${result.view}'`);
    return result.items.map((i) => i.priority ?? '');
  }

  it('direction:"desc" returns descending priority (HIGH → MEDIUM → LOW)', async () => {
    await seedThree();
    expect(await orderFor('desc')).toEqual(['HIGH', 'MEDIUM', 'LOW']);
  });

  it('direction:"asc" returns ascending priority (LOW → MEDIUM → HIGH)', async () => {
    await seedThree();
    expect(await orderFor('asc')).toEqual(['LOW', 'MEDIUM', 'HIGH']);
  });

  it('an omitted direction preserves the historical default (most urgent first)', async () => {
    await seedThree();
    expect(await orderFor(undefined)).toEqual(['HIGH', 'MEDIUM', 'LOW']);
  });
});
