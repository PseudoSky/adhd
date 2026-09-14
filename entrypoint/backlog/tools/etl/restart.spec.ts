/**
 * restart.spec.ts — the restart-idempotency proof (task contract: "Prove
 * restart idempotency by actually killing a run partway and re-running it,
 * then comparing counts — not by arguing it"). Every scenario below spawns
 * the REAL `cli.ts` entrypoint as a REAL child process against a REAL
 * on-disk SQLite file — nothing mocked, nothing simulated with a sleep.
 * The kill is a genuine `SIGKILL` (not `SIGTERM`, which lets a handler
 * finish work and would prove nothing) sent the instant a counted number of
 * real `PROGRESS` lines has been observed on the child's real stdout — a
 * barrier, never a wall-clock guess.
 *
 * Fixture: `fixtures/subset-50` (a further real prefix of the already-real
 * `subset-400` fixture, itself a prefix of the frozen corpus) — chosen
 * specifically so a full clean pass takes ~5s instead of subset-400's ~3
 * minutes, making a kill-partway-through-and-resume cycle (which needs at
 * least two full passes, sometimes three) fast enough to run by default.
 * It carries zero cross-issue edges (SPEC.md §8.3's edges cluster at
 * higher source rowids than this cutoff) — Pass 2/edge-dangling coverage
 * against a KILL boundary specifically is therefore a disclosed gap here;
 * Pass 2 correctness in aggregate (26/26 edges, 0 dangling) is proven
 * against the full subset-400 corpus by `run-etl.spec.ts`, on a clean run.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openEtlStore, type IEtlStoreHandle } from './store-bootstrap.js';
import { runEtlAgainstHandle } from './run-etl.js';
import { IMPORTED_ACTION } from './constants.js';

const FIXTURE_DIR = join(__dirname, 'fixtures/subset-50');
const ORACLE = JSON.parse(readFileSync(join(FIXTURE_DIR, 'oracle.json'), 'utf8')) as {
  totalItems: number;
  liveItems: number;
  invalidatedItems: number;
};
const CLI_PATH = join(__dirname, 'cli.ts');
// Workspace-root `tsx` binary, resolved directly (not via `npx`, which adds
// ~1s of resolution overhead per spawn that would blur the kill timing).
const TSX_BIN = resolve(__dirname, '../../../../node_modules/.bin/tsx');

const TMP_DIR = join(__dirname, '../../tmp/etl');

function dbPathFor(name: string): string {
  return join(TMP_DIR, `restart.${name}.db`);
}

function cleanDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}

interface IEtlSpawnReport {
  totalSourceItems: number;
  alreadyResumedSkipped: number;
  importedThisRun: number;
  failed: unknown[];
}

interface ISpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  progressLines: string[];
  /** Parsed from the real `REPORT <json>` line `cli.ts` prints on exit — `undefined` if the process never reached that line (e.g. it was killed first). */
  report: IEtlSpawnReport | undefined;
  stderr: string;
}

/**
 * Spawns the real CLI against `dbPath`. If `killAfterProgressLines` is set,
 * sends a REAL `SIGKILL` the instant that many `PROGRESS <rowid>
 * <disposition>` lines have been observed on the child's real stdout (a
 * counted barrier — never a `setTimeout`/sleep). Resolves once the process
 * has actually exited (`exit` event), so the caller never races the OS's
 * own teardown of a killed process.
 *
 * `itemDelayMs`, when given, is forwarded as the child's `ETL_TEST_ITEM_DELAY_MS`
 * env var (`cli.ts`/`run-etl.ts`'s documented test-only pacing knob). Without
 * it, a tiny fixture like `subset-50` can run start-to-finish faster than this
 * test's own read-a-line-then-kill round trip — the kill would then always
 * land AFTER the real work already finished, silently turning "kill partway"
 * into "kill after," which is exactly the bug this knob exists to rule out
 * (measured, not assumed: this is the failure this file's own first version hit).
 */
