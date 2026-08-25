/**
 * v2/admin.spec.ts - drives every `backlog_admin` action through its REAL
 * seam against a REAL temp store (`openTmpStore` -> `openGraphBacklogStore`,
 * turso substrate, under `tmp/backlog/`), with real `createItemNode` /
 * `transitionStatusNode` / `addDependencyNode` / `softDeleteItemNode` writes.
 * No mocked store, no mocked graph, no stubbed client functions.
 *
 * The two assertions this file exists for - and the two that carry a
 * documented negative control (see the block comment above each) - are:
 *
 * 1. `doctor` counts the citation gap EXACTLY. The live backlog's headline
 *    integrity number is "~65% of items carry no citations"; a report that
 *    cannot produce that number countably is decoration.
 * 2. `doctor` reports a genuinely dangling edge and does NOT fire on a
 *    correctly-executed merge. `SAME_AS`/`SUPERSEDES` point at tombstones BY
 *    DESIGN (store/structure.ts:250-280,144-232), so a naive "endpoint is
 *    invalidated" scan reports every clean merge as corruption - the exact
 *    false-positive class that trains operators to ignore a health report.
 *
 * Determinism: no sleeps and no wall-clock thresholds. Concurrency is proven
 * with a latch, persistence by opening a SECOND connection to the same file,
 * and the one timeout test races a promise that never settles (an outcome no
 * scheduling jitter can flip).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { buildBacklogEnv } from '../env.js';
import type { BacklogCtx } from '../client.js';
import { closeGraphBacklogStore, openGraphBacklogStore } from '../store/graph-backlog-store.js';
import { createItemNode, getItemNode, softDeleteItemNode } from '../store/crud.js';
import { transitionStatusNode } from '../store/lifecycle.js';
import { addDependencyNode, mergeItemsNode } from '../store/structure.js';
import { mutateMetadata } from '../store/mutate-metadata.js';
import { findItemNode } from '../store/query.js';
import type { BacklogNodeMeta } from '../store/mapping.js';
import { exitCodeForEnvelope, isOutcomeError, isOutcomeOk, type IOutcomeEnvelope } from '../model.js';
import {
  adminArchive,
  adminBatch,
  adminDoctor,
  adminExport,
  adminMerge,
  adminPrune,
  adminRender,
  backlogAdmin,
  computeOverlapView,
  type IAdminBatchDispatch,
} from './admin.js';

const REPO = 'PseudoSky/admin-spec';

let tmp: TmpStore;
let ctx: BacklogCtx;
let adhdRoot: string;

beforeEach(async () => {
  tmp = await openTmpStore('v2-admin-spec');
  adhdRoot = mkdtempSync(join(tmpdir(), 'v2-admin-env-'));
  ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'global', adhdRoot }), adhdRoot };
});

afterEach(async () => {
  // `finally`-equivalent: vitest runs afterEach even when the test threw, so a
  // FAILING run still removes the temp store and the isolated adhdRoot
  // (AGENTS.md 10 - a test that leaves artifacts behind is a defect).
  try {
    await tmp.cleanup();
  } finally {
    rmSync(adhdRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Seed helpers - every one of these goes through the real store operations.
// ---------------------------------------------------------------------------

async function seedItem(
  humanId: string,
  opts: { repo?: string; title?: string; citations?: boolean } = {}
): Promise<string> {
  const created = await createItemNode(tmp.store, {
    family: humanId.replace(/-\d+$/, ''),
    idOverride: humanId,
    title: opts.title ?? `item ${humanId}`,
    body: `body of ${humanId}`,
    repo: opts.repo ?? REPO,
    ...(opts.citations ? { citations: [{ file: `src/${humanId}.ts`, lines: '1-2' }] } : {}),
  });
  expect(created.created).toBe(true);
  return created.item.humanId;
}

/** Terminal-done requires a citation (model.ts:75), so this item ends up WITH one. */
async function resolveWithCitation(humanId: string, repo = REPO): Promise<void> {
  await transitionStatusNode(tmp.store, repo, humanId, 'RESOLVED', {
    by: 'tester',
    citations: [{ file: `src/${humanId}.ts` }],
  });
}

/** Terminal-dismissed requires only a reason (model.ts:79) - the legitimate way to reach terminal with ZERO citations. */
async function dismissWithoutCitation(humanId: string, repo = REPO): Promise<void> {
  await transitionStatusNode(tmp.store, repo, humanId, 'WONTFIX', { by: 'tester', reason: 'not doing it' });
}

