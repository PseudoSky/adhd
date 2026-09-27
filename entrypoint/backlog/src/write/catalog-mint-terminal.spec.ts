/**
 * catalog-mint-terminal.spec.ts — the SOURCE-fix proof for the `status`
 * `terminal`-flag drift (ADR-0002 D1): the mint path seeds terminality from a
 * frozen reserved table, so minting a reserved terminal NAME no longer
 * re-introduces the drift the one-shot `catalog-repair.ts` was written to
 * clean up.
 *
 * THE DEFECT (reproduced RED below). `isStatusTerminal` reads
 * `status.metadata.terminal === true`, defaulting FALSE when the key is
 * absent. Both status-mint sites (`create-issue.ts`, `transition.ts`)
 * hardcoded `mintMetadata: async () => ({ terminal: false })`, so minting the
 * reserved name `closed` produced a row that READ as non-terminal and
 * `queryIssues({filter:{status:'open'}})` returned an item that is closed by
 * name.
 *
 * THE FIX. Terminality is SEEDED from the frozen
 * {@link RESERVED_TERMINAL_STATUS_NAMES} table, never stamped at the call
 * site and never derived at read time (`query/card.ts`'s `isStatusTerminal`
 * stays name-blind). A reserved name (any spelling — membership is decided on
 * the folded name) with no live row is seeded `terminal:true`; every other name
 * keeps the pre-existing `terminal:false` default (SPEC.md §6.3.2: a
 * novel/typo name must never silently close an item).
 *
 * Every assertion drives the REAL verbs (`seedProject`/`createIssue`/
 * `transition`/`queryIssues`) against a REAL store opened via
 * `openTestIssueStore` — never a mock. Load-bearing persistence claims are
 * read back with direct SQL, never trusted from a returned object.
 *
 * The NEGATIVE CONTROL plants a `closed` row carrying `terminal:false` (the
 * pre-fix mint shape) and shows the item IS returned under `open` — proving
 * the green assertions are sensitive to the flag, so the suite goes RED if
 * the fix is reverted.
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
import { queryIssues } from '../query/query.js';
import { writeNodeTx } from './tx.js';
import {
  RESERVED_TERMINAL_STATUS_NAMES,
  isReservedTerminalStatusName,
} from './catalog.js';
import { RESERVED_TERMINAL_STATUS_NAMES as RESERVED_FROM_REPAIR } from './catalog-repair.js';

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

/** Direct SQL: every LIVE `status` row named `name`, parsed. Never a returned object. */
async function liveStatusRows(
  store: TestIssueStore,
  name: string
): Promise<Array<{ rowid: number; uid: string; meta: Record<string, unknown> }>> {
  const { rows } = await store.adapter.executeAll<{
    rowid: number;
    uid: string;
    meta: string | null;
  }>(
    "SELECT rowid, uid, meta FROM node WHERE kind = 'status' AND name = ? AND t_invalid IS NULL ORDER BY rowid ASC",
    [name]
  );
  return rows.map((row) => ({
    rowid: row.rowid,
    uid: row.uid,
    meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, unknown>,
  }));
}

/** Direct SQL: the ONE live `status` row named `name` (throws if not exactly one). */
async function statusRow(
  store: TestIssueStore,
  name: string
): Promise<{ rowid: number; uid: string; meta: Record<string, unknown> }> {
  const rows = await liveStatusRows(store, name);
  if (rows.length !== 1)
    throw new Error(
      `expected exactly one live status row named "${name}", found ${rows.length}`
    );
  return rows[0]!;
}

/** Mint a bare `status` row with caller-chosen metadata — the primitive the buggy mint used, used here only to PLANT the pre-fix drift for the negative control. */
async function plantStatusRow(
  store: TestIssueStore,
  name: string,
  metadata: Record<string, unknown>
): Promise<{ rowid: number; uid: string }> {
  return store.adapter.transaction(
    async (tx) => writeNodeTx(tx, { kind: 'status', name, metadata }),
    { mode: 'immediate' }
  );
}

