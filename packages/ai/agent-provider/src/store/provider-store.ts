import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { providers } from "../db/schema.js";

// ──────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────

export interface Provider {
    id: string;
    transport: string;         // "HTTP" | "stdio"
    authPattern: string;       // e.g. "bearer", "x-api-key", "none"
    baseUrl: string | null;
    endpointTemplate: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ProviderCreateInput {
    id: string;
    transport: string;
    authPattern: string;
    baseUrl?: string | null;
    endpointTemplate?: string | null;
}

// ──────────────────────────────────────────────
// Error codes
// ──────────────────────────────────────────────

export type ProviderErrorCode =
    | "PROVIDER_ALREADY_EXISTS"
    | "PROVIDER_NOT_FOUND";

export class ProviderStoreError extends Error {
    readonly code: ProviderErrorCode;

    constructor(code: ProviderErrorCode, message: string) {
        super(message);
        this.name = "ProviderStoreError";
        this.code = code;
    }
}

// ──────────────────────────────────────────────
// Store
// Thin Drizzle queries, typed errors — mirrors agent-mcp AgentStore pattern.
// ──────────────────────────────────────────────

export class ProviderStore {
    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>
    ) {}

    /**
     * Insert a new provider row.
     * Throws PROVIDER_ALREADY_EXISTS if the id is taken.
     */
    create(input: ProviderCreateInput): Provider {
        const now = new Date().toISOString();

        const existing = this.db
            .select()
            .from(providers)
            .where(eq(providers.id, input.id))
            .get();

        if (existing) {
            throw new ProviderStoreError(
                "PROVIDER_ALREADY_EXISTS",
                `Provider '${input.id}' already exists`
            );
        }

        this.db.insert(providers).values({
            id: input.id,
            transport: input.transport,
            authPattern: input.authPattern,
            baseUrl: input.baseUrl ?? null,
            endpointTemplate: input.endpointTemplate ?? null,
            createdAt: now,
            updatedAt: now,
        }).run();

        return this.read(input.id);
    }

    /**
     * Read a provider by id.
     * Throws PROVIDER_NOT_FOUND if missing.
     */
    read(id: string): Provider {
        const row = this.db
            .select()
            .from(providers)
            .where(eq(providers.id, id))
            .get();

        if (!row) {
            throw new ProviderStoreError(
                "PROVIDER_NOT_FOUND",
                `Provider '${id}' not found`
            );
        }

        return {
            id: row.id,
            transport: row.transport,
            authPattern: row.authPattern,
            baseUrl: row.baseUrl,
            endpointTemplate: row.endpointTemplate,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }

    /** Return all provider rows ordered by id. */
    list(): Provider[] {
        return this.db
            .select()
            .from(providers)
            .all()
            .map(row => ({
                id: row.id,
                transport: row.transport,
                authPattern: row.authPattern,
                baseUrl: row.baseUrl,
                endpointTemplate: row.endpointTemplate,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            }));
    }
}
