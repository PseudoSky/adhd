/**
 * epic-a-backfill.spec.ts — the EPIC-A dimension backfill, proven against a
 * REAL turso-backed store (`openTmpStore`), never a mock. The only
 * monkeypatches in this file are (a) the atomicity negative control's
 * deliberate removal of the transaction and (b) the fork-key negative
 * control's deliberate substitution of the pre-fix, bare-name-only resolver —
 * both restored (or scoped to a single call) so they never leak between
 * tests.
 *
 * PRIOR STATE OF THIS FILE (fixed here): it was written against an imagined
 * API shape that never existed on disk — `epicABackfill`/`verifyEpicABackfill`
 * (the real exports are `runEpicABackfill` and `planEpicABackfill`), a
 * `plan.pending` array (the real field is `plan.items` with a per-item
 * `needsWrite` boolean), an `.action` field on plan items (does not exist),
 * and result/manifest shapes (`linked`/`relinked`/`edgesWritten`/
 * `inRepoDsts`/`itemsRestored`/…) that do not match `IEpicABackfillResult`,
 * `IEpicABackfillBackupManifest`, or `IEpicABackfillRestoreResult` as actually
 * declared in `epic-a-backfill.ts`. 11 of 13 tests failed with `TypeError`.
 * Every assertion below is rewritten against the real exports and real field
 * names, verified by an actual `vitest run` (not by reading the source).
 *
 * The corpus mirrors the shape of the live store this migration is written
 * for: items filed under `adhd` AND `PseudoSky/adhd` (the same project spelled
 * two ways) plus a genuinely third repo, some with a `projectPath` and some
 * without, and items in open, terminal-done, and terminal-dismissed states so
 * "which statuses get backfilled" is answered by the test rather than
 * assumed.
 *
 * What each block proves:
 *
 *  1. DRY RUN WRITES NOTHING — the whole `node` + `edge` tables are captured
 *     before and after and compared byte-for-byte. Not "no items changed":
 *     no ROW changed, so a dry run cannot have minted a dimension node either.
 *  2. THE POST-CONDITION — every item ends with EXACTLY ONE `IN_REPO` edge,
 *     pointing at the repo node its raw string canonicalises to, so both
 *     `adhd` and `PseudoSky/adhd` items share one node and the third repo has
 *     its own. Asserted from raw SQL (the consumer-visible graph), not from
 *     the function's own return value.
 *  3. IDEMPOTENCE — a second run changes no row, writes no backup, and reports
 *     everything as skipped.
 *  4. ATOMICITY UNDER A KILL — failure injected at the seam BETWEEN the
 *     `IN_REPO` write and the `IN_PACKAGE` write, then the store is REOPENED
 *     from disk (a new handle, not the in-process object that did the write):
 *     the killed item has ZERO dimension edges, never one. The NEGATIVE
 *     CONTROL removes the transaction — same injection, same reopen — and the
 *     half-written state DOES appear, so the assertion has teeth.
 *  5. RESUMABILITY — re-running after the kill finishes the remainder and does
 *     NOT rewrite the already-done items, proven by edge `rowid` identity
 *     (a delete+reinsert would allocate new rowids).
 *  6. BACKUP + RESTORE — the manifest exists before the writes, carries its own
 *     restore command, marks completion, is findable when a run dies, and
 *     replays exactly. A backup that cannot be written aborts the run before
 *     ANY item is touched.
 *  7. NEVER IMPLICIT — opening a store, and creating items in it, produces no
 *     dimension node and no dimension edge; and `graph-backlog-store.ts` does
 *     not reference this module at all.
 *  8. FORK-KEY (the rejection's defect (1), fixed by the repo-nodes.ts swap) —
 *     two repositories that share a bare name (`tools`) but disagree on owner
 *     (`alice/tools` vs `bob/tools`) are minted as TWO DISTINCT repo nodes
 *     with un-fused `aliases`, never silently fused into one. A NEGATIVE
 *     CONTROL re-injects the exact pre-fix resolver (bare-name match, no
 *     owner awareness) via the `repoNodes` option and proves it DOES fuse
 *     them — the "this test has teeth" evidence the fix's own assertion
 *     needs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { closeGraphBacklogStore, openGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';
import { createItemNode } from './crud.js';
import { transitionStatusNode } from './lifecycle.js';
import {
  BACKLOG_PACKAGE_TAG,
  BACKLOG_REPO_TAG,
  IN_PACKAGE_REL,
  IN_REPO_REL,
  PROVISIONAL_REPO_NODES_API,
  findIncompleteEpicABackfillBackups,
  planEpicABackfill,
  restoreEpicABackfillBackup,
  runEpicABackfill,
  type IEpicABackfillBackupManifest,
  type IEpicABackfillPlan,
  type IRepoNodesApi,
} from './epic-a-backfill.js';
import { BACKLOG_DIMENSION_KIND, BACKLOG_DIMENSION_NAMESPACE, listPackageNodes, listRepositoryNodes } from './repo-nodes.js';

interface SeedSpec {
  family: string;
  repo: string;
  projectPath?: string;
  /** The canonical repo key this item must end up edged to. */
  expectRepoKey: string;
}

const SEEDS: SeedSpec[] = [
  { family: 'BUG-ALPHA', repo: 'adhd', projectPath: 'entrypoint/backlog', expectRepoKey: 'adhd' },
  { family: 'BUG-BETA', repo: 'adhd', expectRepoKey: 'adhd' },
  { family: 'FEAT-GAMMA', repo: 'PseudoSky/adhd', projectPath: 'packages/apigen/apigen-core-client', expectRepoKey: 'adhd' },
  { family: 'FEAT-DELTA', repo: 'PseudoSky/adhd', expectRepoKey: 'adhd' },
  { family: 'DEBT-EPSILON', repo: 'sox-ecosystem', projectPath: 'libs/data/graph/graph-store', expectRepoKey: 'sox-ecosystem' },
  { family: 'DEBT-ZETA', repo: 'sox-ecosystem', expectRepoKey: 'sox-ecosystem' },
];

