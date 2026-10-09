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
const REPO_ROOT = resolve(HERE, "../../../../../..");

/** The migrations folder agent-mcp ships and the registry runs at startup. */
export const REAL_MIGRATIONS_FOLDER = join(REPO_ROOT, "entrypoint/agent-mcp/drizzle");

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
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  migrate(drizzle(sqlite), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
  if (opts.enforceForeignKeys === true) sqlite.pragma("foreign_keys = ON");
  return sqlite;
}
