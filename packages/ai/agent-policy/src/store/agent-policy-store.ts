import { eq } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBetterSQLite3Database = import("drizzle-orm/better-sqlite3").BetterSQLite3Database<any>;

import {
    agentCategoriesTable,
    agentPoliciesTable,
    categoryPoliciesTable,
} from "../db/schema.js";
import { PolicyError } from "./policy-template-store.js";

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export type AgentPolicyErrorCode =
    | "AGENT_POLICY_ALREADY_ATTACHED"
    | "CATEGORY_POLICY_ALREADY_ATTACHED"
    | "AGENT_CATEGORY_ALREADY_JOINED";

/**
 * Typed error thrown by {@link AgentPolicyStore} — mirrors the PolicyError
 * pattern but for junction-specific error codes.
 */
export class AgentPolicyError extends Error {
    readonly code: AgentPolicyErrorCode;
    readonly data?: unknown;

    constructor(code: AgentPolicyErrorCode, message: string, data?: unknown) {
        super(message);
        this.name = "AgentPolicyError";
        this.code = code;
        this.data = data;
    }
}

// Re-export so callers can import the base PolicyError from this module too.
export { PolicyError };

// ──────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────

/**
 * One resolved `policy_agent_policies` row as returned by
 * {@link AgentPolicyStore.listForAgent}.
 *
 * `overrideConfig` is the per-agent JSON customisation of the template's rules
 * (Decision 3: shallow-merge semantics). `null` means "use the template unchanged."
 *
 * `inheritedFrom` is the taxonomy category slug a policy cascaded from, or
 * `null` when attached directly to the agent. [Decision 1]
 */
export interface AgentPolicyRow {
    /** Logical reference to registry_agents.slug — no cross-package FK. */
    agentSlug: string;
    /** FK to policy_policy_templates.slug (in-package, real FK). */
    policySlug: string;
    /** Per-agent rule overrides (shallow-merge over template.rules). Null = no override. */
    overrideConfig: Record<string, unknown> | null;
    /** True when this policy must be enforced regardless of agent config. */
    isMandatory: boolean;
    /**
     * Category slug this policy cascaded from, or null if attached directly.
     * Direct-attach sets this to null. [Decision 1, inv:reopen-proves-persistence]
     */
    inheritedFrom: string | null;
}

/** Input for {@link AgentPolicyStore.attach} (direct-attach path). */
export interface AgentPolicyAttachInput {
    /** Slug of the agent to attach the policy to. */
    agentSlug: string;
    /** Slug of the policy template to attach. */
    policySlug: string;
    /** Optional per-agent override (shallow-merged over template.rules). */
    overrideConfig?: Record<string, unknown>;
    /** When true, this policy is mandatory. Defaults to false. */
    isMandatory?: boolean;
}

/**
 * Input for {@link AgentPolicyStore.attachToCategory}.
 *
 * Attaches a policy to a taxonomy category.  All agents that belong to the
 * category (now or in the future) will inherit this policy via the lazy
 * resolver — no fanout rows are written. [Decision 1]
 */
export interface CategoryPolicyAttachInput {
    /** Logical taxonomy category slug (cross-package ref, no FK). */
    categorySlug: string;
    /** Slug of the policy template to attach to the category. */
    policySlug: string;
    /** When true, every inheriting agent carries this as mandatory. */
    isMandatory?: boolean;
}

/**
 * One row returned by {@link AgentPolicyStore.attachToCategory} confirming the
 * category-level attachment was stored.
 */
export interface CategoryPolicyRow {
    categorySlug: string;
    policySlug:   string;
    isMandatory:  boolean;
}

/**
 * Input for {@link AgentPolicyStore.addAgentToCategory}.
 *
 * Records that `agentSlug` is a member of `categorySlug`.  At the next
 * `resolveForAgent` call the agent automatically inherits all policies
 * attached to that category. [Decision 1 — lazy, no re-fanout needed]
 */
export interface AgentCategoryInput {
    /** Logical agent slug (cross-package ref, no FK). */
    agentSlug: string;
    /** Logical taxonomy category slug (cross-package ref, no FK). */
    categorySlug: string;
}

// ──────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────

/**
 * Thin Drizzle wrapper for the `policy_agent_policies` junction table.
 *
 * Mirrors the `PolicyTemplateStore` / `agent-mcp` AgentStore pattern:
 *  - constructor takes a `BetterSQLite3Database` handle (caller owns lifecycle)
 *  - methods are synchronous Drizzle queries
 *  - errors throw {@link AgentPolicyError} with typed codes
 *
 * Direct-attach (`attach`) sets `inherited_from = NULL`.  Category inheritance
 * resolution (`resolveForAgent`, added in the `policy-inheritance` state) reads
 * the joined category membership at query time — lazy, per Decision 1.
 */
