/**
 * id-uniqueness.spec.ts — BUG-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-SCAN-001
 * and DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001, against a real temp turso-backed
 * `GraphBacklogStore` (no mocks). See `store/ids.ts`'s file-header doc
 * comment for the full fix rationale; this file proves it.
 *
 * `humanid-collision.spec.ts` (BUG-BACKLOG-HUMANID-COLLISION-001) already
 * covers: (1) `createItemNode` rejecting an empty/missing `family`, (2)
 * `findItemNode`/`findLiveByHumanId` throwing `AmbiguousHumanIdError` on a
 * pre-existing >1-live-node collision, (3) `renameHumanIdNode` repair. This
 * file is deliberately narrower and does NOT duplicate any of that — it
 * covers the two NEW defects: (A) `computeNextHumanId` re-minting an id a
 * TOMBSTONED (invalidated) node still holds, and (B) `humanId` having no
 * store-level uniqueness enforcement at all.
 *
 * LIVE-DATA JUSTIFICATION (DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001, 2026-08-21):
 * before adding the partial unique index in `ids.ts`, the REAL production
 * store (`~/.adhd/backlog/production/data/backlog.db`) was queried
 * directly and read-only, via `@adhd/sox-store-adapter` (bypassing the
 * `sqlite3` CLI, which cannot parse turso's internal schema objects), never
 * written to:
 *
 *   SELECT namespace, json_extract(meta,'$.humanId') AS hid, COUNT(*) AS cnt
 *   FROM node
 *   WHERE tags LIKE '%backlog-item%' AND t_invalid IS NULL
 *     AND json_extract(meta,'$.humanId') IS NOT NULL
 *   GROUP BY namespace, hid HAVING COUNT(*) > 1;
 *   -->  0 rows  (1271 total live backlog-item nodes)
 *
 * A naive, UNTAGGED grouping (same query, no `tags LIKE` filter) DID surface
 * one group — `PseudoSky/adhd` / `FEAT-APIGEN-TS-TYPE-CODEGEN-001`, count 2
 * — but the second row (rowid 654) turned out to be tagged
 * `["backlog-audit-event"]`, carrying `meta.humanId` only to say which item
 * its audit entry is ABOUT, not claiming to BE that item. This is exactly
 * why `ids.ts`'s index predicate is tag-scoped (`instr(tags,
 * '"backlog-item"') > 0`), and why this file's "audit-event-shaped row does
 * NOT collide" test below exists — it is not a hypothetical edge case, it
 * is the one real row that would otherwise have broken this exact rollout.
 *
 * A THIRD query, also read-only against the same real store, found 20
 * `(namespace, humanId)` pairs where a LIVE node's humanId is ALSO held by
 * an INVALIDATED node — i.e. BUG-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-
 * SCAN-001's exact failure shape, already realized in production:
 *
 *   SELECT live.namespace, json_extract(live.meta,'$.humanId') AS hid
 *   FROM node live JOIN node dead
 *     ON dead.namespace = live.namespace
 *    AND json_extract(dead.meta,'$.humanId') = json_extract(live.meta,'$.humanId')
 *    AND dead.t_invalid IS NOT NULL
 *   WHERE live.tags LIKE '%backlog-item%' AND live.t_invalid IS NULL
 *     AND dead.tags LIKE '%backlog-item%';
 *   -->  20 rows
 *
 * (These are irrelevant to the unique index itself — its scope is
 * deliberately live-only, so a real delete-then-reuse stays legal — but
 * they prove fix (A) below is not a hypothetical either.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { openGraphBacklogStore, closeGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';
import { createItemNode, softDeleteItemNode } from './crud.js';
import { findItemNode } from './query.js';
import { BACKLOG_ITEM_TAG, buildNodeContent, buildNodeName } from './mapping.js';

const REPO = 'PseudoSky/adhd-id-uniqueness-test';
const HERE = dirname(fileURLToPath(import.meta.url));
const IDS_TS_PATH = join(HERE, 'ids.ts');

let tmp: TmpStore;

beforeEach(async () => {
  tmp = await openTmpStore('id-uniqueness');
});

afterEach(async () => {
  await tmp.cleanup();
});

describe('fix (A): computeNextHumanId scans invalidated (tombstoned) nodes too, not just live ones', () => {
  it('never re-mints an id a soft-deleted node in the SAME family still holds', async () => {
    const first = await createItemNode(tmp.store, { family: 'BUG-TOMB', title: 'will be deleted', body: 'b1', repo: REPO });
    expect(first.item.humanId).toBe('BUG-TOMB-001');

    await softDeleteItemNode(tmp.store, REPO, first.item.humanId, 'superseded by a later fix');

    // Confirm the tombstone really is invisible to a normal live lookup —
    // this is the exact condition that made the OLD computeNextHumanId
    // think "BUG-TOMB-001 is free again".
    const liveLookup = await findItemNode(tmp.store, REPO, first.item.humanId);
    expect(liveLookup).toBeNull();

    const second = await createItemNode(tmp.store, { family: 'BUG-TOMB', title: 'a new, unrelated item', body: 'b2', repo: REPO });
    // The failing condition this proves against: `second.item.humanId ===
    // 'BUG-TOMB-001'` — silently re-minting the tombstoned identity onto a
    // brand-new, unrelated item.
    expect(second.item.humanId).toBe('BUG-TOMB-002');
    expect(second.item.humanId).not.toBe(first.item.humanId);
  });

  it('still correctly skips PRIOR live siblings when computing the next id (no regression from the tombstone-scan change)', async () => {
    const a = await createItemNode(tmp.store, { family: 'BUG-MIX', title: 'a', body: 'b', repo: REPO });
    const b = await createItemNode(tmp.store, { family: 'BUG-MIX', title: 'b', body: 'b', repo: REPO });
    expect(a.item.humanId).toBe('BUG-MIX-001');
    expect(b.item.humanId).toBe('BUG-MIX-002');
    await softDeleteItemNode(tmp.store, REPO, a.item.humanId, 'cleanup');
    const c = await createItemNode(tmp.store, { family: 'BUG-MIX', title: 'c', body: 'b', repo: REPO });
    // Must skip past BOTH the live b (002) AND the tombstoned a (001) -> 003.
    expect(c.item.humanId).toBe('BUG-MIX-003');
  });

  /**
   * NEGATIVE CONTROL — scripted, not manual: temporarily swaps
   * `computeNextHumanId`'s body back to the pre-fix implementation (a
   * verbatim copy of the version this bug report describes — a plain
   * `store.graph.queryNodes(...)` scan, which ALWAYS excludes invalidated
   * rows), re-runs the exact test above via a real child `vitest` process,
   * confirms it goes RED, then restores the fix and confirms GREEN again.
   * This is the strongest form of "has teeth" proof available: it doesn't
   * just assert against today's code, it demonstrates the assertion above
   * actually depends on the fix by breaking the fix and watching the test
   * fail.
   *
   * Guarded behind `RUN_NEGATIVE_CONTROL=1` (default: skipped) because it
   * shells out to a second vitest process (several seconds) AND briefly
   * rewrites `ids.ts` on disk mid-suite (restored in a `finally` no matter
   * what, per AGENTS.md's "a test that mutates a tracked file must restore
   * it even on failure" rule) — appropriate for a one-time verification
   * run, not for every CI invocation of the full suite. The exit codes from
   * the actual run performed while authoring this fix are recorded in the
   * PR/session report; both are asserted below when the flag is set so the
   * proof re-runs on demand rather than only living in prose.
   */
  it.skipIf(!process.env['RUN_NEGATIVE_CONTROL'])(
    'NEGATIVE CONTROL: reverting computeNextHumanId to the pre-fix graph-only scan makes the tombstone test above fail; restoring it passes again',
    () => {
      const original = readFileSync(IDS_TS_PATH, 'utf8');
      const marker = "// BUG-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-SCAN-001: this used to be";
      expect(original).toContain(marker);

      const buggyScanBlock = `  const nodeFilter: NodeFilter = { kind: 'generic', tags: [BACKLOG_ITEM_TAG], namespace: repo, metadata: { family } };
  const { where, params } = buildNodeFilterClause(nodeFilter, false, 'n');
  const { rows } = await store.adapter.executeAll<{ meta: string | null }>(\`SELECT n.meta AS meta FROM node n \${where}\`, params);
  let max = 0;
  for (const row of rows) {
    const meta = parseNodeMeta(row.meta);
    const match = /-(\\d+)$/.exec(meta?.humanId ?? '');
    if (match) max = Math.max(max, Number(match[1]));
  }`;
      // Verbatim pre-fix behavior: queryNodes() ALWAYS excludes invalidated
      // rows (BUG-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-SCAN-001's root cause).
      const revertedScanBlock = `  const existing = await store.graph.queryNodes({
    kind: 'generic',
    tags: [BACKLOG_ITEM_TAG],
    namespace: repo,
    metadata: { family },
  });
  let max = 0;
  for (const node of existing) {
    const meta = node.metadata as Partial<BacklogNodeMeta> | undefined;
    const match = /-(\\d+)$/.exec(meta?.humanId ?? '');
    if (match) max = Math.max(max, Number(match[1]));
  }`;
      expect(original).toContain(buggyScanBlock);
      const reverted = original.replace(buggyScanBlock, revertedScanBlock);
      expect(reverted).not.toBe(original);

      let redExitCode: number | undefined;
      let greenExitCode: number | undefined;
      try {
        writeFileSync(IDS_TS_PATH, reverted);
        redExitCode = runThisSpecFile("never re-mints an id a soft-deleted node in the SAME family still holds");
      } finally {
        // Restored unconditionally — even if the run above throws — so a
        // failing negative control never leaves the repo on the broken
        // variant (AGENTS.md's mandatory finally-restores-on-failure rule).
        writeFileSync(IDS_TS_PATH, original);
        greenExitCode = runThisSpecFile("never re-mints an id a soft-deleted node in the SAME family still holds");
      }

      // The failing condition this proves against: the negative control
      // NOT actually exercising the fix (a test that stays green either way
      // proves nothing).
      expect(redExitCode).not.toBe(0);
      expect(greenExitCode).toBe(0);
    },
    60_000
  );
});

