import { asc, eq, and } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { agentsTable, taxonomyCategoriesTable } from "../db/schema.js";

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export class AgentError extends Error {
    constructor(
        public readonly code: "AGENT_NOT_FOUND" | "CATEGORY_NOT_FOUND",
        message: string
    ) {
        super(message);
        this.name = "AgentError";
    }
}

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

/** Agent status values. Plain text — not a SQL enum. [inv:lookup-not-enum] */
export type AgentStatus = "draft" | "active" | "deprecated";

/** Default posture for human-in-the-loop decisions. */
export type AgentPosture = "approve" | "needs_work";

export interface TaxonomyCategory {
    slug: string;
    name: string;
    description: string;
    /** Integer ordering key, replaces the `01-`/`02-` directory-prefix convention. */
    position: number;
    /** Nullable parent slug for subcategory nesting. */
    parentSlug: string | null;
}

export interface TaxonomyCategoryCreateInput {
    slug: string;
    name: string;
    description?: string;
    position?: number;
    parentSlug?: string | null;
}

export interface Agent {
    slug: string;
    displayName: string;
    description: string;
    /** 'draft' | 'active' | 'deprecated' */
    status: AgentStatus;
    /**
     * Canonical model id — a string, NOT an FK.
     * Resolved at compile time by @adhd/agent-provider (Decision 1: no cross-package FK).
     */
    modelHint: string | null;
    /** In-package FK → registry_taxonomy_categories.slug (nullable). */
    taxonomyCategory: string | null;
    /** 'approve' | 'needs_work' */
    defaultPosture: AgentPosture;
    createdAt: string;
    updatedAt: string;
}

export interface AgentCreateInput {
    slug: string;
    displayName: string;
    description?: string;
    status?: AgentStatus;
    modelHint?: string | null;
    taxonomyCategory?: string | null;
    defaultPosture?: AgentPosture;
}

export interface AgentUpdateInput {
    displayName?: string;
    description?: string;
    status?: AgentStatus;
    modelHint?: string | null;
    taxonomyCategory?: string | null;
    defaultPosture?: AgentPosture;
}

export interface AgentListFilter {
    /** Filter to agents in this taxonomy category slug. */
    category?: string;
    /** Filter to agents with this status. */
    status?: AgentStatus;
}

// ──────────────────────────────────────────────
// TaxonomyStore
//
// Thin Drizzle wrapper for registry_taxonomy_categories.
// Mirrors the store-class pattern in packages/ai/agent-mcp/src/store/agent-store.ts
// [ref:store-class] (contexts/_shared.md)
// ──────────────────────────────────────────────

export class TaxonomyStore {
    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private readonly db: BetterSQLite3Database<any>
    ) {}

    /**
     * Insert a new taxonomy category.
     * Throws if the slug already exists (use the returned row for idempotent seeding).
     */
    createCategory(input: TaxonomyCategoryCreateInput): TaxonomyCategory {
        const row: TaxonomyCategory = {
            slug: input.slug,
            name: input.name,
            description: input.description ?? "",
            position: input.position ?? 0,
            parentSlug: input.parentSlug ?? null,
        };

        this.db
            .insert(taxonomyCategoriesTable)
            .values({
                slug: row.slug,
                name: row.name,
                description: row.description,
                position: row.position,
                parentSlug: row.parentSlug,
            })
            .run();

        return row;
    }

    /**
     * List all categories ordered by position ASC, then slug ASC for stability.
     * This ordering replaces the `01-`/`02-` directory-prefix convention.
     */
    listCategories(): TaxonomyCategory[] {
        const rows = this.db
            .select()
            .from(taxonomyCategoriesTable)
            .orderBy(
                asc(taxonomyCategoriesTable.position),
                asc(taxonomyCategoriesTable.slug)
            )
            .all();

        return rows.map((r) => ({
            slug: r.slug,
            name: r.name,
            description: r.description,
            position: r.position,
            parentSlug: r.parentSlug ?? null,
        }));
    }
}

// ──────────────────────────────────────────────
// AgentStore
//
// Thin Drizzle wrapper for registry_agents.
// [ref:store-class] (contexts/_shared.md)
// ──────────────────────────────────────────────

