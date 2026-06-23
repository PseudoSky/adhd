import { eq } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBetterSQLite3Database = import("drizzle-orm/better-sqlite3").BetterSQLite3Database<any>;

import { policyTemplatesTable } from "../db/schema.js";

// ──────────────────────────────────────────────
// Error codes local to agent-policy
// ──────────────────────────────────────────────

export type PolicyErrorCode =
    | "POLICY_TEMPLATE_NOT_FOUND"
    | "POLICY_TEMPLATE_ALREADY_EXISTS";

/**
 * Typed error thrown by policy stores — mirrors the ToolError pattern from
 * agent-mcp but uses the policy-specific error code union.
 */
export class PolicyError extends Error {
    readonly code: PolicyErrorCode;
    readonly data?: unknown;

    constructor(code: PolicyErrorCode, message: string, data?: unknown) {
        super(message);
        this.name = "PolicyError";
        this.code = code;
        this.data = data;
    }
}

// ──────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────

/** A policy template as persisted and returned by {@link PolicyTemplateStore}. */
export interface PolicyTemplate {
    /** Unique identifier slug (text PK). */
    slug: string;
    /** FK to policy_policy_types.slug (plain text — no cross-prefix FK). */
    type: string;
    description: string;
    /** Structured rule parameters — deserialized from the JSON column. */
    rules: Record<string, unknown>;
    /**
     * One or more enforcement mechanism strings.
     * Always a JSON ARRAY — never a scalar string. [inv:enforcement-is-array]
     */
    enforcement: string[];
    /** Schema version; starts at 1. */
    version: number;
    /** True for system-owned templates (shipped with the package). */
    isSystem: boolean;
}

/**
 * Input for {@link PolicyTemplateStore.create}. `version` and `isSystem`
 * default to 1 / false when omitted.
 */
export type PolicyTemplateCreateInput = Omit<PolicyTemplate, "version" | "isSystem"> & {
    version?: number;
    isSystem?: boolean;
};

// ──────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────

/**
 * Thin Drizzle wrapper for the `policy_policy_templates` table.
 *
 * Mirrors `@adhd/agent-mcp`'s AgentStore pattern:
 *  - constructor takes a `BetterSQLite3Database` handle (caller owns lifecycle)
 *  - methods are synchronous Drizzle queries
 *  - errors throw {@link PolicyError} with typed codes
 */
export class PolicyTemplateStore {
    constructor(
        // Accept any schema parameter so callers can pass a schema-typed db
        // (e.g. drizzle(sqlite, { schema })) without a type-narrowing cast.
        private readonly db: AnyBetterSQLite3Database
    ) {}

    /**
     * Persist a new policy template.
     *
     * @throws {PolicyError} POLICY_TEMPLATE_ALREADY_EXISTS if the slug is taken.
     */
    create(input: PolicyTemplateCreateInput): PolicyTemplate {
        const existing = this.db
            .select()
            .from(policyTemplatesTable)
            .where(eq(policyTemplatesTable.slug, input.slug))
            .get();

        if (existing) {
            throw new PolicyError(
                "POLICY_TEMPLATE_ALREADY_EXISTS",
                `Policy template '${input.slug}' already exists`
            );
        }

        const row = {
            slug:        input.slug,
            type:        input.type,
            description: input.description,
            // drizzle `text({ mode: "json" })` serialises automatically when
            // passed an object/array value.
            rules:       input.rules as unknown as string,
            enforcement: input.enforcement as unknown as string,
            version:     input.version ?? 1,
            isSystem:    input.isSystem ?? false,
        };

        this.db.insert(policyTemplatesTable).values(row).run();

        return this._toTemplate(
            this.db
                .select()
                .from(policyTemplatesTable)
                .where(eq(policyTemplatesTable.slug, input.slug))
                .get()!
        );
    }

    /**
     * Retrieve a single template by slug.
     *
     * @throws {PolicyError} POLICY_TEMPLATE_NOT_FOUND if no such slug exists.
     */
    read(slug: string): PolicyTemplate {
        const row = this.db
            .select()
            .from(policyTemplatesTable)
            .where(eq(policyTemplatesTable.slug, slug))
            .get();

        if (!row) {
            throw new PolicyError(
                "POLICY_TEMPLATE_NOT_FOUND",
                `Policy template '${slug}' not found`
            );
        }

        return this._toTemplate(row);
    }

    /**
     * Return all templates, optionally filtered by `type` slug.
     *
     * @param typeFilter — when provided, only templates whose `type` matches
     *                     this slug are returned.
     */
    list(typeFilter?: string): PolicyTemplate[] {
        const rows = typeFilter
            ? this.db
                .select()
                .from(policyTemplatesTable)
                .where(eq(policyTemplatesTable.type, typeFilter))
                .all()
            : this.db
                .select()
                .from(policyTemplatesTable)
                .all();

        return rows.map(row => this._toTemplate(row));
    }

    // ── private helpers ──────────────────────────────────────────────────────

    private _toTemplate(
        row: typeof policyTemplatesTable.$inferSelect
    ): PolicyTemplate {
        return {
            slug:        row.slug,
            type:        row.type,
            description: row.description,
            // drizzle returns parsed JS value for `mode:"json"` columns.
            rules:       row.rules as unknown as Record<string, unknown>,
            enforcement: row.enforcement as unknown as string[],
            version:     row.version,
            isSystem:    Boolean(row.isSystem),
        };
    }
}