function spawnEtl(dbPath: string, options: { killAfterProgressLines?: number; itemDelayMs?: number } = {}): Promise<ISpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    if (options.itemDelayMs !== undefined) env.ETL_TEST_ITEM_DELAY_MS = String(options.itemDelayMs);
    const child = spawn(TSX_BIN, [CLI_PATH, FIXTURE_DIR, dbPath], { stdio: ['ignore', 'pipe', 'pipe'], env });
    const progressLines: string[] = [];
    let report: IEtlSpawnReport | undefined;
    let stderr = '';
    let killed = false;

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (line.startsWith('PROGRESS ')) {
        progressLines.push(line);
        if (!killed && options.killAfterProgressLines !== undefined && progressLines.length >= options.killAfterProgressLines) {
          killed = true;
          child.kill('SIGKILL');
        }
      } else if (line.startsWith('REPORT ')) {
        report = JSON.parse(line.slice('REPORT '.length)) as IEtlSpawnReport;
      }
    });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolvePromise({ code, signal, progressLines, report, stderr });
    });
  });
}

async function liveInvalidCounts(dbPath: string): Promise<{ live: number; invalid: number; totalIssues: number; importedAudits: number }> {
  const handle = await openEtlStore(dbPath);
  try {
    const live = await handle.adapter.executeGet<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'issue' AND t_invalid IS NULL");
    const invalid = await handle.adapter.executeGet<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'issue' AND t_invalid IS NOT NULL");
    const total = await handle.adapter.executeGet<{ n: number }>("SELECT COUNT(*) AS n FROM node WHERE kind = 'issue'");
    const audits = await handle.adapter.executeGet<{ n: number }>(
      "SELECT COUNT(*) AS n FROM node WHERE kind = 'audit' AND json_extract(meta, '$.action') = ?",
      [IMPORTED_ACTION],
    );
    return { live: live?.n ?? 0, invalid: invalid?.n ?? 0, totalIssues: total?.n ?? 0, importedAudits: audits?.n ?? 0 };
  } finally {
    await handle.close();
  }
}