interface SeededItem extends SeedSpec {
  nodeId: number;
  humanId: string;
}

let tmp: TmpStore;
let backupDir: string;
let seeded: SeededItem[];

/**
 * Seeds the corpus. `force: true` skips the filing-time dedupe scan so seeding
 * is deterministic and independent of FTS behaviour — this file is about the
 * migration, not about `createItemNode`'s dedupe gate.
 */
async function seedCorpus(store: GraphBacklogStore): Promise<SeededItem[]> {
  const out: SeededItem[] = [];
  for (const spec of SEEDS) {
    const outcome = await createItemNode(store, {
      family: spec.family,
      title: `${spec.family} seed item in ${spec.repo}`,
      body: `Seeded for the EPIC-A dimension backfill spec (${spec.family}).`,
      repo: spec.repo,
      projectPath: spec.projectPath,
      force: true,
    });
    expect(outcome.created).toBe(true);
    out.push({ ...spec, nodeId: outcome.item.nodeId, humanId: outcome.item.humanId });
  }

  // Statuses across the lifecycle: an open item, a terminal-done item (needs a
  // citation), and a terminal-dismissed item (needs a reason). A backfill that
  // only reached OPEN items would leave most of a real corpus unlinked.
  const done = out.find((i) => i.family === 'BUG-BETA')!;
  await transitionStatusNode(store, done.repo, done.humanId, 'RESOLVED', {
    by: 'epic-a-backfill-spec',
    citations: [{ file: 'entrypoint/backlog/src/store/epic-a-backfill.ts' }],
  });
  const dismissed = out.find((i) => i.family === 'FEAT-DELTA')!;
  await transitionStatusNode(store, dismissed.repo, dismissed.humanId, 'WONTFIX', {
    by: 'epic-a-backfill-spec',
    reason: 'seeded as a terminal-dismissed item for the backfill spec',
  });
  return out;
}

/** Whole-table fingerprint. Any write anywhere in the graph changes this string. */
async function tableFingerprint(store: GraphBacklogStore): Promise<string> {
  const edges = await store.adapter.executeAll(
    `SELECT rowid, src, dst, rel, weight, origin, meta, t_created, t_valid, t_invalid FROM edge ORDER BY rowid`
  );
  const nodes = await store.adapter.executeAll(
    `SELECT rowid, uid, kind, name, summary, tags, namespace, meta, content, content_hash, t_invalid, is_superseded FROM node ORDER BY rowid`
  );
  return JSON.stringify({ edges: edges.rows, nodes: nodes.rows });
}

interface DimEdgeRow {
  rowid: number;
  rel: string;
  dst: number;
}

async function dimensionEdges(store: GraphBacklogStore, nodeId: number): Promise<DimEdgeRow[]> {
  const { rows } = await store.adapter.executeAll<DimEdgeRow>(
    `SELECT rowid, rel, dst FROM edge WHERE src = ? AND t_invalid IS NULL AND rel IN (?, ?) ORDER BY rel, dst`,
    [nodeId, IN_REPO_REL, IN_PACKAGE_REL]
  );
  return rows.map((r) => ({ rowid: Number(r.rowid), rel: String(r.rel), dst: Number(r.dst) }));
}

async function canonicalKeyOfNode(store: GraphBacklogStore, nodeId: number): Promise<string> {
  const node = await store.graph.getNode(nodeId);
  const meta = (node?.metadata ?? {}) as { canonicalKey?: string };
  return meta.canonicalKey ?? node?.name ?? '';
}

async function aliasesOfNode(store: GraphBacklogStore, nodeId: number): Promise<string[]> {
  const node = await store.graph.getNode(nodeId);
  const meta = (node?.metadata ?? {}) as { aliases?: unknown };
  return Array.isArray(meta.aliases) ? meta.aliases.filter((a): a is string => typeof a === 'string') : [];
}

async function countTagged(store: GraphBacklogStore, tag: string): Promise<number> {
  const nodes = await store.graph.queryNodes({ kind: 'entity', tags: [tag] });
  return nodes.filter((n) => !n.isSuperseded).length;
}

/** Every plan item the run would still have to write, in the SAME order `runEpicABackfill` writes them in. */
async function pendingItems(store: GraphBacklogStore): Promise<IEpicABackfillPlan['items']> {
  const plan = await planEpicABackfill(store);
  return plan.items.filter((i) => i.needsWrite);
}

/** Opens a SECOND, independent handle against the same on-disk file. */
async function withReopenedStore<T>(dbPath: string, fn: (store: GraphBacklogStore) => Promise<T>): Promise<T> {
  const reopened = await openGraphBacklogStore(dbPath);
  try {
    return await fn(reopened);
  } finally {
    await closeGraphBacklogStore(reopened);
  }
}

/**
 * THE assertion the atomicity guarantee lives or dies by: an item is either
 * fully linked or not linked at all. It must never be found holding an
 * `IN_REPO` edge with its `IN_PACKAGE` edge missing.
 *
 * Returns nothing and throws (via `expect`) on a half-write — so the negative
 * control can call this exact function and prove it goes red.
 */
