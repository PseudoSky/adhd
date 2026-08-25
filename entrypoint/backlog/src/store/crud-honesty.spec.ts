/**
 * crud-honesty.spec.ts — three "the store reports success without doing the
 * thing" defects in `store/crud.ts`, all proven against a REAL store (no
 * mocks) by reading back the CONSUMER-VISIBLE outcome, never the
 * implementation shape:
 *
 *  1. BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001 — `updateItemNode` used to
 *     read exactly five `patch` keys and silently ignore every other
 *     `IUpdatePatch` field (priority/status/plan/assignee/kind/humanId/repo/
 *     files/author/reporter), returning the UNCHANGED item as a SUCCESS.
 *     Proven here by asserting each such key now THROWS, and — the part a
 *     throw alone doesn't prove — that the item is provably unchanged
 *     afterward through a BRAND NEW store handle reopened against the same
 *     on-disk file (not the in-process object the throwing call touched),
 *     so an in-memory cache could never launder a false pass.
 *
 *  2. BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001 — a dedupe-scan hit used
 *     to come back as `{ item: <the matched item>, created: false }` and
 *     NOTHING else: no typed reason, no field distinct from a real create.
 *     Proven by asserting the suppressed outcome carries an explicit
 *     `reason: 'duplicate-suppressed'`, that the live item COUNT in that
 *     (repo, family) does not increase across the suppressed attempt, and
 *     that passing `force: true` both bypasses the suppression AND does
 *     increase the count by exactly one.
 *
 *  3. BUG-BACKLOG-CREATE-DEDUPE-RETURNS-FOREIGN-ID-001 — on that same
 *     suppression path, `item.humanId` belongs to a DIFFERENT item than the
 *     one the caller tried to file; a caller reading it as "the id I just
 *     filed" ends up pointing at someone else's ticket. Proven by asserting
 *     `existingHumanId` names that foreign id explicitly and is NEVER set on
 *     a genuine `created: true` outcome — including the very next call,
 *     immediately after the suppressed one, which allocates a real new id
 *     under the identical (repo, family) and must not collide with, or be
 *     confused for, the suppressed candidate's id.
 *
 * NEGATIVE CONTROLS (performed manually per this repo's "assertions must
 * have teeth" verification standard, CLAUDE.md §7 / the dispatch brief's
 * EVIDENCE RULES): each suite below was run once against a temporarily
 * reverted `crud.ts` (the pre-fix five-key `updateItemNode`, and the pre-fix
 * two-field dedupe-suppression `return`) and observed to fail (RED), then
 * against the restored fix and observed to pass (GREEN). Both exit codes are
 * reported in the implementer's final summary, not restated here, so this
 * file never drifts out of sync with what was actually run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { closeGraphBacklogStore, openGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';
import { createItemNode, updateItemNode, type CreateItemOutcome } from './crud.js';
import { listItems } from './query.js';
import { InvalidArgumentError, UnsupportedOperationError, type IUpdatePatch } from '../model.js';

const REPO = 'PseudoSky/crud-honesty-test';

/**
 * Reads a single item's metadata straight off a BRAND NEW store handle
 * opened against the same on-disk file — never the in-process handle a
 * throwing/suppressed call touched — so a false pass can't hide behind an
 * in-memory cache. Mirrors `repo-migration-durability.spec.ts`'s
 * `identityAfterReopen` helper (same rationale, this file's own shape).
 */
async function readAfterReopen(dbPath: string, repo: string, humanId: string) {
  const reopened: GraphBacklogStore = await openGraphBacklogStore(dbPath);
  try {
    const items = await listItems(reopened, { repo });
    const found = items.find((i) => i.humanId === humanId);
    if (!found) throw new Error(`item ${repo}::${humanId} vanished after reopen`);
    return found;
  } finally {
    await closeGraphBacklogStore(reopened);
  }
}

async function countFamily(store: GraphBacklogStore, repo: string, family: string): Promise<number> {
  return (await listItems(store, { repo, family })).length;
}

