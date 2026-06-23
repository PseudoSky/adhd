import { eq } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { toolTypesTable, toolsTable } from "../db/schema.js";

// ──────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────

/** A seeded tool-type classification row (text PK, never an enum). */
export interface ToolType {
    slug: string;
    description: string;
}

/** A canonical, platform-independent agent capability. */
export interface Tool {
    name: string;
    type: string;
    description: string;
    version: number;
    requiresApproval: boolean;
    isDestructive: boolean;
    dependencyToolIds: string[];
    capabilities: string[];
}

/** Input for creating a canonical tool. */
export interface ToolCreateInput {
    name: string;
    type: string;
    description: string;
    /** Defaults to 1 if omitted. */
    version?: number;
    requiresApproval?: boolean;
    isDestructive?: boolean;
    dependencyToolIds?: string[];
    capabilities?: string[];
}

// ──────────────────────────────────────────────
// Typed error codes
// ──────────────────────────────────────────────

export type ToolStoreErrorCode =
    | "TOOL_ALREADY_EXISTS"
    | "TOOL_NOT_FOUND"
    | "TOOL_TYPE_NOT_FOUND";

export class ToolStoreError extends Error {
    constructor(
        public readonly code: ToolStoreErrorCode,
        message: string
    ) {
        super(message);
        this.name = "ToolStoreError";
    }
}

// ──────────────────────────────────────────────
// ToolStore
//
// Thin Drizzle queries over tool_types and tools.
// Mirrors the pattern in packages/ai/agent-mcp/src/store/agent-store.ts.
// Constructor accepts a BetterSQLite3Database so tests can inject their own
// connection without touching the production singleton in client.ts.
// ──────────────────────────────────────────────

export class ToolStore {
    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>
    ) {}

    // ── tool_types ────────────────────────────

    /** Seed or upsert a tool-type lookup row. */
    seedToolType(input: ToolType): void {
        this.db
            .insert(toolTypesTable)
            .values({ slug: input.slug, description: input.description })
            .onConflictDoNothing()
            .run();
    }

    /** Return all seeded tool types. */
    listToolTypes(): ToolType[] {
        return this.db.select().from(toolTypesTable).all();
    }

    // ── tools ─────────────────────────────────

    /**
     * Create a canonical tool row.
     * Throws TOOL_ALREADY_EXISTS if the name PK already exists.
     */
    create(input: ToolCreateInput): Tool {
        const existing = this.db
            .select()
            .from(toolsTable)
            .where(eq(toolsTable.name, input.name))
            .get();

        if (existing) {
            throw new ToolStoreError(
                "TOOL_ALREADY_EXISTS",
                `Tool '${input.name}' already exists`
            );
        }

        const tool: Tool = {
            name: input.name,
            type: input.type,
            description: input.description,
            version: input.version ?? 1,
            requiresApproval: input.requiresApproval ?? false,
            isDestructive: input.isDestructive ?? false,
            dependencyToolIds: input.dependencyToolIds ?? [],
            capabilities: input.capabilities ?? [],
        };

        this.db
            .insert(toolsTable)
            .values({
                name: tool.name,
                type: tool.type,
                description: tool.description,
                version: tool.version,
                requiresApproval: tool.requiresApproval,
                isDestructive: tool.isDestructive,
                dependencyToolIds: tool.dependencyToolIds,
                capabilities: tool.capabilities,
            })
            .run();

        return tool;
    }

    /**
     * Read a canonical tool by name.
     * Throws TOOL_NOT_FOUND if absent.
     */
    read(name: string): Tool {
        const row = this.db
            .select()
            .from(toolsTable)
            .where(eq(toolsTable.name, name))
            .get();

        if (!row) {
            throw new ToolStoreError(
                "TOOL_NOT_FOUND",
                `Tool '${name}' not found`
            );
        }

        return {
            name: row.name,
            type: row.type,
            description: row.description,
            version: row.version,
            requiresApproval: row.requiresApproval,
            isDestructive: row.isDestructive,
            dependencyToolIds: row.dependencyToolIds as string[],
            capabilities: row.capabilities as string[],
        };
    }

    /** List all canonical tools. */
    list(): Tool[] {
        const rows = this.db.select().from(toolsTable).all();
        return rows.map(row => ({
            name: row.name,
            type: row.type,
            description: row.description,
            version: row.version,
            requiresApproval: row.requiresApproval,
            isDestructive: row.isDestructive,
            dependencyToolIds: row.dependencyToolIds as string[],
            capabilities: row.capabilities as string[],
        }));
    }
}
