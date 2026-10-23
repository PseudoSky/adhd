/**
 * Shared test fixture: an in-memory better-sqlite3 database built through the
 * REAL drizzle migrations that agent-mcp ships (`entrypoint/agent-mcp/drizzle`),
 * instead of hand-written `CREATE TABLE` DDL.
 *
 * Why: hand-written copies of `task_usage` drifted from the shipped schema
 * (1f1c8598 / 37f6c511 added `response_model`, `cost_basis`, `pricing_ref`,
 * `cost_status`, `priced_cost_usd`, `unpriced_tokens`) and every consumer of
 * `buildTaskUsageReport` failed with `no such column`. Building through the
 * migrations makes that class of drift impossible: a new migration reaches
 * these tests automatically.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

/** The migrations folder agent-mcp ships and the registry runs at startup. */
export const REAL_MIGRATIONS_FOLDER = join(REPO_ROOT, "entrypoint/agent-mcp/drizzle");

let cachedImage: Buffer | undefined;

/** The serialized image of an empty database with every real migration applied (built once per process). */
function migratedImage(): Buffer {
  if (cachedImage === undefined) {
    const seed = new Database(":memory:");
    seed.pragma("foreign_keys = OFF");
    migrate(drizzle(seed), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
    cachedImage = seed.serialize();
    seed.close();
  }
  return cachedImage;
}

/**
 * Create an in-memory database and apply every real migration to it.
 *
 * Foreign-key enforcement is left OFF on the returned connection: these suites
 * seed sessions and tasks directly without registering the owning agent rows
 * (`sessions.agent_name` references `agents`), exactly as the hand-written DDL
 * they replace (which declared no such FK) allowed. Pass
 * `{ enforceForeignKeys: true }` to opt in to the production constraint.
 */
export function createMigratedSqlite(
  opts: { enforceForeignKeys?: boolean } = {}
): Database.Database {
  // Variance fix (qa-variance 2026-10-14, verification pending): `migrate()` re-read and re-ran every real migration for
  // EVERY call (25 test files call this per test), a disk + DDL cost that swung with load. The real migrations still run
  // for real, once per process; each call then deserializes that migrated image into its own independent in-memory
  // database, so a new migration still reaches every consumer and no state is shared between tests.
  const sqlite = new Database(migratedImage());
  sqlite.pragma("foreign_keys = OFF");
  if (opts.enforceForeignKeys === true) sqlite.pragma("foreign_keys = ON");
  return sqlite;
}
