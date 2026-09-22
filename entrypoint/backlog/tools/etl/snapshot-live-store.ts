/**
 * snapshot-live-store.ts — take a consistent, single-file ONLINE BACKUP of a
 * LIVE store via the adapter's own `backupTo()` (VACUUM INTO), so the live
 * production file is only ever READ, never written, and never even opened for
 * a direct multi-statement scan while other processes hold it.
 *
 * Usage: npx tsx tools/etl/snapshot-live-store.ts <sourceDbPath> <destPath>
 *
 * The source adapter is opened `readonly: true`. `backupTo` runs VACUUM INTO
 * against the destination, which requires no write access to the source. If
 * `backupTo` is unavailable on the resolved backend, this script fails loudly
 * rather than silently falling back to a torn `cp`.
 */
import { createStoreAdapter } from '@adhd/sox-store-adapter';

async function main(): Promise<void> {
  const [sourceDbPath, destPath] = process.argv.slice(2);
  if (!sourceDbPath || !destPath) {
    process.stderr.write('usage: snapshot-live-store.ts <sourceDbPath> <destPath>\n');
    process.exit(2);
  }
  const adapter = await createStoreAdapter({ dbPath: sourceDbPath, readonly: true });
  try {
    if (typeof adapter.backupTo !== 'function') {
      process.stderr.write('snapshot: resolved adapter has no backupTo() — refusing to fall back to a torn copy\n');
      process.exit(2);
    }
    const res = await adapter.backupTo(destPath);
    process.stderr.write(`snapshot: wrote ${res.destPath} integrity=${res.integrity ?? 'n/a'}\n`);
  } finally {
    await adapter.close();
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(2);
});
