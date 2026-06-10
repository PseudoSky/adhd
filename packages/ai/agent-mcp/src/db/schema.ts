import {
    index,
    integer,
    sqliteTable,
    text
} from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────
// agents
// ──────────────────────────────────────────────
export const agentsTable = sqliteTable("agents", {
    name: text("name").primaryKey(),
    version: integer("version").notNull().default(1),
    data: text("data").notNull(), // JSON blob: AgentDefinition
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});

// ──────────────────────────────────────────────
// sessions
// ──────────────────────────────────────────────
export const sessionsTable = sqliteTable("sessions", {
    id: text("id").primaryKey(),
    agentName: text("agent_name")
        .notNull()
        .references(() => agentsTable.name, {
            onDelete: "cascade"
        }),
    agentVersion: integer("agent_version").notNull(),
    // Full JSON snapshot of AgentDefinition at session creation time.
    // Not exposed in the public Session type — accessed only via
    // SessionStore.getAgentDefinition(sessionId).
    agentData: text("agent_data").notNull(),
    status: text("status", {
        enum: ["active", "closed"]
    }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
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
    // JSON blobs for tool call / result payloads
    toolCalls: text("tool_calls"),
    toolResults: text("tool_results"),
    createdAt: text("created_at").notNull(),
});

// ──────────────────────────────────────────────
// tasks
// ──────────────────────────────────────────────
export const tasksTable = sqliteTable("tasks", {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
        .notNull()
        .references(() => sessionsTable.id, {
            onDelete: "cascade"
        }),
    parentTaskId: text("parent_task_id"),
    recursionDepth: integer("recursion_depth").notNull().default(0),
    status: text("status", {
        enum: ["pending", "running", "completed", "failed", "cancelled"]
    }).notNull().default("pending"),
    prompt: text("prompt").notNull(),
    result: text("result"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    cancelledAt: text("cancelled_at"),
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
    payload: text("payload"), // JSON
    createdAt: text("created_at").notNull(),
});

// ──────────────────────────────────────────────
// task_usage
// ──────────────────────────────────────────────
// No FK on task_id → tasks.id: ephemeral tasks never write a tasks row,
// and cleanup scenarios make the constraint unreliable.
export const taskUsageTable = sqliteTable(
    "task_usage",
    {
        taskId: text("task_id").primaryKey(),
        // null = this task IS the root of its delegation tree.
        // non-null = task_id of the topmost ancestor.
        rootTaskId: text("root_task_id"),
        agentName: text("agent_name").notNull(),
        // "openai" | "anthropic" | "lmstudio" | "claudecli" — kept as plain
        // text rather than an enum so new providers don't require a migration.
        providerType: text("provider_type").notNull(),
        model: text("model").notNull(),
        // Accumulated across all post:model_response events for this task.
        inputTokens: integer("input_tokens").notNull().default(0),
        outputTokens: integer("output_tokens").notNull().default(0),
        toolCallCount: integer("tool_call_count").notNull().default(0),
        modelCalls: integer("model_calls").notNull().default(0),
        // Wall-clock ms from task start to terminal event; 0 until terminal.
        latencyMs: integer("latency_ms").notNull().default(0),
        // 0 = in-progress or crashed before terminal; 1 = terminal event fired.
        isComplete: integer("is_complete").notNull().default(0),
        // null until first post:model_response — most-severe stop reason across all
        // model calls for this task. See [ref:normalised-stop-reason].
        stopReason: text("stop_reason"),
        // null for claudecli (no maxTokens in config) and for tasks started before
        // this migration. Written once at task-start from provider.maxTokens.
        maxTokens: integer("max_tokens"),
        createdAt: text("created_at").notNull(),
    },
    (table) => [
        // Critical for O(1) subtree aggregation:
        //   WHERE task_id = ? OR root_task_id = ?
        index("idx_task_usage_root_task_id").on(table.rootTaskId),
    ]
);
