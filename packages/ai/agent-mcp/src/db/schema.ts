import {
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
