import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { composedPromptsTable } from "../db/schema.js";

// ──────────────────────────────────────────────
// context_hash helper
//
// Deterministic + stable: sorts the keys of the context map, JSON-serialises
// the result, then SHA-256s it. The same input map in any key order always
// produces an identical hash — the precondition for the composed_prompts cache
// (Decision 2, decisions.md: the total-order assembly rule makes (agent, context)
// → byte-identical output; the hash encodes the cache key for that output).
//
// This function is EXPORTED from the package barrel so @adhd/agent-compiler can
// reuse the exact same algorithm (it must match — a different hash in the
// compiler and the registry would produce permanent cache misses).
//
// @param context - An arbitrary key/value string map (runtime context).
// @returns A hex SHA-256 string; same map with any key ordering → same string.
// ──────────────────────────────────────────────

/**
 * Compute a deterministic, order-independent SHA-256 hash for a context map.
 *
 * Sorted-key JSON canonicalization → SHA-256 hex.
 * `{ b: "2", a: "1" }` and `{ a: "1", b: "2" }` both hash to the same value.
 *
 * This is the canonical implementation reused by @adhd/agent-compiler — import
 * it from `@adhd/agent-registry` rather than reimplementing.
 *
 * @param context - Runtime context key/value map.
 * @returns 64-character lowercase hex SHA-256 string.
 */
export function contextHash(context: Record<string, string>): string {
    // Sort keys to guarantee identical canonical form regardless of insertion order.
    const sorted = Object.fromEntries(
        Object.keys(context)
            .sort()
            .map((k) => [k, context[k]] as const)
    );
    const canonical = JSON.stringify(sorted);
    return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export class ComposedPromptError extends Error {
    constructor(
        public readonly code: "NOT_FOUND",
        message: string
    ) {
        super(message);
        this.name = "ComposedPromptError";
    }
}

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

/** A fully-hydrated composed_prompts row with parsed component versions. */
export interface ComposedPrompt {
    id: number;
    agentSlug: string;
    contextHash: string;
    content: string;
    /** Parsed audit map: `{ [componentSlug]: version }`. */
    componentVersions: Record<string, number>;
    createdAt: string;
}

/** Input required to write a new composed prompt cache entry. */
export interface ComposedPromptWriteInput {
    agentSlug: string;
    contextHash: string;
    content: string;
    /** Audit map: `{ [componentSlug]: version }` — which version was used for each component. */
    componentVersions: Record<string, number>;
}

// ──────────────────────────────────────────────
// ComposedPromptStore
//
// Thin Drizzle wrapper for registry_composed_prompts.
// Three methods:
//   write(...)           — insert a new cache entry
//   lookup(slug, hash)   — O(1) cache lookup by (agent_slug, context_hash)
//   read(id)             — read a single row by PK id
//
// [ref:store-class] (contexts/_shared.md)
// [def:composed-prompt] (contexts/_shared.md)
// ──────────────────────────────────────────────

export class ComposedPromptStore {
    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private readonly db: BetterSQLite3Database<any>
    ) {}

    /**
     * Write a new composed prompt cache entry.
     *
     * The caller is responsible for computing the `contextHash` using the
     * exported `contextHash()` helper. Inserting a duplicate (agent_slug,
     * context_hash) is allowed — the cache layer may accumulate redundant rows;
     * `lookup` will return the most recently written one.
     *
     * @returns The inserted row with its generated `id`.
     */
    write(input: ComposedPromptWriteInput): ComposedPrompt {
        const now = new Date().toISOString();
        const componentVersionsJson = JSON.stringify(input.componentVersions);

        const result = this.db
            .insert(composedPromptsTable)
            .values({
                agentSlug: input.agentSlug,
                contextHash: input.contextHash,
                content: input.content,
                componentVersions: componentVersionsJson,
                createdAt: now,
            })
            .returning()
            .get();

        return this._rowToComposedPrompt(result);
    }

    /**
     * Look up a composed prompt by (agent_slug, context_hash).
     *
     * Returns the most recently written row for this cache key, or null if no
     * entry exists. O(1) via the `registry_composed_prompts_agent_hash_idx` index.
     *
     * @param agentSlug   - The agent whose cached prompt to retrieve.
     * @param hash        - The context hash produced by `contextHash()`.
     * @returns The composed prompt row, or null on a cache miss.
     */
    lookup(agentSlug: string, hash: string): ComposedPrompt | null {
        // Order by id DESC to get the most recently written row first.
        const row = this.db
            .select()
            .from(composedPromptsTable)
            .where(
                and(
                    eq(composedPromptsTable.agentSlug, agentSlug),
                    eq(composedPromptsTable.contextHash, hash)
                )
            )
            .orderBy(composedPromptsTable.id)
            .all()
            .at(-1); // last (highest id) = most recently written

        return row ? this._rowToComposedPrompt(row) : null;
    }

    /**
     * Read a single composed prompt row by its PK id.
     *
     * @param id - The row id returned by `write()`.
     * @returns The composed prompt row.
     * @throws ComposedPromptError('NOT_FOUND') if no row with that id exists.
     */
    read(id: number): ComposedPrompt {
        const row = this.db
            .select()
            .from(composedPromptsTable)
            .where(eq(composedPromptsTable.id, id))
            .get();

        if (!row) {
            throw new ComposedPromptError("NOT_FOUND", `Composed prompt id=${id} not found`);
        }

        return this._rowToComposedPrompt(row);
    }

    // ── Private helpers ───────────────────────

    private _rowToComposedPrompt(row: {
        id: number;
        agentSlug: string;
        contextHash: string;
        content: string;
        componentVersions: string;
        createdAt: string;
    }): ComposedPrompt {
        return {
            id: row.id,
            agentSlug: row.agentSlug,
            contextHash: row.contextHash,
            content: row.content,
            componentVersions: JSON.parse(row.componentVersions) as Record<string, number>,
            createdAt: row.createdAt,
        };
    }
}
