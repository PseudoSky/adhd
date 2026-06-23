import {
    index,
    integer,
    primaryKey,
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
