import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { providers } from "../db/schema.js";

// ──────────────────────────────────────────────
// Provider seed data (SEED_DATA.md §5 Platforms)
// Five providers: anthropic, openai, bedrock, lmstudio, claudecli
// ──────────────────────────────────────────────

interface ProviderSeedRow {
    id: string;
    transport: string;
    authPattern: string;
    baseUrl: string | null;
    endpointTemplate: string | null;
}

const PROVIDER_ROWS: ProviderSeedRow[] = [
    {
        id: "anthropic",
        transport: "HTTP",
        authPattern: "bearer",
        baseUrl: "https://api.anthropic.com",
        endpointTemplate: "https://api.anthropic.com/v1/messages",
    },
    {
        id: "openai",
        transport: "HTTP",
        authPattern: "bearer",
        baseUrl: "https://api.openai.com",
        endpointTemplate: "https://api.openai.com/v1/chat/completions",
    },
    {
        id: "bedrock",
        transport: "HTTP",
        authPattern: "aws-sigv4",
        baseUrl: "https://bedrock-runtime.{region}.amazonaws.com",
        endpointTemplate:
            "https://bedrock-runtime.{region}.amazonaws.com/model/{model}/converse-stream",
    },
    {
        id: "lmstudio",
        transport: "HTTP",
        authPattern: "none",
        baseUrl: "http://localhost:1234",
        endpointTemplate: "http://localhost:1234/v1/chat/completions",
    },
    {
        id: "claudecli",
        transport: "stdio",
        authPattern: "none",
        baseUrl: null,
        endpointTemplate: null,
    },
];

/**
 * Seed provider rows.
 *
 * Uses INSERT OR IGNORE so a second call is a silent no-op
 * ([inv:reopen-proves-persistence]: counts are identical on second run).
 */
export function seedProviders(
    db: BetterSQLite3Database<Record<string, never>>
): void {
    const now = new Date().toISOString();

    for (const row of PROVIDER_ROWS) {
        db.insert(providers)
            .values({
                id: row.id,
                transport: row.transport,
                authPattern: row.authPattern,
                baseUrl: row.baseUrl,
                endpointTemplate: row.endpointTemplate,
                createdAt: now,
                updatedAt: now,
            })
            // Idempotency: ignore if the PK already exists.
            .onConflictDoNothing()
            .run();
    }
}

/** Canonical provider ids shipped by this seed module. */
export const SEEDED_PROVIDER_IDS = PROVIDER_ROWS.map(r => r.id);
