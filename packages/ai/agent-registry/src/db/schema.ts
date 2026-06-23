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

// ──────────────────────────────────────────────
// registry_taxonomy_categories
//
// Hierarchical taxonomy for grouping agents. `position` (integer) replaces the
// `01-`/`02-` directory-prefix convention for ordering. `parent_slug` is a
// nullable self-FK enabling subcategory nesting (e.g. cto-system/).
// In-package self-FK: .references() is used normally within this prefix.
// ──────────────────────────────────────────────
export const taxonomyCategoriesTable = sqliteTable(
    "registry_taxonomy_categories",
    {
        slug: text("slug").primaryKey(),
        name: text("name").notNull(),
        description: text("description").notNull().default(""),
        position: integer("position").notNull().default(0),
        // nullable self-FK for subcategories
        parentSlug: text("parent_slug").references(
            (): ReturnType<typeof text> => taxonomyCategoriesTable.slug
        ),
    },
    (t) => ({
        positionIdx: index("registry_taxonomy_categories_position_idx").on(t.position),
        parentIdx: index("registry_taxonomy_categories_parent_idx").on(t.parentSlug),
    })
);

// ──────────────────────────────────────────────
// registry_agents
//
// Agent identity rows. Holds metadata only — no prompt text.
// `model_hint` is plain TEXT (a canonical model id); NOT an FK onto any
// provider table. Cross-package resolution happens at compile time in
// @adhd/agent-provider; Decision 1 forbids cross-package SQLite FKs.
// `taxonomy_category` is an in-package FK → registry_taxonomy_categories.slug.
// ──────────────────────────────────────────────
export const agentsTable = sqliteTable(
    "registry_agents",
    {
        slug: text("slug").primaryKey(),
        displayName: text("display_name").notNull(),
        description: text("description").notNull().default(""),
        // 'draft' | 'active' | 'deprecated' — plain TEXT, not a SQL enum.
        // New statuses are added by convention, no migration needed.
        // [inv:lookup-not-enum] (contexts/_shared.md)
        status: text("status").notNull().default("draft"),
        // Canonical model id string resolved at compile time by @adhd/agent-provider.
        // NO cross-package FK (Decision 1: decisions.md).
        modelHint: text("model_hint"),
        // In-package FK to registry_taxonomy_categories.slug.
        taxonomyCategory: text("taxonomy_category").references(
            () => taxonomyCategoriesTable.slug
        ),
        // 'approve' | 'needs_work' — plain TEXT
        defaultPosture: text("default_posture").notNull().default("needs_work"),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (t) => ({
        statusIdx: index("registry_agents_status_idx").on(t.status),
        categoryIdx: index("registry_agents_category_idx").on(t.taxonomyCategory),
    })
);