function expectOk<T>(env: IOutcomeEnvelope<T>): T {
  if (!isOutcomeOk(env)) {
    throw new Error(`expected ok envelope, got ${JSON.stringify(env)}`);
  }
  return env.data;
}

function expectError<T>(env: IOutcomeEnvelope<T>): { code: string; message: string; exit: number } {
  if (!isOutcomeError(env)) {
    throw new Error(`expected error envelope, got ${JSON.stringify(env)}`);
  }
  return { code: env.error.code, message: env.error.message, exit: exitCodeForEnvelope(env) };
}

/** A genuinely fresh connection to the same file - the only honest proof a write is durable. */
async function withReopenedStore<T>(body: (store: TmpStore['store']) => Promise<T>): Promise<T> {
  const reopened = await openGraphBacklogStore(tmp.dbPath);
  try {
    return await body(reopened);
  } finally {
    await closeGraphBacklogStore(reopened);
  }
}

// ===========================================================================
// FEAT-008 - doctor
// ===========================================================================

describe('backlog_admin(doctor) - FEAT-008 integrity report', () => {
  /**
   * NEGATIVE CONTROL 1 (performed, see the task report): replacing the
   * `item.citations.length === 0` predicate in `runDoctor` with `>= 0` (count
   * every item) turns this test RED on both `count` and
   * `missingCitationsPercent`. A report that cannot be wrong about the number
   * is not reporting the number.
   */
  it('counts the citation gap EXACTLY and expresses it as a percentage of the scanned set', async () => {
    for (let i = 0; i < 3; i++) await seedItem(`CITED-00${i + 1}`, { citations: true });
    for (let i = 0; i < 7; i++) await seedItem(`BARE-00${i + 1}`);

    const report = expectOk(await adminDoctor(ctx, { repo: REPO }));

    expect(report.scannedItems).toBe(10);
    expect(report.missingCitations).toHaveLength(7);
    expect(report.missingCitations.map((r) => r.humanId).sort()).toEqual([
      'BARE-001',
      'BARE-002',
      'BARE-003',
      'BARE-004',
      'BARE-005',
      'BARE-006',
      'BARE-007',
    ]);
    expect(report.missingCitationsPercent).toBe(70);

    const check = report.checks.find((c) => c.name === 'missing_citations');
    expect(check).toEqual({ name: 'missing_citations', count: 7, ok: false, sampled: 7, truncated: false });
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(true);
  });

  it('separates "terminal with no evidence" from "no citations at all" - the stronger finding is its own check', async () => {
    await seedItem('OPEN-001'); // open, no citations
    await seedItem('DONE-001');
    await resolveWithCitation('DONE-001'); // terminal WITH a citation
    await seedItem('DROP-001');
    await dismissWithoutCitation('DROP-001'); // terminal, zero citations

    const report = expectOk(await adminDoctor(ctx, { repo: REPO }));

    expect(report.missingCitations.map((r) => r.humanId).sort()).toEqual(['DROP-001', 'OPEN-001']);
    expect(report.terminalWithoutCitations.map((r) => r.humanId)).toEqual(['DROP-001']);
  });

  it('finds two live nodes answering to one (repo, humanId) even when the DB unique index cannot - the namespace-drift duplicate', async () => {
    // The live unique index is keyed on `namespace` (store/ids.ts:117-122), so
    // a node whose `metadata.repo` drifted off its namespace (a half-applied
    // repo migration) is a duplicate the index cannot see - AND is unreachable
    // through `findItemNode`, which queries by namespace.
    await seedItem('DUP-001', { repo: 'legacy-repo', title: 'the stranded copy' });
    await seedItem('DUP-001', { repo: REPO, title: 'the reachable copy' });
    const stranded = await findItemNode(tmp.store, 'legacy-repo', 'DUP-001');
    expect(stranded).not.toBeNull();
    await mutateMetadata<BacklogNodeMeta>(tmp.store, (stranded as { id: number }).id, (meta) => ({ ...meta, repo: REPO }));

    // Consumer-visible symptom first: addressing (REPO, DUP-001) silently
    // resolves to ONE of the two, so the other is invisible to every read.
    const reachable = await findItemNode(tmp.store, REPO, 'DUP-001');
    expect(reachable?.namespace).toBe(REPO);

    const report = expectOk(await adminDoctor(ctx, {}));
    const group = report.duplicateHumanIds.find((g) => g.humanId === 'DUP-001');
    expect(group).toBeDefined();
    expect(group?.repo).toBe(REPO);
    expect(group?.count).toBe(2);
    expect(group?.nodes.map((n) => n.namespace).sort()).toEqual([REPO, 'legacy-repo'].sort());
  });

  /**
   * NEGATIVE CONTROL 2 (performed, see the task report): deleting
   * `SAME_AS`/`SUPERSEDES` from `TOMBSTONE_REFERENCING_RELS` makes
   * `danglingEdges` report 2 instead of 1 - the clean merge below is flagged
   * as corruption - and this test goes RED on both the length and the rel.
   */
  it('reports a real dangling edge and does NOT fire on a correctly-executed merge', async () => {
    await seedItem('EDGE-001');
    await seedItem('EDGE-002');
    await seedItem('KEEP-001');
    await seedItem('MERGE-001');

    // A genuine dangler: a live DEPENDS_ON pointing at a soft-deleted item.
    await addDependencyNode(tmp.store, REPO, 'EDGE-001', 'EDGE-002');
    await softDeleteItemNode(tmp.store, REPO, 'EDGE-002', 'no longer relevant');

    // A clean merge: SAME_AS(drop -> keep) + invalidate(drop). Correct by
    // design, and must NOT show up as corruption.
    await mergeItemsNode(tmp.store, REPO, 'KEEP-001', 'MERGE-001', 'same root cause');

    const report = expectOk(await adminDoctor(ctx, { repo: REPO }));

    expect(report.danglingEdges).toHaveLength(1);
    expect(report.danglingEdges[0].rel).toBe('DEPENDS_ON');
    expect(report.danglingEdges[0].broken).toEqual([{ endpoint: 'dst', nodeId: expect.any(Number), reason: 'invalidated-node' }]);
    expect(report.checks.find((c) => c.name === 'dangling_edges')?.count).toBe(1);
  });

  it('caps the sample arrays at limitPerCheck while keeping every count exact and flagging the truncation', async () => {
    for (let i = 0; i < 12; i++) await seedItem(`BARE-${String(i + 1).padStart(3, '0')}`);

    const report = expectOk(await adminDoctor(ctx, { repo: REPO, limitPerCheck: 5 }));

    expect(report.missingCitations).toHaveLength(5);
    const check = report.checks.find((c) => c.name === 'missing_citations');
    expect(check?.count).toBe(12); // exact, not the sample size
    expect(check?.sampled).toBe(5);
    expect(check?.truncated).toBe(true);
    expect(report.missingCitationsPercent).toBe(100);
  });

  it('a narrowed `checks` list reports what it skipped and refuses to claim completeness', async () => {
    await seedItem('BARE-001');

    const report = expectOk(await adminDoctor(ctx, { repo: REPO, checks: ['missing_citations'] }));

    expect(report.checks.map((c) => c.name)).toEqual(['missing_citations']);
    expect(report.skipped).toContain('dangling_edges');
    expect(report.skipped).toContain('duplicate_human_ids');
    expect(report.complete).toBe(false);
    expect(report.danglingEdges).toEqual([]);
  });

  it('a clean store reports ok, and says out loud that the repo-node check is INERT rather than clean', async () => {
    await seedItem('CLEAN-001', { citations: true });

    const env = await adminDoctor(ctx, { repo: REPO });
    const report = expectOk(env);

    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(isOutcomeOk(env) && env.warnings?.some((w) => w.includes('orphaned_repo_keys check is inert'))).toBe(true);
  });

  it('rejects an unknown check name and an unknown param key by NAME, with exit 2 - never a silent default', async () => {
    const badCheck = expectError(await adminDoctor(ctx, { checks: ['duplicate_human_ids', 'invented_check'] }));
    expect(badCheck.code).toBe('validation');
    expect(badCheck.message).toContain('invented_check');
    expect(badCheck.exit).toBe(2);

    const badKey = expectError(await adminDoctor(ctx, { repoo: REPO } as Record<string, unknown>));
    expect(badKey.code).toBe('validation');
    expect(badKey.message).toContain('repoo');
    expect(badKey.exit).toBe(2);
  });
});

