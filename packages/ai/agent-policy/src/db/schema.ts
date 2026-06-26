import {
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
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

// ──────────────────────────────────────────────
// policy_category_policies  (category→policy attachment)
// ──────────────────────────────────────────────
// Stores the lazy category-level policy attachments.  When a policy is attached
// to a taxonomy category, a single row lands here — NOT fan-outed to per-agent
// rows.  `resolveForAgent` joins this table against `policy_agent_categories` at
// query time to compute inherited policies. [Decision 1 — LAZY]
//
// `category_slug` is a LOGICAL reference to the taxonomy-category slug owned by
// `agent-registry-schema` — plain text, no cross-prefix SQLite FK. [Decision 0]
// `policy_slug` IS a real in-package FK → policy_policy_templates.slug.
export const categoryPoliciesTable = sqliteTable(
    "policy_category_policies",
    {
        // Logical cross-package reference — plain text, no .references().
        categorySlug: text("category_slug").notNull(),
        // In-package FK → policy_policy_templates.slug (real Drizzle FK).
        policySlug:   text("policy_slug")
                          .notNull()
                          .references(() => policyTemplatesTable.slug),
        // SQLite boolean: 1 = this policy is mandatory for every member agent.
        isMandatory:  integer("is_mandatory", { mode: "boolean" }).notNull().default(false),
    },
    (table) => [
        // Composite PK — one row per (category, policy) pair.
        primaryKey({ columns: [table.categorySlug, table.policySlug] }),
        // Look up all policies for a given category.
        index("idx_category_policies_category_slug").on(table.categorySlug),
    ]
);

// ──────────────────────────────────────────────
// policy_agent_categories  (agent↔category membership)
// ──────────────────────────────────────────────
// Records which taxonomy categories an agent belongs to.  This is the minimal
// local membership table for the lazy resolver; it does NOT redefine taxonomy
// tables — `category_slug` and `agent_slug` are both logical (plain text) refs
// to slugs owned by `agent-registry-schema`. [Decision 0, no cross-prefix FK]
//
// The resolver (resolveForAgent) joins this table against
// `policy_category_policies` at query time to fan category-level policies into
// per-agent resolved rows, each carrying `inherited_from = category_slug`.
// A new agent added to a category AFTER the policy was attached inherits
// automatically on the next `resolveForAgent` call — no re-fanout needed.
export const agentCategoriesTable = sqliteTable(
    "policy_agent_categories",
    {
        // Logical cross-package reference — plain text, no .references().
        agentSlug:    text("agent_slug").notNull(),
        // Logical cross-package reference — plain text, no .references().
        categorySlug: text("category_slug").notNull(),
    },
    (table) => [
        // Composite PK — an agent may belong to a category only once.
        primaryKey({ columns: [table.agentSlug, table.categorySlug] }),
        // Dominant read: "which categories does this agent belong to?"
        index("idx_agent_categories_agent_slug").on(table.agentSlug),
    ]
);

// ──────────────────────────────────────────────
// policy_agent_policies  (agent↔policy junction)
// ──────────────────────────────────────────────
// Attaches a policy template to an agent (directly or via category inheritance).
//
// CRITICAL: `agent_slug` is a LOGICAL reference to the agent-registry package's
// `registry_agents.slug` column — it is plain text, NOT a SQLite FK.  No
// cross-package foreign keys are allowed. [Decision 0, inv:no-cross-pkg-fk]
//
// `policy_slug` IS a real in-package FK → policy_policy_templates.slug.
//
// `inherited_from` is the taxonomy category slug a policy cascaded from, or NULL
// when attached directly to the agent. It is a plain text column (logical ref to
// agent-registry's taxonomy categories — no cross-prefix FK). [Decision 1]
//
// Composite PK uses a real `primaryKey({columns})`, never a non-unique index.
// Exported as `agentPoliciesTable`; the underlying SQL table name is
// `policy_agent_policies` (policy_ prefix per package convention).
// @alias agentPolicy agentPolicies agent_policy_junction
export const agentPoliciesTable = sqliteTable(
    "policy_agent_policies",
    {
        // Logical cross-package reference — plain text, no .references().
        agentSlug:      text("agent_slug").notNull(),
        // In-package FK → policy_policy_templates.slug (real Drizzle FK).
        policySlug:     text("policy_slug")
                            .notNull()
                            .references(() => policyTemplatesTable.slug),
        // Per-agent JSON customising the template's rules (shallow-merge semantics
        // per Decision 3). NULL means "use the template unchanged."
        overrideConfig: text("override_config", { mode: "json" }),
        // SQLite boolean: 1 = this policy is mandatory for the agent.
        isMandatory:    integer("is_mandatory", { mode: "boolean" }).notNull().default(false),
        // NULL = attached directly; non-NULL = category slug it cascaded from.
        // Plain text (logical cross-package ref) — no .references(). [Decision 1]
        inheritedFrom:  text("inherited_from"),
    },
    (table) => [
        // Composite PK — one row per (agent, policy) pair.
        primaryKey({ columns: [table.agentSlug, table.policySlug] }),
        // Look up all policies for a given agent (dominant query pattern).
        index("idx_agent_policies_agent_slug").on(table.agentSlug),
    ]
);
