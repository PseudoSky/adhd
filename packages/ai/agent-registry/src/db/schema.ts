import {
    index,
    integer,
    sqliteTable,
    text
} from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────
// @adhd/agent-registry — table prefix: registry_
//
// Decision 1 (decisions.md): all tables in this package use the `registry_`
// prefix. Cross-package FKs are logical only (plain text columns, no
// .references() across prefixes). In-package FKs use .references() normally.
//
// Tables are added by later plan states:
//   - lookup-and-component-schema  → registry_prompt_types, registry_prompt_components
//   - agents-table                 → registry_agents
//   - composition-junction         → registry_agent_components
//   - usecase-and-context-rules    → registry_context_rules
//   - composed-prompts             → registry_composed_prompts
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// registry_prompt_types
//
// Lookup table for prompt component types. Text PK (slug), not a SQL enum —
// new types are added by inserting a row, no migration needed.
// [inv:lookup-not-enum] (decisions.md)
// ──────────────────────────────────────────────
export const promptTypesTable = sqliteTable("registry_prompt_types", {
    slug: text("slug").primaryKey(),
    description: text("description").notNull(),
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
});

// ──────────────────────────────────────────────
// registry_prompt_components
//
// Versioned prompt component table. PK is (slug, version) so old versions are
// retained for audit/rollback — bumping version writes a new row, never mutates
// the prior one. [inv:version-retained] (decisions.md)
// FK to registry_prompt_types.slug is an in-package reference (.references()).
// ──────────────────────────────────────────────
export const promptComponentsTable = sqliteTable(
    "registry_prompt_components",
    {
        slug: text("slug").notNull(),
        type: text("type")
            .notNull()
            .references(() => promptTypesTable.slug),
        version: integer("version").notNull().default(1),
        content: text("content").notNull(),
        isShared: integer("is_shared", { mode: "boolean" }).notNull().default(false),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (t) => ({
        pk: index("registry_prompt_components_pkey").on(t.slug, t.version),
        slugIdx: index("registry_prompt_components_slug_idx").on(t.slug),
        typeIdx: index("registry_prompt_components_type_idx").on(t.type),
    })
);
