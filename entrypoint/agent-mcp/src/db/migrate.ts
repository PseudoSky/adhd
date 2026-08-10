import { db, sqlite } from "./client.js";
import { runMigrationsOn } from "./migrate-runner.js";
import { migrateLegacyOperationalDb } from "./migrate-legacy.js";
import { logger } from "../logger.js";

/**
 * Applies the drizzle schema migrations, then the one-time flat-legacy →
 * namespaced operational-data migration (DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-
 * 001, design decision 3).
 *
 * Ordering is load-bearing: the legacy row copy must run AFTER the drizzle
 * migrations so the canonical tables exist with the full CURRENT schema
 * (drizzle migration 0000 uses a bare `CREATE TABLE` and 0002/0003/0004/0010
 * `ALTER TABLE` — copying before them would either fail or corrupt the
 * migration chain). See `db/migrate-legacy.ts`'s header for the copy's own
 * safety guarantees.
 */
export function runMigrations(): void {
    runMigrationsOn(sqlite, db);

    try {
        const outcome = migrateLegacyOperationalDb(sqlite, {
            log: (level, message) => (level === "warn" ? logger.warn(message) : logger.info(message)),
        });
        if (outcome.reason === "copied") {
            logger.info(
                { agentsCopied: outcome.agentsCopied },
                "migrate-legacy: copied flat legacy operational DB into the namespaced store " +
                "(DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001)"
            );
        }
    } catch (err) {
        // The operational store still opens fine without the migration — never
        // take the server down over a best-effort data copy.
        logger.warn({ err }, "migrate-legacy: flat→namespaced migration failed; continuing with the canonical store only");
    }
}