export class AgentPolicyStore {
    constructor(
        // Accept any schema parameter so callers can pass a schema-typed db
        // (e.g. drizzle(sqlite, { schema })) without a type-narrowing cast.
        private readonly db: AnyBetterSQLite3Database
    ) {}

    /**
     * Attach a policy template DIRECTLY to an agent (`inherited_from = null`).
     *
     * @throws {AgentPolicyError} AGENT_POLICY_ALREADY_ATTACHED when the
     *   (agentSlug, policySlug) pair already exists.
     */
    attach(input: AgentPolicyAttachInput): AgentPolicyRow {
        const existing = this.db
            .select()
            .from(agentPoliciesTable)
            .where(
                eq(agentPoliciesTable.agentSlug, input.agentSlug)
            )
            .all()
            .find((r: { policySlug: string }) => r.policySlug === input.policySlug);

        if (existing) {
            throw new AgentPolicyError(
                "AGENT_POLICY_ALREADY_ATTACHED",
                `Policy '${input.policySlug}' is already attached to agent '${input.agentSlug}'`
            );
        }

        const row = {
            agentSlug:      input.agentSlug,
            policySlug:     input.policySlug,
            // drizzle `text({ mode: "json" })` serialises automatically when
            // passed an object value; NULL is represented as null/undefined.
            overrideConfig: (input.overrideConfig ?? null) as unknown as string | null,
            isMandatory:    input.isMandatory ?? false,
            // Direct attach — NOT inherited from a category. [Decision 1]
            inheritedFrom:  null,
        };

        this.db.insert(agentPoliciesTable).values(row).run();

        return this._toRow(
            this.db
                .select()
                .from(agentPoliciesTable)
                .where(eq(agentPoliciesTable.agentSlug, input.agentSlug))
                .all()
                .find((r: { policySlug: string }) => r.policySlug === input.policySlug)!
        );
    }

    /**
     * Return all direct `policy_agent_policies` rows for the given agent slug.
     *
     * Returns only rows stored directly against the agent (`inherited_from IS NULL`
     * for direct-attach rows).  Use {@link resolveForAgent} to include inherited
     * policies from category membership.
     *
     * @param agentSlug — the slug of the agent whose policies to retrieve.
     */
    listForAgent(agentSlug: string): AgentPolicyRow[] {
        const rows = this.db
            .select()
            .from(agentPoliciesTable)
            .where(eq(agentPoliciesTable.agentSlug, agentSlug))
            .all();

        return rows.map((r: typeof agentPoliciesTable.$inferSelect) => this._toRow(r));
    }

    /**
     * Attach a policy template to a taxonomy CATEGORY (lazy inheritance).
     *
     * Stores a single `policy_category_policies` row — does NOT fan out rows to
     * individual agents.  Any agent already in or later added to the category
     * inherits this policy at the next `resolveForAgent` call. [Decision 1]
     *
     * @throws {AgentPolicyError} CATEGORY_POLICY_ALREADY_ATTACHED when the
     *   (categorySlug, policySlug) pair already exists.
     */
    attachToCategory(input: CategoryPolicyAttachInput): CategoryPolicyRow {
        const existing = this.db
            .select()
            .from(categoryPoliciesTable)
            .where(eq(categoryPoliciesTable.categorySlug, input.categorySlug))
            .all()
            .find(
                (r: { policySlug: string }) => r.policySlug === input.policySlug
            );

        if (existing) {
            throw new AgentPolicyError(
                "CATEGORY_POLICY_ALREADY_ATTACHED",
                `Policy '${input.policySlug}' is already attached to category '${input.categorySlug}'`
            );
        }

        const row = {
            categorySlug: input.categorySlug,
            policySlug:   input.policySlug,
            isMandatory:  input.isMandatory ?? false,
        };

        this.db.insert(categoryPoliciesTable).values(row).run();

        return {
            categorySlug: row.categorySlug,
            policySlug:   row.policySlug,
            isMandatory:  Boolean(row.isMandatory),
        };
    }

