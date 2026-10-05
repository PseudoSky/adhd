/**
 * `migrate-registry.ts` — the ONE reusable "give me a migrated registry DB"
 * call (backlog 1ef6134d).
 *
 * The registry is a FIVE-package shared-SQLite-file family. Each package owns
 * its own drizzle migration set, and ALL FIVE must be applied, in ascending
 * timestamp order, to the SAME connection before any registry-family store can
 * query it:
 *
 *   1. agent-core-provider       (provider_*)  — 1750*
 *   2. agent-store-prompts       (registry_*)  — 1782193*
 *   3. agent-store-tools         (tool_*)      — 1782250*
 *   4. agent-core-policy         (policy_*)    — 1782256*
 *   5. agent-engine-compiler     (compiler_*)  — 18*
 *
 * Before this module, the sequence was hand-inlined at each call site (most
 * notably `entrypoint/agent-mcp`'s `buildPromptResolver`), so any standalone
 * tool that called `openRegistryDb()` and skipped re-assembling the five
 * runners hit `no such table`. It lives in `@adhd/agent-engine-compiler` — the
 * engine-tier package that already depends on all five registry-family
 * packages — NOT in `@adhd/agent-core-env`, which is core-tier and must not
 * acquire upward dependencies on store/engine packages (layer purity: a
 * `migrateRegistry` there would be a core→store/engine violation).
 *
 * `runMigrationsOn` (from each sibling package) is the FK-safe wrapper around
 * drizzle's migrator: it disables `foreign_keys` for the duration of the run so
 * a table-recreate migration cannot cascade-delete child rows. Using it — not
 * raw `migrate()` — keeps this helper consistent with every other registry
 * migration call in the repo.
 */
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import {
  runMigrationsOn as runProviderMigrationsOn,
  MIGRATIONS_FOLDER as PROVIDER_MIGRATIONS_FOLDER,
} from '@adhd/agent-core-provider';
import {
  runMigrationsOn as runPromptsMigrationsOn,
  MIGRATIONS_FOLDER as PROMPTS_MIGRATIONS_FOLDER,
} from '@adhd/agent-store-prompts';
import {
  runMigrationsOn as runToolsMigrationsOn,
  MIGRATIONS_FOLDER as TOOLS_MIGRATIONS_FOLDER,
} from '@adhd/agent-store-tools';
import {
  runMigrationsOn as runPolicyMigrationsOn,
  MIGRATIONS_FOLDER as POLICY_MIGRATIONS_FOLDER,
} from '@adhd/agent-core-policy';
import {
  runMigrationsOn as runCompilerMigrationsOn,
  MIGRATIONS_FOLDER as COMPILER_MIGRATIONS_FOLDER,
} from './migrate-runner.js';

/**
 * Runs ALL FIVE registry-family migration sets, in canonical ascending-
 * timestamp order, against ONE shared SQLite connection. Idempotent (each
 * package's drizzle migrator is a no-op once its journal is current), so it is
 * safe to call on every open.
 *
 * @param sqlite an already-open `better-sqlite3` connection to the shared
 *   registry file. The caller owns it (opens/closes it); this function only
 *   migrates.
 */
export function migrateRegistry(sqlite: Database.Database): void {
  // A schema-less drizzle instance is enough for the migrator; each package's
  // runner passes it straight through to drizzle's `migrate()`, which only
  // reads the migration journal.
  const db = drizzle(sqlite);

  runProviderMigrationsOn(sqlite, db, PROVIDER_MIGRATIONS_FOLDER);

  runPromptsMigrationsOn(sqlite, db, PROMPTS_MIGRATIONS_FOLDER);

  runToolsMigrationsOn(sqlite, db, TOOLS_MIGRATIONS_FOLDER);

  runPolicyMigrationsOn(sqlite, db, POLICY_MIGRATIONS_FOLDER);

  runCompilerMigrationsOn(sqlite, db, COMPILER_MIGRATIONS_FOLDER);
}
