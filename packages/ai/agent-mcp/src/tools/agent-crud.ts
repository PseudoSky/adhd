import type { AgentStore } from "../store/agent-store.js";
import type { SessionStore } from "../store/session-store.js";
import type {
    AgentCreateInput,
    AgentDefinition,
    AgentDeleteInput,
    AgentReadInput,
    AgentUpdateInput,
} from "../validation/index.js";

export interface AgentCrudDeps {
    agentStore: AgentStore;
    sessionStore: SessionStore;
}

export function agentCreate(input: AgentCreateInput, deps: AgentCrudDeps): AgentDefinition {
    return deps.agentStore.create(input);
}

export function agentRead(input: AgentReadInput, deps: AgentCrudDeps): AgentDefinition {
    return deps.agentStore.read(input.name);
}

export function agentUpdate(input: AgentUpdateInput, deps: AgentCrudDeps): AgentDefinition {
    return deps.agentStore.update(input);
}

export function agentDelete(input: AgentDeleteInput, deps: AgentCrudDeps): { success: true } {
    if (input.force) {
        // BUG-002 escape hatch: close any active sessions before deleting so the
        // AGENT_HAS_ACTIVE_SESSIONS guard doesn't block recovery from a failed
        // delegation that orphaned sessions. Only closes sessions; does not touch
        // user-persistent sessions that were explicitly kept open by the caller.
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
