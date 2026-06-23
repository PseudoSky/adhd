import {
    index,
    integer,
    sqliteTable,
    text
} from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────
// policy_policy_types  (lookup — never a SQL enum)
// ──────────────────────────────────────────────
// Controlled-vocab slug values are seeded as rows, not baked into the
// column type.  New policy types are added by inserting a row, never by
// a migration altering the column. [inv:lookup-not-enum]
export const policyTypesTable = sqliteTable("policy_policy_types", {
    slug:        text("slug").primaryKey(),
    description: text("description").notNull(),
});

// ──────────────────────────────────────────────
// policy_policy_templates
// ──────────────────────────────────────────────
// Reusable rule definitions.  `rules` and `enforcement` are JSON columns:
//   - rules:       structured JSON object (policy-specific rule parameters)
//   - enforcement: JSON ARRAY of one or more mechanism strings
//                  e.g. ["agent","ci"] — NEVER a single scalar column.
//                  [inv:enforcement-is-array]
//
// `type` is an in-package FK to policy_policy_types.slug (real Drizzle FK).
// Cross-package references (e.g. agent_slug → registry_agents) are plain
// text columns — no cross-prefix FK. [decisions.md Decision 0]
export const policyTemplatesTable = sqliteTable(
    "policy_policy_templates",
    {
        slug:        text("slug").primaryKey(),
        // In-package FK — policy_policy_types lives in the same drizzle schema.
        type:        text("type")
                         .notNull()
                         .references(() => policyTypesTable.slug),
        description: text("description").notNull(),
        // Structured rule parameters — deserialized to an object on read.
        rules:       text("rules", { mode: "json" }).notNull(),
        // One or more enforcement mechanism strings stored as a JSON array.
        enforcement: text("enforcement", { mode: "json" }).notNull(),
        // Schema version; starts at 1, incremented on template update.
        version:     integer("version").notNull().default(1),
        // SQLite boolean: 1 = system-owned template (cannot be deleted by users).
        isSystem:    integer("is_system", { mode: "boolean" }).notNull().default(false),
    },
    (table) => [
        // Querying templates by type is the dominant read pattern.
        index("idx_policy_templates_type").on(table.type),
    ]
);