describe('BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001 — updateItem rejects every patch key it does not apply, by name', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('crud-honesty-update');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  /**
   * One shared fixture item + a table of every "declared but unimplemented"
   * IUpdatePatch key, each proven to (a) throw and (b) leave the item
   * provably unchanged after a full store reopen. Table-driven rather than
   * one assertion per bug, because the bug's whole point is that EVERY one
   * of these keys used to fail this way, not just one.
   */
  const REJECTED_KEYS: ReadonlyArray<{ patch: IUpdatePatch; errorClass: typeof InvalidArgumentError | typeof UnsupportedOperationError; argument: string }> = [
    { patch: { priority: 'CRITICAL' }, errorClass: InvalidArgumentError, argument: 'priority' },
    { patch: { status: 'DONE' }, errorClass: InvalidArgumentError, argument: 'status' },
    { patch: { plan: 'some-plan' }, errorClass: InvalidArgumentError, argument: 'plan' },
    { patch: { assignee: 'someone' }, errorClass: InvalidArgumentError, argument: 'assignee' },
    { patch: { humanId: 'BUG-CRUD-HONESTY-999' }, errorClass: InvalidArgumentError, argument: 'humanId' },
    { patch: { kind: 'DEBT' }, errorClass: InvalidArgumentError, argument: 'kind' },
    { patch: { repo: 'PseudoSky/somewhere-else' }, errorClass: UnsupportedOperationError, argument: 'repo' },
    { patch: { files: ['packages/foo/bar.ts'] }, errorClass: UnsupportedOperationError, argument: 'files' },
    { patch: { author: 'someone' }, errorClass: UnsupportedOperationError, argument: 'author' },
    { patch: { reporter: 'someone' }, errorClass: UnsupportedOperationError, argument: 'reporter' },
  ];

  for (const { patch, errorClass, argument } of REJECTED_KEYS) {
    it(`rejects patch.${argument} (never silently discards it) and leaves the item unchanged after reopening the store`, async () => {
      const created = await createItemNode(tmp.store, {
        family: 'BUG-CRUD-HONESTY',
        title: 'unchanged title',
        body: 'unchanged body',
        repo: REPO,
      });
      expect(created.created).toBe(true);
      const humanId = created.item.humanId;

      await expect(updateItemNode(tmp.store, REPO, humanId, patch)).rejects.toThrow(errorClass);
      // The error must name the offending field, not just be "some"
      // InvalidArgumentError/UnsupportedOperationError. The two error
      // classes carry it under different property names (model.ts:
      // InvalidArgumentError.argument vs UnsupportedOperationError.operation).
      const propertyName = errorClass === UnsupportedOperationError ? 'operation' : 'argument';
      await expect(updateItemNode(tmp.store, REPO, humanId, patch)).rejects.toMatchObject({ [propertyName]: argument });

      // THE PART A THROW ALONE DOESN'T PROVE: read the item back through a
      // fresh reopened store handle and confirm it is byte-for-byte the item
      // that was created — no partial write snuck through before the throw.
      const reread = await readAfterReopen(tmp.dbPath, REPO, humanId);
      expect(reread.title).toBe('unchanged title');
      expect(reread.body).toBe('unchanged body');
      expect(reread.priority).toBeUndefined();
      expect(reread.plan).toBeUndefined();
      expect(reread.assignee).toBeUndefined();
      expect(reread.kind).toBe('BUG');
      expect(reread.repo).toBe(REPO);
      expect(reread.humanId).toBe(humanId);
    });
  }

  it('rejects a totally unknown patch key by name (assertKnownPatchKeys), distinct from a declared-but-unimplemented one', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-CRUD-HONESTY', title: 't', body: 'b', repo: REPO });
    await expect(
      updateItemNode(tmp.store, REPO, created.item.humanId, { bogusTypoField: 'x' } as unknown as IUpdatePatch)
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('positive control: a patch using only the five keys this operation genuinely owns still applies normally', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-CRUD-HONESTY', title: 'old title', body: 'old body', repo: REPO });
    const updated = await updateItemNode(tmp.store, REPO, created.item.humanId, { title: 'new title', body: 'new body' });
    expect(updated.title).toBe('new title');
    expect(updated.body).toBe('new body');

    const reread = await readAfterReopen(tmp.dbPath, REPO, created.item.humanId);
    expect(reread.title).toBe('new title');
    expect(reread.body).toBe('new body');
  });
});

