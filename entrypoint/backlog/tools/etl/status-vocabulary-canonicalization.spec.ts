/**
 * status-vocabulary-canonicalization.spec.ts — regression proof for the
 * canonical `status` spelling.
 *
 * The store's flat `status` catalog is canonical LOWERCASE: the shipped write
 * path mints lowercase literals (`create-issue.ts` defaults to `'open'`) and
 * catalog identity is exact-case, so the write layer's mint now REFUSES a
 * name that differs from a live row only by letter case
 * (`CaseVariantNameError`). The frozen source corpus, however, spells every
 * status UPPERCASE (`OPEN`, `FIXED`, `RESOLVED`, …). If the ETL mints or
 * seeds those raw spellings against a store that already holds the lowercase
 * canonicals, the seed aborts (or every affected item fails) and the ETL can
 * no longer run against the real store.
 *
 * This suite drives the REAL `runEtl` state machine — the real write layer,
 * a real on-disk store file, and real citation file I/O, nothing mocked —
 * against a store that is PRE-SEEDED with the lowercase canonical status
 * rows, then asserts the run completes with no failure and leaves no
 * uppercase status twin behind.
 *
 * Ephemeral scratch belongs under `tmp/<package>/…` (AGENTS.md §10). The
 * throwaway store path is passed straight to `runEtl`, so the live production
 * store is never opened.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PRIORITIES, ALL_STATUSES } from './constants.js';
import { runEtl, type IEtlReport } from './run-etl.js';
import { openEtlStore, type IEtlStoreHandle } from './store-bootstrap.js';
import {
  mintOrResolveCatalogTx,
  mintOrResolveStatusTx,
} from '../../src/write/catalog.js';
import { executeWriteTransaction, nowISO } from '../../src/write/tx.js';

const FIXTURE_DIR = join(__dirname, 'fixtures/subset-50');
const TMP_DIR = join(__dirname, '../../tmp/etl');
const DB_PATH = join(TMP_DIR, 'status-canonical.spec.db');

describe('ETL status vocabulary vs a store holding the lowercase canonicals', () => {
  let report: IEtlReport;
  let handle: IEtlStoreHandle;

  beforeAll(async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });

    // Pre-seed the store exactly as a real store already is: the lowercase
    // canonical status rows plus the uppercase canonical priority rows. The
    // status spellings are derived from ALL_STATUSES via toLowerCase so the
    // STORE is the fixed point here — it holds the lowercase canonicals no
    // matter how the ETL's own vocabulary happens to be spelled.
    const seedHandle = await openEtlStore(DB_PATH);
    try {
      await executeWriteTransaction(seedHandle, async (tx) => {
        const at = nowISO();
        const canonicalStatuses = [...new Set(ALL_STATUSES.map((s) => s.toLowerCase()))];
        for (const name of canonicalStatuses) {
          await mintOrResolveStatusTx(tx, { ref: name, at });
        }
        for (const priority of ALL_PRIORITIES) {
          await mintOrResolveCatalogTx(tx, { catalogKind: 'priority', ref: priority, at });
        }
      });
    } finally {
      await seedHandle.close();
    }

    report = await runEtl({ extractDir: FIXTURE_DIR, dbPath: DB_PATH });
    handle = await openEtlStore(DB_PATH);
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  });

  it('completes with zero failed items — the run never errors on a case-variant status', () => {
    expect(report.failed).toEqual([]);
    const caseVariantFailures = report.failed.filter((f) =>
      /letter case|CaseVariant/i.test(f.error)
    );
    expect(caseVariantFailures).toEqual([]);
  });

  it('every live status catalog row is the canonical lowercase spelling — no uppercase twin minted', async () => {
    const { rows } = await handle.adapter.executeAll<{ name: string }>(
      "SELECT name FROM node WHERE kind = 'status' AND t_invalid IS NULL"
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const { name } of rows) {
      expect(name, `non-canonical status spelling "${name}" survived the run`).toBe(
        name.toLowerCase()
      );
    }
  });

  it('imports every fixture item and links them to lowercase status rows', async () => {
    expect(report.importedThisRun).toBe(50);
    const live = await handle.adapter.executeGet<{ n: number }>(
      "SELECT COUNT(*) AS n FROM node WHERE kind = 'issue' AND t_invalid IS NULL"
    );
    expect(live?.n).toBe(49);
  });

  it('every transition status token written is canonical lowercase (when present)', async () => {
    const { rows } = await handle.adapter.executeAll<{ from: string | null; to: string | null }>(
      "SELECT json_extract(meta, '$.from_status') AS \"from\", json_extract(meta, '$.to_status') AS \"to\" FROM node WHERE kind = 'transition' AND t_invalid IS NULL"
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.from !== null) expect(row.from, `uppercase from_status "${row.from}"`).toBe(row.from.toLowerCase());
      if (row.to !== null) expect(row.to, `uppercase to_status "${row.to}"`).toBe(row.to.toLowerCase());
    }
  });
});
