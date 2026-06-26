import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { providerToolFormats } from "../db/schema.js";

// ──────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────

/** Controlled-vocab values for emit_shape ([inv:lookup-not-enum]). */
export type EmitShape = "custom" | "server_side" | "unsupported";

export interface ToolFormat {
    providerId: string;
    canonicalTool: string;
    /** "custom" | "server_side" | "unsupported" */
    emitShape: EmitShape;
    /**
     * Versioned type-tagged string for server_side rows only.
     * e.g. "web_search_20250305". Null for custom/unsupported.
     * ([def:server-side-tool])
     */
    typeTag: string | null;
    /**
     * Actionable message for unsupported rows only.
     * e.g. "Anthropic bash requires a local execution loop; not supported".
     * Null for custom/server_side.
     * ([def:unsupported-native])
     */
    note: string | null;
}

export interface ToolFormatCreateInput {
    providerId: string;
    canonicalTool: string;
    emitShape: EmitShape;
    typeTag?: string | null;
    note?: string | null;
}

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export type ToolFormatErrorCode =
    | "TOOL_FORMAT_ALREADY_EXISTS"
    | "TOOL_FORMAT_NOT_FOUND";

export class ToolFormatStoreError extends Error {
    readonly code: ToolFormatErrorCode;

    constructor(code: ToolFormatErrorCode, message: string) {
        super(message);
        this.name = "ToolFormatStoreError";
        this.code = code;
    }
}

// ──────────────────────────────────────────────
// Store
// Thin Drizzle queries, typed errors — mirrors agent-mcp AgentStore pattern.
// ([ref:store-class])
// ──────────────────────────────────────────────

export class ToolFormatStore {
    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>
    ) {}

    /**
     * Insert a new provider_tool_formats row.
     * Throws TOOL_FORMAT_ALREADY_EXISTS if (providerId, canonicalTool) is taken.
     */
    create(input: ToolFormatCreateInput): ToolFormat {
        const existing = this.db
            .select()
            .from(providerToolFormats)
            .where(
                and(
                    eq(providerToolFormats.providerId, input.providerId),
                    eq(providerToolFormats.canonicalTool, input.canonicalTool)
                )
            )
            .get();

        if (existing) {
            throw new ToolFormatStoreError(
                "TOOL_FORMAT_ALREADY_EXISTS",
                `Tool format for '${input.canonicalTool}' on provider '${input.providerId}' already exists`
            );
        }

        this.db
            .insert(providerToolFormats)
            .values({
                providerId: input.providerId,
                canonicalTool: input.canonicalTool,
                emitShape: input.emitShape,
                typeTag: input.typeTag ?? null,
                note: input.note ?? null,
            })
            .run();

        return this.read(input.providerId, input.canonicalTool);
    }

    /**
     * Read a tool format row by (providerId, canonicalTool).
     * Throws TOOL_FORMAT_NOT_FOUND if missing.
     */
    read(providerId: string, canonicalTool: string): ToolFormat {
        const row = this.db
            .select()
            .from(providerToolFormats)
            .where(
                and(
                    eq(providerToolFormats.providerId, providerId),
                    eq(providerToolFormats.canonicalTool, canonicalTool)
                )
            )
            .get();

        if (!row) {
            throw new ToolFormatStoreError(
                "TOOL_FORMAT_NOT_FOUND",
                `Tool format for '${canonicalTool}' on provider '${providerId}' not found`
            );
        }

        return this._rowToToolFormat(row);
    }

    /**
     * Convenience helper used by the runtime emitter to branch on emit_shape.
     * Returns the full ToolFormat row for (providerId, canonicalTool), or null
     * if no row exists (i.e. the tool is treated as a plain custom function def).
     */
    getShape(providerId: string, canonicalTool: string): ToolFormat | null {
        const row = this.db
            .select()
            .from(providerToolFormats)
            .where(
                and(
                    eq(providerToolFormats.providerId, providerId),
                    eq(providerToolFormats.canonicalTool, canonicalTool)
                )
            )
            .get();

        return row ? this._rowToToolFormat(row) : null;
    }

    /** Return all tool format rows for a given provider, ordered by canonical_tool. */
    listByProvider(providerId: string): ToolFormat[] {
        return this.db
            .select()
            .from(providerToolFormats)
            .where(eq(providerToolFormats.providerId, providerId))
            .all()
            .map(row => this._rowToToolFormat(row));
    }

    private _rowToToolFormat(row: typeof providerToolFormats.$inferSelect): ToolFormat {
        return {
            providerId: row.providerId,
            canonicalTool: row.canonicalTool,
            emitShape: row.emitShape as EmitShape,
            typeTag: row.typeTag,
            note: row.note,
        };
    }
}