    /**
     * Record that an agent is a member of a taxonomy category.
     *
     * At the next `resolveForAgent` call the agent automatically inherits all
     * policies attached to the category — no re-fanout or migration needed.
     * This is the "agent added AFTER the category-attach" case from Decision 1.
     *
     * @throws {AgentPolicyError} AGENT_CATEGORY_ALREADY_JOINED when the
     *   (agentSlug, categorySlug) pair already exists.
     */
    addAgentToCategory(input: AgentCategoryInput): void {
        const existing = this.db
            .select()
            .from(agentCategoriesTable)
            .where(eq(agentCategoriesTable.agentSlug, input.agentSlug))
            .all()
            .find(
                (r: { categorySlug: string }) => r.categorySlug === input.categorySlug
            );

        if (existing) {
            throw new AgentPolicyError(
                "AGENT_CATEGORY_ALREADY_JOINED",
                `Agent '${input.agentSlug}' is already in category '${input.categorySlug}'`
            );
        }

        this.db
            .insert(agentCategoriesTable)
            .values({ agentSlug: input.agentSlug, categorySlug: input.categorySlug })
            .run();
    }

    /**
     * Resolve the complete effective policy set for an agent at query time.
     *
     * Returns a union of:
     *  1. Policies attached DIRECTLY to the agent (inheritedFrom = null).
     *  2. Policies inherited from every category the agent belongs to,
     *     synthesised as rows with inheritedFrom = categorySlug. [Decision 1]
     *
     * The join is performed at call time so newly added category policies or
     * membership changes are always reflected — there is no stale materialised
     * cache to invalidate.
     *
     * If an agent has a direct-attach for a policy AND inherits the same policy
     * from a category, the direct-attach row takes precedence (override wins).
     *
     * @param agentSlug — the slug of the agent to resolve policies for.
     */
    resolveForAgent(agentSlug: string): AgentPolicyRow[] {
        // 1. Direct-attach policies for this agent.
        const directRows = this.db
            .select()
            .from(agentPoliciesTable)
            .where(eq(agentPoliciesTable.agentSlug, agentSlug))
            .all() as (typeof agentPoliciesTable.$inferSelect)[];

        const directPolicySlugs = new Set(directRows.map(r => r.policySlug));

        // 2. Categories the agent belongs to.
        const categoryMemberships = this.db
            .select()
            .from(agentCategoriesTable)
            .where(eq(agentCategoriesTable.agentSlug, agentSlug))
            .all() as (typeof agentCategoriesTable.$inferSelect)[];

        // 3. For each category membership, fetch attached policies and synthesise
        //    inherited rows — skipping any policy already covered by a direct-attach
        //    (direct attachment wins per the override semantics).
        const inheritedRows: AgentPolicyRow[] = [];

        for (const membership of categoryMemberships) {
            const catPolicies = this.db
                .select()
                .from(categoryPoliciesTable)
                .where(eq(categoryPoliciesTable.categorySlug, membership.categorySlug))
                .all() as (typeof categoryPoliciesTable.$inferSelect)[];

            for (const catPolicy of catPolicies) {
                if (directPolicySlugs.has(catPolicy.policySlug)) {
                    // Direct-attach overrides; skip the inherited copy.
                    continue;
                }

                inheritedRows.push({
                    agentSlug:      agentSlug,
                    policySlug:     catPolicy.policySlug,
                    overrideConfig: null,
                    isMandatory:    Boolean(catPolicy.isMandatory),
                    // The key contract: inherited_from = the category slug. [Decision 1]
                    inheritedFrom:  catPolicy.categorySlug,
                });
            }
        }

        return [
            ...directRows.map(r => this._toRow(r)),
            ...inheritedRows,
        ];
    }

    // ── private helpers ──────────────────────────────────────────────────────

    private _toRow(
        row: typeof agentPoliciesTable.$inferSelect
    ): AgentPolicyRow {
        return {
            agentSlug:      row.agentSlug,
            policySlug:     row.policySlug,
            // drizzle returns parsed JS value for `mode:"json"` columns.
            overrideConfig: row.overrideConfig as Record<string, unknown> | null ?? null,
            isMandatory:    Boolean(row.isMandatory),
            inheritedFrom:  row.inheritedFrom ?? null,
        };
    }
}

/**
 * Compute effective rules by shallow-merging `overrideConfig` on top of
 * `templateRules`. Override keys replace template keys (arrays and nested
 * objects are replaced wholesale). An absent or empty override leaves the
 * template unchanged. [Decision 3]
 *
 * @param templateRules — the base rules object from `policy_policy_templates`.
 * @param overrideConfig — the per-agent override (may be null/undefined).
 * @returns the effective merged rules object.
 */
export function resolveEffectiveRules(
    templateRules: Record<string, unknown>,
    overrideConfig: Record<string, unknown> | null | undefined
): Record<string, unknown> {
    if (!overrideConfig || Object.keys(overrideConfig).length === 0) {
        return templateRules;
    }
    return { ...templateRules, ...overrideConfig };
}
