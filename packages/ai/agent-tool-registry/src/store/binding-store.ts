import { and, eq } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { platformsTable, toolPlatformBindingsTable } from "../db/schema.js";

// ──────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────

/** A runtime environment a canonical tool can be deployed to. */
export interface Platform {
    id: string;
    name: string;
    /** One of: yaml_frontmatter | json_object | none */
    headerFormat: string;
    supportsToolSelection: boolean;
}

/** Input for seeding a platform row. */
export interface PlatformSeedInput {
    id: string;
    name: string;
    headerFormat: string;
    supportsToolSelection?: boolean;
}

/**
 * The per-platform alias for a canonical tool.
 *
 * availability is one of: available | restricted | unavailable | requires_permission
 */
export interface ToolPlatformBinding {
    toolName: string;
    platformId: string;
    platformToolName: string;
    availability: string;
    requiresMcp: boolean;
    invocationNote: string | null;
}

/** Input for inserting a tool-platform binding row. */
export interface BindingCreateInput {
    toolName: string;
    platformId: string;
    platformToolName: string;
    availability: string;
    requiresMcp?: boolean;
    invocationNote?: string | null;
}

// ──────────────────────────────────────────────
// Typed error codes
// ──────────────────────────────────────────────

export type BindingStoreErrorCode =
    | "BINDING_NOT_FOUND"
    | "PLATFORM_NOT_FOUND"
    | "BINDING_ALREADY_EXISTS";

export class BindingStoreError extends Error {
    constructor(
        public readonly code: BindingStoreErrorCode,
        message: string
    ) {
        super(message);
        this.name = "BindingStoreError";
    }
}

// ──────────────────────────────────────────────
// BindingStore
//
// Thin Drizzle queries over platforms and tool_platform_bindings.
// Mirrors the pattern in packages/ai/agent-mcp/src/store/agent-store.ts.
// Constructor accepts a BetterSQLite3Database so tests can inject their own
// connection without touching the production singleton in client.ts.
// ──────────────────────────────────────────────

export class BindingStore {
    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>
    ) {}

    // ── platforms ─────────────────────────────

    /** Seed or upsert a platform row. Idempotent via onConflictDoNothing. */
    seedPlatform(input: PlatformSeedInput): void {
        this.db
            .insert(platformsTable)
            .values({
                id: input.id,
                name: input.name,
                headerFormat: input.headerFormat,
                supportsToolSelection: input.supportsToolSelection ?? false,
            })
            .onConflictDoNothing()
            .run();
    }

    /** Read a platform by id. Throws PLATFORM_NOT_FOUND if absent. */
    readPlatform(id: string): Platform {
        const row = this.db
            .select()
            .from(platformsTable)
            .where(eq(platformsTable.id, id))
            .get();

        if (!row) {
            throw new BindingStoreError(
                "PLATFORM_NOT_FOUND",
                `Platform '${id}' not found`
            );
        }

        return {
            id: row.id,
            name: row.name,
            headerFormat: row.headerFormat,
            supportsToolSelection: row.supportsToolSelection,
        };
    }

    /** List all seeded platforms. */
    listPlatforms(): Platform[] {
        return this.db
            .select()
            .from(platformsTable)
            .all()
            .map(row => ({
                id: row.id,
                name: row.name,
                headerFormat: row.headerFormat,
                supportsToolSelection: row.supportsToolSelection,
            }));
    }

    // ── tool_platform_bindings ────────────────

    /**
     * Insert a tool-platform binding.
     * Throws BINDING_ALREADY_EXISTS if the (toolName, platformId) PK is taken.
     */
    createBinding(input: BindingCreateInput): ToolPlatformBinding {
        const existing = this.db
            .select()
            .from(toolPlatformBindingsTable)
            .where(
                and(
                    eq(toolPlatformBindingsTable.toolName, input.toolName),
                    eq(toolPlatformBindingsTable.platformId, input.platformId)
                )
            )
            .get();

        if (existing) {
            throw new BindingStoreError(
                "BINDING_ALREADY_EXISTS",
                `Binding for ('${input.toolName}', '${input.platformId}') already exists`
            );
        }

        const binding: ToolPlatformBinding = {
            toolName: input.toolName,
            platformId: input.platformId,
            platformToolName: input.platformToolName,
            availability: input.availability,
            requiresMcp: input.requiresMcp ?? false,
            invocationNote: input.invocationNote ?? null,
        };

        this.db
            .insert(toolPlatformBindingsTable)
            .values({
                toolName: binding.toolName,
                platformId: binding.platformId,
                platformToolName: binding.platformToolName,
                availability: binding.availability,
                requiresMcp: binding.requiresMcp,
                invocationNote: binding.invocationNote,
            })
            .run();

        return binding;
    }

    /**
     * [def:resolve] — The keystone primitive.
     *
     * Returns the platform_tool_name for (canonicalToolName, platformId),
     * or throws BINDING_NOT_FOUND if no binding exists for that exact pair.
     *
     * MUST filter on BOTH tool_name AND platform_id — the [dod.1] negative-
     * control breaks this function by ignoring the platform argument, which
     * would return the wrong alias when multiple bindings exist for a tool.
     */
    resolve(canonicalToolName: string, platformId: string): string {
        const row = this.db
            .select()
            .from(toolPlatformBindingsTable)
            .where(
                and(
                    eq(toolPlatformBindingsTable.toolName, canonicalToolName),
                    eq(toolPlatformBindingsTable.platformId, platformId)
                )
            )
            .get();

        if (!row) {
            throw new BindingStoreError(
                "BINDING_NOT_FOUND",
                `No binding found for tool '${canonicalToolName}' on platform '${platformId}'`
            );
        }

        return row.platformToolName;
    }

    /**
     * List all bindings for a given platform.
     * Used by @adhd/agent-compiler to build the platform's tools: header.
     */
    listForPlatform(platformId: string): ToolPlatformBinding[] {
        return this.db
            .select()
            .from(toolPlatformBindingsTable)
            .where(eq(toolPlatformBindingsTable.platformId, platformId))
            .all()
            .map(row => ({
                toolName: row.toolName,
                platformId: row.platformId,
                platformToolName: row.platformToolName,
                availability: row.availability,
                requiresMcp: row.requiresMcp,
                invocationNote: row.invocationNote,
            }));
    }
}
