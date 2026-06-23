import { and, desc, eq, max } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import {
    componentsTable,
    componentVersionsTable,
    promptTypesTable,
} from "../db/schema.js";

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export class ComponentError extends Error {
    constructor(
        public readonly code: "COMPONENT_NOT_FOUND" | "COMPONENT_TYPE_NOT_FOUND" | "COMPONENT_VERSION_NOT_FOUND",
        message: string
    ) {
        super(message);
        this.name = "ComponentError";
    }
}

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

export interface PromptType {
    slug: string;
    description: string;
    isSystem: boolean;
}

export interface PromptComponent {
    slug: string;
    type: string;
    version: number;
    /**
     * The registry_component_versions.version_id surrogate for THIS version row.
     * Stable, single-column — this is what a junction `version_pin` stores when an
     * exact version is pinned (Decision 5). Resolve a `(slug, version)` pair to it
     * with {@link ComponentStore.resolveVersionId}.
     */
    versionId: number;
    content: string;
    isShared: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface ComponentCreateInput {
    slug: string;
    type: string;
    content: string;
    isShared?: boolean;
}

export interface ComponentListFilter {
    type?: string;
    shared?: boolean;
}

// ──────────────────────────────────────────────
// ComponentStore
//
// Thin Drizzle wrapper for the head/version split (Decision 5):
//   registry_components          — identity (slug PK, type, is_shared)
//   registry_component_versions  — history  (version_id PK, slug FK, version, content)
//   registry_prompt_types        — type lookup
//
// Public method names + semantics are preserved from the pre-split store: create()
// returns version 1, read() returns the latest version, version() appends a new
// version row. The PromptComponent shape gains `versionId` (the stable surrogate a
// junction version_pin stores).
//
// Mirrors the store-class pattern in packages/ai/agent-mcp/src/store/agent-store.ts
// [ref:store-class] (contexts/_shared.md)
// ──────────────────────────────────────────────

export class ComponentStore {
    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private readonly db: BetterSQLite3Database<any>
    ) {}

    // ── Prompt Types ──────────────────────────

    /** Insert a prompt type. No-op if the slug already exists. */
    upsertType(input: PromptType): PromptType {
        this.db
            .insert(promptTypesTable)
            .values({
                slug: input.slug,
                description: input.description,
                isSystem: input.isSystem,
            })
            .onConflictDoNothing()
            .run();
        return input;
    }

    /** Read a prompt type by slug. Throws COMPONENT_TYPE_NOT_FOUND if absent. */
    readType(slug: string): PromptType {
        const row = this.db
            .select()
            .from(promptTypesTable)
            .where(eq(promptTypesTable.slug, slug))
            .get();

        if (!row) {
            throw new ComponentError(
                "COMPONENT_TYPE_NOT_FOUND",
                `Prompt type '${slug}' not found`
            );
        }

        return { slug: row.slug, description: row.description, isSystem: Boolean(row.isSystem) };
    }

    // ── Prompt Components ─────────────────────

    /**
     * Create a new component: insert the head identity row plus its version-1
     * history row, in ONE transaction (Decision 5).
     *
     * [inv:version-retained]: each later call to version() appends a NEW version
     * row at version+1; it never overwrites a prior version.
     */
    create(input: ComponentCreateInput): PromptComponent {
        const now = new Date().toISOString();
        const isShared = input.isShared ?? false;

        // Head + first version are written atomically: a version row must never
        // exist without its head, and a head must always have at least v1.
        const versionId = this.db.transaction((tx) => {
            tx
                .insert(componentsTable)
                .values({
                    slug: input.slug,
                    type: input.type,
                    isShared,
                    createdAt: now,
                })
                .run();

            const inserted = tx
                .insert(componentVersionsTable)
                .values({
                    slug: input.slug,
                    version: 1,
                    content: input.content,
                    createdAt: now,
                    updatedAt: now,
                })
                .returning({ versionId: componentVersionsTable.versionId })
                .get();

            return inserted!.versionId;
        });

        return {
            slug: input.slug,
            type: input.type,
            version: 1,
            versionId,
            content: input.content,
            isShared,
            createdAt: now,
            updatedAt: now,
        };
    }

    /**
     * Read the latest version of a component by slug (head joined to its highest
     * version row).
     * Throws COMPONENT_NOT_FOUND if no head row exists for the slug.
     */
    read(slug: string): PromptComponent {
        const head = this.db
            .select()
            .from(componentsTable)
            .where(eq(componentsTable.slug, slug))
            .get();

        if (!head) {
            throw new ComponentError(
                "COMPONENT_NOT_FOUND",
                `Component '${slug}' not found`
            );
        }

        const latest = this.db
            .select()
            .from(componentVersionsTable)
            .where(eq(componentVersionsTable.slug, slug))
            .orderBy(desc(componentVersionsTable.version))
            .limit(1)
            .get();

        if (!latest) {
            // Head with no version is an integrity violation (create() writes both
            // atomically) — surface it rather than returning a malformed component.
            throw new ComponentError(
                "COMPONENT_NOT_FOUND",
                `Component '${slug}' has a head row but no versions`
            );
        }

        return this._join(head, latest);
    }

