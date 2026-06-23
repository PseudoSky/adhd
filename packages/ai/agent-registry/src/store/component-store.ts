import { and, desc, eq, max } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { promptComponentsTable, promptTypesTable } from "../db/schema.js";

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
// Thin Drizzle wrapper for registry_prompt_components and registry_prompt_types.
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
     * Create a new component at version 1.
     * [inv:version-retained]: each call to version() writes a NEW row at version+1;
     * it never overwrites the prior version.
     */
    create(input: ComponentCreateInput): PromptComponent {
        const now = new Date().toISOString();
        const row: PromptComponent = {
            slug: input.slug,
            type: input.type,
            version: 1,
            content: input.content,
            isShared: input.isShared ?? false,
            createdAt: now,
            updatedAt: now,
        };

        this.db
            .insert(promptComponentsTable)
            .values({
                slug: row.slug,
                type: row.type,
                version: row.version,
                content: row.content,
                isShared: row.isShared,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            })
            .run();

        return row;
    }

    /**
     * Read the latest version of a component by slug.
     * Throws COMPONENT_NOT_FOUND if no rows exist for the slug.
     */
    read(slug: string): PromptComponent {
        const row = this.db
            .select()
            .from(promptComponentsTable)
            .where(eq(promptComponentsTable.slug, slug))
            .orderBy(desc(promptComponentsTable.version))
            .limit(1)
            .get();

        if (!row) {
            throw new ComponentError(
                "COMPONENT_NOT_FOUND",
                `Component '${slug}' not found`
            );
        }

        return this._rowToComponent(row);
    }

    /**
     * Read a specific version of a component.
     * Throws COMPONENT_VERSION_NOT_FOUND if that exact (slug, version) row is absent.
     */
    readVersion(slug: string, version: number): PromptComponent {
        const row = this.db
            .select()
            .from(promptComponentsTable)
            .where(
                and(
                    eq(promptComponentsTable.slug, slug),
                    eq(promptComponentsTable.version, version)
                )
            )
            .get();

        if (!row) {
            throw new ComponentError(
                "COMPONENT_VERSION_NOT_FOUND",
                `Component '${slug}' version ${version} not found`
            );
        }

        return this._rowToComponent(row);
    }

    /**
     * Bump a component to a new version with updated content.
     * Writes a NEW row at max(existing version) + 1 — old rows are NEVER deleted.
     * [inv:version-retained]
     */
    version(slug: string, newContent: string): PromptComponent {
        // Read current latest to get the current version number and metadata
        const latest = this.read(slug); // throws COMPONENT_NOT_FOUND if slug absent

        const now = new Date().toISOString();
        const nextVersion = latest.version + 1;

        const newRow: PromptComponent = {
            slug: latest.slug,
            type: latest.type,
            version: nextVersion,
            content: newContent,
            isShared: latest.isShared,
            createdAt: latest.createdAt, // preserve original creation time
            updatedAt: now,
        };

        this.db
            .insert(promptComponentsTable)
            .values({
                slug: newRow.slug,
                type: newRow.type,
                version: newRow.version,
                content: newRow.content,
                isShared: newRow.isShared,
                createdAt: newRow.createdAt,
                updatedAt: newRow.updatedAt,
            })
            .run();

        return newRow;
    }

    /**
     * List the latest version of each component, optionally filtered by type
     * and/or shared flag.
     */
    list(filter: ComponentListFilter = {}): PromptComponent[] {
        // Subquery: for each slug, find the max version
        const maxVersions = this.db
            .select({
                slug: promptComponentsTable.slug,
                maxVersion: max(promptComponentsTable.version).as("max_version"),
            })
            .from(promptComponentsTable)
            .groupBy(promptComponentsTable.slug)
            .as("max_versions");

        // Join back to get the full row for the latest version of each slug
        let query = this.db
            .select({
                slug: promptComponentsTable.slug,
                type: promptComponentsTable.type,
                version: promptComponentsTable.version,
                content: promptComponentsTable.content,
                isShared: promptComponentsTable.isShared,
                createdAt: promptComponentsTable.createdAt,
                updatedAt: promptComponentsTable.updatedAt,
            })
            .from(promptComponentsTable)
            .innerJoin(
                maxVersions,
                and(
                    eq(promptComponentsTable.slug, maxVersions.slug),
                    eq(promptComponentsTable.version, maxVersions.maxVersion)
                )
            );

        // Apply filters (Drizzle's .where() can only be called once, so accumulate conditions)
        const conditions = [];

        if (filter.type !== undefined) {
            conditions.push(eq(promptComponentsTable.type, filter.type));
        }

        if (filter.shared !== undefined) {
            conditions.push(eq(promptComponentsTable.isShared, filter.shared));
        }

        if (conditions.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            query = (query as any).where(and(...conditions));
        }

        const rows = query.all();

        return rows.map((r) => this._rowToComponent(r));
    }

    // ── Private helpers ───────────────────────

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