// ===========================================================================
// FEAT-009 - prune
// ===========================================================================

describe('backlog_admin(prune) - FEAT-009 bounded, dry-run-by-default maintenance', () => {
  async function seedArchivedItem(humanId: string): Promise<void> {
    await seedItem(humanId);
    await resolveWithCitation(humanId);
    const confirmed = expectOk(await adminArchive(ctx, { repo: REPO, confirm: true }, 'tester'));
    expect(confirmed.archivedCount).toBeGreaterThan(0);
  }

  it('DEFAULTS to a dry run: it reports every candidate, writes nothing, and says so', async () => {
    await seedArchivedItem('OLD-001');

    const env = await adminPrune(ctx, { repo: REPO, olderThanDays: 0 });
    const report = expectOk(env);

    expect(report.dryRun).toBe(true);
    expect(report.candidateCount).toBe(1);
    expect(report.candidates[0].humanId).toBe('OLD-001');
    expect(report.pruned).toBe(0);
    expect(isOutcomeOk(env) && env.warnings?.some((w) => w.includes('dry run'))).toBe(true);

    // The consumer-visible outcome: the item is STILL THERE, on a fresh
    // connection to the same file.
    const stillLive = await withReopenedStore((store) => getItemNode(store, REPO, 'OLD-001'));
    expect(stillLive).not.toBeNull();
  });

  it('refuses an unattributed destructive run - `confirm: true` without `by` is invalid_argument AND writes nothing', async () => {
    await seedArchivedItem('OLD-001');

    const err = expectError(await adminPrune(ctx, { repo: REPO, olderThanDays: 0, confirm: true }));
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain('by');
    expect(err.exit).toBe(2);

    const stillLive = await withReopenedStore((store) => getItemNode(store, REPO, 'OLD-001'));
    expect(stillLive).not.toBeNull();
  });

  it('with `confirm: true` + `by` it soft-deletes the candidates, durably', async () => {
    await seedArchivedItem('OLD-001');

    const report = expectOk(await adminPrune(ctx, { repo: REPO, olderThanDays: 0, confirm: true }, 'tester'));

    expect(report.dryRun).toBe(false);
    expect(report.pruned).toBe(1);
    expect(report.failures).toEqual([]);

    const gone = await withReopenedStore((store) => getItemNode(store, REPO, 'OLD-001'));
    expect(gone).toBeNull();
  });

  it('honours the olderThanDays window - a freshly archived item is NOT a candidate at the default 90d cutoff', async () => {
    await seedArchivedItem('FRESH-001');

    const wide = expectOk(await adminPrune(ctx, { repo: REPO, olderThanDays: 0 }));
    expect(wide.candidateCount).toBe(1);

    const narrow = expectOk(await adminPrune(ctx, { repo: REPO }));
    expect(narrow.candidateCount).toBe(0);
    expect(narrow.cutoff).toBeDefined();
  });

  it('never prunes a live, unarchived item - only archived terminal ones qualify', async () => {
    await seedItem('LIVE-001');
    await seedItem('DONE-001');
    await resolveWithCitation('DONE-001'); // terminal but NOT archived

    const report = expectOk(await adminPrune(ctx, { repo: REPO, olderThanDays: 0 }));
    expect(report.candidates).toEqual([]);
  });

  it('target "dangling_edges" removes exactly the broken edge, and doctor comes back clean on that check', async () => {
    await seedItem('EDGE-001');
    await seedItem('EDGE-002');
    await addDependencyNode(tmp.store, REPO, 'EDGE-001', 'EDGE-002');
    await softDeleteItemNode(tmp.store, REPO, 'EDGE-002', 'gone');

    const dry = expectOk(await adminPrune(ctx, { repo: REPO, target: 'dangling_edges' }));
    expect(dry.candidateCount).toBe(1);
    expect(dry.candidates[0].kind).toBe('edge');
    expect(dry.pruned).toBe(0);
    expect(expectOk(await adminDoctor(ctx, { repo: REPO, checks: ['dangling_edges'] })).danglingEdges).toHaveLength(1);

    const applied = expectOk(await adminPrune(ctx, { repo: REPO, target: 'dangling_edges', confirm: true }, 'tester'));
    expect(applied.pruned).toBe(1);

    const after = expectOk(await adminDoctor(ctx, { repo: REPO, checks: ['dangling_edges'] }));
    expect(after.danglingEdges).toEqual([]);
    expect(after.checks[0]).toEqual({ name: 'dangling_edges', count: 0, ok: true, sampled: 0, truncated: false });
  });

  it('rejects an unknown target and an unknown param key by name', async () => {
    const badTarget = expectError(await adminPrune(ctx, { target: 'everything' }));
    expect(badTarget.code).toBe('invalid_argument');
    expect(badTarget.message).toContain('everything');

    const badKey = expectError(await adminPrune(ctx, { olderThan: 30 }));
    expect(badKey.code).toBe('validation');
    expect(badKey.message).toContain('olderThan');
  });
});