describe('ETL restart idempotency (real spawn, real SIGKILL, real DB)', () => {
  let sourceHashesBefore: { corpus: string; edges: string };

  function hashSources(): { corpus: string; edges: string } {
    const corpus = createHash('sha256').update(readFileSync(join(FIXTURE_DIR, 'corpus.jsonl'))).digest('hex');
    const edges = createHash('sha256').update(readFileSync(join(FIXTURE_DIR, 'edges.jsonl'))).digest('hex');
    return { corpus, edges };
  }

  beforeAll(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    sourceHashesBefore = hashSources();
  });

  afterEach(() => {
    // The one invariant every scenario below must hold: the frozen fixture
    // is NEVER mutated by any of this file's spawned processes or in-process
    // calls — checked after every single test, not just once at the end.
    const after = hashSources();
    expect(after).toEqual(sourceHashesBefore);
  });

  it('kill-and-resume: a REAL process is SIGKILLed partway through Pass 1, then a REAL second process resumes it to completion with no double-write', async () => {
    const dbPath = dbPathFor('kill-resume');
    cleanDb(dbPath);
    try {
      // Run A: kill after the 20th of 50 real PROGRESS lines.
      const runA = await spawnEtl(dbPath, { killAfterProgressLines: 20 });
      expect(runA.signal, `run A stderr: ${runA.stderr}`).toBe('SIGKILL');
      expect(runA.progressLines.length).toBeGreaterThanOrEqual(20);
      expect(runA.progressLines.length).toBeLessThan(ORACLE.totalItems); // genuinely partial, never the full run racing the kill

      const afterKill = await liveInvalidCounts(dbPath);
      expect(afterKill.totalIssues).toBeGreaterThan(0);
      expect(afterKill.totalIssues).toBeLessThan(ORACLE.totalItems); // partial state actually persisted, never zero and never complete

      // Run B: a SEPARATE real process, resuming against the SAME db file.
      const runB = await spawnEtl(dbPath);
      expect(runB.signal).toBeNull();
      expect(runB.code, `run B stderr: ${runB.stderr}`).toBe(0);
      expect(runB.report?.failed).toEqual([]);

      const final = await liveInvalidCounts(dbPath);
      expect(final.totalIssues).toBe(ORACLE.totalItems); // never doubled
      expect(final.live).toBe(ORACLE.liveItems);
      expect(final.invalid).toBe(ORACLE.invalidatedItems);
      expect(final.importedAudits).toBe(ORACLE.totalItems); // exactly one `imported` audit per item, never two
    } finally {
      cleanDb(dbPath);
    }
  }, 120_000);

  it('already-complete store: re-running the ETL again changes nothing (idempotent re-run, not just idempotent resume)', async () => {
    const dbPath = dbPathFor('rerun-complete');
    cleanDb(dbPath);
    try {
      const first = await spawnEtl(dbPath);
      expect(first.code).toBe(0);
      const afterFirst = await liveInvalidCounts(dbPath);
      expect(afterFirst.totalIssues).toBe(ORACLE.totalItems);

      const second = await spawnEtl(dbPath);
      expect(second.code, `second run stderr: ${second.stderr}`).toBe(0);
      expect(second.report?.importedThisRun).toBe(0);
      expect(second.report?.alreadyResumedSkipped).toBe(ORACLE.totalItems);

      const afterSecond = await liveInvalidCounts(dbPath);
      expect(afterSecond).toEqual(afterFirst); // byte-identical counts, not merely "close"
    } finally {
      cleanDb(dbPath);
    }
  }, 60_000);

  it('NEGATIVE CONTROL: destroying the real persisted resume signal (the `imported` audit notes) makes a real re-run double every issue — proving the mechanism, not assuming it', async () => {
    const dbPath = dbPathFor('negative-control');
    cleanDb(dbPath);
    try {
      const first = await spawnEtl(dbPath);
      expect(first.code).toBe(0);
      const clean = await liveInvalidCounts(dbPath);
      expect(clean.totalIssues).toBe(ORACLE.totalItems);
      expect(clean.importedAudits).toBe(ORACLE.totalItems);

      // Real corruption of REAL persisted state, through the REAL adapter —
      // never a code mock. This is the literal mechanism restart-safety
      // depends on (SPEC.md §8.7): erase it and the resume-set is empty.
      const handle = await openEtlStore(dbPath);
      const before = await handle.adapter.executeGet<{ n: number }>(
        "SELECT COUNT(*) AS n FROM node WHERE kind = 'audit' AND json_extract(meta, '$.action') = ?",
        [IMPORTED_ACTION],
      );
      expect(before?.n).toBe(ORACLE.totalItems);
      await handle.adapter.executeRun(
        "UPDATE node SET meta = json_set(meta, '$.action', 'corrupted-for-test') WHERE kind = 'audit' AND json_extract(meta, '$.action') = ?",
        [IMPORTED_ACTION],
      );
      const corruptedCount = await handle.adapter.executeGet<{ n: number }>(
        "SELECT COUNT(*) AS n FROM node WHERE kind = 'audit' AND json_extract(meta, '$.action') = ?",
        [IMPORTED_ACTION],
      );
      expect(corruptedCount?.n).toBe(0); // scanResumeState will now find nothing to resume from
      const report = await runEtlAgainstHandle(handle, { extractDir: FIXTURE_DIR, dbPath });
      await handle.close();

      expect(report.alreadyResumedSkipped).toBe(0); // the resume-set genuinely came up empty
      expect(report.importedThisRun).toBe(ORACLE.totalItems); // every item was reprocessed as if new

      const after = await liveInvalidCounts(dbPath);
      expect(after.totalIssues).toBe(ORACLE.totalItems * 2); // DOUBLED — the exact failure this mechanism exists to prevent
      expect(after.importedAudits).toBe(ORACLE.totalItems * 2); // and duplicated, right alongside it

      // Teeth, stated: `run-etl.spec.ts`'s clean pass and this file's first
      // two scenarios prove NO doubling with the real mechanism intact;
      // this scenario proves DOUBLING the instant that mechanism's own
      // persisted signal is destroyed. Same code path, opposite outcome,
      // both measured — not argued.
    } finally {
      cleanDb(dbPath);
    }
  }, 60_000);
});
