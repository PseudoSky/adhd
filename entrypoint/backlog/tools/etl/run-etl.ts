/**
 * run-etl.ts — the ETL as ONE coherent state machine (SPEC.md §8.6/§8.7/§8.8;
 * task contract). States, in order, every run:
 *
 *   LOAD_CORPUS → OPEN_STORE → SCAN_RESUME_STATE → SEED_CATALOGS
 *   → SEED_PROJECTS → PASS_1_ISSUES → PASS_2_EDGES → done
 *
 * Two-pass ordering, per-issue transaction granularity, the crosswalk, and
 * restart idempotency are ONE mechanism here, not four: the crosswalk
 * (`identity.ts`) is rebuilt from durable state in SCAN_RESUME_STATE before
 * PASS_1 ever writes a row, PASS_1 skips anything already in the resume set
 * and commits (or fails) each issue atomically, and PASS_2 only ever runs
 * once PASS_1 has produced a crosswalk complete for every issue this run
 * will ever write — the same ordering constraint whether this is a fresh
 * run or a resume.
 */
import { normalizeProjectName, ADHD_PROJECT_NAME, ADHD_PROJECT_PATH, ADHD_PROJECT_REPO_URL, ALL_PRIORITIES, ALL_STATUSES, PRIORITY_RANK, TERMINAL_STATUSES } from './constants.js';
import { loadCorpus } from './corpus-loader.js';
import { sourceRefOf, type IItemRow } from './corpus-types.js';
import { writeCrossIssueEdges, type IPass2Result } from './edges.js';
import { scanResumeState } from './identity.js';
import { importItem } from './import-item.js';
import { type IEtlStoreHandle, openEtlStore } from './store-bootstrap.js';
import { mintOrResolveCatalogTx } from '../../src/write/catalog.js';
import { executeWriteTransaction, nowISO } from '../../src/write/tx.js';
import { upsertProjectTx } from './catalog-upsert.js';
import type { IResolvedProjectRow } from '../../src/write/catalog.js';

export interface IEtlOptions {
  extractDir: string;
  dbPath: string;
  /** Test/CLI observability hook — called once after EVERY source item is dispositioned (imported, skipped-as-resumed, or failed), always AFTER that item's own transaction has already committed or rolled back. Never called mid-transaction. */
  onItemDispositioned?: (info: { rowid: number; disposition: 'imported' | 'skipped-resumed' | 'failed' }) => void;
  /**
   * TEST-ONLY pacing knob — never set in normal operation (no CLI flag
   * exposes it; `cli.ts` reads it only from the opt-in `ETL_TEST_ITEM_DELAY_MS`
   * env var, mirroring `tx.ts`'s own `ADHD_BACKLOG_UNSAFE_TX_MODE`
   * convention for "exists for a negative-control test, not production").
   * When set, Pass 1 awaits this many ms after EVERY item (imported,
   * skipped-resumed, or failed) before moving to the next one. This exists
   * so `restart.spec.ts`'s real-SIGKILL proof does not have to race real
   * wall-clock disk-cache-dependent citation I/O speed to land its kill
   * mid-run — the KILL, the RESUME, and every correctness assertion stay
   * fully real; only the inter-item TIMING is made deterministic.
   */
  testItemDelayMs?: number;
}

export interface IFailedItem {
  rowid: number;
  repo: string;
  sourceRef: string;
  error: string;
}

export interface IEtlReport {
  totalSourceItems: number;
  alreadyResumedSkipped: number;
  importedThisRun: number;
  failed: IFailedItem[];
  citationsVerified: number;
  citationsUnverified: number;
  citationsMalformed: number;
  pass2: IPass2Result;
  anomalousAuditEvents: number;
  malformedResumeAuditNotes: number;
  /** Live/invalidated `issue` node counts read back from the store AFTER both passes — the acceptance-gate numbers, never a remembered in-process tally (SPEC.md §8.8's own rule: "checked by a live query against the fresh backlog store, never asserted from a remembered count"). */
  liveIssueCountPostRun: number;
  invalidatedIssueCountPostRun: number;
}

/** SPEC.md §8.1's fallback for a source item's effective `repo` (`toBacklogItem`'s `meta.repo ?? node.namespace`). */
function effectiveRepo(item: IItemRow): string {
  return item.itemMeta.repo ?? item.namespace ?? 'global';
}