// ===========================================================================
// archive / merge - the other destructive actions
// ===========================================================================

describe('backlog_admin(archive) - dry-run by default', () => {
  it('reports candidates without writing, then archives and renders the changelog when confirmed', async () => {
    await seedItem('DONE-001');
    await resolveWithCitation('DONE-001');
    await seedItem('OPEN-001');

    const dry = expectOk(await adminArchive(ctx, { repo: REPO }));
    expect(dry.dryRun).toBe(true);
    expect(dry.candidates.map((c) => c.humanId)).toEqual(['DONE-001']);
    expect(dry.archivedCount).toBe(0);
    expect(dry.changelogMarkdown).toBe('');

    // Nothing was written: the same dry run repeats identically.
    expect(expectOk(await adminArchive(ctx, { repo: REPO })).candidateCount).toBe(1);

    const applied = expectOk(await adminArchive(ctx, { repo: REPO, confirm: true }, 'tester'));
    expect(applied.dryRun).toBe(false);
    expect(applied.archivedCount).toBe(1);
    expect(applied.changelogMarkdown).toContain('DONE-001');

    // And now there is nothing left to archive - the candidate set is derived,
    // not remembered.
    expect(expectOk(await adminArchive(ctx, { repo: REPO })).candidateCount).toBe(0);
  });

  it('an excluded humanId is never a candidate', async () => {
    await seedItem('DONE-001');
    await resolveWithCitation('DONE-001');

    const dry = expectOk(await adminArchive(ctx, { repo: REPO, exclude: ['DONE-001'] }));
    expect(dry.candidates).toEqual([]);
  });
});

