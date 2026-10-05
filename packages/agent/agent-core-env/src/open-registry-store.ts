/**
 * `open-registry-store.ts` — the LAZY, adapter-backed open for the shared
 * registry SQLite file (ADR-0001 D4 step 1; backlog 331508ac).
 *
 * ADR-0001 D1 retires `better-sqlite3`-as-the-store for adhd stores and D4
 * makes this the single highest-leverage choke point: every registry-family
 * consumer inherits the sox store adapter through here. This factory:
 *
 *  - never opens anything at module scope (import is side-effect free, exactly
 *    like the `openRegistryDb` it supersedes) — only a call opens;
 *  - resolves the SAME path the family always agreed on
 *    (`resolveRegistryDbPath`);
 *  - opens the adapter with the mandated concurrency mode
 *    (`multiprocess-wal`, ADR-0001 D7 — typed config, never `STORE_ADAPTER`
 *    env, never the single-writer SQLite fallback);
 *  - applies the locking contract's connect-time half: `busy_timeout`
 *    (ADR-0001 D3.1), typed, default 5000 ms.
 *
 * The read-modify-write half (`BEGIN IMMEDIATE` + bounded busy retry) lives in
 * `store-transaction.ts` (`withImmediateRetry`).
 *
 * `openRegistryDb` (better-sqlite3) remains for the not-yet-migrated
 * Drizzle-based consumers; the D4 sequence migrates them off it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createTursoAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';

import { resolveRegistryDbPath } from './resolve-registry-db-path.js';
import { DEFAULT_REGISTRY_BUSY_TIMEOUT_MS } from './store-transaction.js';

export interface OpenRegistryStoreOpts {
  /** Explicit path override — forwarded to `resolveRegistryDbPath()`. */
  registryDbPath?: string;
  /** `busy_timeout` budget (ms) applied at connect time. Typed config, never
   *  an env-var toggle (sox ADR-0013). Defaults to 5000 ms. */
  busyTimeoutMs?: number;
}

/**
 * Opens (and, if needed, creates) the shared registry store through
 * `@adhd/sox-store-adapter` (Turso, multiprocess-enabled), applying the typed
 * `busy_timeout`. The caller owns the returned adapter and must `close()` it.
 */
export async function openRegistryStore(
  opts: OpenRegistryStoreOpts = {}
): Promise<StoreAdapter> {
  const dbPath = path.resolve(
    resolveRegistryDbPath({ registryDbPath: opts.registryDbPath })
  );

  const directory = path.dirname(dbPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const busyTimeoutMs = Math.max(
    0,
    Math.trunc(opts.busyTimeoutMs ?? DEFAULT_REGISTRY_BUSY_TIMEOUT_MS)
  );

  // Explicit, typed concurrency mode (ADR-0001 D7): multiprocess is mandatory
  // and disabling it is banned. Using `createTursoAdapter` directly — rather
  // than the env-driven `createStoreAdapter` — means a stray `STORE_ADAPTER`
  // can never select the single-writer SQLite fallback for an adhd store.
  const adapter = await createTursoAdapter({
    dbPath,
    concurrencyMode: 'multiprocess-wal',
  });
  if (typeof adapter.init === 'function') {
    await adapter.init();
  }

  await adapter.pragmaSet('busy_timeout', busyTimeoutMs);

  return adapter;
}
