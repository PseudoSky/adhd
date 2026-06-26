import { and, asc, desc, eq } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import {
    agentComponentsTable,
    componentsTable,
    componentVersionsTable,
} from "../db/schema.js";
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
     *
     * Pinning ergonomics (Decision 5): the stored `version_pin` is a
     * registry_component_versions.version_id (an ENFORCED nullable FK). Callers may
     * pin either way:
     *   - `versionPin`     — a version_id directly (already resolved).
     *   - `pinVersion`     — a human `version` number; this store resolves it to the
     *                        matching version_id for `componentSlug` via
     *                        {@link resolvePinVersionId}.
     * Supplying both, or a `pinVersion` for a (slug, version) that does not exist,
     * throws. Omitting both leaves the pin null = resolve latest at resolve-time.
     */
    attach(input: {
        agentSlug: string;
        componentSlug: string;
        position: number;
        /** A registry_component_versions.version_id to pin to (already resolved). */
        versionPin?: number | null;
        /** A human version number to pin to; resolved to a version_id for componentSlug. */
        pinVersion?: number | null;
        contextCondition?: string | null;
        isRequired?: boolean;
    }): void {
        const versionId = this._resolvePinInput(
            input.componentSlug,
            input.versionPin,
            input.pinVersion
        );

        this.db
            .insert(agentComponentsTable)
            .values({
                agentSlug: input.agentSlug,
                componentSlug: input.componentSlug,
                position: input.position,
                versionPin: versionId,
                contextCondition: input.contextCondition ?? null,
                isRequired: input.isRequired ?? false,
            })
            .run();
    }

    /**
     * Resolve a `(slug, version)` pair to its registry_component_versions.version_id
     * — the value stored as a junction `version_pin` when pinning an exact version.
     *
     * Throws COMPONENT_VERSION_NOT_FOUND if that exact version row is absent.
     */
    resolvePinVersionId(componentSlug: string, version: number): number {
        const row = this.db
            .select({ versionId: componentVersionsTable.versionId })
            .from(componentVersionsTable)
            .where(
                and(
                    eq(componentVersionsTable.slug, componentSlug),
                    eq(componentVersionsTable.version, version)
                )
            )
            .get();

        if (!row) {
            throw new CompositionError(
                "COMPONENT_VERSION_NOT_FOUND",
                `Component '${componentSlug}' version ${version} not found`
            );
        }

        return row.versionId;
    }

    /**
     * Normalize the two pinning inputs into a single nullable version_id.
     * Rejects supplying both forms at once.
     */
    private _resolvePinInput(
        componentSlug: string,
        versionPin: number | null | undefined,
        pinVersion: number | null | undefined
    ): number | null {
        const hasVersionId = versionPin !== undefined && versionPin !== null;
        const hasPinVersion = pinVersion !== undefined && pinVersion !== null;

        if (hasVersionId && hasPinVersion) {
            throw new CompositionError(
                "COMPONENT_VERSION_NOT_FOUND",
                `attach: supply either versionPin (version_id) or pinVersion (version number) for ` +
                    `'${componentSlug}', not both`
            );
        }

        if (hasPinVersion) {
            return this.resolvePinVersionId(componentSlug, pinVersion);
        }

        return hasVersionId ? versionPin : null;
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
     * Resolve a junction row to a specific component version.
     *
     * Decision 4 + Decision 5 (decisions.md):
     *   - pin IS NULL  → max(version) for `slug` at resolution time ("latest").
     *   - pin IS INT   → the registry_component_versions row whose version_id = pin.
     *                    That row's `slug` MUST equal the junction's component_slug —
     *                    a mismatch is an integrity violation and throws.
     *
     * Throws COMPONENT_VERSION_NOT_FOUND if the row does not exist (the DB FK makes
     * this unreachable for a pinned id, but we still guard defensively).
     */
    private _resolveComponentVersion(slug: string, pin: number | null): PromptComponent {
        const head = this.db
            .select()
            .from(componentsTable)
            .where(eq(componentsTable.slug, slug))
            .get();

        if (!head) {
            throw new CompositionError(
                "COMPONENT_VERSION_NOT_FOUND",
                `Component '${slug}' not found (no head row)`
            );
        }

        if (pin !== null) {
            // Pinned: load the exact version row by its surrogate version_id.
            const ver = this.db
                .select()
                .from(componentVersionsTable)
                .where(eq(componentVersionsTable.versionId, pin))
                .get();

            if (!ver) {
                throw new CompositionError(
                    "COMPONENT_VERSION_NOT_FOUND",
                    `version_id ${pin} (pinned by '${slug}') not found`
                );
            }

            // The pinned version row must belong to the junction's component_slug.
            if (ver.slug !== slug) {
                throw new CompositionError(
                    "COMPONENT_VERSION_NOT_FOUND",
                    `version_id ${pin} belongs to '${ver.slug}', not the junction's '${slug}'`
                );
            }

            return this._join(head, ver);
        }

        // Latest: highest version for the slug.
        const latest = this.db
            .select()
            .from(componentVersionsTable)
            .where(eq(componentVersionsTable.slug, slug))
            .orderBy(desc(componentVersionsTable.version))
            .limit(1)
            .get();

        if (!latest) {
            throw new CompositionError(
                "COMPONENT_VERSION_NOT_FOUND",
                `Component '${slug}' has no versions`
            );
        }

        return this._join(head, latest);
    }

    /** Join a head identity row to one version row into a PromptComponent. */
    private _join(
        head: {
            slug: string;
            type: string;
            isShared: boolean | number | null;
            createdAt: string;
        },
        ver: {
            versionId: number;
            version: number;
            content: string;
            updatedAt: string;
        }
    ): PromptComponent {
        return {
            slug: head.slug,
            type: head.type,
            version: ver.version,
            versionId: ver.versionId,
            content: ver.content,
            isShared: Boolean(head.isShared),
            createdAt: head.createdAt,
            updatedAt: ver.updatedAt,
        };
    }
}