describe('backlog_admin(merge) - dry-run by default, both endpoints verified on the safe call', () => {
  it('a typo in `drop` fails on the DRY RUN with item_not_found (exit 1), not only on the destructive call', async () => {
    await seedItem('KEEP-001');

    const err = expectError(await adminMerge(ctx, { repo: REPO, keep: 'KEEP-001', drop: 'NOPE-999', reason: 'dupe' }));
    expect(err.code).toBe('item_not_found');
    expect(err.exit).toBe(1);
  });

  it('merges only when confirmed, and the dropped item stops resolving', async () => {
    await seedItem('KEEP-001');
    await seedItem('DROP-001');

    const dry = expectOk(await adminMerge(ctx, { repo: REPO, keep: 'KEEP-001', drop: 'DROP-001', reason: 'dupe' }));
    expect(dry.dryRun).toBe(true);
    expect(dry.merged).toBe(false);
    expect(await getItemNode(tmp.store, REPO, 'DROP-001')).not.toBeNull();

    const applied = expectOk(
      await adminMerge(ctx, { repo: REPO, keep: 'KEEP-001', drop: 'DROP-001', reason: 'dupe', confirm: true }, 'tester')
    );
    expect(applied.merged).toBe(true);
    expect(applied.item?.humanId).toBe('KEEP-001');
    expect(await withReopenedStore((store) => getItemNode(store, REPO, 'DROP-001'))).toBeNull();
  });

  it('refuses to merge an item into itself', async () => {
    await seedItem('KEEP-001');
    const err = expectError(await adminMerge(ctx, { repo: REPO, keep: 'KEEP-001', drop: 'KEEP-001', reason: 'x' }));
    expect(err.code).toBe('invalid_argument');
  });
});

// ===========================================================================
// 5a.3 - files / overlap
// ===========================================================================

