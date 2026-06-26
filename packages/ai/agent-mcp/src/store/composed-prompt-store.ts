import { and, eq } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { composedPromptsTable } from "../db/schema.js";
import { logger } from "../logger.js";
import { ToolError } from "../validation/errors.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { ComposedPrompt } from "@adhd/agent-mcp-types";

export class ComposedPromptStore {
    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>
    ) {}

    /**
     * Upserts a composed-prompt row. If a row already exists for the same
     * (agentSlug, contextHash) it is returned unchanged (cache hit). Otherwise
     * a new row is inserted and returned.
     *
     * Callers should prefer {@link findByAgentContext} to check for a hit before
     * calling upsert so they can distinguish new writes from cache hits.
     */
    upsert(row: Omit<ComposedPrompt, "id" | "createdAt">): ComposedPrompt {
        const existing = this.findByAgentContext(row.agentSlug, row.contextHash);
        if (existing) {
            return existing;
        }

        const id = generateId();
        const createdAt = nowIso();

        this.db.insert(composedPromptsTable).values({
            id,
            agentSlug: row.agentSlug,
            contextHash: row.contextHash,
            content: row.content,
            componentVersions: row.componentVersions,
            createdAt,
        }).run();

        logger.info(
            { composedPromptId: id, agentSlug: row.agentSlug },
            "Composed prompt cached"
        );

        return this.read(id);
    }

    /**
     * Returns the composed-prompt row for the given (agentSlug, contextHash) pair,
     * or null when no cached entry exists.
     */
    findByAgentContext(
        agentSlug: string,
        contextHash: string
    ): ComposedPrompt | null {
        const row = this.db
            .select()
            .from(composedPromptsTable)
            .where(
                and(
                    eq(composedPromptsTable.agentSlug, agentSlug),
                    eq(composedPromptsTable.contextHash, contextHash)
                )
            )
            .get();

        if (!row) return null;
        return this.#toModel(row);
    }

    /** Returns a composed-prompt row by primary key; throws if not found. */
    read(id: string): ComposedPrompt {
        const row = this.db
            .select()
            .from(composedPromptsTable)
            .where(eq(composedPromptsTable.id, id))
            .get();

        if (!row) {
            throw new ToolError(
                "COMPOSED_PROMPT_NOT_FOUND",
                `ComposedPrompt '${id}' not found`
            );
        }

        return this.#toModel(row);
    }

    #toModel(row: {
        id: string;
        agentSlug: string;
        contextHash: string;
        content: string;
        componentVersions: string;
        createdAt: string;
    }): ComposedPrompt {
        return {
            id: row.id,
            agentSlug: row.agentSlug,
            contextHash: row.contextHash,
            content: row.content,
            componentVersions: row.componentVersions,
            createdAt: row.createdAt,
        };
    }
}
