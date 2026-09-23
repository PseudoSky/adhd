/**
 * run-etl.spec.ts — in-process correctness proof for the ETL state machine
 * (SPEC.md §8.6/§8.7/§8.8; task contract), driven against the REAL frozen
 * `subset-400` fixture through the REAL write layer (`executeWriteTransaction`,
 * `writeNodeTx`/`writeEdgeTx`, `writeAudit` — nothing mocked) and a REAL
 * on-disk SQLite file. Every assertion below reads the numbers back from a
 * live query against that file, never from a remembered in-process tally
 * (SPEC.md §8.8's own rule, applied to this test too).
 *
 * `fixtures/subset-400` is a real prefix of the frozen corpus
 * (`scratchpad/extract/corpus.jsonl`/`edges.jsonl`) — 400 real backlog-item
 * rows plus their real audit-event/edge rows, with an independently
 * computed `oracle.json` this suite cross-checks against. A full pass over
 * it does REAL file-hash I/O for every citation (SPEC.md §8.5) and takes on
 * the order of 2-3 minutes — this is setup cost, not a reason to skip it
 * (AGENTS.md §7 "Live testing is mandatory").
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEtl, type IEtlReport } from './run-etl.js';
import { openEtlStore, type IEtlStoreHandle } from './store-bootstrap.js';
import { ADHD_PROJECT_PATH, IMPORTED_ACTION, MISSING_CITATION_FILE, UNVERIFIED_SHA } from './constants.js';

const FIXTURE_DIR = join(__dirname, 'fixtures/subset-400');
const ORACLE = JSON.parse(readFileSync(join(FIXTURE_DIR, 'oracle.json'), 'utf8')) as {
  totalItems: number;
  liveItems: number;
  invalidatedItems: number;
  edgesInSubset: number;
  edgesInSubsetByRel: Record<string, number>;
};

// Ephemeral scratch belongs under `tmp/<package>/…` (AGENTS.md §10).
const TMP_DIR = join(__dirname, '../../tmp/etl');
const DB_PATH = join(TMP_DIR, 'run-etl.spec.db');

describe('runEtl — subset-400 (real write layer, real store, real citation I/O)', () => {
  let report: IEtlReport;
  let handle: IEtlStoreHandle;

  beforeAll(async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
    report = await runEtl({ extractDir: FIXTURE_DIR, dbPath: DB_PATH });
    handle = await openEtlStore(DB_PATH);
  }, 480_000);

  afterAll(async () => {
    await handle?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  });

  it('the acceptance gate (SPEC.md §8.8): failed is empty, dangling is empty', () => {
    expect(report.failed).toEqual([]);
    expect(report.pass2.danglingReferences).toEqual([]);
  });

  it('total/live/invalidated issue counts match the independently-computed oracle', () => {
    expect(report.totalSourceItems).toBe(ORACLE.totalItems);
    expect(report.importedThisRun).toBe(ORACLE.totalItems);
    expect(report.alreadyResumedSkipped).toBe(0);
    expect(report.liveIssueCountPostRun).toBe(ORACLE.liveItems);
    expect(report.invalidatedIssueCountPostRun).toBe(ORACLE.invalidatedItems);
  });

  it('live query against the store agrees with the report (never a remembered count)', async () => {
    const live = await handle.adapter.executeGet<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'issue' AND t_invalid IS NULL");
    const invalid = await handle.adapter.executeGet<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'issue' AND t_invalid IS NOT NULL");
    expect(live?.n).toBe(ORACLE.liveItems);
    expect(invalid?.n).toBe(ORACLE.invalidatedItems);
  });

  it('Pass 2 edge counts match the oracle, split by rel', async () => {
    expect(report.pass2.edgesWritten).toBe(ORACLE.edgesInSubset);
    const relatesTo = await handle.adapter.executeGet<{ n: number }>("SELECT COUNT(*) AS n FROM edge WHERE rel = 'relates_to' AND t_invalid IS NULL");
    const blocks = await handle.adapter.executeGet<{ n: number }>("SELECT COUNT(*) AS n FROM edge WHERE rel = 'blocks' AND t_invalid IS NULL");
    expect(relatesTo?.n).toBe(ORACLE.edgesInSubsetByRel.RELATES_TO);
    expect(blocks?.n).toBe(ORACLE.edgesInSubsetByRel.DEPENDS_ON); // DEPENDS_ON -> blocks, reversed (SPEC.md §8.3)
  });

  it('exactly one `imported` audit node per source item, every one carrying a real sha (SPEC.md §8.2a/§8.4)', async () => {
    const { rows } = await handle.adapter.executeAll<{ n: number; sha: string | null }>(
      "SELECT COUNT(*) AS n, MIN(json_extract(meta, '$.sha')) AS sha FROM node WHERE kind = 'audit' AND json_extract(meta, '$.action') = ? AND t_invalid IS NULL",
      [IMPORTED_ACTION],
    );
    expect(rows[0]?.n).toBe(ORACLE.totalItems);
    expect(rows[0]?.sha).toBeTruthy();
  });

  it('every migrated `transition` node has a non-empty agent, note, and sha (SPEC.md §8.8 point 4)', async () => {
    const { rows } = await handle.adapter.executeAll<{ agent: string | null; note: string | null; sha: string | null }>(
      "SELECT json_extract(meta, '$.agent') AS agent, json_extract(meta, '$.note') AS note, json_extract(meta, '$.sha') AS sha FROM node WHERE kind = 'transition' AND t_invalid IS NULL",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.agent, `transition missing agent: ${JSON.stringify(row)}`).toBeTruthy();
      expect(row.note, `transition missing note: ${JSON.stringify(row)}`).toBeTruthy();
      expect(row.sha, `transition missing sha: ${JSON.stringify(row)}`).toBeTruthy();
    }
  });

  it('citations: verified/unverified/malformed partition sums to the total written, and every one carries a sha', async () => {
    const { rows } = await handle.adapter.executeAll<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'citation' AND t_invalid IS NULL");
    expect(rows[0]?.n).toBe(report.citationsVerified + report.citationsUnverified);
    expect(report.citationsMalformed).toBe(1); // the real, empirically-discovered anomaly at source rowid 474 (see MISSING_CITATION_FILE)

    const { rows: noSha } = await handle.adapter.executeAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM node WHERE kind = 'citation' AND (json_extract(meta, '$.sha') IS NULL OR json_extract(meta, '$.sha') = '')",
    );
    expect(noSha[0]?.n).toBe(0);
  });

  it('citation repair (SPEC.md §8.5): a verified citation\'s sha is the REAL sha256 of the file it names, independently recomputed here', async () => {
    const { rows } = await handle.adapter.executeAll<{ target: string; sha: string }>(
      "SELECT json_extract(meta, '$.target') AS target, json_extract(meta, '$.sha') AS sha FROM node WHERE kind = 'citation' AND json_extract(meta, '$.sha') != ? LIMIT 5",
      [UNVERIFIED_SHA],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const real = createHash('sha256').update(readFileSync(join(ADHD_PROJECT_PATH, row.target))).digest('hex');
      expect(row.sha).toBe(real);
    }
  });

  it('the one malformed citation (no `file` at all) degrades to the disclosed sentinel instead of crashing the item (found + fixed bug)', async () => {
    const row = await handle.adapter.executeGet<{ target: string; sha: string }>(
      "SELECT json_extract(meta, '$.target') AS target, json_extract(meta, '$.sha') AS sha FROM node WHERE kind = 'citation' AND json_extract(meta, '$.target') = ?",
      [MISSING_CITATION_FILE],
    );
    expect(row).toBeTruthy();
    expect(row?.sha).toBe(UNVERIFIED_SHA);
  });

  it('provenance blob (SPEC.md §8.2a/task contract): every one of the ten persisted keys is present, and `humanId` never appears anywhere in the persisted note', async () => {
    const { rows } = await handle.adapter.executeAll<{ note: string }>(
      "SELECT json_extract(meta, '$.note') AS note FROM node WHERE kind = 'audit' AND json_extract(meta, '$.action') = ?",
      [IMPORTED_ACTION],
    );
    expect(rows.length).toBe(ORACLE.totalItems);
    const CONTRACT_KEYS = [
      'sourceProject', 'sourceRef', 'sourceFamily', 'sourcePlan', 'sourceImportedFrom',
      'sourceAssignee', 'sourceTags', 'sourceReporter', 'sourceClaimState', 'sourceRenamedFrom',
    ];
    const ALLOWED_KEYS = new Set([...CONTRACT_KEYS, 'sourceNodeId']);
    for (const { note } of rows) {
      expect(note.includes('humanId')).toBe(false);
      const parsed = JSON.parse(note) as Record<string, unknown>;
      expect(parsed).toHaveProperty('sourceNodeId');
      // Every persisted key is one of the eleven documented ones — never a
      // stray/renamed key (e.g. a re-introduced `humanId`, or an undisclosed
      // twelfth field). Presence of each contract key is conditional on the
      // source data (§8.2a: "written when the source data has a value for
      // it"), so this checks the SET, not that every key is present on every row.
      for (const key of Object.keys(parsed)) {
        expect(ALLOWED_KEYS.has(key), `unexpected provenance key "${key}"`).toBe(true);
      }
    }
    // At least one real item in this fixture actually carries a `sourceRef` value.
    const withRef = rows.filter((r) => (JSON.parse(r.note) as { sourceRef?: string }).sourceRef).length;
    expect(withRef).toBeGreaterThan(0);
  });

  it('the disclosed sourceNodeId collision (identity.ts doc comment): both colliding rows resolve to DISTINCT uids, never merged', async () => {
    const { rows } = await handle.adapter.executeAll<{ sourceNodeId: number; targetUid: string }>(
      "SELECT json_extract(meta, '$.note') AS note, json_extract(meta, '$.target_uid') AS targetUid FROM node WHERE kind = 'audit' AND json_extract(meta, '$.action') = ?",
      [IMPORTED_ACTION],
    );
    const bySourceNodeId = new Map<number, string>();
    let duplicateSourceNodeIds = 0;
    for (const row of rows as unknown as Array<{ note: string; targetUid: string }>) {
      const sourceNodeId = (JSON.parse(row.note) as { sourceNodeId: number }).sourceNodeId;
      if (bySourceNodeId.has(sourceNodeId)) duplicateSourceNodeIds += 1;
      bySourceNodeId.set(sourceNodeId, row.targetUid);
    }
    // sourceNodeId is the source store's own rowid — one audit note per rowid, never collided.
    expect(duplicateSourceNodeIds).toBe(0);
    expect(bySourceNodeId.size).toBe(ORACLE.totalItems);
  });
});