describe('computeOverlapView - INTERFACE_v2 5a.3 / AC-28', () => {
  /** `files` is declared metadata (5a.3: the tool never reads the filesystem) and is not yet mapped by `toBacklogItem`. */
  async function declareFiles(humanId: string, files: string[], projectPath?: string): Promise<void> {
    const node = await findItemNode(tmp.store, REPO, humanId);
    expect(node).not.toBeNull();
    await mutateMetadata<BacklogNodeMeta & { files?: string[] }>(tmp.store, (node as { id: number }).id, (meta) => ({
      ...meta,
      files,
      ...(projectPath !== undefined ? { projectPath } : {}),
    }));
  }

  it('the file and project axes produce DIFFERENT pair sets on the same humanId set', async () => {
    await seedItem('WAVE-001');
    await seedItem('WAVE-002');
    await seedItem('WAVE-003');
    // A and B share a file but sit in different projects.
    await declareFiles('WAVE-001', ['src/a.ts', 'src/shared.ts'], 'packages/one');
    await declareFiles('WAVE-002', ['src/shared.ts'], 'packages/two');
    // C shares NO file with either, but shares A's project.
    await declareFiles('WAVE-003', ['src/c.ts'], 'packages/one');

    const ids = ['WAVE-001', 'WAVE-002', 'WAVE-003'];
    const byFile = expectOk(await computeOverlapView(ctx, ids, 'file', REPO));
    const byProject = expectOk(await computeOverlapView(ctx, ids, 'project', REPO));

    expect(byFile.axis).toBe('file');
    expect(byFile.pairs).toEqual([{ a: 'WAVE-001', b: 'WAVE-002', shared: ['src/shared.ts'] }]);

    expect(byProject.axis).toBe('project');
    expect(byProject.pairs).toEqual([{ a: 'WAVE-001', b: 'WAVE-003', shared: ['packages/one'] }]);

    // AC-28 asserts the difference rather than assuming it.
    expect(byFile.pairs).not.toEqual(byProject.pairs);
  });

  it('items with no declared files produce no pairs - an empty overlap is a real answer, never an error', async () => {
    await seedItem('BARE-001');
    await seedItem('BARE-002');

    const view = expectOk(await computeOverlapView(ctx, ['BARE-001', 'BARE-002'], 'file', REPO));
    expect(view.pairs).toEqual([]);
  });

  it('an unresolvable humanId is item_not_found (exit 1) - the set is never silently narrowed', async () => {
    await seedItem('WAVE-001');
    const err = expectError(await computeOverlapView(ctx, ['WAVE-001', 'NOPE-999'], 'file', REPO));
    expect(err.code).toBe('item_not_found');
    expect(err.exit).toBe(1);
  });

  it('a repeated humanId is de-duplicated WITH a warning, and fewer than two distinct ids is invalid_argument', async () => {
    await seedItem('WAVE-001');
    await seedItem('WAVE-002');

    const env = await computeOverlapView(ctx, ['WAVE-001', 'WAVE-001', 'WAVE-002'], 'file', REPO);
    expect(isOutcomeOk(env)).toBe(true);
    expect(isOutcomeOk(env) && env.warnings?.some((w) => w.includes('more than once'))).toBe(true);

    const tooFew = expectError(await computeOverlapView(ctx, ['WAVE-001', 'WAVE-001'], 'file', REPO));
    expect(tooFew.code).toBe('invalid_argument');
  });
});

// ===========================================================================
// BUG-BACKLOG-BATCH-CLI-001 - batch
// ===========================================================================