    /**
     * Read a specific version of a component.
     * Throws COMPONENT_VERSION_NOT_FOUND if that exact (slug, version) row is absent,
     * or COMPONENT_NOT_FOUND if the head identity row is absent.
     */
    readVersion(slug: string, version: number): PromptComponent {
        const head = this.db
            .select()
            .from(componentsTable)
            .where(eq(componentsTable.slug, slug))
            .get();

        if (!head) {
            throw new ComponentError(
                "COMPONENT_NOT_FOUND",
                `Component '${slug}' not found`
            );
        }

        const row = this.db
            .select()
            .from(componentVersionsTable)
            .where(
                and(
                    eq(componentVersionsTable.slug, slug),
                    eq(componentVersionsTable.version, version)
                )
            )
            .get();

        if (!row) {
            throw new ComponentError(
                "COMPONENT_VERSION_NOT_FOUND",
                `Component '${slug}' version ${version} not found`
            );
        }

        return this._join(head, row);
    }

    /**
     * Resolve a `(slug, version)` pair to its stable registry_component_versions
     * .version_id surrogate — the value a junction `version_pin` stores when an
     * exact version is pinned (Decision 5).
     *
     * Throws COMPONENT_VERSION_NOT_FOUND if that exact version row is absent.
     */
    resolveVersionId(slug: string, version: number): number {
        const row = this.db
            .select({ versionId: componentVersionsTable.versionId })
            .from(componentVersionsTable)
            .where(
                and(
                    eq(componentVersionsTable.slug, slug),
                    eq(componentVersionsTable.version, version)
                )
            )
            .get();

        if (!row) {
            throw new ComponentError(
                "COMPONENT_VERSION_NOT_FOUND",
                `Component '${slug}' version ${version} not found`
            );
        }

        return row.versionId;
    }

    /**
     * Bump a component to a new version with updated content.
     * Appends a NEW version row at max(existing version) + 1 for the slug — the head
     * identity row is unchanged and old version rows are NEVER deleted.
     * [inv:version-retained]
     */
    version(slug: string, newContent: string): PromptComponent {
        const head = this.db
            .select()
            .from(componentsTable)
            .where(eq(componentsTable.slug, slug))
            .get();

        if (!head) {
            throw new ComponentError(
                "COMPONENT_NOT_FOUND",
                `Component '${slug}' not found`
            );
        }

        // Highest existing version for the slug → next is +1.
        const maxRow = this.db
            .select({ maxVersion: max(componentVersionsTable.version).as("max_version") })
            .from(componentVersionsTable)
            .where(eq(componentVersionsTable.slug, slug))
            .get();

        const nextVersion = (maxRow?.maxVersion ?? 0) + 1;
        const now = new Date().toISOString();

        const inserted = this.db
            .insert(componentVersionsTable)
            .values({
                slug,
                version: nextVersion,
                content: newContent,
                createdAt: now,
                updatedAt: now,
            })
            .returning({ versionId: componentVersionsTable.versionId })
            .get();

        return {
            slug,
            type: head.type,
            version: nextVersion,
            versionId: inserted!.versionId,
            content: newContent,
            isShared: Boolean(head.isShared),
            createdAt: head.createdAt,
            updatedAt: now,
        };
    }

    /**
     * List the latest version of each component, optionally filtered by type
     * and/or shared flag. Joins each head to its highest version row.
     */
    list(filter: ComponentListFilter = {}): PromptComponent[] {
        // Subquery: for each slug, find the max version.
        const maxVersions = this.db
            .select({
                slug: componentVersionsTable.slug,
                maxVersion: max(componentVersionsTable.version).as("max_version"),
            })
            .from(componentVersionsTable)
            .groupBy(componentVersionsTable.slug)
            .as("max_versions");

        // Join head identity → its latest version row.
        let query = this.db
            .select({
                slug: componentsTable.slug,
                type: componentsTable.type,
                isShared: componentsTable.isShared,
                headCreatedAt: componentsTable.createdAt,
                versionId: componentVersionsTable.versionId,
                version: componentVersionsTable.version,
                content: componentVersionsTable.content,
                versionUpdatedAt: componentVersionsTable.updatedAt,
            })
            .from(componentsTable)
            .innerJoin(
                componentVersionsTable,
                eq(componentsTable.slug, componentVersionsTable.slug)
            )
            .innerJoin(
                maxVersions,
                and(
                    eq(componentVersionsTable.slug, maxVersions.slug),
                    eq(componentVersionsTable.version, maxVersions.maxVersion)
                )
            );

        // Apply filters (Drizzle's .where() can only be called once, so accumulate conditions)
        const conditions = [];

        if (filter.type !== undefined) {
            conditions.push(eq(componentsTable.type, filter.type));
        }

        if (filter.shared !== undefined) {
            conditions.push(eq(componentsTable.isShared, filter.shared));
        }

        if (conditions.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            query = (query as any).where(and(...conditions));
        }

        const rows = query.all();

        return rows.map((r) => ({
            slug: r.slug,
            type: r.type,
            version: r.version,
            versionId: r.versionId,
            content: r.content,
            isShared: Boolean(r.isShared),
            createdAt: r.headCreatedAt,
            updatedAt: r.versionUpdatedAt,
        }));
    }

    // ── Private helpers ───────────────────────

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
