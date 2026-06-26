import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { models } from "../db/schema.js";

// ──────────────────────────────────────────────
// Model seed data (SEED_DATA.md §7)
// Four canonical Claude models — context window, output limit, capability
// flags, and pricing tier verbatim from §7.
// ──────────────────────────────────────────────

interface ModelSeedRow {
    id: string;
    contextWindow: number;
    outputLimit: number;
    vision: boolean;
    promptCaching: boolean;
    extendedThinking: boolean;
    pricingTier: string;
}

export const MODEL_ROWS: ModelSeedRow[] = [
    {
        id: "claude_sonnet_4_6",
        contextWindow: 200_000,
        outputLimit: 8_192,
        vision: true,
        promptCaching: true,
        extendedThinking: false,
        pricingTier: "standard",
    },
    {
        id: "claude_opus_4_8",
        contextWindow: 200_000,
        outputLimit: 32_000,
        vision: true,
        promptCaching: true,
        extendedThinking: true,
        pricingTier: "premium",
    },
    {
        id: "claude_haiku_4_5",
        contextWindow: 200_000,
        outputLimit: 8_192,
        vision: true,
        promptCaching: true,
        extendedThinking: false,
        pricingTier: "economy",
    },
    {
        id: "claude_fable_5",
        contextWindow: 200_000,
        outputLimit: 32_000,
        vision: true,
        promptCaching: true,
        extendedThinking: true,
        pricingTier: "premium",
    },
];

/**
 * Seed canonical model rows.
 *
 * Uses INSERT OR IGNORE so a second call is a silent no-op
 * ([inv:reopen-proves-persistence]: counts are identical on second run).
 */
export function seedModels(
    db: BetterSQLite3Database<Record<string, never>>
): void {
    const now = new Date().toISOString();

    for (const row of MODEL_ROWS) {
        db.insert(models)
            .values({
                id: row.id,
                contextWindow: row.contextWindow,
                outputLimit: row.outputLimit,
                vision: row.vision,
                promptCaching: row.promptCaching,
                extendedThinking: row.extendedThinking,
                pricingTier: row.pricingTier,
                createdAt: now,
                updatedAt: now,
            })
            // Idempotency: ignore if the PK already exists.
            .onConflictDoNothing()
            .run();
    }
}

/** Canonical model ids shipped by this seed module. */
export const SEEDED_MODEL_IDS = MODEL_ROWS.map(r => r.id);