async function assertNeverHalfWritten(store: GraphBacklogStore, item: SeededItem): Promise<void> {
  const edges = await dimensionEdges(store, item.nodeId);
  const repoEdges = edges.filter((e) => e.rel === IN_REPO_REL);
  const pkgEdges = edges.filter((e) => e.rel === IN_PACKAGE_REL);
  const expectedPkgCount = item.projectPath ? 1 : 0;
  if (repoEdges.length === 0) {
    // Fully un-linked: the correct rolled-back state.
    expect(pkgEdges.length).toBe(0);
    return;
  }
  // Linked: then it must be COMPLETELY linked.
  expect(repoEdges.length).toBe(1);
  expect(pkgEdges.length).toBe(expectedPkgCount);
}

beforeEach(async () => {
  tmp = await openTmpStore('epic-a-backfill');
  backupDir = join(tmp.dir, 'epic-a-backfill-backups');
  seeded = await seedCorpus(tmp.store);
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------

describe('runEpicABackfill — dry run', () => {
  it('reports exactly what it would do and writes nothing at all', async () => {
    const before = await tableFingerprint(tmp.store);

    const result = await runEpicABackfill(tmp.store, { dryRun: true, backupDir });

    const after = await tableFingerprint(tmp.store);
    // Not "no items changed" — NO ROW ANYWHERE changed. A dry run that minted
    // a dimension node as a side effect would fail here.
    expect(after).toBe(before);

    expect(result.dryRun).toBe(true);
    expect(result.itemsWritten).toBe(0);
    expect(result.itemsSkipped).toBe(SEEDS.length);
    expect(result.staleEdgesRemoved).toBe(0);
    expect(result.backupPath).toBeUndefined();
    // Two canonical repos out of three spellings — that IS the AC-7 fix.
    expect([...result.plan.repoKeysToCreate].sort()).toEqual(['adhd', 'sox-ecosystem']);
    expect(result.plan.packageKeysToCreate.length).toBe(SEEDS.filter((s) => s.projectPath).length);
    expect(result.plan.itemsNeedingWrite).toBe(SEEDS.length);
    expect(result.plan.itemsAlreadyLinked).toBe(0);

    // And nothing was created: zero dimension nodes exist after a dry run.
    expect(await countTagged(tmp.store, BACKLOG_REPO_TAG)).toBe(0);
    expect(await countTagged(tmp.store, BACKLOG_PACKAGE_TAG)).toBe(0);
  });

  it('an omitted dryRun is REFUSED — it never silently defaults to a writing run', async () => {
    // The footgun this spec previously documented: `options.dryRun === true`
    // meant ANY omission performed the real, whole-store migration, so a
    // caller that simply forgot the flag rewrote every item. `dryRun` is now
    // required by the type AND guarded at runtime, because an `as` cast (as
    // used here) or a plain JS caller bypasses the type entirely.
    //
    // Asserted through the store, not just the thrown error: the refusal has
    // to happen BEFORE any write, so the fingerprint must be untouched.
    const before = await tableFingerprint(tmp.store);
    await expect(
      runEpicABackfill(tmp.store, { backupDir } as unknown as { dryRun: boolean; backupDir: string })
    ).rejects.toThrow(/explicit dryRun boolean/);
    expect(await tableFingerprint(tmp.store)).toBe(before);
  });

  it('a non-boolean dryRun is REFUSED rather than coerced', async () => {
    // `dryRun: 'false'` (a string, e.g. straight off argv or a JSON config)
    // is truthy. Under a `=== true` test it would have been treated as a REAL
    // run — the precise inversion of what the caller wrote.
    const before = await tableFingerprint(tmp.store);
    await expect(
      runEpicABackfill(tmp.store, { dryRun: 'false', backupDir } as unknown as { dryRun: boolean; backupDir: string })
    ).rejects.toThrow(/explicit dryRun boolean/);
    expect(await tableFingerprint(tmp.store)).toBe(before);
  });
});

describe('runEpicABackfill — the post-condition', () => {
  it('gives every item exactly one IN_REPO edge to the right canonical repo node', async () => {
    const result = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(result.itemsWritten).toBe(SEEDS.length);
    expect(result.itemsSkipped).toBe(0);

    const repoNodeIdByExpectedKey = new Map<string, number>();
    for (const item of seeded) {
      const edges = await dimensionEdges(tmp.store, item.nodeId);
      const repoEdges = edges.filter((e) => e.rel === IN_REPO_REL);
      expect(repoEdges.length, `${item.humanId} must have exactly one IN_REPO edge`).toBe(1);

      const key = await canonicalKeyOfNode(tmp.store, repoEdges[0].dst);
      expect(key, `${item.humanId} (filed under ${item.repo}) must be edged to its canonical repo node`).toBe(item.expectRepoKey);

      const seen = repoNodeIdByExpectedKey.get(item.expectRepoKey);
      if (seen === undefined) repoNodeIdByExpectedKey.set(item.expectRepoKey, repoEdges[0].dst);
      // Every item that canonicalises to the same key must land on the SAME
      // node id — this is the whole AC-7 reconciliation, asserted structurally.
      else expect(repoEdges[0].dst).toBe(seen);

      const pkgEdges = edges.filter((e) => e.rel === IN_PACKAGE_REL);
      expect(pkgEdges.length, `${item.humanId} IN_PACKAGE edge count`).toBe(item.projectPath ? 1 : 0);
    }

    // `adhd` and `PseudoSky/adhd` are ONE node; `sox-ecosystem` is a different one.
    expect(repoNodeIdByExpectedKey.size).toBe(2);
    expect(repoNodeIdByExpectedKey.get('adhd')).not.toBe(repoNodeIdByExpectedKey.get('sox-ecosystem'));
    expect(await countTagged(tmp.store, BACKLOG_REPO_TAG)).toBe(2);

    // "Verified" = a fresh plan finds nothing left to write.
    expect(await pendingItems(tmp.store)).toEqual([]);
  });

  it('repairs an item carrying duplicate or wrong IN_REPO edges instead of adding a third', async () => {
    await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    const victim = seeded[0];
    const wrongTargetId = seeded[5].nodeId; // any other node — a bogus dst

    const now = new Date().toISOString();
    await tmp.store.adapter.executeRun(
      `INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created, t_valid)
       VALUES (?, ?, ?, 1.0, 'user_asserted', NULL, ?, ?)`,
      [victim.nodeId, wrongTargetId, IN_REPO_REL, now, now]
    );
    expect((await dimensionEdges(tmp.store, victim.nodeId)).filter((e) => e.rel === IN_REPO_REL).length).toBe(2);

    const plan = await planEpicABackfill(tmp.store);
    const victimPlanItem = plan.items.find((i) => i.nodeId === victim.nodeId);
    expect(victimPlanItem?.needsWrite).toBe(true);
    expect(victimPlanItem?.staleEdgeCount).toBeGreaterThan(0);

    const result = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(result.itemsWritten).toBe(1);
    expect(result.staleEdgesRemoved).toBeGreaterThan(0);

    const after = (await dimensionEdges(tmp.store, victim.nodeId)).filter((e) => e.rel === IN_REPO_REL);
    expect(after.length).toBe(1);
    expect(await canonicalKeyOfNode(tmp.store, after[0].dst)).toBe(victim.expectRepoKey);
    expect(await pendingItems(tmp.store)).toEqual([]);
  });
});

describe('runEpicABackfill — idempotence', () => {
  it('is a provable no-op the second time: no row changes, no backup, everything skipped', async () => {
    const first = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(first.itemsWritten).toBe(SEEDS.length);
    const backupsAfterFirst = (await findIncompleteEpicABackfillBackups(backupDir)).length;

    const fingerprintAfterFirst = await tableFingerprint(tmp.store);

    const second = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });

    expect(await tableFingerprint(tmp.store)).toBe(fingerprintAfterFirst);
    expect(second.itemsWritten).toBe(0);
    expect(second.itemsSkipped).toBe(SEEDS.length);
    expect(second.staleEdgesRemoved).toBe(0);
    // DEBT-BACKLOG-EPICA-001 (a), fixed: the backup gate is
    // `itemsNeedingWrite > 0`, not `plan.items.length > 0` (every live item,
    // whether or not it needs a write). A true no-op run — everything
    // already correctly dimensioned — writes NO manifest at all, so an
    // operator re-running the backfill does not fill their incident
    // directory with zero-work snapshots.
    expect(second.backupPath).toBeUndefined();
    expect((await findIncompleteEpicABackfillBackups(backupDir)).length).toBe(backupsAfterFirst);
    expect(await pendingItems(tmp.store)).toEqual([]);
  });
});