export class AgentStore {
    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        private readonly db: BetterSQLite3Database<any>
    ) {}

    /**
     * Create a new agent metadata row.
     * Does not associate prompt components — that is handled by the
     * composition-junction state.
     */
    create(input: AgentCreateInput): Agent {
        const now = new Date().toISOString();
        const row: Agent = {
            slug: input.slug,
            displayName: input.displayName,
            description: input.description ?? "",
            status: input.status ?? "draft",
            modelHint: input.modelHint ?? null,
            taxonomyCategory: input.taxonomyCategory ?? null,
            defaultPosture: input.defaultPosture ?? "needs_work",
            createdAt: now,
            updatedAt: now,
        };

        this.db
            .insert(agentsTable)
            .values({
                slug: row.slug,
                displayName: row.displayName,
                description: row.description,
                status: row.status,
                modelHint: row.modelHint,
                taxonomyCategory: row.taxonomyCategory,
                defaultPosture: row.defaultPosture,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            })
            .run();

        return row;
    }

    /**
     * Read an agent by slug.
     * Throws AGENT_NOT_FOUND if the slug does not exist.
     */
    read(slug: string): Agent {
        const row = this.db
            .select()
            .from(agentsTable)
            .where(eq(agentsTable.slug, slug))
            .get();

        if (!row) {
            throw new AgentError("AGENT_NOT_FOUND", `Agent '${slug}' not found`);
        }

        return this._rowToAgent(row);
    }

    /**
     * Update mutable fields of an agent by slug.
     * Throws AGENT_NOT_FOUND if the slug does not exist.
     * Returns the updated agent.
     */
    update(slug: string, input: AgentUpdateInput): Agent {
        // Verify existence first
        this.read(slug); // throws AGENT_NOT_FOUND if missing

        const now = new Date().toISOString();

        this.db
            .update(agentsTable)
            .set({
                ...(input.displayName !== undefined && { displayName: input.displayName }),
                ...(input.description !== undefined && { description: input.description }),
                ...(input.status !== undefined && { status: input.status }),
                ...(input.modelHint !== undefined && { modelHint: input.modelHint }),
                ...(input.taxonomyCategory !== undefined && { taxonomyCategory: input.taxonomyCategory }),
                ...(input.defaultPosture !== undefined && { defaultPosture: input.defaultPosture }),
                updatedAt: now,
            })
            .where(eq(agentsTable.slug, slug))
            .run();

        return this.read(slug);
    }

    /**
     * Delete an agent by slug.
     * Throws AGENT_NOT_FOUND if the slug does not exist.
     */
    delete(slug: string): void {
        this.read(slug); // throws AGENT_NOT_FOUND if missing

        this.db
            .delete(agentsTable)
            .where(eq(agentsTable.slug, slug))
            .run();
    }

    /**
     * List agents, optionally filtered by category and/or status.
     * Results are ordered by slug ASC for stable output.
     */
    list(filter: AgentListFilter = {}): Agent[] {
        const conditions = [];

        if (filter.category !== undefined) {
            conditions.push(eq(agentsTable.taxonomyCategory, filter.category));
        }

        if (filter.status !== undefined) {
            conditions.push(eq(agentsTable.status, filter.status));
        }

        let query = this.db.select().from(agentsTable).orderBy(asc(agentsTable.slug));

        if (conditions.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            query = (query as any).where(and(...conditions));
        }

        const rows = query.all();
        return rows.map((r) => this._rowToAgent(r));
    }

    // ── Private helpers ───────────────────────

    private _rowToAgent(row: {
        slug: string;
        displayName: string;
        description: string;
        status: string;
        modelHint: string | null;
        taxonomyCategory: string | null;
        defaultPosture: string;
        createdAt: string;
        updatedAt: string;
    }): Agent {
        return {
            slug: row.slug,
            displayName: row.displayName,
            description: row.description,
            status: row.status as AgentStatus,
            modelHint: row.modelHint ?? null,
            taxonomyCategory: row.taxonomyCategory ?? null,
            defaultPosture: row.defaultPosture as AgentPosture,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
}
