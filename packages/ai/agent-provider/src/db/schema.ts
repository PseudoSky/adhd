import {
    index,
    integer,
    primaryKey,
    sqliteTable,
    text
} from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────
// provider_providers
// Text PK (lookup-not-enum) — new providers are seeded rows, not migrations.
// transport: "HTTP" | "stdio"  (controlled-vocabulary seeded values, plain text)
// auth_pattern: e.g. "bearer", "x-api-key", "none"
// ──────────────────────────────────────────────
export const providers = sqliteTable("provider_providers", {
    id: text("id").primaryKey(),                     // e.g. "anthropic", "openai", "lmstudio", "claudecli"
    transport: text("transport").notNull(),           // "HTTP" | "stdio"
    authPattern: text("auth_pattern").notNull(),      // e.g. "bearer", "x-api-key", "none"
    baseUrl: text("base_url"),                        // nullable — absent for stdio providers
    endpointTemplate: text("endpoint_template"),      // nullable — provider-specific template
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});

// ──────────────────────────────────────────────
// provider_models
// Canonical model catalog independent of any provider naming.
// Capability flags stored as SQLite integers (mode:"boolean") so Drizzle
// converts 0/1 ↔ false/true on read — asserted in tests ([inv:reopen-proves-persistence]).
// ──────────────────────────────────────────────
export const models = sqliteTable(
    "provider_models",
    {
        id: text("id").primaryKey(),                           // e.g. "claude_opus_4_8", "gpt_4o_mini"
        contextWindow: integer("context_window").notNull(),
        outputLimit: integer("output_limit").notNull(),
        vision: integer("vision", { mode: "boolean" }).notNull().default(false),
        promptCaching: integer("prompt_caching", { mode: "boolean" }).notNull().default(false),
        extendedThinking: integer("extended_thinking", { mode: "boolean" }).notNull().default(false),
        pricingTier: text("pricing_tier").notNull(),           // e.g. "premium", "standard", "economy"
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (table) => [
        index("idx_provider_models_pricing_tier").on(table.pricingTier),
    ]
);

// ──────────────────────────────────────────────
// provider_model_platform_bindings
// Maps a canonical model id + platform to the provider-specific string.
// PK is composite (model_id, platform) — one row per (model, platform) pair.
// model_id is a LOGICAL FK to provider_models.id (cross-package seeded lookup;
// no SQL FK so seeding order and shared-DB topology stay flexible).
// platform is a controlled-vocab text key (e.g. "claude_api", "claude_code",
// "bedrock") — never a SQL enum ([inv:lookup-not-enum]).
// ──────────────────────────────────────────────
export const modelPlatformBindings = sqliteTable(
    "provider_model_platform_bindings",
    {
        modelId: text("model_id").notNull(),                   // logical ref → provider_models.id
        platform: text("platform").notNull(),                  // e.g. "claude_api", "claude_code", "bedrock"
        platformModelId: text("platform_model_id").notNull(), // e.g. "claude-opus-4-8", "opus", ARN
    },
    (table) => [
        primaryKey({ columns: [table.modelId, table.platform] }),
        index("idx_provider_mpb_model_id").on(table.modelId),
    ]
);