describe('runEpicABackfill — apply consumes the reported plan (DEBT-BACKLOG-EPICA-001 (b))', () => {
  it('a plan that still matches the live store is accepted and applies exactly as reported', async () => {
    const reported = await planEpicABackfill(tmp.store, {});
    expect(reported.itemsNeedingWrite).toBe(SEEDS.length);

    const result = await runEpicABackfill(tmp.store, { dryRun: false, backupDir, plan: reported });
    expect(result.itemsWritten).toBe(SEEDS.length);
    expect(await pendingItems(tmp.store)).toEqual([]);
  });

  it('REFUSES to apply a stale plan when the store changed since it was computed — no write happens at all', async () => {
    const reported = await planEpicABackfill(tmp.store, {});
    expect(reported.itemsNeedingWrite).toBeGreaterThan(0);

    // Store changes: a new item lands after the plan was taken, and it is
    // NOT reflected in `reported`.
    const extra = await createItemNode(tmp.store, {
      family: 'BUG-DRIFT',
      title: 'filed after the plan was taken',
      body: 'DEBT-BACKLOG-EPICA-001 (b) drift-detection fixture.',
      repo: 'adhd',
      force: true,
    });
    expect(extra.created).toBe(true);

    const fingerprintBefore = await tableFingerprint(tmp.store);
    await expect(runEpicABackfill(tmp.store, { dryRun: false, backupDir, plan: reported })).rejects.toThrow(
      /store changed since the supplied plan|is new since the reported plan/
    );
    // Refused BEFORE any write — not even the backup manifest.
    expect(await tableFingerprint(tmp.store)).toBe(fingerprintBefore);
    expect((await findIncompleteEpicABackfillBackups(backupDir)).length).toBe(0);
  });

  it('REFUSES when an item the plan reported has since been repaired by another process (drift the other direction)', async () => {
    const reported = await planEpicABackfill(tmp.store, {});
    expect(reported.itemsNeedingWrite).toBe(SEEDS.length);

    // Someone else runs the real backfill first — the store is now fully
    // dimensioned, but `reported` still describes the OLD, unlinked state.
    const firstRun = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(firstRun.itemsWritten).toBe(SEEDS.length);

    await expect(runEpicABackfill(tmp.store, { dryRun: false, backupDir, plan: reported })).rejects.toThrow(
      /store changed since the supplied plan/
    );
  });

  it('NEGATIVE CONTROL — omitting `plan` entirely applies the live state with no drift check at all (proves the check above has teeth)', async () => {
    const reported = await planEpicABackfill(tmp.store, {});
    await createItemNode(tmp.store, {
      family: 'BUG-DRIFT-NEGCTRL',
      title: 'filed after the plan was taken, but plan is never passed this time',
      body: 'DEBT-BACKLOG-EPICA-001 (b) negative control.',
      repo: 'adhd',
      force: true,
    });
    // No `plan` option this time — the exact same drift exists, but with
    // nothing to diff against there is nothing to refuse.
    const result = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(result.itemsWritten).toBe(reported.itemsNeedingWrite + 1);
  });
});

