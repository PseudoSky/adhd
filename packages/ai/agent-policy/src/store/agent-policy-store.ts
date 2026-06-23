import { eq } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBetterSQLite3Database = import("drizzle-orm/better-sqlite3").BetterSQLite3Database<any>;

import { agentPoliciesTable } from "../db/schema.js";
import { PolicyError } from "./policy-template-store.js";

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export type AgentPolicyErrorCode = "AGENT_POLICY_ALREADY_ATTACHED";

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
     * In the `policy-inheritance` state a `resolveForAgent` method is added that
     * also fans in category-inherited policies (lazy join). This method returns
     * only the rows stored directly against the agent — sufficient for the
     * direct-attach tests (`agent-policy-junction` acceptance criteria).
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
