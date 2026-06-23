import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────
// Tables will be added by subsequent plan states
// (define-schema, seed-data, etc.).
// ──────────────────────────────────────────────

// Placeholder export so this module is never empty;
// replaced by real table exports in the define-schema state.
export type SchemaTable = AnySQLiteTable;
