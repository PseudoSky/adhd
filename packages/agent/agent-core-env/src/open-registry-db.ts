/**
 * `open-registry-db.ts` — a LAZY factory for the shared registry SQLite
 * connection. Never opens a connection at module scope — only when
 * `openRegistryDb()` is actually called. This is the fix for the regression
 * this whole migration exists to prevent: each of the 5 registry-family
 * packages previously opened `new Database(...)` as a module-top-level
 * side effect, so merely `import`ing the package (which `entrypoint/agent-mcp`
 * does at boot) opened a legacy-default connection and materialized
 * `<repo>/data/{registry,agents}.db` on disk.
 *
 * Does NOT run migrations — that stays the caller's explicit responsibility
 * (exactly as `buildPromptResolver()` in `entrypoint/agent-mcp/src/index.ts`
 * already does, via each package's own `runMigrationsOn`).
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { resolveRegistryDbPath } from './resolve-registry-db-path.js';
import { applyLockingPragmas } from './sqlite-locking.js';

export interface OpenRegistryDbOpts {
  /** Explicit path override — forwarded to `resolveRegistryDbPath()`. When
   *  absent, the full precedence chain (function arg / env vars / canonical
   *  default) resolves the path. */
  registryDbPath?: string;
  /** `busy_timeout` budget (ms) applied at connect time. Typed config, never
   *  an env-var toggle (ADR-0013). Defaults to 5000ms. */
  busyTimeoutMs?: number;
}

export interface RegistryDbHandle {
  /** The raw `better-sqlite3` connection — WAL mode + `foreign_keys = ON` +
   *  `busy_timeout` already set (see `sqlite-locking.ts`), matching every
   *  existing family client's pragmas. */
  sqlite: Database.Database;
  /** A schema-less Drizzle instance over `sqlite`. Each family package
   *  binds its OWN schema-typed Drizzle instance against this same
   *  connection (`drizzle(handle.sqlite, { schema })`) — this package owns
   *  no registry-family schema itself. */
  db: BetterSQLite3Database;
}

/**
 * Opens (and, if needed, creates) the shared registry SQLite file, applying
 * the same pragmas every existing family client already applied
 * (`journal_mode = WAL`, `foreign_keys = ON`) and `mkdir -p`'ing the parent
 * directory first. Safe to call more than once — each call opens its own
 * connection (matching the pre-migration behavior of `db/client.ts`, which
 * every consumer already expected to be a single connection per process).
 */
export function openRegistryDb(opts: OpenRegistryDbOpts = {}): RegistryDbHandle {
  const resolvedPath = path.resolve(resolveRegistryDbPath({ registryDbPath: opts.registryDbPath }));

  const directory = path.dirname(resolvedPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const sqlite: Database.Database = new Database(resolvedPath);
  applyLockingPragmas(sqlite, { busyTimeoutMs: opts.busyTimeoutMs });

  const db = drizzle(sqlite);

  return { sqlite, db };
}
