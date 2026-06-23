import {
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    uniqueIndex
} from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────
// @adhd/agent-registry — table prefix: registry_
//
// Decision 1 (decisions.md): all tables in this package use the `registry_`
// prefix. Cross-package FKs are logical only (plain text columns, no
// .references() across prefixes). In-package FKs use .references() normally.
//
// Tables are added by later plan states:
//   - lookup-and-component-schema  → registry_prompt_types,
//                                    registry_components (head) +
//                                    registry_component_versions (history)
//   - agents-table                 → registry_agents
//   - composition-junction         → registry_agent_components
//   - usecase-and-context-rules    → registry_context_rules
//   - composed-prompts             → registry_composed_prompts
//
// Decision 5 (decisions.md): component IDENTITY (registry_components, keyed by a
// single-column text PK `slug`) is split from component HISTORY
// (registry_component_versions, keyed by a single-column surrogate `version_id`).
// This makes `slug` and `version_id` real single-column PKs that downstream tables
// can target with ENFORCED Drizzle .references() FKs — the integrity the old
// (slug, version) composite-PK table could not provide.
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
// registry_components  (component IDENTITY / head)
//
// Decision 5 (decisions.md): the IDENTITY half of the head/version split. One row
// per component slug. `slug` is a single-column TEXT PRIMARY KEY — this is the
// stable identity every other table FKs onto (which the old (slug, version)
// composite-PK table made impossible).
//
// `type` and `is_shared` are IDENTITY-level facts: they describe what the
// component IS, not what any particular revision says, so they live on the head
// row and do not change per version.
//
// `type` is an in-package FK → registry_prompt_types.slug (.references(), enforced).
// ──────────────────────────────────────────────
export const componentsTable = sqliteTable(
    "registry_components",
    {
        slug: text("slug").primaryKey(),
        type: text("type")
            .notNull()
            .references(() => promptTypesTable.slug),
        isShared: integer("is_shared", { mode: "boolean" }).notNull().default(false),
        createdAt: text("created_at").notNull(),
    },
    (t) => ({
        typeIdx: index("registry_components_type_idx").on(t.type),
    })
);

