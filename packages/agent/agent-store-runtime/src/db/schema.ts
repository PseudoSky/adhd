import {
    index,
    integer,
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
        createdAt: text("created_at").notNull(),
    },
    (table) => [
        index("idx_task_usage_root_task_id").on(table.rootTaskId),
    ]
);
