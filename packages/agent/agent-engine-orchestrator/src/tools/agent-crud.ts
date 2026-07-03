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

export function agentUpdate(input: AgentUpdateInput, deps: AgentCrudDeps): AgentDefinition {
    return deps.agentStore.update(input);
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
