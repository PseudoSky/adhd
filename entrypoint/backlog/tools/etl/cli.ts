#!/usr/bin/env -S node
/**
 * cli.ts — ETL entrypoint. Usage:
 *
 *   npx tsx tools/etl/cli.ts <extractDir> <dbPath>
 *
 * Prints one `PROGRESS <rowid> <disposition>` line per source item to
 * stdout (flushed immediately, unbuffered — the restart-idempotency test
 * watches this stream to know exactly when to SIGKILL this process) and a
 * final `REPORT <json>` line, then exits 0 if `failed` is empty, 1
 * otherwise. Never swallows a thrown error: an unexpected exception prints
 * to stderr and exits 2, so a killed-vs-crashed run is always distinguishable
 * from stdout/exit-code alone (never `grep`-inferred).
 *
 * `ETL_TEST_ITEM_DELAY_MS` (opt-in, TEST-ONLY — see `run-etl.ts`'s
 * `IEtlOptions.testItemDelayMs` doc comment): when set to a positive integer,
 * forwarded as `testItemDelayMs` so `restart.spec.ts`'s real-SIGKILL proof can
 * land its kill reliably mid-Pass-1 without racing real wall-clock citation
 * I/O speed. Unset (the only way this binary is ever invoked outside that one
 * test file) → `undefined`, i.e. no throttling, the exact behavior before this
 * env var existed.
 */
import { runEtl } from './run-etl.js';

async function main(): Promise<void> {
  const [extractDir, dbPath] = process.argv.slice(2);
  if (!extractDir || !dbPath) {
    process.stderr.write('usage: cli.ts <extractDir> <dbPath>\n');
    process.exit(2);
  }

  const rawDelay = process.env.ETL_TEST_ITEM_DELAY_MS;
  const testItemDelayMs = rawDelay !== undefined && rawDelay.trim().length > 0 ? Number(rawDelay) : undefined;
  if (testItemDelayMs !== undefined && (!Number.isFinite(testItemDelayMs) || testItemDelayMs < 0)) {
    process.stderr.write(`cli.ts: ETL_TEST_ITEM_DELAY_MS must be a non-negative number, got ${JSON.stringify(rawDelay)}\n`);
    process.exit(2);
  }

  const report = await runEtl({
    extractDir,
    dbPath,
    testItemDelayMs,
    onItemDispositioned: (info) => {
      process.stdout.write(`PROGRESS ${info.rowid} ${info.disposition}\n`);
    },
  });

  process.stdout.write(`REPORT ${JSON.stringify(report)}\n`);
  process.exit(report.failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(2);
});
