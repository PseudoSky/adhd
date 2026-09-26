/**
 * catalog-repair.spec.ts — proof for `write/catalog-repair.ts`, the D1 repair
 * of the `terminal`-flag drift, and the RED reproduction of that drift.
 *
 * THE DEFECT. `query/card.ts`'s `isStatusTerminal` reads
 * `status.metadata.terminal === true`, defaulting FALSE when the key is
 * absent. A `status` catalog row named `closed` (or any other reserved
 * terminal name) that was minted WITHOUT that flag — `create-issue.ts`'s
 * `mintMetadata: async () => ({ terminal: false })` — is therefore treated as
 * NON-terminal, so `queryIssues({filter:{status:'open'}})` returns items that
 * are, by name, closed.
 *
 * THE REPAIR. `applyTerminalBackfill` sets `meta.terminal = true` on exactly
 * those live `status` rows whose folded name is a reserved terminal name and
 * whose flag is not already `true` — leaving every other `meta` key untouched.
 * It is idempotent (a re-run plans nothing) and reversible (the journal
 * restores the prior flag).
 *
 * Every assertion drives the REAL verbs (`seedProject`/`createIssue`/
 * `queryIssues`) against a REAL store opened via `openTestIssueStore` — never
 * a mock of any verb, never a mock of the store. Load-bearing persistence
 * claims are read back with direct SQL, never trusted from a returned object.
 *
 * The negative control (NO backfill ⇒ the item is returned as open) is what
 * gives the green assertions teeth: it proves the backfill, not some
 * unrelated coincidence, is what removes the item from `open`.
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
import { queryIssues } from '../query/query.js';
import {
  applyTerminalBackfill,
  catalogNameFold,
  planTerminalBackfill,
  reverseTerminalBackfill,
} from './catalog-repair.js';
import { writeNodeTx } from './tx.js';

/** The uids a `view:'list'` result contains; throws on any other view so a wrong shape fails loudly rather than silently reading `undefined`. */
async function listedUids(
  store: TestIssueStore,
  filter: { status: 'open' | 'closed' }
): Promise<string[]> {
  const result = await queryIssues(store, { filter, limit: 100 });
  if (result.view !== 'list')
    throw new Error(`expected view:'list', got ${result.view}`);
  return result.items.map((item) => item.uid);
}

/** Direct SQL: the live `status` row named `name` (rowid + parsed meta), never a returned object. */
async function statusRow(
  store: TestIssueStore,
  name: string
): Promise<{ rowid: number; uid: string; meta: Record<string, unknown> }> {
  const { rows } = await store.adapter.executeAll<{
    rowid: number;
    uid: string;
    meta: string | null;
  }>(
    "SELECT rowid, uid, meta FROM node WHERE kind = 'status' AND name = ? AND t_invalid IS NULL",
    [name]
  );
  if (rows.length !== 1)
    throw new Error(
      `expected exactly one live status row named "${name}", found ${rows.length}`
    );
  const row = rows[0]!;
  return {
    rowid: row.rowid,
    uid: row.uid,
    meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, unknown>,
  };
}

/** Mint a bare `status` row with caller-chosen metadata — the same `writeNodeTx` primitive every verb uses. */
async function mintStatusRow(
  store: TestIssueStore,
  name: string,
  metadata: Record<string, unknown>
): Promise<{ rowid: number; uid: string }> {
  return store.adapter.transaction(
    async (tx) => writeNodeTx(tx, { kind: 'status', name, metadata }),
    { mode: 'immediate' }
  );
}

