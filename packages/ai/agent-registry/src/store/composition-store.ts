import { asc, desc, eq, max } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { agentComponentsTable, promptComponentsTable } from "../db/schema.js";
import type { PromptComponent } from "./component-store.js";

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export class CompositionError extends Error {
    constructor(
        public readonly code:
            | "AGENT_NOT_FOUND"
            | "COMPONENT_VERSION_NOT_FOUND"
            | "REQUIRED_COMPONENT_EXCLUDED",
        message: string
    ) {
        super(message);
        this.name = "CompositionError";
    }
}

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

/**
 * A runtime context object — arbitrary key/value string pairs.
 * The context-condition evaluator checks that every key in a predicate
 * equals the corresponding value in the context (Decision 2, decisions.md).
 */
export type CompositionContext = Record<string, string>;

/** One row from registry_agent_components with its resolved component payload. */
export interface ResolvedComponent {
    /** The junction row's component slug. */
    componentSlug: string;
    /** Assembly ordering position from the junction row. */
    position: number;
    /** The actual version resolved (either pinned or latest-at-resolve-time). */
    resolvedVersion: number;
    /** The full component row at the resolved version. */
    component: PromptComponent;
}

// ──────────────────────────────────────────────
// Internal: context-condition predicate evaluator
//
// Shared single evaluator (Decision 3, decisions.md): used by both junction-level
// context_condition and (later) context_rules rows. Defined here as the canonical
// implementation so it can be imported wherever needed.
//
// Rule (Decision 2, decisions.md §"Binding evaluation rule"):
//   - condition IS NULL → always included (returns true).
//   - non-null JSON predicate → included iff EVERY key in the predicate equals
//     the corresponding value in ctx. Context keys not in the predicate are ignored.
// ──────────────────────────────────────────────

/**
 * Evaluate a context condition predicate against a runtime context.
 *
 * @param condition - JSON text predicate, or null for "always include".
 * @param ctx       - The runtime context key/value map.
 * @returns true if the component should be included for this context.
 */
export function evaluateCondition(
    condition: string | null,
    ctx: CompositionContext
): boolean {
    if (condition === null) {
        return true;
    }

    let predicate: Record<string, unknown>;
    try {
        predicate = JSON.parse(condition) as Record<string, unknown>;
    } catch {
        // Malformed JSON — treat as non-matching rather than throwing, so a
        // bad condition doesn't corrupt an unrelated agent's composition.
        // (Bad conditions on required rows will still surface as a REQUIRED_COMPONENT_EXCLUDED.)
        return false;
    }

    // Every key in the predicate must equal the corresponding ctx value.
    for (const [key, value] of Object.entries(predicate)) {
        if (ctx[key] !== value) {
            return false;
        }
    }

    return true;
}

// ──────────────────────────────────────────────
// CompositionStore
//
// Thin Drizzle wrapper for registry_agent_components.
// Single owner of ordering + version-pin + context-condition evaluation.
// [ref:store-class] (contexts/_shared.md)
// [Decision 2] All-included; total order (position ASC, version DESC, slug ASC).
// [Decision 4] version_pin: null = latest-at-resolve, int = exact pin.
// ──────────────────────────────────────────────

