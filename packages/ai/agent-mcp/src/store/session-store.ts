import { and, eq } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { messagesTable, sessionsTable } from "../db/schema.js";
import { logger } from "../logger.js";
import type { AgentDefinition, Message, Session, SessionListInput } from "../validation/index.js";
import { agentDefinitionSchema, sessionSchema } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { IHookRegistry } from "@adhd/agent-mcp-types";

export class SessionStore {
    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>,
        private readonly hooks?: IHookRegistry
    ) {}

    create(input: {
        agentName: string;
        agentDefinition: AgentDefinition;
        /**
         * Optional: the composed_prompts row id produced (or served from cache)
         * by the prompt-resolver at session start.  Written to
         * sessions.composed_prompt_id so callers can trace the exact compiled
         * artifact used.  Null/undefined for legacy sessions created before the
         * registry integration (backward-compatible additive column).
         */
        composedPromptId?: string;
    }): Session {
        const now = nowIso();
        const id = generateId();

        this.db.insert(sessionsTable).values({
            id,
            agentName: input.agentName,
            agentVersion: input.agentDefinition.version,
            agentData: JSON.stringify(input.agentDefinition),
            status: "active",
            createdAt: now,
            updatedAt: now,
            composedPromptId: input.composedPromptId ?? null,
        }).run();

        logger.info(
            { sessionId: id, agentName: input.agentName },
            "Session created"
        );

        const session = this.read(id);
        void this.hooks?.emit("session:created", { session });
        return session;
    }

    read(id: string): Session {
        const row = this.db
            .select()
            .from(sessionsTable)
            .where(eq(sessionsTable.id, id))
            .get();

        if (!row) {
            throw new ToolError(
                "SESSION_NOT_FOUND",
                `Session '${id}' not found`
            );
        }

        return sessionSchema.parse({
            id: row.id,
            agentName: row.agentName,
            agentVersion: row.agentVersion,
            status: row.status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            closedAt: row.closedAt ?? undefined,
        });
    }

    /**
     * Returns the snapshotted AgentDefinition stored at session creation time.
     * This is intentionally separate from `read()` which returns the public
     * Session shape — `agentData` is storage-only and never exposed directly.
     */
    getAgentDefinition(sessionId: string): AgentDefinition {
        const row = this.db
            .select()
            .from(sessionsTable)
            .where(eq(sessionsTable.id, sessionId))
            .get();

        if (!row) {
            throw new ToolError(
                "SESSION_NOT_FOUND",
                `Session '${sessionId}' not found`
            );
        }

        return agentDefinitionSchema.parse(JSON.parse(row.agentData));
    }

    list(input: SessionListInput): Session[] {
        const conditions = [];

        if (input.agentName) {
            conditions.push(eq(sessionsTable.agentName, input.agentName));
        }

        if (input.status) {
            conditions.push(eq(sessionsTable.status, input.status));
        }

        const rows =
            conditions.length > 0
                ? this.db
                    .select()
                    .from(sessionsTable)
                    .where(and(...conditions))
                    .all()
                : this.db.select().from(sessionsTable).all();

        return rows.map(row =>
            sessionSchema.parse({
                id: row.id,
                agentName: row.agentName,
                agentVersion: row.agentVersion,
                status: row.status,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                closedAt: row.closedAt ?? undefined,
            })
        );
    }

    close(id: string): Session {
        const session = this.read(id); // throws SESSION_NOT_FOUND if missing

        if (session.status === "closed") {
            throw new ToolError(
                "SESSION_CLOSED",
                `Session '${id}' is already closed`
            );
        }

        const now = nowIso();
        this.db
            .update(sessionsTable)
            .set({
                status: "closed",
                closedAt: now,
                updatedAt: now,
            })
            .where(eq(sessionsTable.id, id))
            .run();

        logger.info({ sessionId: id }, "Session closed");
        return this.read(id);
    }

    clearMessages(sessionId: string): number {
        const session = this.read(sessionId); // throws SESSION_NOT_FOUND if missing

        if (session.status === "closed") {
            throw new ToolError(
                "SESSION_CLOSED",
                `Session '${sessionId}' is closed; cannot clear context`
            );
        }

        const result = this.db
            .delete(messagesTable)
            .where(eq(messagesTable.sessionId, sessionId))
            .run();

        logger.info({ sessionId, cleared: result.changes }, "Session context cleared");
        return result.changes;
    }

    appendMessage(sessionId: string, message: Message): void {
        this.db.insert(messagesTable).values({
            id: message.id,
            sessionId,
            role: message.role,
            content: message.content ?? null,
            toolCalls: message.toolCalls
                ? JSON.stringify(message.toolCalls)
                : null,
            toolResults: message.toolResults
                ? JSON.stringify(message.toolResults)
                : null,
            createdAt: message.createdAt,
        }).run();
    }

    getMessages(sessionId: string): Message[] {
        const rows = this.db
            .select()
            .from(messagesTable)
            .where(eq(messagesTable.sessionId, sessionId))
            .all();

        return rows.map(row => ({
            id: row.id,
            sessionId: row.sessionId,
            role: row.role as Message["role"],
            content: row.content ?? undefined,
            toolCalls: row.toolCalls ? JSON.parse(row.toolCalls) : undefined,
            toolResults: row.toolResults
                ? JSON.parse(row.toolResults)
                : undefined,
            createdAt: row.createdAt,
        }));
    }
}

/**
 * Estimates the token count for a set of messages using a 4-chars-per-token heuristic.
 */
export function estimateTokens(messages: Message[]): number {
    return Math.ceil(
        messages.reduce((sum, m) => {
            return (
                sum +
                (m.content?.length ?? 0) +
                (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0) +
                (m.toolResults ? JSON.stringify(m.toolResults).length : 0)
            );
        }, 0) / 4
    );
}

/**
 * Returns a windowed view of messages that fits within tokenLimit estimated tokens.
 * System messages are always preserved. Oldest non-system messages are dropped first.
 * Returns the original array unchanged if tokenLimit <= 0 or the array already fits.
 *
 * See [inv:window-messages] in docs/plan/0.0.6/contexts/_shared.md.
 */
export function windowMessages(messages: Message[], tokenLimit: number): Message[] {
    if (tokenLimit <= 0) return messages;
    if (estimateTokens(messages) <= tokenLimit) return messages;

    const systemMessages = messages.filter(m => m.role === "system");
    const nonSystemMessages = messages.filter(m => m.role !== "system");

    const systemBudget = estimateTokens(systemMessages);
    const remaining = Math.max(0, tokenLimit - systemBudget);

    const selected: Message[] = [];
    let used = 0;

    // Walk newest-to-oldest; include at least one message even if it exceeds budget
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
        const msg = nonSystemMessages[i];
        const cost = estimateTokens([msg]);
        if (used + cost > remaining && selected.length > 0) break;
        selected.unshift(msg);
        used += cost;
    }

    return [...systemMessages, ...selected];
}
