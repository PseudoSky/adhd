import { eq } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { contextRulesTable, componentUsageTable, useCasesTable } from "../db/schema.js";

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export class UseCaseError extends Error {
    constructor(
        public readonly code:
            | "USE_CASE_NOT_FOUND"
            | "USE_CASE_ALREADY_EXISTS",
        message: string
    ) {
        super(message);
        this.name = "UseCaseError";
    }
}

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

export interface UseCase {
    slug: string;
    name: string;
    description: string;
}

export interface UseCaseCreateInput {
    slug: string;
    name: string;
    description?: string;
}

/**
 * One row from registry_component_usage with its optional weight.
 *
 * ANNOTATION ONLY — not on resolveComposition's hot path.
 * Used by the future suggestion engine (GOAL.md "Knowledge Graph").
 */
export interface ComponentUsageRow {
    componentSlug: string;
    useCaseSlug: string;
    /** Optional numeric weight for ranking/suggestion. Higher = more valuable. */
    weight: number | null;
}

/**
 * One row from registry_context_rules.
 *
 * An additive rule: "for agent X, when condition Y, also include component Z."
 * Evaluated by the same evaluateCondition() predicate used for junction-level
 * context_condition (Decision 3, decisions.md: one predicate shape, one evaluator).
 */
export interface ContextRule {
    id: number;
    agentSlug: string;
    /** JSON predicate — same format as context_condition on agent_components. */
    condition: string;
    componentSlug: string;
    /** Ordering position for merging into Decision 2's total order. null = append. */
    position: number | null;
}

export interface ContextRuleCreateInput {
    agentSlug: string;
    /** JSON predicate string. */
    condition: string;
    componentSlug: string;
    position?: number | null;
}

// ──────────────────────────────────────────────
// UseCaseStore
//
// Thin Drizzle wrapper for registry_use_cases, registry_component_usage, and
// registry_context_rules. Annotation + rule management only — keeps annotation
// data out of resolveComposition's hot path (composition-store.ts).
// [ref:store-class] (contexts/_shared.md)
// ──────────────────────────────────────────────

export class UseCaseStore {
    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private readonly db: BetterSQLite3Database<any>
    ) {}

    // ── Use-case CRUD ─────────────────────────────────────────────────────────

    /**
     * Create a new use-case row. Throws USE_CASE_ALREADY_EXISTS if the slug
     * is already taken (slug is the PK).
     */
    createUseCase(input: UseCaseCreateInput): UseCase {
        const row = {
            slug: input.slug,
            name: input.name,
            description: input.description ?? "",
        };

        this.db.insert(useCasesTable).values(row).run();
        return row;
    }

    /** Return a single use-case by slug, or undefined if it does not exist. */
    getUseCase(slug: string): UseCase | undefined {
        const row = this.db
            .select()
            .from(useCasesTable)
            .where(eq(useCasesTable.slug, slug))
            .get();

        if (!row) return undefined;
        return { slug: row.slug, name: row.name, description: row.description };
    }

    /** Return all use-case rows ordered by slug. */
    listUseCases(): UseCase[] {
        return this.db
            .select()
            .from(useCasesTable)
            .all()
            .map((r) => ({ slug: r.slug, name: r.name, description: r.description }));
    }

    // ── Component-usage (annotation junction) ────────────────────────────────

    /**
     * Link a prompt component to a use-case with an optional weight.
     *
     * ANNOTATION ONLY — this has no effect on resolveComposition's hot path.
     * Duplicate (component_slug, use_case_slug) pairs will cause a unique-constraint
     * violation if the migration creates a unique index; callers should guard.
     *
     * @param componentSlug - The component to annotate (logical FK).
     * @param useCaseSlug   - The use-case to associate with (FK → registry_use_cases).
     * @param weight        - Optional numeric weight for suggestion ranking.
     */
    linkComponent(componentSlug: string, useCaseSlug: string, weight?: number): ComponentUsageRow {
        const row = {
            componentSlug,
            useCaseSlug,
            weight: weight ?? null,
        };

        this.db.insert(componentUsageTable).values(row).run();
        return row;
    }

    /**
     * Return all component-usage rows for a given use-case slug.
     *
     * Used by the suggestion engine to find which components are valuable for a
     * given scenario. NOT called during runtime prompt assembly.
     */
    componentsFor(useCaseSlug: string): ComponentUsageRow[] {
        return this.db
            .select()
            .from(componentUsageTable)
            .where(eq(componentUsageTable.useCaseSlug, useCaseSlug))
            .all()
            .map((r) => ({
                componentSlug: r.componentSlug,
                useCaseSlug: r.useCaseSlug,
                weight: r.weight,
            }));
    }

    // ── Context rules ─────────────────────────────────────────────────────────

    /**
     * Add a context rule: "for agent X, when condition Y, additionally include component Z."
     *
     * The condition must be a valid JSON predicate string in the same format as
     * registry_agent_components.context_condition — evaluated by the same
     * evaluateCondition() function (Decision 3, decisions.md: one predicate, one evaluator).
     *
     * @param input.agentSlug      - The agent this rule applies to (in-package FK).
     * @param input.condition      - JSON predicate string, e.g. '{"ticket_type":"security"}'.
     * @param input.componentSlug  - The component to additionally include (logical FK).
     * @param input.position       - Optional ordering position for merging with Decision 2's order.
     */
    addContextRule(input: ContextRuleCreateInput): ContextRule {
        const result = this.db
            .insert(contextRulesTable)
            .values({
                agentSlug: input.agentSlug,
                condition: input.condition,
                componentSlug: input.componentSlug,
                position: input.position ?? null,
            })
            .returning({ id: contextRulesTable.id })
            .get();

        return {
            id: result!.id,
            agentSlug: input.agentSlug,
            condition: input.condition,
            componentSlug: input.componentSlug,
            position: input.position ?? null,
        };
    }

    /**
     * Return all context rules for a given agent slug.
     *
     * Used by the composition engine (agent-compiler) to discover which additive
     * rules apply to an agent and merge them into the resolved composition per
     * Decision 3 (decisions.md §"Additive, then deduplicated").
     */
    contextRulesFor(agentSlug: string): ContextRule[] {
        return this.db
            .select()
            .from(contextRulesTable)
            .where(eq(contextRulesTable.agentSlug, agentSlug))
            .all()
            .map((r) => ({
                id: r.id,
                agentSlug: r.agentSlug,
                condition: r.condition,
                componentSlug: r.componentSlug,
                position: r.position,
            }));
    }
}
