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

// ──────────────────────────────────────────────
// registry_agent_components  (composition-junction state)
//
// Junction table binding agents to their ordered component set.
// [def:junction-row] (contexts/_shared.md)
//
// PK: (agent_slug, component_slug, position)
//   - position is an ORDERING key, not a unique slot — multiple components MAY
//     share the same position value (Decision 2: all-included, total order).
//   - version_pin: null → resolve to latest-at-resolve-time (Decision 4).
//                  int  → pin to exactly that version (Decision 4).
//   - context_condition: nullable JSON predicate; null = always include.
//     Evaluated by CompositionStore.resolveComposition per Decision 2:
//     every key in the predicate must equal the corresponding context value.
//   - is_required: true AND condition does not match → CompositionError thrown.
//
// agent_slug is an in-package FK → registry_agents.slug (Decision 1).
// component_slug is a LOGICAL FK only (no .references()) because SQLite does
// not enforce FKs against non-PK columns; the composite PK of
// registry_prompt_components is (slug, version), not slug alone.
// CompositionStore enforces the logical link at resolve time.
// ──────────────────────────────────────────────
export const agentComponentsTable = sqliteTable(
    "registry_agent_components",
    {
        agentSlug: text("agent_slug")
            .notNull()
            .references(() => agentsTable.slug),
        componentSlug: text("component_slug").notNull(),
        // Assembly ordering key — NOT a unique slot. Decision 2: position ASC
        // is the primary sort; ties broken by (version DESC, component_slug ASC).
        position: integer("position").notNull(),
        // null = latest-at-resolve; integer = pin to that exact version. [Decision 4]
        versionPin: integer("version_pin"),
        // JSON predicate object as text, e.g. '{"ticket_type":"security"}'.
        // null means always include. [def:context-condition]
        contextCondition: text("context_condition"),
        // 1 = required; if condition filters this row out → CompositionError.
        isRequired: integer("is_required", { mode: "boolean" }).notNull().default(false),
    },
    (t) => ({
        // Composite PK: (agent_slug, component_slug, position) per DATA_MODEL.md Domain 1.
        pk: index("registry_agent_components_pkey").on(
            t.agentSlug,
            t.componentSlug,
            t.position
        ),
        agentIdx: index("registry_agent_components_agent_idx").on(t.agentSlug),
        positionIdx: index("registry_agent_components_position_idx").on(
            t.agentSlug,
            t.position
        ),
    })
);
