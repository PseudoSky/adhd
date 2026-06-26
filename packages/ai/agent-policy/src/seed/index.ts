/**
 * Policy library seeder — populates `policy_policy_types` and
 * `policy_policy_templates` idempotently.
 *
 * `seed(db)` is safe to call multiple times on the same database:
 *  - Types use `INSERT OR IGNORE` (ON CONFLICT DO NOTHING).
 *  - Templates use `INSERT OR IGNORE` (ON CONFLICT DO NOTHING).
 *  - A second call is a genuine no-op — no version bump, no duplicate rows,
 *    no error. [seed-and-roundtrip.1]
 *
 * The caller is responsible for running migrations BEFORE calling `seed()`.
 *
 * @example
 * ```ts
 * import Database from "better-sqlite3";
 * import { drizzle } from "drizzle-orm/better-sqlite3";
 * import { runMigrationsOn } from "@adhd/agent-policy/db/migrate-runner";
 * import { seed } from "@adhd/agent-policy";
 * import * as schema from "@adhd/agent-policy/db/schema";
 *
 * const sqlite = new Database("./data/agents.db");
 * const db = drizzle(sqlite, { schema });
 * runMigrationsOn(sqlite, db);
 * seed(db);
 * ```
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBetterSQLite3Database = import("drizzle-orm/better-sqlite3").BetterSQLite3Database<any>;

import { policyTypesTable, policyTemplatesTable } from "../db/schema.js";
import { POLICY_TYPES } from "./policy-types.js";
import { POLICY_TEMPLATES } from "./policy-templates.js";

/**
 * Idempotently insert all canonical policy types and system templates.
 *
 * Uses `onConflictDoNothing()` (Drizzle's typed wrapper for `INSERT OR IGNORE`)
 * so re-running is always safe: no duplicate rows, no errors, version unchanged.
 *
 * @param db — a Drizzle `BetterSQLite3Database` instance with migrations applied.
 */
export function seed(db: AnyBetterSQLite3Database): void {
    // 1. Policy types first (templates FK into this table).
    for (const typeRow of POLICY_TYPES) {
        db.insert(policyTypesTable)
            .values(typeRow)
            .onConflictDoNothing()
            .run();
    }

    // 2. Policy templates — one upsert per template.
    for (const tmpl of POLICY_TEMPLATES) {
        db.insert(policyTemplatesTable)
            .values({
                slug:        tmpl.slug,
                type:        tmpl.type,
                description: tmpl.description,
                // drizzle `text({ mode: "json" })` serialises automatically.
                rules:       tmpl.rules as unknown as string,
                enforcement: tmpl.enforcement as unknown as string,
                version:     tmpl.version,
                isSystem:    tmpl.isSystem,
            })
            .onConflictDoNothing()
            .run();
    }
}

export { POLICY_TYPES } from "./policy-types.js";
export { POLICY_TEMPLATES } from "./policy-templates.js";