export class CompositionStore {
    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private readonly db: BetterSQLite3Database<any>
    ) {}

    /**
     * Attach a component to an agent at a given position.
     *
     * Inserts one row into registry_agent_components. No conflict handling —
     * callers must ensure the (agent_slug, component_slug, position) triple
     * is unique or use separate positions for multiple rows at the same position.
     */
    attach(input: {
        agentSlug: string;
        componentSlug: string;
        position: number;
        versionPin?: number | null;
        contextCondition?: string | null;
        isRequired?: boolean;
    }): void {
        this.db
            .insert(agentComponentsTable)
            .values({
                agentSlug: input.agentSlug,
                componentSlug: input.componentSlug,
                position: input.position,
                versionPin: input.versionPin ?? null,
                contextCondition: input.contextCondition ?? null,
                isRequired: input.isRequired ?? false,
            })
            .run();
    }

    /**
     * Resolve an agent's composition for a given runtime context.
     *
     * Steps (per composition-junction context + decisions.md):
     *  1. Read all junction rows for the agent ordered by position ASC.
     *  2. For each row, resolve the component version:
     *       - version_pin IS NULL  → latest version of that component slug.
     *       - version_pin IS INT   → exactly that version row.
     *  3. Evaluate context_condition with the shared predicate evaluator:
     *       - null condition → always included.
     *       - non-null JSON  → included iff every predicate key matches ctx.
     *     Exclude non-matching rows.
     *  4. If a row has is_required = true AND its condition did not match →
     *     throw CompositionError('REQUIRED_COMPONENT_EXCLUDED').
     *  5. Return the INCLUDED set ordered by:
     *       (position ASC, resolvedVersion DESC, componentSlug ASC)
     *     [Decision 2: total, stable, deterministic order]
     *
     * This is the single place ordering + filtering happen — do not duplicate.
     *
     * @param agentSlug - The agent whose composition to resolve.
     * @param ctx       - Runtime context key/value map.
     * @returns Ordered, filtered list of resolved components. NOT a rendered prompt.
     *          Markdown assembly is @adhd/agent-compiler's responsibility.
     */
    resolveComposition(
        agentSlug: string,
        ctx: CompositionContext = {}
    ): ResolvedComponent[] {
        // Step 1: read all junction rows for this agent, ordered by position ASC.
        const junctionRows = this.db
            .select()
            .from(agentComponentsTable)
            .where(eq(agentComponentsTable.agentSlug, agentSlug))
            .orderBy(asc(agentComponentsTable.position))
            .all();

        // Step 2 + 3 + 4: resolve version, evaluate condition, accumulate.
        const included: ResolvedComponent[] = [];

        for (const row of junctionRows) {
            const conditionMatches = evaluateCondition(row.contextCondition, ctx);

            // Step 4: required but excluded → error immediately.
            if (!conditionMatches) {
                if (Boolean(row.isRequired)) {
                    throw new CompositionError(
                        "REQUIRED_COMPONENT_EXCLUDED",
                        `Required component '${row.componentSlug}' at position ${row.position} ` +
                            `was excluded by its context_condition for agent '${agentSlug}'`
                    );
                }
                // Non-required + no match → skip.
                continue;
            }

            // Step 2: resolve version — pinned or latest.
            const component = this._resolveComponentVersion(
                row.componentSlug,
                row.versionPin ?? null
            );

            included.push({
                componentSlug: row.componentSlug,
                position: row.position,
                resolvedVersion: component.version,
                component,
            });
        }

        // Step 5: apply total order (position ASC, version DESC, slug ASC).
        // [Decision 2: deterministic total order]
        included.sort((a, b) => {
            if (a.position !== b.position) return a.position - b.position;
            if (b.resolvedVersion !== a.resolvedVersion) return b.resolvedVersion - a.resolvedVersion;
            return a.componentSlug < b.componentSlug ? -1 : a.componentSlug > b.componentSlug ? 1 : 0;
        });

        return included;
    }

    // ── Private helpers ───────────────────────

    /**
     * Resolve a component to a specific version row.
     *
     * Decision 4 (decisions.md):
     *   - pin IS NULL  → max(version) for the slug at resolution time ("latest").
     *   - pin IS INT   → exactly that version row.
     *
     * Throws COMPONENT_VERSION_NOT_FOUND if the row does not exist.
     */
    private _resolveComponentVersion(slug: string, pin: number | null): PromptComponent {
        if (pin !== null) {
            // Pinned: exact (slug, version) lookup.
            const row = this.db
                .select()
                .from(promptComponentsTable)
                .where(
                    eq(promptComponentsTable.slug, slug)
                )
                .orderBy(desc(promptComponentsTable.version))
                .all()
                .find((r) => r.version === pin);

            if (!row) {
                throw new CompositionError(
                    "COMPONENT_VERSION_NOT_FOUND",
                    `Component '${slug}' version ${pin} not found`
                );
            }

            return this._rowToComponent(row);
        }

        // Latest: highest version for the slug.
        const latestRow = this.db
            .select({
                slug: promptComponentsTable.slug,
                maxVersion: max(promptComponentsTable.version).as("max_version"),
            })
            .from(promptComponentsTable)
            .where(eq(promptComponentsTable.slug, slug))
            .groupBy(promptComponentsTable.slug)
            .get();

        if (!latestRow || latestRow.maxVersion === null) {
            throw new CompositionError(
                "COMPONENT_VERSION_NOT_FOUND",
                `Component '${slug}' not found (no rows)`
            );
        }

        const fullRow = this.db
            .select()
            .from(promptComponentsTable)
            .where(eq(promptComponentsTable.slug, slug))
            .orderBy(desc(promptComponentsTable.version))
            .limit(1)
            .get();

        if (!fullRow) {
            throw new CompositionError(
                "COMPONENT_VERSION_NOT_FOUND",
                `Component '${slug}' not found`
            );
        }

        return this._rowToComponent(fullRow);
    }

    private _rowToComponent(row: {
        slug: string;
        type: string;
        version: number;
        content: string;
        isShared: boolean | number | null;
        createdAt: string;
        updatedAt: string;
    }): PromptComponent {
        return {
            slug: row.slug,
            type: row.type,
            version: row.version,
            content: row.content,
            isShared: Boolean(row.isShared),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
}
