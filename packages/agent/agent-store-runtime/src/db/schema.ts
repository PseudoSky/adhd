import {
    index,
    integer,
    real,
    sqliteTable,
    text,
    uniqueIndex
} from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────
// sessions
// ──────────────────────────────────────────────
export const sessionsTable = sqliteTable("sessions", {
    id: text("id").primaryKey(),
    agentName: text("agent_name")
        .notNull(),
    agentVersion: integer("agent_version").notNull(),
    agentData: text("agent_data").notNull(),
    status: text("status", {
        enum: ["active", "closed"]
    }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
    composedPromptId: text("composed_prompt_id"),
});

/**
 * The session-held provider binding columns (D-G(2); added by agent-mcp
 * migration 0011). Declared as a SEPARATE view over the same `sessions` table
 * so a store whose `sessions` DDL predates the migration keeps working for every
 * non-binding query (`sessionsTable` selects an explicit older column set).
 * `models` is a JSON ModelSlug[].
 */
export const sessionBindingTable = sqliteTable("sessions", {
    id: text("id").primaryKey(),
    providerType: text("provider_type"),
    modelRef: text("model_ref"),
    models: text("models"),
});

// ──────────────────────────────────────────────
// messages
// ──────────────────────────────────────────────
export const messagesTable = sqliteTable("messages", {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
        .notNull()
        .references(() => sessionsTable.id, {
            onDelete: "cascade"
        }),
    role: text("role", {
        enum: ["system", "user", "assistant", "tool"]
    }).notNull(),
    content: text("content"),
    toolCalls: text("tool_calls"),
    toolResults: text("tool_results"),
    createdAt: text("created_at").notNull(),
});

// ──────────────────────────────────────────────
// tasks
// ──────────────────────────────────────────────
export const tasksTable = sqliteTable("tasks", {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    parentTaskId: text("parent_task_id"),
    isEphemeral: integer("is_ephemeral").notNull().default(0),
    recursionDepth: integer("recursion_depth").notNull().default(0),
    status: text("status", {
        enum: ["pending", "running", "completed", "failed", "cancelled", "waiting", "awaiting_input"]
    }).notNull().default("pending"),
    prompt: text("prompt").notNull(),
    result: text("result"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    cancelledAt: text("cancelled_at"),
    depends_on: text("depends_on"),
    on_upstream_failure: text("on_upstream_failure"),
    inputs: text("inputs"),
    resume_token: text("resume_token"),
});

// ──────────────────────────────────────────────
// task_events
// ──────────────────────────────────────────────
export const taskEventsTable = sqliteTable("task_events", {
    id: text("id").primaryKey(),
    taskId: text("task_id")
        .notNull()
        .references(() => tasksTable.id, {
            onDelete: "cascade"
        }),
    type: text("type", {
        enum: [
            "MODEL_REQUEST",
            "MODEL_RESPONSE",
            "TOOL_CALL",
            "TOOL_RESULT",
            "TOOL_ARG_COERCED",
            "TASK_COMPLETED",
            "TASK_FAILED",
            "TASK_CANCELLED"
        ]
    }).notNull(),
    payload: text("payload"),
    createdAt: text("created_at").notNull(),
});

// ──────────────────────────────────────────────
// composed_prompts
// ──────────────────────────────────────────────
export const composedPromptsTable = sqliteTable(
    "composed_prompts",
    {
        id: text("id").primaryKey(),
        agentSlug: text("agent_slug").notNull(),
        contextHash: text("context_hash").notNull(),
        content: text("content").notNull(),
        componentVersions: text("component_versions").notNull(),
        createdAt: text("created_at").notNull(),
    },
    (table) => [
        uniqueIndex("idx_composed_prompts_agent_ctx").on(
            table.agentSlug,
            table.contextHash
        ),
    ]
);

// ──────────────────────────────────────────────
// experiment_assignments
// ──────────────────────────────────────────────
export const experimentAssignmentsTable = sqliteTable("experiment_assignments", {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
        .notNull()
        .references(() => sessionsTable.id, { onDelete: "cascade" }),
    experimentSlug: text("experiment_slug").notNull(),
    variant: text("variant").notNull(),
    createdAt: text("created_at").notNull(),
});

// ──────────────────────────────────────────────
// task_usage
// ──────────────────────────────────────────────
export const taskUsageTable = sqliteTable(
    "task_usage",
    {
        taskId: text("task_id").primaryKey(),
        rootTaskId: text("root_task_id"),
        agentName: text("agent_name").notNull(),
        providerType: text("provider_type").notNull(),
        model: text("model").notNull(),
        // CUMULATIVE across the task's model calls (SUM). Because chat APIs are stateless,
        // the whole history is re-sent every call, so this is billed spend — NOT a context
        // size. Do not read it as one. See peakContextTokens. (FINDING-ORCH-007)
        inputTokens: integer("input_tokens").notNull().default(0),
        outputTokens: integer("output_tokens").notNull().default(0),
        toolCallCount: integer("tool_call_count").notNull().default(0),
        modelCalls: integer("model_calls").notNull().default(0),
        latencyMs: integer("latency_ms").notNull().default(0),
        isComplete: integer("is_complete").notNull().default(0),
        stopReason: text("stop_reason"),
        maxTokens: integer("max_tokens"),
        cacheReadTokens: integer("cache_read_input_tokens"),
        cacheCreationTokens: integer("cache_creation_input_tokens"),
        // Full-price (cache-miss) input. Cache-hit vs cache-miss is a 50x price difference
        // on deepseek-v4-flash, so this — not inputTokens — is what actually drives cost.
        uncachedInputTokens: integer("uncached_input_tokens"),
        // Reasoning tokens (reasoning models); billed as output.
        reasoningTokens: integer("reasoning_tokens"),
        // PEAK single-call input (MAX, not SUM) — the real context high-water mark, and the
        // only number that may be compared against a model's context window.
        peakContextTokens: integer("peak_context_tokens"),
        // Which model call (1-based) hit that peak.
        peakContextAt: integer("peak_context_at"),
        // CUMULATIVE Σ of per-turn model-call latency (MODEL_RESPONSE.created_at -
        // MODEL_REQUEST.created_at) — turn-level compute time, distinct from the
        // task-wall-clock `latencyMs` above (see DESIGN.md §6: the two answer
        // different questions — "how long did the model think" vs "how long did
        // the whole task take", and a turn-sum would undercount real duration by
        // missing tool-exec/queueing gaps between calls).
        computeMs: integer("compute_ms"),
        // CUMULATIVE Σ of tokenized tool-result payloads, tokenized on the FULL
        // result BEFORE the existing 500-char truncation applied to the stored
        // `task_events.TOOL_RESULT.result` summary — tokenizing the truncated
        // summary would undercount every large tool result.
        estToolResultTokens: integer("est_tool_result_tokens"),
        // CUMULATIVE Σ of estimated dollar cost from the rate-card module
        // (agent-core-provider/src/pricing/rate-card.ts). NULL (never 0) once any
        // turn's model has no rate-card entry — an unknown model's cost must never
        // be silently reported as $0.
        estCostUsd: real("est_cost_usd"),
        // ── Cost provenance (1f1c8598 / 37f6c511). All nullable: rows written before
        // migration 0012 read NULL = "provenance unknown" (never back-filled).
        // Model id the provider says actually served the call (response.model).
        responseModel: text("response_model"),
        // Which basis priced it: 'vendor-direct' | 'openrouter-estimate' | 'owner-assumption'.
        costBasis: text("cost_basis"),
        // Pointer to the price record used: 'rate-card:<key>' | history row id | 'bundled:<fetchedAt>:<id>'.
        pricingRef: text("pricing_ref"),
        // 'priced' | 'unpriced_model' | 'partial' (mixed priced/unpriced turns).
        costStatus: text("cost_status"),
        // CUMULATIVE Σ of the PRICED turns only (unpriced turns add 0), so a partial
        // task still reports the portion that could be priced while est_cost_usd stays NULL.
        pricedCostUsd: real("priced_cost_usd"),
        // CUMULATIVE Σ input+output tokens of turns whose model had no price.
        unpricedTokens: integer("unpriced_tokens"),
        createdAt: text("created_at").notNull(),
    },
    (table) => [
        index("idx_task_usage_root_task_id").on(table.rootTaskId),
    ]
);

// ──────────────────────────────────────────────
// model_price_history  (append-only; UPDATE/DELETE blocked by triggers in 0012)
// ──────────────────────────────────────────────
/**
 * Observation-time price history. Rates are USD per MILLION tokens, normalised to
 * 12 significant digits by the single shared `perMillion` conversion. NULL = absent
 * (or router); 0 = a real free price. Corrections are new rows; newest `observed_at` wins.
 */
export const modelPriceHistoryTable = sqliteTable(
    "model_price_history",
    {
        id: text("id").primaryKey(),
        modelId: text("model_id").notNull(),
        observedAt: text("observed_at").notNull(),
        // 'bundled' | 'openrouter-live'
        source: text("source").notNull(),
        // 'model' | 'router' (router => rates NULL => unpriced)
        kind: text("kind").notNull().default("model"),
        inputPerM: real("input_per_m"),
        cacheReadPerM: real("cache_read_per_m"),
        cacheWritePerM: real("cache_write_per_m"),
        outputPerM: real("output_per_m"),
        // Verbatim per-token pricing strings (float-dispute defence).
        rawJson: text("raw_json").notNull(),
        // Verbatim `pricing.overrides`; applied to nothing (phase 1).
        overridesJson: text("overrides_json"),
        // NULL for the bundled seed.
        ledgerId: text("ledger_id"),
    },
    (table) => [
        index("idx_price_history_model_observed").on(table.modelId, table.observedAt),
        uniqueIndex("uq_price_history_obs").on(table.modelId, table.observedAt, table.source),
    ]
);

// ──────────────────────────────────────────────
// price_pull_ledger
// ──────────────────────────────────────────────
/** One row per live-price pull attempt (also the multi-process claim record). */
export const pricePullLedgerTable = sqliteTable(
    "price_pull_ledger",
    {
        id: text("id").primaryKey(),
        startedAt: text("started_at").notNull(),
        finishedAt: text("finished_at"),
        // 'running' | 'ok' | 'failed' | 'rejected_shrink' | 'rejected_invalid'
        status: text("status").notNull(),
        httpStatus: integer("http_status"),
        modelsSeen: integer("models_seen"),
        newCount: integer("new_count"),
        changedCount: integer("changed_count"),
        unchangedCount: integer("unchanged_count"),
        anomaliesJson: text("anomalies_json"),
        error: text("error"),
        durationMs: integer("duration_ms"),
        sourceUrl: text("source_url").notNull(),
    },
    (table) => [index("idx_price_pull_ledger_started").on(table.startedAt)]
);
