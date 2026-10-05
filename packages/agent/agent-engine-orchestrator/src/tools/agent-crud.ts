import type {
    AgentCreateInput,
    AgentDefinition,
    AgentDeleteInput,
    AgentReadInput,
    AgentUpdateInput,
} from "../validation/index.js";

export interface AgentStore {
    create(input: AgentCreateInput): AgentDefinition;
    read(name: string): AgentDefinition;
    update(input: AgentUpdateInput): AgentDefinition;
    delete(name: string): void;
    list(): AgentDefinition[];
}

export interface SessionStoreForCrud {
    list(filter: { agentName: string; status: string }): Array<{ id: string }>;
    close(sessionId: string): void;
}

export interface AgentCrudDeps {
    agentStore: AgentStore;
    sessionStore: SessionStoreForCrud;
}

export function agentCreate(input: AgentCreateInput, deps: AgentCrudDeps): AgentDefinition {
    return deps.agentStore.create(input);
}

export function agentRead(input: AgentReadInput, deps: AgentCrudDeps): AgentDefinition {
    return deps.agentStore.read(input.name);
}

/**
 * The `agent_update` result: the updated definition PLUS the ids of every
 * currently-ACTIVE session on that agent that will NOT receive this update.
 *
 * A session snapshots its agent definition at creation (documented, intended),
 * so an update silently never reaches already-open sessions — the operator only
 * discovers it later when a retry on the old `session_id` reproduces the exact
 * failure they just fixed (backlog 301f040a). Surfacing the open session ids
 * on the update response makes that visible up front: close/reopen the listed
 * sessions (or open fresh ones) to pick up the new definition.
 */
export type AgentUpdateResult = AgentDefinition & {
    openSessionsNotUpdated: string[];
};

export function agentUpdate(input: AgentUpdateInput, deps: AgentCrudDeps): AgentUpdateResult {
    const updated = deps.agentStore.update(input);

    // Read AFTER the write: any session active at this point was created from
    // the pre-update snapshot, so it will keep running on the old definition.
    const openSessions = deps.sessionStore.list({
        agentName: input.name,
        status: "active",
    });

    return {
        ...updated,
        openSessionsNotUpdated: openSessions.map((s) => s.id),
    };
}

export function agentDelete(input: AgentDeleteInput, deps: AgentCrudDeps): { success: true } {
    if (input.force) {
        const activeSessions = deps.sessionStore.list({ agentName: input.name, status: "active" });
        for (const session of activeSessions) {
            try {
                deps.sessionStore.close(session.id);
            } catch {
                // Already closed in a race — ignore
            }
        }
    }
    deps.agentStore.delete(input.name);
    return { success: true };
}

export function agentList(_input: unknown, deps: AgentCrudDeps): AgentDefinition[] {
    return deps.agentStore.list();
}
