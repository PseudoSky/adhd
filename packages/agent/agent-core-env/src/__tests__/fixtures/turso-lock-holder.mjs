// Forked (OS-process) fixture for registry-adapter-concurrency.test.ts
// (ADR-0001 D5). Opens its OWN adapter connection to `argv[2]`, takes a real
// `BEGIN IMMEDIATE` write lock on the shared store, inserts a row, signals
// `{type:'locked'}`, then commits after `argv[3]` ms and signals `{type:'committed'}`.
//
// It holds a genuine cross-process Turso multiprocess lock, so the parent's
// contending immediate transaction must recover via the adapter + bounded retry
// (no raw busy error) for the GREEN assertion.
import { createTursoAdapter } from '@adhd/sox-store-adapter';

const dbPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? 300);

const adapter = await createTursoAdapter({
  dbPath,
  concurrencyMode: 'multiprocess-wal',
});
if (typeof adapter.init === 'function') await adapter.init();
await adapter.pragmaSet('busy_timeout', 0);
await adapter.exec(
  'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, who TEXT)'
);

await adapter.transaction(
  async (tx) => {
    await tx.executeRun("INSERT INTO t (who) VALUES ('holder')");
    process.send?.({ type: 'locked' });
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  },
  { mode: 'immediate' }
);

process.send?.({ type: 'committed' });
await adapter.close();
process.exit(0);