describe('runEpicABackfill — killed mid-run', () => {
  /** The first pending item that (a) is not the very first and (b) has a package edge, so the seam is between two real writes. */
  async function killIndex(pending: IEpicABackfillPlan['items']): Promise<number> {
    const idx = pending.findIndex((item, i) => i > 0 && item.projectPath !== undefined);
    expect(idx, 'the corpus must contain a non-first pending item with a projectPath').toBeGreaterThan(0);
    return idx;
  }

  it('leaves NO half-written item — verified after reopening the store from disk', async () => {
    const pending = await pendingItems(tmp.store);
    const idx = await killIndex(pending);
    const victimNodeId = pending[idx].nodeId;
    const victim = seeded.find((s) => s.nodeId === victimNodeId)!;
    const committed = pending.slice(0, idx).map((p) => seeded.find((s) => s.nodeId === p.nodeId)!);
    const untouched = pending.slice(idx + 1).map((p) => seeded.find((s) => s.nodeId === p.nodeId)!);

    await expect(
      runEpicABackfill(tmp.store, {
        dryRun: false,
        backupDir,
        // Deterministic: an exact seam at an exact item index. No timers.
        onAfterRepoEdgeWrite: (ctx) => {
          if (ctx.index === idx) throw new Error('injected kill: after-repo-edge');
        },
      })
    ).rejects.toThrow(/injected kill/);

    await withReopenedStore(tmp.dbPath, async (reopened) => {
      // The killed item rolled back completely.
      expect(await dimensionEdges(reopened, victim.nodeId)).toEqual([]);
      await assertNeverHalfWritten(reopened, victim);
      // Items committed before the kill survived it.
      for (const item of committed) {
        const edges = await dimensionEdges(reopened, item.nodeId);
        expect(edges.filter((e) => e.rel === IN_REPO_REL).length).toBe(1);
        await assertNeverHalfWritten(reopened, item);
      }
      // Items after the kill were never started.
      for (const item of untouched) expect(await dimensionEdges(reopened, item.nodeId)).toEqual([]);
    });
  });

  it('NEGATIVE CONTROL — with the transaction removed, the same kill DOES leave a half-written item', async () => {
    const pending = await pendingItems(tmp.store);
    const idx = await killIndex(pending);
    const victimNodeId = pending[idx].nodeId;
    const victim = seeded.find((s) => s.nodeId === victimNodeId)!;
    expect(victim.projectPath, 'the negative control needs an item with two edge writes').toBeDefined();

    const adapter = tmp.store.adapter as unknown as Record<string, unknown>;
    const realTransaction = adapter.transaction as (...args: unknown[]) => unknown;
    // Autocommit: invoke the transactional body with a tx-shaped object that
    // issues each statement directly, with no surrounding BEGIN/COMMIT/ROLLBACK.
    // This is EXACTLY the pre-fix shape BUG-BACKLOG-REPO-MIGRATION-NON-ATOMIC-001
    // describes, applied to this module.
    adapter.transaction = async <T>(fn: (tx: unknown) => T | Promise<T>): Promise<T> =>
      fn({
        executeRun: (sql: string, args?: unknown[]) => tmp.store.adapter.executeRun(sql, args),
        executeGet: (sql: string, args?: unknown[]) => tmp.store.adapter.executeGet(sql, args),
        executeAll: (sql: string, args?: unknown[]) => tmp.store.adapter.executeAll(sql, args),
        exec: (sql: string) => tmp.store.adapter.exec(sql),
      });

    let halfWriteDetected = false;
    try {
      await expect(
        runEpicABackfill(tmp.store, {
          dryRun: false,
          backupDir,
          onAfterRepoEdgeWrite: (ctx) => {
            if (ctx.index === idx) throw new Error('injected kill: after-repo-edge');
          },
        })
      ).rejects.toThrow(/injected kill/);

      await withReopenedStore(tmp.dbPath, async (reopened) => {
        const edges = await dimensionEdges(reopened, victim.nodeId);
        // The half-written state, stated positively: IN_REPO present, IN_PACKAGE missing.
        expect(edges.filter((e) => e.rel === IN_REPO_REL).length).toBe(1);
        expect(edges.filter((e) => e.rel === IN_PACKAGE_REL).length).toBe(0);

        // And the SAME assertion the positive test relies on now FAILS —
        // which is what "the test has teeth" means. Caught here so the suite
        // stays green while proving the red.
        try {
          await assertNeverHalfWritten(reopened, victim);
        } catch {
          halfWriteDetected = true;
        }
      });
    } finally {
      adapter.transaction = realTransaction;
    }

    expect(halfWriteDetected, 'assertNeverHalfWritten must reject the un-transacted outcome').toBe(true);
  });
});