describe('status mint — reserved terminal names seed terminal:true at the source', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('catalog-mint-terminal');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'mint-terminal-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueDirSafely(dir);
  });

  it('CREATE: minting the reserved name `closed` seeds terminal:true — the item is ABSENT from `open` and PRESENT under `closed`', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'reserved-name create',
      body: 'minting a reserved terminal name must seed the flag',
      status: 'closed',
      by: 'mint-test',
    });
    expect(created.created).toBe(true);

    // Direct SQL read: the freshly-seeded row carries the flag.
    expect((await statusRow(store, 'closed')).meta.terminal).toBe(true);

    // Consumer-visible outcome through the REAL read layer.
    expect(await listedUids(store, { status: 'open' })).not.toContain(
      created.uid
    );
    expect(await listedUids(store, { status: 'closed' })).toContain(created.uid);
  });

  it('NEGATIVE CONTROL: a `closed` row carrying terminal:false (the pre-fix mint shape) leaves the item returned under `open` — the assertion above has teeth', async () => {
    // Bypass the seeding resolver entirely: plant exactly what the buggy
    // `mintMetadata: async () => ({ terminal: false })` used to write.
    await plantStatusRow(store, 'closed', { terminal: false });

    const created = await createIssue(store, {
      project: projectUid,
      title: 'planted non-terminal closed',
      body: 'the negative control: the drift is still observable when the flag is false',
      status: 'closed',
      by: 'mint-test',
    });
    expect(created.created).toBe(true);

    // The drift stands: an item named-closed shows up as open. This is the
    // RED condition the positive test above asserts the ABSENCE of, so the
    // fix is load-bearing, not incidental.
    expect(await listedUids(store, { status: 'open' })).toContain(created.uid);
    expect(await listedUids(store, { status: 'closed' })).not.toContain(
      created.uid
    );
  });

  it('TRANSITION: a reserved terminal `toStatus` seeds terminal:true — the item leaves `open` and the outcome carries closedAt', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'transition to reserved',
      body: 'transitioning onto a reserved terminal name must close the item',
      by: 'mint-test',
    });

    const outcome = await transition(store, {
      uid: created.uid,
      by: 'mint-test',
      toStatus: 'closed',
      note: 'closing via transition',
    });
    expect(outcome.toStatus).toBe('closed');
    expect(outcome.closedAt).toBeDefined();
    expect((await statusRow(store, 'closed')).meta.terminal).toBe(true);

    expect(await listedUids(store, { status: 'open' })).not.toContain(
      created.uid
    );
    expect(await listedUids(store, { status: 'closed' })).toContain(created.uid);
  });

  it('EVERY name in the frozen reserved table seeds terminal:true (create path)', async () => {
    for (const name of RESERVED_TERMINAL_STATUS_NAMES) {
      const created = await createIssue(store, {
        project: projectUid,
        title: `reserved ${name}`,
        body: 'table coverage',
        status: name,
        by: 'mint-test',
      });
      expect((await statusRow(store, name)).meta.terminal).toBe(true);
      expect(await listedUids(store, { status: 'open' })).not.toContain(
        created.uid
      );
    }
  });

  it('SPEC.md §6.3.2 preserved: a NON-reserved novel name still mints terminal:false and stays under `open` (a typo never silently closes)', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'novel status name',
      body: 'a name outside the reserved table must not close anything',
      status: 'AWAITING_REVIEW',
      by: 'mint-test',
    });

    expect((await statusRow(store, 'AWAITING_REVIEW')).meta.terminal).toBe(
      false
    );
    expect(await listedUids(store, { status: 'open' })).toContain(created.uid);
  });

  it('IDEMPOTENT: minting the same reserved name twice leaves exactly ONE live status row (self-heal, no duplicate)', async () => {
    await createIssue(store, {
      project: projectUid,
      title: 'first closed',
      body: 'first',
      status: 'closed',
      by: 'mint-test',
    });
    await createIssue(store, {
      project: projectUid,
      title: 'second closed',
      body: 'second',
      status: 'closed',
      by: 'mint-test',
    });

    const rows = await liveStatusRows(store, 'closed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta.terminal).toBe(true);
  });

  it('CASE FOLD: minting a non-canonical reserved spelling (`Closed`) seeds terminal:true (reserved terminality is decided on the folded name)', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'case variant closed',
      body: 'reserved terminality is decided on the folded name',
      status: 'Closed',
      by: 'mint-test',
    });
    expect(created.created).toBe(true);

    // No `closed` row exists in this fresh store, so `Closed` is an exact miss
    // and mints a row of its own (a distinct spelling). The write path refuses
    // only a case-variant of an EXISTING live row, never a first-ever spelling.
    const rows = await liveStatusRows(store, 'Closed');
    expect(rows).toHaveLength(1);

    // Terminality is decided on the FOLDED name, so `Closed` folds to the
    // reserved `closed` and seeds the flag — no longer a closed-by-name row
    // that reads as open.
    expect(rows[0]!.meta.terminal).toBe(true);
    expect(await listedUids(store, { status: 'open' })).not.toContain(
      created.uid
    );
    expect(await listedUids(store, { status: 'closed' })).toContain(created.uid);
  });

  it('CASE FOLD: transition to a non-canonical reserved spelling (`Closed`) seeds terminal:true', async () => {
    const created = await createIssue(store, {
      project: projectUid,
      title: 'transition case variant',
      body: 'transitioning onto a reserved spelling must close the item',
      by: 'mint-test',
    });

    const outcome = await transition(store, {
      uid: created.uid,
      by: 'mint-test',
      toStatus: 'Closed',
      note: 'case variant transition',
    });
    expect(outcome.toStatus).toBe('Closed');
    expect((await statusRow(store, 'Closed')).meta.terminal).toBe(true);
    expect(await listedUids(store, { status: 'open' })).not.toContain(
      created.uid
    );
  });

  it('DRIFT (one definition): `catalog-repair` re-exports the `catalog.ts` reserved table by identity, and membership is case-folded', () => {
    // Reference identity => there is exactly ONE definition of the reserved
    // set in the codebase, not two copies that merely agree today.
    expect(RESERVED_FROM_REPAIR).toBe(RESERVED_TERMINAL_STATUS_NAMES);

    for (const name of RESERVED_TERMINAL_STATUS_NAMES) {
      expect(isReservedTerminalStatusName(name)).toBe(true);
    }
    expect(isReservedTerminalStatusName('open')).toBe(false);
    // Membership folds: every spelling of a reserved terminal token counts, so
    // a first-ever lowercase `fixed`/`resolved`/`done` seeds terminal:true
    // instead of reading as open (backlog b4525bc3 / d7ec2c50).
    expect(isReservedTerminalStatusName('Closed')).toBe(true);
    expect(isReservedTerminalStatusName('fixed')).toBe(true);
    expect(isReservedTerminalStatusName('RESOLVED')).toBe(true);
    expect(isReservedTerminalStatusName('done')).toBe(true);
    expect(RESERVED_TERMINAL_STATUS_NAMES.size).toBeGreaterThan(0);
  });
});

/** Teardown wrapper: `removeTestIssueStoreDir` is a pure fs removal; kept named for readability at the call site. */
function removeTestIssueDirSafely(dir: string): void {
  removeTestIssueStoreDir(dir);
}