// ──────────────────────────────────────────────
// registry_component_versions  (component HISTORY / audit)
//
// Decision 5 (decisions.md): the HISTORY half of the head/version split. One row
// per (slug, version). `version_id` is a single-column autoincrement SURROGATE
// PRIMARY KEY so a junction row's version_pin can be an ENFORCED FK to exactly one
// version row (a composite (slug, version) target could not be FK'd).
//
// Old versions are retained for audit/rollback — bumping a component writes a NEW
// row at max(version)+1 for the slug; it never mutates a prior row.
// [inv:version-retained] (decisions.md)
//
// `slug` is an in-package FK → registry_components.slug (.references(), enforced):
// a version row cannot exist without its head identity row.
// UNIQUE(slug, version) is a REAL unique index — it gives [inv:version-retained]
// its teeth (a duplicate (slug, version) write THROWS) and guarantees version_pin
// resolution is unambiguous.
// ──────────────────────────────────────────────
export const componentVersionsTable = sqliteTable(
    "registry_component_versions",
    {
        versionId: integer("version_id").primaryKey({ autoIncrement: true }),
        slug: text("slug")
            .notNull()
            .references(() => componentsTable.slug),
        version: integer("version").notNull().default(1),
        content: text("content").notNull(),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (t) => ({
        slugVersionUq: uniqueIndex("registry_component_versions_slug_version_uq").on(
            t.slug,
            t.version
        ),
        slugIdx: index("registry_component_versions_slug_idx").on(t.slug),
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
// registry_use_cases  (usecase-and-context-rules state)
//
// Seed data for the future suggestion engine (GOAL.md "Knowledge Graph").
// Represents named scenarios components can be tagged against — e.g. code-review,
// security-audit, data-migration. Annotation only; does NOT affect runtime composition.
// ──────────────────────────────────────────────
export const useCasesTable = sqliteTable("registry_use_cases", {
    slug: text("slug").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
});

// ──────────────────────────────────────────────
// registry_component_usage  (usecase-and-context-rules state)
//
// Junction: (component_slug, use_case_slug) with an optional numeric weight.
// Records which prompt components are valuable in which scenarios.
// ANNOTATION ONLY — must NOT be on resolveComposition's hot path. This table
// informs the future suggestion engine (GOAL.md "Knowledge Graph"), not runtime assembly.
//
// component_slug is now an ENFORCED in-package FK → registry_components.slug
// (.references()). Decision 5's head/version split made registry_components.slug a
// single-column PK, so SQLite can enforce this — annotating a component that has no
// head identity row now THROWS instead of silently inserting an orphan.
// use_case_slug is an in-package FK → registry_use_cases.slug (.references() used normally).
// ──────────────────────────────────────────────
export const componentUsageTable = sqliteTable(
    "registry_component_usage",
    {
        componentSlug: text("component_slug")
            .notNull()
            .references(() => componentsTable.slug),
        useCaseSlug: text("use_case_slug")
            .notNull()
            .references(() => useCasesTable.slug),
        // Optional weight for future ranking/suggestion logic. Higher = more valuable.
        weight: integer("weight"),
    },
    (t) => ({
        pk: primaryKey({ columns: [t.componentSlug, t.useCaseSlug] }),
        useCaseIdx: index("registry_component_usage_use_case_idx").on(t.useCaseSlug),
        componentIdx: index("registry_component_usage_component_idx").on(t.componentSlug),
    })
);

// ──────────────────────────────────────────────
// registry_context_rules  (usecase-and-context-rules state)
//
// Free-standing additive inclusion rules: "for agent X, when condition Y,
// additionally include component Z."
//
// Decision 3 (decisions.md): KEEP BOTH tables. This is DISTINCT from
// registry_agent_components.context_condition (junction-level). A junction row
// asks "is this already-attached component included?"; a context_rules row asks
// "does this agent gain a component it does NOT permanently own when Y holds?"
//
// Evaluation (Decision 3 §"Binding unification rules"):
//   - Same JSON-predicate format as context_condition on the junction.
//   - Same evaluator function: evaluateCondition() from composition-store.ts.
//   - Resolution = (matching junction components) ∪ (components added by matching rules).
//   - If the same component_slug arrives from both sources, the junction row wins for
//     position / version_pin / is_required (the explicit attachment is authoritative).
//   - A context_rules row can only ADD; it cannot make a junction row optional/required.
//
// position: an integer ordering key used when merging into Decision 2's total order.
//   null = append at end (implementation detail for agent-compiler).
//
// agent_slug: logical FK → registry_agents.slug. In-package but we use .references()
//   as it IS within the same prefix, so in-package FK rules apply (Decision 1 §3).
// component_slug: now an ENFORCED FK → registry_components.slug (Decision 5). A rule
//   that adds a nonexistent component now THROWS at insert instead of silently
//   creating an orphan additive rule.
// ──────────────────────────────────────────────
export const contextRulesTable = sqliteTable(
    "registry_context_rules",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        agentSlug: text("agent_slug")
            .notNull()
            .references(() => agentsTable.slug),
        // JSON predicate in the same format as context_condition on the junction.
        // Evaluated by evaluateCondition() (composition-store.ts) — same evaluator,
        // never a separate one. [Decision 3: one predicate shape, one evaluator]
        condition: text("condition").notNull(),
        componentSlug: text("component_slug")
            .notNull()
            .references(() => componentsTable.slug),
        // Position for merging into the Decision 2 total order. null = append.
        position: integer("position"),
    },
    (t) => ({
        agentIdx: index("registry_context_rules_agent_idx").on(t.agentSlug),
        componentIdx: index("registry_context_rules_component_idx").on(t.componentSlug),
    })
);

// ──────────────────────────────────────────────
// registry_composed_prompts  (composed-prompt-cache state)
//
// Cache + audit table for assembled prompts.
// [def:composed-prompt] (contexts/_shared.md)
//
// `context_hash` is the SHA-256 of the sorted-key JSON canonicalization of the
// runtime context map used at assembly time. Same inputs in any key order →
// identical hash. This makes (agent_slug, context_hash) an O(1) cache key.
// Index on (agent_slug, context_hash) supports the lookup hot-path.
//
// `component_versions` is a JSON map `{componentSlug: version}` recording the
// exact component version resolved during assembly — the audit trail GOAL.md
// "Audit Trail" depends on (Decision 4, decisions.md). A cache miss (or a new
// unpinned component advancing to a later version) triggers a new write.
//
// agent_slug is a LOGICAL FK only (no .references()) — cross-concern, same as
// the pattern in registry_context_rules for cross-prefix references. The store
// layer enforces the link at write time.
// ──────────────────────────────────────────────
export const composedPromptsTable = sqliteTable(
    "registry_composed_prompts",
    {
        id: integer("id").primaryKey({ autoIncrement: true }),
        agentSlug: text("agent_slug").notNull(),
        // SHA-256 of sorted-key JSON canonicalization of the context inputs.
        // Same map with different key orderings → same hash. [ref: contextHash helper]
        contextHash: text("context_hash").notNull(),
        // The final flat assembled prompt text.
        content: text("content").notNull(),
        // JSON object: { [componentSlug]: version } — full audit record.
        // Proves exactly which component versions produced this composed prompt.
        componentVersions: text("component_versions").notNull(),
        createdAt: text("created_at").notNull(),
    },
    (t) => ({
        // O(1) cache lookup: (agent_slug, context_hash) index.
        agentHashIdx: index("registry_composed_prompts_agent_hash_idx").on(
            t.agentSlug,
            t.contextHash
        ),
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
//   - version_pin: null → resolve latest-at-resolve-time (Decision 4).
//                  int  → a registry_component_versions.version_id — pin to exactly
//                         that version row (Decision 4 + Decision 5).
//   - context_condition: nullable JSON predicate; null = always include.
//     Evaluated by CompositionStore.resolveComposition per Decision 2:
//     every key in the predicate must equal the corresponding context value.
//   - is_required: true AND condition does not match → CompositionError thrown.
//
// THREE FKs, all DB-enforced (Decision 5):
//   - agent_slug   → registry_agents.slug (always-enforced).
//   - component_slug → registry_components.slug (always-enforced): a junction row
//       cannot reference a component that has no head identity row.
//   - version_pin  → registry_component_versions.version_id (NULLABLE-enforced):
//       null = resolve latest at resolve-time; a non-null value MUST name an
//       existing version row.
//
// Two SEPARATE FKs are used (component_slug always-enforced + version_pin
// nullable-enforced), NOT one composite FK: in SQLite a composite FK whose set of
// columns includes a NULL column is treated as satisfied (not enforced), so a
// composite (component_slug, version_pin) FK would lose enforcement for the common
// null-pin case. Splitting them keeps component_slug strictly enforced while
// letting version_pin be null-or-valid.
// ──────────────────────────────────────────────
export const agentComponentsTable = sqliteTable(
    "registry_agent_components",
    {
        agentSlug: text("agent_slug")
            .notNull()
            .references(() => agentsTable.slug),
        componentSlug: text("component_slug")
            .notNull()
            .references(() => componentsTable.slug),
        // Assembly ordering key — NOT a unique slot. Decision 2: position ASC
        // is the primary sort; ties broken by (version DESC, component_slug ASC).
        position: integer("position").notNull(),
        // null = latest-at-resolve; integer = a registry_component_versions.version_id
        // pinning that exact version row. [Decision 4 + Decision 5]
        versionPin: integer("version_pin").references(
            () => componentVersionsTable.versionId
        ),
        // JSON predicate object as text, e.g. '{"ticket_type":"security"}'.
        // null means always include. [def:context-condition]
        contextCondition: text("context_condition"),
        // 1 = required; if condition filters this row out → CompositionError.
        isRequired: integer("is_required", { mode: "boolean" }).notNull().default(false),
    },
    (t) => ({
        // Composite PK: (agent_slug, component_slug, position) per DATA_MODEL.md Domain 1.
        pk: primaryKey({ columns: [t.agentSlug, t.componentSlug, t.position] }),
        agentIdx: index("registry_agent_components_agent_idx").on(t.agentSlug),
        positionIdx: index("registry_agent_components_position_idx").on(
            t.agentSlug,
            t.position
        ),
    })
);