describe('runEpicABackfill — resumability', () => {
  it('restarts cleanly after a kill and does not rewrite what already landed', async () => {
    const pending = await pendingItems(tmp.store);
    const idx = pending.findIndex((item, i) => i > 0 && item.projectPath !== undefined);
    const committedIds = pending.slice(0, idx).map((p) => p.nodeId);

    await expect(
      runEpicABackfill(tmp.store, {
        dryRun: false,
        backupDir,
        onAfterRepoEdgeWrite: (ctx) => {
          if (ctx.index === idx) throw new Error('injected kill: after-repo-edge');
        },
      })
    ).rejects.toThrow(/injected kill/);

    // An interrupted run is DETECTABLE from the filesystem alone.
    const incomplete = await findIncompleteEpicABackfillBackups(backupDir);
    expect(incomplete.length).toBe(1);
    expect(incomplete[0].completedAt).toBeUndefined();

    // Edge identity of what already landed, so a rewrite would be visible:
    // delete+reinsert allocates a NEW rowid, an untouched edge keeps its old one.
    const rowidsBefore = new Map<number, number[]>();
    for (const nodeId of committedIds) rowidsBefore.set(nodeId, (await dimensionEdges(tmp.store, nodeId)).map((e) => e.rowid));

    const resumed = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });

    // Already-done items are skipped, not re-linked: no double-write.
    expect(resumed.itemsSkipped).toBe(committedIds.length);
    expect(resumed.itemsWritten).toBe(SEEDS.length - committedIds.length);
    for (const nodeId of committedIds) {
      expect((await dimensionEdges(tmp.store, nodeId)).map((e) => e.rowid)).toEqual(rowidsBefore.get(nodeId));
    }

    // And the corpus is now fully and correctly linked.
    expect(await pendingItems(tmp.store)).toEqual([]);
    for (const item of seeded) await assertNeverHalfWritten(tmp.store, item);
  });
});

describe('runEpicABackfill — backup and restore', () => {
  it('writes a manifest before any write, carrying its own restore command, and marks completion', async () => {
    const result = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(result.backupPath).toBeDefined();

    const manifest = JSON.parse(readFileSync(result.backupPath as string, 'utf8')) as IEpicABackfillBackupManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.items.length).toBe(SEEDS.length);
    // Pre-run state: nothing was linked yet, and that is what the manifest holds.
    for (const item of manifest.items) {
      expect(item.inRepo).toEqual([]);
      expect(item.inPackage).toEqual([]);
    }
    // No dimension node existed before the run, so a rollback may invalidate
    // every one this run minted.
    expect(manifest.dimensionNodeIdsBefore).toEqual([]);
    // No repository node existed before the run either, so there is nothing
    // to snapshot on the alias axis yet.
    expect(manifest.repositoriesBefore ?? []).toEqual([]);
    // The documented restore command is IN the manifest — an operator holding
    // only this file has the recovery step in hand.
    expect(manifest.restoreCommand).toContain('restoreEpicABackfillBackup');
    expect(manifest.restoreCommand).toContain(result.backupPath as string);
    expect(manifest.completedAt).toBeDefined();
    expect(manifest.resultSummary).toEqual({
      itemsWritten: SEEDS.length,
      itemsSkipped: 0,
      staleEdgesRemoved: 0,
      repoNodesCreated: 2,
      packageNodesCreated: SEEDS.filter((s) => s.projectPath).length,
    });
    expect(await findIncompleteEpicABackfillBackups(backupDir)).toEqual([]);
  });

  it('restores the store to its exact pre-run state, verified after a reopen', async () => {
    const before = await tableFingerprint(tmp.store);
    const result = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(await tableFingerprint(tmp.store)).not.toBe(before);

    const restore = await restoreEpicABackfillBackup(tmp.store, result.backupPath as string);
    expect(restore.succeeded).toBe(SEEDS.length);
    expect(restore.failed).toBe(0);
    expect(restore.results.every((r) => r.ok)).toBe(true);
    // Every dimension node this run minted is gone again.
    expect(restore.dimensionNodesInvalidated.length).toBe(result.repoNodesCreated.length + result.packageNodesCreated.length);
    // Nothing to revert on the alias axis — no repo node existed before this run.
    expect(restore.repositoryAliasesRestored).toEqual([]);

    await withReopenedStore(tmp.dbPath, async (reopened) => {
      for (const item of seeded) expect(await dimensionEdges(reopened, item.nodeId)).toEqual([]);
      expect(await countTagged(reopened, BACKLOG_REPO_TAG)).toBe(0);
      expect(await countTagged(reopened, BACKLOG_PACKAGE_TAG)).toBe(0);
    });
  });

  it('reverts an alias fold onto a PRE-EXISTING repo node (the manifest-alias gap fix)', async () => {
    // First run links the whole corpus. `sox-ecosystem` is addressed ONLY by
    // its bare name in the seed corpus, so it mints with an EMPTY alias list
    // (GRAPH_MODEL §3: a bare input records no alias, only the canonical key).
    const first = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(first.backupPath).toBeDefined();

    // A SECOND, later item addresses the SAME repo by a QUALIFIED spelling
    // that shares its bare name but was never seen before. `decideRepository`
    // folds it into the pre-existing (unowned) node rather than minting a new
    // one — this fold happens onto a node that existed BEFORE the second
    // run's own backup was taken, which is exactly the case the
    // manifest-alias gap left unrecoverable.
    const extra = await createItemNode(tmp.store, {
      family: 'BUG-EXTRA',
      title: 'extra seed for a fresh alias spelling',
      body: 'seeded to exercise a second-run alias fold onto a pre-existing repo node',
      repo: 'someorg/sox-ecosystem',
      force: true,
    });

    const soxNodeId = (await listRepositoryNodes(tmp.store)).find((r) => r.canonicalKey === 'sox-ecosystem')!.nodeId;
    const aliasesBeforeSecondRun = await aliasesOfNode(tmp.store, soxNodeId);
    expect(aliasesBeforeSecondRun).not.toContain('someorg/sox-ecosystem');

    // A SECOND pre-existing repo node (`adhd`) that this run never touches at
    // all. It sits in `manifest.repositoriesBefore` for no reason other than
    // the fixed-format loop in `restoreEpicABackfillBackup` visiting every
    // entry — so it is the exact node an unconditional wholesale `touch()`
    // would clobber. Snapshot its COMPLETE raw metadata now, and again after
    // restore, to prove the restore path leaves an untouched node
    // byte-identical rather than merely "aliases still look right."
    const adhdNodeId = (await listRepositoryNodes(tmp.store)).find((r) => r.canonicalKey === 'adhd')!.nodeId;
    const adhdMetaBeforeSecondRun = (await tmp.store.graph.getNode(adhdNodeId))?.metadata;

    const second = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(second.backupPath).toBeDefined();

    const aliasesAfterSecondRun = await aliasesOfNode(tmp.store, soxNodeId);
    expect(aliasesAfterSecondRun).toContain('someorg/sox-ecosystem');

    const manifest = JSON.parse(readFileSync(second.backupPath as string, 'utf8')) as IEpicABackfillBackupManifest;
    const soxSnapshot = (manifest.repositoriesBefore ?? []).find((r) => r.nodeId === soxNodeId);
    expect(soxSnapshot, 'the second run must snapshot the pre-existing sox-ecosystem node before folding the new alias').toBeDefined();
    expect(soxSnapshot?.aliases).toEqual(aliasesBeforeSecondRun);

    const restore = await restoreEpicABackfillBackup(tmp.store, second.backupPath as string);
    expect(restore.repositoryAliasesRestored.some((r) => r.nodeId === soxNodeId && r.ok)).toBe(true);

    // The fold is undone: the alias the second run added is gone again.
    const aliasesAfterRestore = await aliasesOfNode(tmp.store, soxNodeId);
    expect(aliasesAfterRestore).toEqual(aliasesBeforeSecondRun);
    expect(aliasesAfterRestore).not.toContain('someorg/sox-ecosystem');

    // The untouched `adhd` node's metadata is EXACTLY what it was before the
    // restore ran at all — not just "aliases still match" but every field,
    // proving the restore's skip-if-unchanged guard actually fired for it
    // (rather than a wholesale rewrite happening to reproduce the same
    // aliases/canonicalKey while silently dropping some other field).
    const adhdMetaAfterRestore = (await tmp.store.graph.getNode(adhdNodeId))?.metadata;
    expect(adhdMetaAfterRestore).toEqual(adhdMetaBeforeSecondRun);
    expect(restore.repositoryAliasesRestored.find((r) => r.nodeId === adhdNodeId)).toEqual({
      nodeId: adhdNodeId,
      canonicalKey: 'adhd',
      ok: true,
    });

    // And the extra item's own edges were restored to their (empty) pre-run state.
    expect(await dimensionEdges(tmp.store, extra.item.nodeId)).toEqual([]);
  });

  it('fails CLOSED when the backup cannot be written — not one item is touched', async () => {
    // A path that cannot become a directory (its parent is a regular file).
    const blocked = join(tmp.dbPath, 'not-a-directory', 'backups');
    const before = await tableFingerprint(tmp.store);

    await expect(runEpicABackfill(tmp.store, { dryRun: false, backupDir: blocked })).rejects.toThrow();

    expect(await tableFingerprint(tmp.store)).toBe(before);
    expect(await countTagged(tmp.store, BACKLOG_REPO_TAG)).toBe(0);
    for (const item of seeded) expect(await dimensionEdges(tmp.store, item.nodeId)).toEqual([]);
  });
});