describe('catalog-repair — terminal status flag drift', () => {
  let dir: string;
  let store: TestIssueStore;

  beforeEach(async () => {
    dir = freshTmpDir('catalog-repair-spec');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  it('NEGATIVE CONTROL: without the backfill, a `closed`-status issue IS returned under filter.status:"open" — the drift, reproduced', async () => {
    const { projectUid } = await seedProject(store, 'catalog-repair-negctl');
    const closed = await createIssue(store, {
      project: projectUid,
      title: 'negative-control closed item',
      body: 'status name is reserved-terminal but minted without the flag',
      status: 'closed',
      by: 'repair-test',
    });
    expect(closed.created).toBe(true);

    // The store genuinely HAS work to do — otherwise this would be a
    // "negative control" that proves nothing.
    const plan = await planTerminalBackfill(store);
    expect(plan.setTerminalRowids.length).toBeGreaterThanOrEqual(1);

    // ...and with NO apply, the drift stands: the item shows up as OPEN.
    expect(await listedUids(store, { status: 'open' })).toContain(closed.uid);
    expect(await listedUids(store, { status: 'closed' })).not.toContain(
      closed.uid
    );
  });

  it('GREEN: after applyTerminalBackfill, the item leaves `open` and appears under `closed`', async () => {
    const { projectUid } = await seedProject(store, 'catalog-repair-green');
    const closed = await createIssue(store, {
      project: projectUid,
      title: 'green closed item',
      body: 'status name is reserved-terminal, backfill will flag it',
      status: 'closed',
      by: 'repair-test',
    });
    expect(closed.created).toBe(true);

    const plan = await planTerminalBackfill(store);
    expect(plan.setTerminalRowids.length).toBeGreaterThanOrEqual(1);
    const journal = await applyTerminalBackfill(store, plan);
    expect(journal.entries.length).toBe(plan.setTerminalRowids.length);

    // The minted `closed` row now carries terminal:true (direct SQL read).
    expect((await statusRow(store, 'closed')).meta.terminal).toBe(true);

    // Consumer-visible outcome via the REAL read layer:
    expect(await listedUids(store, { status: 'open' })).not.toContain(
      closed.uid
    );
    expect(await listedUids(store, { status: 'closed' })).toContain(closed.uid);
  });

  it('IDEMPOTENT: a re-run after apply plans nothing and writes nothing', async () => {
    const { projectUid } = await seedProject(store, 'catalog-repair-idem');
    await createIssue(store, {
      project: projectUid,
      title: 'idempotency closed item',
      body: 'first apply flags the status row',
      status: 'closed',
      by: 'repair-test',
    });

    await applyTerminalBackfill(store, await planTerminalBackfill(store));

    const secondPlan = await planTerminalBackfill(store);
    expect(secondPlan.setTerminalRowids).toEqual([]);
    const secondJournal = await applyTerminalBackfill(store, secondPlan);
    expect(secondJournal.entries).toEqual([]);
  });

  it('already-terminal rows are excluded from the plan and left byte-for-byte untouched by a forced apply', async () => {
    const planted = await mintStatusRow(store, 'closed', {
      terminal: true,
      marker: 'keep-me',
    });

    // Excluded from a normal plan...
    const plan = await planTerminalBackfill(store);
    expect(plan.setTerminalRowids).not.toContain(planted.rowid);

    // ...and even a FORCED plan that names it changes nothing, journaling no entry.
    const journal = await applyTerminalBackfill(store, {
      setTerminalRowids: [planted.rowid],
      at: new Date().toISOString(),
    });
    expect(journal.entries).toEqual([]);

    const { rows } = await store.adapter.executeAll<{ meta: string }>(
      'SELECT meta FROM node WHERE rowid = ? AND t_invalid IS NULL',
      [planted.rowid]
    );
    expect(JSON.parse(rows[0]!.meta)).toEqual({
      terminal: true,
      marker: 'keep-me',
    });
  });

  it('reverses exactly: the journal restores the prior flag and the item returns to `open`', async () => {
    const { projectUid } = await seedProject(store, 'catalog-repair-reverse');
    const closed = await createIssue(store, {
      project: projectUid,
      title: 'reverse closed item',
      body: 'apply then reverse restores the drift',
      status: 'closed',
      by: 'repair-test',
    });

    const journal = await applyTerminalBackfill(
      store,
      await planTerminalBackfill(store)
    );
    expect(journal.entries.length).toBeGreaterThanOrEqual(1);
    expect((await statusRow(store, 'closed')).meta.terminal).toBe(true);
    expect(await listedUids(store, { status: 'open' })).not.toContain(
      closed.uid
    );

    await reverseTerminalBackfill(store, journal);

    // `hadTerminal` was false for every real entry: the flag is restored to false.
    for (const entry of journal.entries) expect(entry.hadTerminal).toBe(false);
    expect((await statusRow(store, 'closed')).meta.terminal).toBe(false);
    expect(await listedUids(store, { status: 'open' })).toContain(closed.uid);
  });

  it('groups by Unicode fold: `DONE`, `done` and `Done` are ALL flagged under one folded name', async () => {
    const a = await mintStatusRow(store, 'DONE', { terminal: false });
    const b = await mintStatusRow(store, 'done', { terminal: false });
    const c = await mintStatusRow(store, 'Done', { terminal: false });

    expect(catalogNameFold('DONE')).toBe(catalogNameFold('Done'));
    expect(catalogNameFold('Done')).toBe('done');

    const plan = await planTerminalBackfill(store);
    for (const rowid of [a.rowid, b.rowid, c.rowid]) {
      expect(plan.setTerminalRowids).toContain(rowid);
    }

    await applyTerminalBackfill(store, plan);
    for (const name of ['DONE', 'done', 'Done']) {
      expect((await statusRow(store, name)).meta.terminal).toBe(true);
    }
  });
});
