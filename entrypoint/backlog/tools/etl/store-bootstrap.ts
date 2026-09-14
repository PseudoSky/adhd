/**
 * store-bootstrap.ts — opens (creating if absent) the backlog target store
 * the ETL writes into. Self-contained rather than importing
 * `src/test/helpers/open-test-issue-store.ts` (a TEST fixture, not a stable
 * export this tooling should couple to) — the same open-vocabulary
 * `TypePolicy` shape is reproduced here, matching `write/tx.ts`'s own doc
 * comment on why an open policy is required until a real store-bootstrap
 * module exists ("out of scope for this slice," same as `create-issue.ts`'s
 * test harness already documents).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createStoreAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend, type TypePolicy } from '@adhd/sox-graph-store';
export { OPEN_TYPE_POLICY } from '../../src/store/type-policy.js';
import { OPEN_TYPE_POLICY } from '../../src/store/type-policy.js';
import type { IWriteStoreHandle } from '../../src/write/tx.js';


export interface IEtlStoreHandle extends IWriteStoreHandle {
  readonly adapter: StoreAdapter;
  close(): Promise<void>;
}

/**
 * Opens a REAL store at `dbPath` (never `:memory:` — the restart-idempotency
 * proof needs a real shared file the ETL can be killed and re-run against),
 * creating parent directories and applying schema if the file is new.
 * Reopening an EXISTING file is exactly what makes a resumed run possible —
 * `createStoreAdapter`/`applySchema` are both idempotent against an
 * already-schemaed file.
 */
export async function openEtlStore(dbPath: string, busyTimeoutMs = 10_000): Promise<IEtlStoreHandle> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const adapter = await createStoreAdapter({ dbPath });
  await adapter.pragmaSet('busy_timeout', busyTimeoutMs);
  const graph = createGraphBackend(adapter, { typePolicy: OPEN_TYPE_POLICY });
  await graph.applySchema();
  return {
    adapter,
    typePolicy: OPEN_TYPE_POLICY,
    close: () => adapter.close(),
  };
}