describe('runEpicABackfill — never runs implicitly', () => {
  it('opening a store and creating items produces no dimension node and no dimension edge', async () => {
    // `beforeEach` already opened a store and created six items through the
    // ordinary write path. If anything wired this migration into store open —
    // or into `createItemNode` — it would show up right here.
    expect(await countTagged(tmp.store, BACKLOG_REPO_TAG)).toBe(0);
    expect(await countTagged(tmp.store, BACKLOG_PACKAGE_TAG)).toBe(0);
    for (const item of seeded) expect(await dimensionEdges(tmp.store, item.nodeId)).toEqual([]);

    // And a reopen does not trigger it either.
    await withReopenedStore(tmp.dbPath, async (reopened) => {
      expect(await countTagged(reopened, BACKLOG_REPO_TAG)).toBe(0);
      const { rows } = await reopened.adapter.executeAll(`SELECT COUNT(*) AS n FROM edge WHERE rel IN (?, ?)`, [
        IN_REPO_REL,
        IN_PACKAGE_REL,
      ]);
      expect(Number((rows[0] as { n: number }).n)).toBe(0);
    });
  });

  it('graph-backlog-store.ts does not reference this module', () => {
    // Structural guard: the store-open path must never gain an import of the
    // migration. A future agent wiring it in turns this red immediately.
    const source = readFileSync(new URL('./graph-backlog-store.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('epic-a-backfill');
  });
});

// ---------------------------------------------------------------------------
// Fork-key: the rejection's defect (1). Fixed by routing `PROVISIONAL_REPO_
// NODES_API` through `store/repo-nodes.ts`'s owner-aware `decideRepository`
// instead of `model.ts`'s bare-name-only `resolveRepositoryNode`.
// ---------------------------------------------------------------------------

describe('runEpicABackfill — fork-key: two owners sharing a bare name never fuse', () => {
  async function seedForkPair(store: GraphBacklogStore): Promise<{ alice: SeededItem; bob: SeededItem }> {
    const aliceOutcome = await createItemNode(store, {
      family: 'BUG-ALICEFORK',
      title: 'alice/tools fork-key seed',
      body: 'seeded to prove two repos sharing a bare name but disagreeing on owner never fuse',
      repo: 'alice/tools',
      force: true,
    });
    const bobOutcome = await createItemNode(store, {
      family: 'BUG-BOBFORK',
      title: 'bob/tools fork-key seed',
      body: 'seeded to prove two repos sharing a bare name but disagreeing on owner never fuse',
      repo: 'bob/tools',
      force: true,
    });
    return {
      alice: { family: 'BUG-ALICEFORK', repo: 'alice/tools', expectRepoKey: 'tools', nodeId: aliceOutcome.item.nodeId, humanId: aliceOutcome.item.humanId },
      bob: { family: 'BUG-BOBFORK', repo: 'bob/tools', expectRepoKey: 'bob/tools', nodeId: bobOutcome.item.nodeId, humanId: bobOutcome.item.humanId },
    };
  }

  it('mints TWO distinct repo nodes with un-fused aliases for alice/tools and bob/tools', async () => {
    const { alice, bob } = await seedForkPair(tmp.store);
    const result = await runEpicABackfill(tmp.store, { dryRun: false, backupDir });
    expect(result.itemsWritten).toBeGreaterThanOrEqual(2);

    const aliceRepoEdges = (await dimensionEdges(tmp.store, alice.nodeId)).filter((e) => e.rel === IN_REPO_REL);
    const bobRepoEdges = (await dimensionEdges(tmp.store, bob.nodeId)).filter((e) => e.rel === IN_REPO_REL);
    expect(aliceRepoEdges).toHaveLength(1);
    expect(bobRepoEdges).toHaveLength(1);
    expect(aliceRepoEdges[0].dst, 'alice/tools and bob/tools must NOT resolve to the same repo node').not.toBe(bobRepoEdges[0].dst);

    const aliceAliases = await aliasesOfNode(tmp.store, aliceRepoEdges[0].dst);
    const bobAliases = await aliasesOfNode(tmp.store, bobRepoEdges[0].dst);
    expect(aliceAliases).not.toContain('bob/tools');
    expect(bobAliases).not.toContain('alice/tools');
  });

  it('NEGATIVE CONTROL — the pre-fix bare-name-only resolver DOES fuse them (proves the fix test above has teeth)', async () => {
    const { alice, bob } = await seedForkPair(tmp.store);

    // The exact defect the reviewer rejected, reproduced deliberately: match
    // by bare name alone (no owner awareness at all — mirrors `model.ts`'s
    // `resolveRepositoryNode`) and fold ANY bare-name match's foreign
    // spelling into the winner's `aliases`.
    const unsafeApi: IRepoNodesApi = {
      listRepositoryNodes,
      listPackageNodes,
      packageNodeFor: (store, repoKey, projectPath, opts) => PROVISIONAL_REPO_NODES_API.packageNodeFor(store, repoKey, projectPath, opts),
      async canonicalRepoKeyFor(store, raw, opts = {}) {
        const create = opts.create !== false;
        const trimmed = raw.trim();
        const bareOf = (spelling: string): string => spelling.replace(/\.git$/i, '').split('/').filter(Boolean).pop() ?? spelling;
        const bare = bareOf(trimmed);
        const known = await listRepositoryNodes(store);
        const match = known.find((r) => [r.canonicalKey, ...r.aliases].some((spelling) => bareOf(spelling) === bare));
        if (match) {
          if (create && trimmed !== match.canonicalKey && !match.aliases.includes(trimmed)) {
            await store.adapter.transaction(
              async () => {
                await store.graph.touch(match.nodeId, {
                  metadata: { canonicalKey: match.canonicalKey, aliases: [...match.aliases, trimmed] },
                });
              },
              { mode: 'immediate' }
            );
          }
          return { nodeId: match.nodeId, key: match.canonicalKey, created: false };
        }
        if (!create) return null;
        const nodeId = await store.adapter.transaction(
          () =>
            store.graph.writeNode(`unsafe-fork-key-negative-control: ${bare}\n\n<!-- ${randomUUID()} -->`, {
              kind: BACKLOG_DIMENSION_KIND,
              name: bare,
              summary: `Repository ${bare}`,
              tags: [BACKLOG_REPO_TAG],
              namespace: BACKLOG_DIMENSION_NAMESPACE,
              metadata: { canonicalKey: bare, aliases: trimmed === bare ? [] : [trimmed] },
            }),
          { mode: 'immediate' }
        );
        return { nodeId, key: bare, created: true };
      },
    };

    const result = await runEpicABackfill(tmp.store, { dryRun: false, backupDir, repoNodes: unsafeApi });
    expect(result.itemsWritten).toBeGreaterThanOrEqual(2);

    const aliceRepoEdges = (await dimensionEdges(tmp.store, alice.nodeId)).filter((e) => e.rel === IN_REPO_REL);
    const bobRepoEdges = (await dimensionEdges(tmp.store, bob.nodeId)).filter((e) => e.rel === IN_REPO_REL);
    expect(aliceRepoEdges).toHaveLength(1);
    expect(bobRepoEdges).toHaveLength(1);

    // THE RED, stated positively: under the pre-fix resolver, both land on
    // the SAME node, and the foreign spelling has been folded into its
    // `aliases`. This is the silent false merge the reviewer rejected.
    expect(aliceRepoEdges[0].dst).toBe(bobRepoEdges[0].dst);
    const fusedAliases = await aliasesOfNode(tmp.store, aliceRepoEdges[0].dst);
    expect(fusedAliases).toContain('bob/tools');

    // And the fix test's own assertion, run against THIS (unsafe) outcome,
    // now fails — literal proof the fix test has teeth. Caught here so the
    // suite stays green while proving the red.
    let fixAssertionWentRed = false;
    try {
      expect(aliceRepoEdges[0].dst).not.toBe(bobRepoEdges[0].dst);
    } catch {
      fixAssertionWentRed = true;
    }
    expect(fixAssertionWentRed, 'the fix test`s own assertion must go RED against the pre-fix resolver').toBe(true);
  });
});
