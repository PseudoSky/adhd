import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { modelPlatformBindings } from "../db/schema.js";

// ──────────────────────────────────────────────
// Model-platform binding seed data (SEED_DATA.md §7)
//
// claude_code aliases  — short names used by Claude Code CLI
//   claude_sonnet_4_6 → "sonnet"
//   claude_opus_4_8   → "opus"
//   claude_haiku_4_5  → "haiku"
//   claude_fable_5    → "fable"
//
// claude_api full ids — verbatim API model strings
//   claude_sonnet_4_6 → "claude-sonnet-4-6"
//   claude_opus_4_8   → "claude-opus-4-8"
//   claude_haiku_4_5  → "claude-haiku-4-5-20251001"
//   claude_fable_5    → "claude-fable-5"
// ──────────────────────────────────────────────

interface BindingSeedRow {
    modelId: string;
    platform: string;
    platformModelId: string;
}

export const BINDING_ROWS: BindingSeedRow[] = [
    // ── claude_code aliases ───────────────────
    { modelId: "claude_sonnet_4_6", platform: "claude_code", platformModelId: "sonnet" },
    { modelId: "claude_opus_4_8",   platform: "claude_code", platformModelId: "opus" },
    { modelId: "claude_haiku_4_5",  platform: "claude_code", platformModelId: "haiku" },
    { modelId: "claude_fable_5",    platform: "claude_code", platformModelId: "fable" },

    // ── claude_api full ids ───────────────────
    { modelId: "claude_sonnet_4_6", platform: "claude_api", platformModelId: "claude-sonnet-4-6" },
    { modelId: "claude_opus_4_8",   platform: "claude_api", platformModelId: "claude-opus-4-8" },
    { modelId: "claude_haiku_4_5",  platform: "claude_api", platformModelId: "claude-haiku-4-5-20251001" },
    { modelId: "claude_fable_5",    platform: "claude_api", platformModelId: "claude-fable-5" },
];

/**
 * Seed model-platform binding rows.
 *
 * The composite PK is (model_id, platform) — INSERT OR IGNORE ensures a second
 * call is a no-op (idempotency invariant — the negative-control test bites here).
 */
export function seedBindings(
    db: BetterSQLite3Database<Record<string, never>>
): void {
    for (const row of BINDING_ROWS) {
        db.insert(modelPlatformBindings)
            .values({
                modelId: row.modelId,
                platform: row.platform,
                platformModelId: row.platformModelId,
            })
            // Idempotency: composite PK (model_id, platform) — ignore on conflict.
            .onConflictDoNothing()
            .run();
    }
}
