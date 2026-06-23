import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { models } from "../db/schema.js";

// ──────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────

export interface Model {
    id: string;
    contextWindow: number;
    outputLimit: number;
    vision: boolean;
    promptCaching: boolean;
    extendedThinking: boolean;
    pricingTier: string;
    createdAt: string;
    updatedAt: string;
}

export interface ModelCreateInput {
    id: string;
    contextWindow: number;
    outputLimit: number;
    vision?: boolean;
    promptCaching?: boolean;
    extendedThinking?: boolean;
    pricingTier: string;
}

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export type ModelErrorCode =
    | "MODEL_ALREADY_EXISTS"
    | "MODEL_NOT_FOUND";

export class ModelStoreError extends Error {
    readonly code: ModelErrorCode;

    constructor(code: ModelErrorCode, message: string) {
        super(message);
        this.name = "ModelStoreError";
        this.code = code;
    }
}

// ──────────────────────────────────────────────
// Store
// Thin Drizzle queries, typed errors — mirrors agent-mcp AgentStore pattern.
// Capability flags (vision/promptCaching/extendedThinking) are stored as
// SQLite integers but Drizzle's integer({mode:"boolean"}) deserialises them
// as JS booleans on read — the reopen test asserts this.
// ──────────────────────────────────────────────

export class ModelStore {
    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>
    ) {}

    /**
     * Insert a new model row.
     * Throws MODEL_ALREADY_EXISTS if the id is taken.
     */
    create(input: ModelCreateInput): Model {
        const now = new Date().toISOString();

        const existing = this.db
            .select()
            .from(models)
            .where(eq(models.id, input.id))
            .get();

        if (existing) {
            throw new ModelStoreError(
                "MODEL_ALREADY_EXISTS",
                `Model '${input.id}' already exists`
            );
        }

        this.db.insert(models).values({
            id: input.id,
            contextWindow: input.contextWindow,
            outputLimit: input.outputLimit,
            vision: input.vision ?? false,
            promptCaching: input.promptCaching ?? false,
            extendedThinking: input.extendedThinking ?? false,
            pricingTier: input.pricingTier,
            createdAt: now,
            updatedAt: now,
        }).run();

        return this.read(input.id);
    }

    /**
     * Read a model by id.
     * Throws MODEL_NOT_FOUND if missing.
     */
    read(id: string): Model {
        const row = this.db
            .select()
            .from(models)
            .where(eq(models.id, id))
            .get();

        if (!row) {
            throw new ModelStoreError(
                "MODEL_NOT_FOUND",
                `Model '${id}' not found`
            );
        }

        return this._rowToModel(row);
    }

    /** Return all model rows. */
    list(): Model[] {
        return this.db
            .select()
            .from(models)
            .all()
            .map(row => this._rowToModel(row));
    }

    private _rowToModel(row: typeof models.$inferSelect): Model {
        return {
            id: row.id,
            contextWindow: row.contextWindow,
            outputLimit: row.outputLimit,
            // Drizzle deserialises integer({mode:"boolean"}) as booleans —
            // coerce here to ensure JS boolean regardless of DB driver version.
            vision: Boolean(row.vision),
            promptCaching: Boolean(row.promptCaching),
            extendedThinking: Boolean(row.extendedThinking),
            pricingTier: row.pricingTier,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
}
