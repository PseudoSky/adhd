import type { AgentStore } from "../store/agent-store.js";
import type {
    AgentCreateInput,
    AgentDefinition,
    AgentDeleteInput,
    AgentReadInput,
    AgentUpdateInput,
} from "../validation/index.js";

export interface AgentCrudDeps {
    agentStore: AgentStore;
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
    deps.agentStore.delete(input.name);
    return { success: true };
}

export function agentList(_input: unknown, deps: AgentCrudDeps): AgentDefinition[] {
    return deps.agentStore.list();
}
