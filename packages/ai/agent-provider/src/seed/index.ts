import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { seedBindings } from "./bindings.js";
import { seedModels } from "./models.js";
import { seedProviders } from "./providers.js";

// ──────────────────────────────────────────────
// Unified seeder — providers, models, bindings
//
// Call seed(db) once to populate all lookup tables.  A second call is a no-op
// (INSERT OR IGNORE on every table) — row counts remain identical, no version
// drift ([inv:reopen-proves-persistence], [dod.3]).
//
// Ordering: providers → models → bindings (logical dependency order, though
// there are no SQL FKs in the shared-DB topology).
// ──────────────────────────────────────────────

/**
 * Idempotent seeder for all agent-provider lookup tables.
 *
 * Safe to call on every process start.  Subsequent runs after the first are
 * silent no-ops: each insert uses `onConflictDoNothing()` so duplicate rows
 * are never written and counts never change.
 */
export function seed(db: BetterSQLite3Database<Record<string, never>>): void {
    seedProviders(db);
    seedModels(db);
    seedBindings(db);
}

export { seedProviders, SEEDED_PROVIDER_IDS } from "./providers.js";
export { seedModels, MODEL_ROWS, SEEDED_MODEL_IDS } from "./models.js";
export { seedBindings, BINDING_ROWS } from "./bindings.js";