/** Shells out to a real, separate `vitest run` process scoped to exactly one
 *  test name in THIS file, and returns its exit code (never throws on a
 *  non-zero exit — that IS the signal for the "RED" half of the control). */
function runThisSpecFile(testNamePattern: string): number {
  const repoRoot = join(HERE, '..', '..', '..', '..');
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--config', 'entrypoint/backlog/vite.config.ts', '-t', testNamePattern, fileURLToPath(import.meta.url)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 55_000 }
  );
  return result.status ?? 1;
}

describe('fix (B): humanId is enforced unique (partial UNIQUE index) at the store boundary, live rows only', () => {
  it('two LIVE nodes sharing the same (namespace, humanId) are rejected by the store, not silently accepted', async () => {
    const first = await createItemNode(tmp.store, { family: 'BUG-DUPIDX', title: 'first', body: 'b1', repo: REPO });
    expect(first.item.humanId).toBe('BUG-DUPIDX-001');

    // Bypasses allocateHumanIdAndInsert deliberately — proves the guarantee
    // lives at the STORE boundary (a real DB constraint), not merely in
    // application-level code that a future/other write path could skip.
    let threw: unknown;
    try {
      await tmp.store.graph.writeNode(buildNodeContent(REPO, first.item.humanId, 'second', 'b2') + '\n<!-- distinct content -->', {
        kind: 'generic',
        name: buildNodeName(REPO, first.item.humanId) + '-dup',
        summary: 'second',
        tags: [BACKLOG_ITEM_TAG, 'BUG', 'BUG-DUPIDX'],
        namespace: REPO,
        metadata: { humanId: first.item.humanId, family: 'BUG-DUPIDX', title: 'second', body: 'b2', status: 'OPEN', repo: REPO, citations: [], notes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect(String((threw as Error)?.message ?? threw)).toMatch(/UNIQUE constraint failed/i);
  });

  it('after the original is tombstoned, a fresh LIVE node reusing the SAME humanId is allowed (uniqueness scope is live-only, by design)', async () => {
    const first = await createItemNode(tmp.store, { family: 'BUG-REUSE', title: 'first', body: 'b1', repo: REPO });
    await softDeleteItemNode(tmp.store, REPO, first.item.humanId, 'tombstoned for the test');

    let threw: unknown;
    let newId: number | undefined;
    try {
      newId = await tmp.store.graph.writeNode(buildNodeContent(REPO, first.item.humanId, 'reused', 'b2') + '\n<!-- distinct content 2 -->', {
        kind: 'generic',
        name: buildNodeName(REPO, first.item.humanId) + '-reused',
        summary: 'reused',
        tags: [BACKLOG_ITEM_TAG, 'BUG', 'BUG-REUSE'],
        namespace: REPO,
        metadata: { humanId: first.item.humanId, family: 'BUG-REUSE', title: 'reused', body: 'b2', status: 'OPEN', repo: REPO, citations: [], notes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeUndefined();
    expect(newId).toBeDefined();
  });

  it('a DIFFERENT-kind row (e.g. an audit-event-shaped node) carrying the SAME humanId in its metadata is NOT blocked — the index is tag-scoped, matching the real production row that motivated the scope', async () => {
    const item = await createItemNode(tmp.store, { family: 'BUG-AUDITSHAPE', title: 'the item', body: 'b1', repo: REPO });

    let threw: unknown;
    try {
      await tmp.store.graph.writeNode(`audit entry about ${item.item.humanId}\n\n<!-- distinct content 3 -->`, {
        kind: 'generic',
        name: buildNodeName(REPO, item.item.humanId) + '::audit',
        summary: 'audit entry',
        tags: ['backlog-audit-event'],
        namespace: REPO,
        metadata: { humanId: item.item.humanId },
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeUndefined();
  });

  it('a duplicate under a DIFFERENT namespace (repo) is unaffected — the index is namespace-scoped', async () => {
    const item = await createItemNode(tmp.store, { family: 'BUG-NSSCOPE', title: 'the item', body: 'b1', repo: REPO });

    let threw: unknown;
    try {
      await tmp.store.graph.writeNode(buildNodeContent('some/other-repo', item.item.humanId, 'other repo item', 'b2') + '\n<!-- distinct content 4 -->', {
        kind: 'generic',
        name: buildNodeName('some/other-repo', item.item.humanId),
        summary: 'other repo item',
        tags: [BACKLOG_ITEM_TAG, 'BUG', 'BUG-NSSCOPE'],
        namespace: 'some/other-repo',
        metadata: { humanId: item.item.humanId, family: 'BUG-NSSCOPE', title: 'other repo item', body: 'b2', status: 'OPEN', repo: 'some/other-repo', citations: [], notes: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeUndefined();
  });
});

describe('atomic concurrent mint: two REAL, SEPARATE store connections to the SAME db file racing for the SAME family', () => {
  let storeB: GraphBacklogStore;

  afterEach(async () => {
    if (storeB) await closeGraphBacklogStore(storeB);
  });

  it('two concurrent createItem calls for the SAME family, from two independent connections, NEVER produce the same id — and both nodes are genuinely persisted', async () => {
    // A genuinely separate `GraphBacklogStore` — its own StoreAdapter
    // instance, its own connection — to the SAME on-disk file `tmp.store`
    // already has open. `.transaction(fn, {mode:'immediate'})` on EACH
    // adapter instance serializes against the OTHER via SQLite's real
    // BEGIN IMMEDIATE file lock (verified: `@adhd/sox-store-adapter`'s
    // in-process `_withTxLock` mutex is scoped to a single adapter INSTANCE,
    // not the file — see ids.ts's own doc comments on why this file's
    // sibling `concurrency-scale.spec.ts` instead uses separate
    // worker_threads: that spec's goal is proving the SAME thing across
    // genuinely separate OS-level participants, which two connections in
    // one process do not need to demonstrate the SQL-level guarantee below).
    storeB = await openGraphBacklogStore(tmp.dbPath);

    // `createItemNode` (not a raw `allocateHumanIdAndInsert` call with a
    // no-op insert) — this drives the REAL write path end to end, the same
    // one a consumer's `createItem` call goes through, so the id AND the
    // persisted node are both proven, not just the id in isolation.
    //
    // No sleep, no Atomics: `Promise.all` invokes both async functions
    // back-to-back, synchronously, before either can resolve its first
    // await — so by construction BOTH calls are genuinely in flight (one's
    // `.immediate()` transaction already dispatched) before either commits.
    // Whichever wins the real SQLite write-lock proceeds; the other is a
    // real busy/locked bounce that `withImmediateRetry` retries and
    // re-reads the NOW-committed state — this is the actual mechanism under
    // test, not a simulated one.
    const createA = createItemNode(tmp.store, { family: 'BUG-CONCUR', title: 'writer A', body: 'a', repo: REPO });
    const createB = createItemNode(storeB, { family: 'BUG-CONCUR', title: 'writer B', body: 'b', repo: REPO });

    const [resultA, resultB] = await Promise.all([createA, createB]);
    const idA = resultA.item.humanId;
    const idB = resultB.item.humanId;

    // The failing condition this proves against: idA === idB (a genuine
    // lost-update — the exact shape BUG-BACKLOG-CONCURRENT-ID-ALLOCATION-
    // RACE-001 originally reported, re-verified here under this file's OWN
    // race harness rather than only trusting the sibling spec).
    expect(idA).not.toBe(idB);
    expect(new Set([idA, idB]).size).toBe(2);

    // Both writes genuinely landed — re-read via a THIRD, fresh connection
    // (never either racer's own handle) so this proves real persistence,
    // not one writer's in-process view of its own write.
    const storeC = await openGraphBacklogStore(tmp.dbPath);
    try {
      expect(await findItemNode(storeC, REPO, idA)).not.toBeNull();
      expect(await findItemNode(storeC, REPO, idB)).not.toBeNull();
    } finally {
      await closeGraphBacklogStore(storeC);
    }
  });

  it('5 concurrent createItem calls for the SAME family (one pre-existing tombstoned sibling already in it) all resolve to 5 distinct, never-before-used ids', async () => {
    const tombstoned = await createItemNode(tmp.store, { family: 'BUG-SCALE5', title: 'will be deleted before the race', body: 'x', repo: REPO });
    await softDeleteItemNode(tmp.store, REPO, tombstoned.item.humanId, 'tombstoned before the concurrent mint race');
    expect(tombstoned.item.humanId).toBe('BUG-SCALE5-001');

    storeB = await openGraphBacklogStore(tmp.dbPath);
    // Every connection races on `tmp.store` or `storeB` — 3 concurrent
    // creates share `tmp.store`'s own adapter instance (serialized against
    // each other by that instance's in-process `_withTxLock`, exactly as
    // two agents sharing one process would be) and 2 share `storeB`'s — the
    // cross-instance race (the part that needs a REAL file lock, not just
    // an in-process mutex) still genuinely occurs between the two groups.
    const creates = [
      createItemNode(tmp.store, { family: 'BUG-SCALE5', title: 'w1', body: 'x', repo: REPO }),
      createItemNode(tmp.store, { family: 'BUG-SCALE5', title: 'w2', body: 'x', repo: REPO }),
      createItemNode(tmp.store, { family: 'BUG-SCALE5', title: 'w3', body: 'x', repo: REPO }),
      createItemNode(storeB, { family: 'BUG-SCALE5', title: 'w4', body: 'x', repo: REPO }),
      createItemNode(storeB, { family: 'BUG-SCALE5', title: 'w5', body: 'x', repo: REPO }),
    ];
    const results = await Promise.all(creates);
    const ids = results.map((r) => r.item.humanId);

    expect(new Set(ids).size).toBe(5); // zero duplicate ids among the 5 new mints
    expect(ids).not.toContain(tombstoned.item.humanId); // never re-mints the tombstoned id
    // All 5 must be strictly AFTER -001 (the tombstoned one) — -002..-006 in some order.
    const nums = ids.map((id) => Number(/-(\d+)$/.exec(id)?.[1])).sort((a, b) => a - b);
    expect(nums).toEqual([2, 3, 4, 5, 6]);
  });
});