describe('backlog_admin(batch) - BUG-BACKLOG-BATCH-CLI-001: discoverable, documented, and honest about what ran', () => {
  it('without a host dispatcher it VALIDATES and NORMALIZES the request, reports executed:false, and names where to run it', async () => {
    const env = await adminBatch(ctx, { operation: 'create-item', items: [{ title: 'a' }, { title: 'b' }], mode: 'serial' });
    const report = expectOk(env);

    expect(report.executed).toBe(false);
    expect(report.results).toBeUndefined();
    expect(report.plan).toEqual({
      operation: 'create-item',
      itemCount: 2,
      mode: 'serial',
      concurrency: 1, // serial pins concurrency to 1, mirroring apigen-engine-runtime batch.ts:144
      onItemError: 'continue',
    });
    expect(report.dispatch.http).toContain('/_batch/action');
    expect(report.dispatch.mcp).toContain('batch_action');
    expect(isOutcomeOk(env) && env.warnings?.some((w) => w.includes('NOT executed'))).toBe(true);
  });

  it('rejects an unknown param key, an unknown mode, and an empty item list - never a silent no-op', async () => {
    const badKey = expectError(await adminBatch(ctx, { operation: 'x', items: [{}], parallelism: 4 }));
    expect(badKey.code).toBe('validation');
    expect(badKey.message).toContain('parallelism');

    const badMode = expectError(await adminBatch(ctx, { operation: 'x', items: [{}], mode: 'turbo' }));
    expect(badMode.code).toBe('invalid_argument');
    expect(badMode.message).toContain('turbo');

    const empty = expectError(await adminBatch(ctx, { operation: 'x', items: [] }));
    expect(empty.code).toBe('invalid_argument');
    expect(empty.message).toContain('items');
  });

  it('with a dispatcher it really fans out, and a per-item failure under onItemError:"continue" never aborts the rest', async () => {
    const dispatch: IAdminBatchDispatch = async (_op, item, index) => {
      if (index === 1) throw new Error('item one is bad');
      return { ok: index, title: item['title'] };
    };

    const report = expectOk(
      await adminBatch(
        ctx,
        { operation: 'create-item', items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] },
        'tester',
        dispatch
      )
    );

    expect(report.executed).toBe(true);
    expect(report.fulfilled).toBe(2);
    expect(report.rejected).toBe(1);
    expect(report.notAttempted).toBe(0);
    expect(report.results?.map((r) => r.ok)).toEqual([true, false, true]);
    expect(report.results?.[1].error?.code).toBe('internal');
    expect(report.results?.[1].error?.message).toContain('item one is bad');
  });

  it('onItemError:"abort" stops the sweep and marks the untried items notAttempted rather than silently dropping them', async () => {
    const dispatch: IAdminBatchDispatch = async (_op, _item, index) => {
      if (index === 0) throw new Error('first fails');
      return index;
    };

    const report = expectOk(
      await adminBatch(
        ctx,
        { operation: 'create-item', items: [{}, {}, {}], mode: 'serial', onItemError: 'abort' },
        'tester',
        dispatch
      )
    );

    expect(report.fulfilled).toBe(0);
    expect(report.rejected).toBe(1);
    expect(report.notAttempted).toBe(2);
    expect(report.results?.slice(1).every((r) => r.notAttempted === true)).toBe(true);
  });

  it('honours the concurrency bound: concurrency 1 never overlaps two items', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch: IAdminBatchDispatch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return null;
    };

    const report = expectOk(
      await adminBatch(ctx, { operation: 'x', items: [{}, {}, {}, {}], concurrency: 1 }, 'tester', dispatch)
    );
    expect(report.fulfilled).toBe(4);
    expect(maxInFlight).toBe(1);
  });

  it('really runs items in parallel up to the bound - proven with a latch, not a sleep', async () => {
    // Deterministic: every item awaits the SAME promise, which is resolved the
    // moment two items are simultaneously in flight. If the pool were serial
    // this would never resolve; if it were unbounded, maxInFlight would exceed
    // 2. Neither outcome depends on timing.
    let release!: () => void;
    const pairReached = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch: IAdminBatchDispatch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight >= 2) release();
      await pairReached;
      inFlight -= 1;
      return null;
    };

    const report = expectOk(
      await adminBatch(ctx, { operation: 'x', items: [{}, {}, {}, {}], concurrency: 2 }, 'tester', dispatch)
    );
    expect(report.fulfilled).toBe(4);
    expect(maxInFlight).toBe(2);
  });

  it('itemTimeoutMs bounds an item that never settles instead of hanging the sweep', async () => {
    const dispatch: IAdminBatchDispatch = async (_op, _item, index) =>
      index === 0 ? new Promise(() => undefined) : 'fine';

    const report = expectOk(
      await adminBatch(ctx, { operation: 'x', items: [{}, {}], itemTimeoutMs: 20 }, 'tester', dispatch)
    );
    expect(report.results?.[0].ok).toBe(false);
    expect(report.results?.[0].error?.message).toContain('itemTimeoutMs=20');
    expect(report.results?.[1].ok).toBe(true);
  });

  it('an executing fan-out is a mutation and must be attributed', async () => {
    const err = expectError(await adminBatch(ctx, { operation: 'x', items: [{}] }, undefined, async () => 'ran'));
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain('by');
  });
});

// ===========================================================================
// export / render - bulk reads with an honest filter contract
// ===========================================================================

describe('backlog_admin export/render - the filter contract is closed, not best-effort', () => {
  it('exports the real items and renders real markdown', async () => {
    await seedItem('EXP-001', { title: 'exportable' });

    const items = expectOk(await adminExport(ctx, { filter: { repo: REPO } }));
    expect(items.map((i) => i.humanId)).toEqual(['EXP-001']);

    const { markdown } = expectOk(await adminRender(ctx, { filter: { repo: REPO } }));
    expect(markdown).toContain('EXP-001');
    expect(markdown).toContain('exportable');
  });

  it('a v2-only filter key is `unsupported` NAMING it - never silently dropped into a v1 read', async () => {
    const err = expectError(await adminExport(ctx, { filter: { repo: REPO, semantic: 'sign-in button' } }));
    expect(err.code).toBe('unsupported');
    expect(err.message).toContain('semantic');
    expect(err.exit).toBe(2);
  });

  it('an unknown filter key is a validation error naming it', async () => {
    const err = expectError(await adminRender(ctx, { filter: { repoo: REPO } }));
    expect(err.code).toBe('validation');
    expect(err.message).toContain('repoo');
  });
});

// ===========================================================================
// The backlog_admin entry point - dispatch, carve-outs and refusals
// ===========================================================================