/** Backs `IEtlOptions.testItemDelayMs` — see that field's own doc comment. Never called with a falsy value (every call site guards `if (options.testItemDelayMs)` first). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function seedClosedCatalogs(handle: IEtlStoreHandle): Promise<void> {
  await executeWriteTransaction(handle, async (tx) => {
    const now = nowISO();
    for (const status of ALL_STATUSES) {
      await mintOrResolveCatalogTx(tx, { catalogKind: 'status', ref: status, at: now, mintMetadata: async () => ({ terminal: TERMINAL_STATUSES.has(status) }) });
    }
    for (const priority of ALL_PRIORITIES) {
      await mintOrResolveCatalogTx(tx, { catalogKind: 'priority', ref: priority, at: now, mintMetadata: async () => ({ rank: PRIORITY_RANK[priority] }) });
    }
  });
}

async function seedProjects(handle: IEtlStoreHandle, items: readonly IItemRow[]): Promise<Map<string, IResolvedProjectRow>> {
  const distinctNames = new Set<string>();
  for (const item of items) distinctNames.add(normalizeProjectName(effectiveRepo(item)));

  const projectsByName = new Map<string, IResolvedProjectRow>();
  for (const name of distinctNames) {
    const metadata = name === ADHD_PROJECT_NAME ? { path: ADHD_PROJECT_PATH, repoUrl: ADHD_PROJECT_REPO_URL } : {};
    const project = await executeWriteTransaction(handle, (tx) => upsertProjectTx(handle, tx, { name, metadata, at: nowISO() }));
    projectsByName.set(name, project);
  }
  return projectsByName;
}

export async function runEtl(options: IEtlOptions): Promise<IEtlReport> {
  const handle = await openEtlStore(options.dbPath);
  try {
    return await runEtlAgainstHandle(handle, options);
  } finally {
    await handle.close();
  }
}

/** Split out so tests can open the store once and drive multiple ETL invocations against the SAME live connection (the restart-idempotency proof instead opens a FRESH connection per invocation, via `runEtl`, to mirror a real separate process — this split exists for the cheaper in-process re-run assertions). */
export async function runEtlAgainstHandle(handle: IEtlStoreHandle, options: IEtlOptions): Promise<IEtlReport> {
  // LOAD_CORPUS
  const corpus = loadCorpus(options.extractDir);

  // SCAN_RESUME_STATE — before any write, so a resume never re-derives its
  // own resume set from data it is about to mutate.
  const { crosswalk, resumeSet, malformedResumeAuditNotes } = await scanResumeState(handle.adapter);

  // SEED_CATALOGS, SEED_PROJECTS — idempotent by construction (§8.7); safe
  // to re-run against a partially-populated store every time.
  await seedClosedCatalogs(handle);
  const projectsByName = await seedProjects(handle, corpus.items);

  const knownItemRowids = new Set(corpus.items.map((i) => i.rowid));

  // PASS_1_ISSUES
  const failed: IFailedItem[] = [];
  let importedThisRun = 0;
  let alreadyResumedSkipped = 0;
  let citationsVerified = 0;
  let citationsUnverified = 0;
  let citationsMalformed = 0;

  for (const item of corpus.items) {
    if (resumeSet.has(item.rowid)) {
      alreadyResumedSkipped += 1;
      options.onItemDispositioned?.({ rowid: item.rowid, disposition: 'skipped-resumed' });
      if (options.testItemDelayMs) await sleep(options.testItemDelayMs);
      continue;
    }

    const rawRepo = effectiveRepo(item);
    const project = projectsByName.get(normalizeProjectName(rawRepo));
    if (!project) {
      // Unreachable given SEED_PROJECTS enumerates the SAME `corpus.items`
      // this loop iterates — kept as a loud failure, never a silent skip.
      throw new Error(`runEtl: no seeded project for normalized name "${normalizeProjectName(rawRepo)}" (item rowid=${item.rowid}) — SEED_PROJECTS/PASS_1 item sets have diverged.`);
    }

    try {
      const transitionEvents = corpus.transitionEventsByItemRowid.get(item.rowid) ?? [];
      const result = await importItem({
        handle,
        item,
        rawRepo,
        project,
        transitionEvents,
        adhdProjectPath: project.name === ADHD_PROJECT_NAME ? ADHD_PROJECT_PATH : undefined,
      });
      crosswalk.set(item.rowid, result.uid);
      citationsVerified += result.citationsVerified;
      citationsUnverified += result.citationsUnverified;
      citationsMalformed += result.citationsMalformed;
      importedThisRun += 1;
      options.onItemDispositioned?.({ rowid: item.rowid, disposition: 'imported' });
    } catch (err) {
      // §8.8: one malformed record must never block the others. The
      // transaction this item opened has already rolled back in full
      // (`executeWriteTransaction`'s own guarantee) — nothing partial from
      // it persists.
      failed.push({ rowid: item.rowid, repo: rawRepo, sourceRef: sourceRefOf(item.itemMeta) ?? '', error: err instanceof Error ? err.message : String(err) });
      options.onItemDispositioned?.({ rowid: item.rowid, disposition: 'failed' });
    }
    if (options.testItemDelayMs) await sleep(options.testItemDelayMs);
  }

  // PASS_2_EDGES — only after PASS_1 has produced a crosswalk complete for
  // every issue this run (resumed + fresh) will ever write.
  const pass2 = await writeCrossIssueEdges(handle, corpus.edges, crosswalk, knownItemRowids);

  // Acceptance-gate counts, read fresh — never the in-process tally above.
  const liveRow = await handle.adapter.executeGet<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'issue' AND t_invalid IS NULL");
  const invalidRow = await handle.adapter.executeGet<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'issue' AND t_invalid IS NOT NULL");

  return {
    totalSourceItems: corpus.items.length,
    alreadyResumedSkipped,
    importedThisRun,
    failed,
    citationsVerified,
    citationsUnverified,
    citationsMalformed,
    pass2,
    anomalousAuditEvents: corpus.anomalousAuditEvents.length,
    malformedResumeAuditNotes,
    liveIssueCountPostRun: liveRow?.n ?? 0,
    invalidatedIssueCountPostRun: invalidRow?.n ?? 0,
  };
}
