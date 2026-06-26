import { eq } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { agentsTable, sessionsTable } from "../db/schema.js";
import { logger } from "../logger.js";
import type { AgentCreateInput, AgentDefinition, AgentUpdateInput } from "../validation/index.js";
import { agentDefinitionSchema } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import { nowIso } from "../utils/timestamps.js";
import type { IHookRegistry } from "@adhd/agent-mcp-types";

/**
 * Thin compiled-agent cache (Plan 6 wave 3 — agent-store-retire).
 *
 * `AgentStore` was previously the source of truth for agent definitions
 * (authored `systemPrompt` blob + provider config). After wave 3 it is a
 * compiled-agent cache: the `agents.data` blob is populated from
 * `compileAgent()` output by `compiler-integration`, not authored by the user.
 *
 * The CRUD tool surface (`agent_create` / `agent_read` / `agent_update` /
 * `agent_delete` / `agent_list`) is retained unchanged for non-regression.
 * `agent_create` and `agent_update` no longer require a flat `systemPrompt` —
 * the field is an optional computed compat shim populated from compiler output.
 */
export class AgentStore {
    constructor(
        private readonly db: BetterSQLite3Database<Record<string, never>>,
        private readonly hooks?: IHookRegistry
    ) {}

    create(input: AgentCreateInput): AgentDefinition {
        const now = nowIso();
        const definition: AgentDefinition = {
            ...input,
            version: 1,
            createdAt: now,
            updatedAt: now,
        };

        const existing = this.db
            .select()
            .from(agentsTable)
            .where(eq(agentsTable.name, input.name))
            .get();

        if (existing) {
            throw new ToolError(
                "AGENT_ALREADY_EXISTS",
                `Agent '${input.name}' already exists`
            );
        }

        this.db.insert(agentsTable).values({
            name: definition.name,
            version: definition.version,
            data: JSON.stringify(definition),
            createdAt: now,
            updatedAt: now,
        }).run();

        logger.info({ agentName: input.name }, "Agent created");
        return definition;
    }

    read(name: string): AgentDefinition {
        const row = this.db
            .select()
            .from(agentsTable)
            .where(eq(agentsTable.name, name))
            .get();

        if (!row) {
            throw new ToolError(
                "AGENT_NOT_FOUND",
                `Agent '${name}' not found`
            );
        }

        return agentDefinitionSchema.parse(JSON.parse(row.data));
    }

    update(input: AgentUpdateInput): AgentDefinition {
        const existing = this.read(input.name); // throws AGENT_NOT_FOUND if missing

        // Strip undefined values so absent patch fields don't clobber existing ones
        const definedPatch = Object.fromEntries(
            Object.entries(input.patch).filter(([, v]) => v !== undefined)
        );

        const updated: AgentDefinition = {
            ...existing,
            ...definedPatch,
            name: existing.name,      // name is immutable
            createdAt: existing.createdAt, // createdAt is immutable
            version: existing.version + 1,
            updatedAt: nowIso(),
        };

        this.db
            .update(agentsTable)
            .set({
                version: updated.version,
                data: JSON.stringify(updated),
                updatedAt: updated.updatedAt,
            })
            .where(eq(agentsTable.name, input.name))
            .run();

        logger.info(
            { agentName: input.name, version: updated.version },
            "Agent updated"
        );
        void this.hooks?.emit("agent:mutated", { agent: updated, operation: "update" });
        return updated;
    }

    delete(name: string): void {
        // Read definition BEFORE the DELETE so we have it for the hook
        const definition = this.read(name); // throws AGENT_NOT_FOUND if missing

        const activeSessionCheck = this.db
            .select()
            .from(sessionsTable)
            .where(eq(sessionsTable.agentName, name))
            .all()
            .find(s => s.status === "active");

        if (activeSessionCheck) {
            throw new ToolError(
                "AGENT_HAS_ACTIVE_SESSIONS",
                `Agent '${name}' has active sessions and cannot be deleted`
            );
        }

        this.db
            .delete(agentsTable)
            .where(eq(agentsTable.name, name))
            .run();

        logger.info({ agentName: name }, "Agent deleted");
        void this.hooks?.emit("agent:mutated", { agent: definition, operation: "delete" });
    }

    list(): AgentDefinition[] {
        const rows = this.db.select().from(agentsTable).all();
        return rows.map(row => agentDefinitionSchema.parse(JSON.parse(row.data)));
    }
}