describe('backlogAdmin - INTERFACE_v2 6 dispatch', () => {
  it('tags every successful action so a dynamic caller can narrow the result', async () => {
    await seedItem('TAG-001');

    const doctor = await backlogAdmin(ctx, { action: 'doctor', params: { repo: REPO } });
    expect(isOutcomeOk(doctor) && doctor.data.action).toBe('doctor');

    const version = await backlogAdmin(ctx, { action: 'version' });
    const versionData = expectOk(version);
    expect(versionData.action).toBe('version');
    expect(versionData.action === 'version' && versionData.version.name).toBe('@adhd/backlog');

    const status = expectOk(await backlogAdmin(ctx, { action: 'migration_status' }));
    expect(status.action).toBe('migration_status');
    expect(status.action === 'migration_status' && typeof status.status.phase).toBe('string');
  });

  it('an unknown action is `not_found` with exit 4 - distinct from a bad flag (exit 2)', async () => {
    const err = expectError(await backlogAdmin(ctx, { action: 'obliterate' as never }));
    expect(err.code).toBe('not_found');
    expect(err.exit).toBe(4);
    expect(err.message).toContain('obliterate');
  });

  it('honours the 6 host-command carve-out: `skill` is refused as `unsupported` and points at the host command', async () => {
    const err = expectError(await backlogAdmin(ctx, { action: 'skill' }));
    expect(err.code).toBe('unsupported');
    expect(err.exit).toBe(2);
    expect(err.message).toContain('install-skill');
    expect(err.message).toContain('host');
  });

  it('never exposes `install` or `serve` as admin actions at all', async () => {
    for (const action of ['install', 'serve', 'install-skill']) {
      const err = expectError(await backlogAdmin(ctx, { action: action as never }));
      expect(err.code).toBe('not_found');
      expect(err.exit).toBe(4);
    }
  });

  it('the EPIC-G actions refuse with `rag_not_configured` rather than fabricating an empty result', async () => {
    for (const action of ['run_dedup_sweep', 'embedding_health', 'list_near_duplicates'] as const) {
      const err = expectError(await backlogAdmin(ctx, { action }));
      expect(err.code).toBe('rag_not_configured');
    }
  });

  it('`migrate_model_v2` is `unsupported` - the contract exists, the implementation does not, and it says which', async () => {
    const err = expectError(await backlogAdmin(ctx, { action: 'migrate_model_v2' }));
    expect(err.code).toBe('unsupported');
    expect(err.message).toContain('EPIC-A');
  });

  it('a non-object `params` is invalid_argument, not a crash', async () => {
    const err = expectError(await backlogAdmin(ctx, { action: 'doctor', params: ['repo'] as never }));
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain('params');
  });

  it('propagates warnings from the underlying action through the tagged envelope', async () => {
    await seedItem('WARN-001');
    const env = await backlogAdmin(ctx, { action: 'prune', params: { repo: REPO, olderThanDays: 0 } });
    expect(isOutcomeOk(env) && env.warnings?.some((w) => w.includes('dry run'))).toBe(true);
  });

  it('import is dry-run by default and reports the parse result without writing', async () => {
    const mdPath = join(adhdRoot, 'BACKLOG.md');
    writeFileSync(mdPath, '## IMPORTED-001 — a real imported item\n\nSome body text.\n', 'utf8');

    const dry = expectOk(await backlogAdmin(ctx, { action: 'import', params: { path: mdPath, repo: REPO } }));
    expect(dry.action).toBe('import');
    expect(dry.action === 'import' && dry.report.dryRun).toBe(true);
    expect(dry.action === 'import' && dry.report.result.created).toBe(0);
    expect(await getItemNode(tmp.store, REPO, 'IMPORTED-001')).toBeNull();
  });

  it('import with a missing path is invalid_argument (exit 2), not an internal error', async () => {
    const err = expectError(
      await backlogAdmin(ctx, { action: 'import', params: { path: join(adhdRoot, 'nope.md'), repo: REPO } })
    );
    expect(err.code).toBe('invalid_argument');
    expect(err.exit).toBe(2);
  });

  it('reconcile_repo is dry-run by default and delegates to the real repo-migration planner', async () => {
    await seedItem('MOVE-001', { repo: 'legacy-key' });

    const dry = expectOk(await backlogAdmin(ctx, { action: 'reconcile_repo', params: { from: 'legacy-key', to: REPO } }));
    expect(dry.action).toBe('reconcile_repo');
    expect(dry.action === 'reconcile_repo' && dry.report.dryRun).toBe(true);
    expect(dry.action === 'reconcile_repo' && dry.report.plan.items.length).toBe(1);

    // Nothing moved.
    expect(await getItemNode(tmp.store, 'legacy-key', 'MOVE-001')).not.toBeNull();
  });
});