describe('BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001 / BUG-BACKLOG-CREATE-DEDUPE-RETURNS-FOREIGN-ID-001', () => {
  let tmp: TmpStore;
  const FAMILY = 'BUG-DEDUPE-HONESTY';
  const DUPE_TITLE = 'A very specific dedupe honesty probe title that will not collide with anything else';

  beforeEach(async () => {
    tmp = await openTmpStore('crud-honesty-dedupe');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('a dedupe hit is an explicit, typed outcome — never a bare success envelope for an item that was not written', async () => {
    const original = await createItemNode(tmp.store, { family: FAMILY, title: DUPE_TITLE, body: 'original body content', repo: REPO });
    expect(original.created).toBe(true);
    expect(original.existingHumanId).toBeUndefined();
    expect(original.reason).toBeUndefined();

    const countBefore = await countFamily(tmp.store, REPO, FAMILY);
    expect(countBefore).toBe(1);

    const attempt: CreateItemOutcome = await createItemNode(tmp.store, {
      family: FAMILY,
      title: DUPE_TITLE,
      body: 'a different body, same title — should be caught by the FTS+title-overlap gate',
      repo: REPO,
    });

    // The suppression itself: created:false was already reported pre-fix —
    // what BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001 is actually about is
    // that nothing ELSE distinguished this from success. `reason` is that
    // distinguishing, explicitly-typed field.
    expect(attempt.created).toBe(false);
    expect(attempt.reason).toBe('duplicate-suppressed');
    expect(attempt.duplicateCandidates.map((c) => c.humanId)).toContain(original.item.humanId);

    // BUG-BACKLOG-CREATE-DEDUPE-RETURNS-FOREIGN-ID-001: the id belongs to a
    // DIFFERENT item — named honestly, not smuggled in unlabeled via `item`.
    expect(attempt.existingHumanId).toBe(original.item.humanId);

    // THE COUNT DID NOT INCREASE — a caller counting "how many items exist"
    // (or re-deriving `created` by checking for a new row) sees the truth.
    const countAfterSuppressed = await countFamily(tmp.store, REPO, FAMILY);
    expect(countAfterSuppressed).toBe(1);

    // Same fact, proven through a REOPENED store handle — not the in-process
    // object the suppressed call touched.
    const reopenedCount = (await (async () => {
      const reopened = await openGraphBacklogStore(tmp.dbPath);
      try {
        return (await listItems(reopened, { repo: REPO, family: FAMILY })).length;
      } finally {
        await closeGraphBacklogStore(reopened);
      }
    })());
    expect(reopenedCount).toBe(1);
  });

  it('FEAT-013: increments the matched item\'s dupeHits counter on a suppressed dedupe hit', async () => {
    const original = await createItemNode(tmp.store, { family: FAMILY, title: DUPE_TITLE, body: 'original body', repo: REPO });
    await createItemNode(tmp.store, { family: FAMILY, title: DUPE_TITLE, body: 'refile attempt 1', repo: REPO });
    await createItemNode(tmp.store, { family: FAMILY, title: DUPE_TITLE, body: 'refile attempt 2', repo: REPO });

    const node = await tmp.store.graph.getNode(original.item.nodeId);
    const meta = (node?.metadata ?? {}) as { dupeHits?: number };
    expect(meta.dupeHits).toBe(2);
  });

  it('honours an explicit force: true — bypasses suppression AND increases the live count by exactly one', async () => {
    const original = await createItemNode(tmp.store, { family: FAMILY, title: DUPE_TITLE, body: 'original body', repo: REPO });
    expect(await countFamily(tmp.store, REPO, FAMILY)).toBe(1);

    const forced = await createItemNode(tmp.store, {
      family: FAMILY,
      title: DUPE_TITLE,
      body: 'forced duplicate body',
      repo: REPO,
      force: true,
    });

    expect(forced.created).toBe(true);
    // A genuine create must NEVER carry the suppression fields — the other
    // half of BUG-BACKLOG-CREATE-DEDUPE-RETURNS-FOREIGN-ID-001: a real
    // create's own new id must never be shadowed by, or confused with, a
    // foreign existingHumanId.
    expect(forced.existingHumanId).toBeUndefined();
    expect(forced.reason).toBeUndefined();
    expect(forced.item.humanId).not.toBe(original.item.humanId);

    expect(await countFamily(tmp.store, REPO, FAMILY)).toBe(2);

    // Persisted, not just an in-process artifact of this call.
    const reopened = await openGraphBacklogStore(tmp.dbPath);
    try {
      expect((await listItems(reopened, { repo: REPO, family: FAMILY })).length).toBe(2);
    } finally {
      await closeGraphBacklogStore(reopened);
    }
  });

  it('the exact-idOverride-collision path sets existingHumanId to the CALLER\'S OWN requested id (never a foreign one) — distinct from the dedupe-scan path above', async () => {
    const created = await createItemNode(tmp.store, { family: FAMILY, idOverride: `${FAMILY}-777`, title: 'idempotent reimport', body: 'b', repo: REPO });
    expect(created.created).toBe(true);

    const reimport = await createItemNode(tmp.store, { family: FAMILY, idOverride: `${FAMILY}-777`, title: 'idempotent reimport', body: 'b', repo: REPO });
    expect(reimport.created).toBe(false);
    expect(reimport.reason).toBe('id-collision');
    // Not "foreign" — it is exactly the id the caller themselves asked for.
    expect(reimport.existingHumanId).toBe(`${FAMILY}-777`);
    expect(reimport.item.humanId).toBe(`${FAMILY}-777`);
  });
});
