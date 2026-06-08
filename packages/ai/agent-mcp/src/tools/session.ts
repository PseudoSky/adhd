import { logger } from "../logger.js";
import type { AgentStore } from "../store/agent-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { PolicyEngine } from "../engine/policy.js";
import type {
    AgentToolInput,
    AgentToolOutput,
    ExecutionContext,
    Session,
    SessionCloseInput,
    SessionClearInput,
    SessionClearOutput,
    SessionListInput,
} from "../validation/index.js";

export interface SessionDeps {
    agentStore: AgentStore;
    sessionStore: SessionStore;
    policy: PolicyEngine;
}

/**
 * `agent` tool — instantiates a session for a named agent.
 *
 * When called from within a running task context (executionContext is
 * defined), the policy engine enforces the allowedAgents check and we
 * log an AGENT_DELEGATION event.
 */
export async function agentTool(
    input: AgentToolInput,
    deps: SessionDeps,
    executionContext?: ExecutionContext
): Promise<AgentToolOutput> {
    const agentDefinition = deps.agentStore.read(input.name); // throws AGENT_NOT_FOUND

    // Policy check when called from within a running task
    if (executionContext) {
        deps.policy.check({
            executionContext,
            targetTool: "agent-mcp__agent",
            targetAgentName: input.name,
        });

        logger.info(
            {
                taskId: executionContext.taskId,
                targetAgent: input.name,
                newDepth: executionContext.recursionDepth + 1,
            },
            "AGENT_DELEGATION"
        );
    }

    const session = deps.sessionStore.create({
        agentName: input.name,
        agentDefinition,
    });

    return { session_id: session.id };
}

export function sessionList(input: SessionListInput, deps: SessionDeps): Session[] {
    return deps.sessionStore.list(input);
}

export function sessionClose(input: SessionCloseInput, deps: SessionDeps): Session {
    // SessionStore.close() throws SESSION_NOT_FOUND or SESSION_CLOSED as appropriate
    return deps.sessionStore.close(input.session_id);
}

export function sessionClear(input: SessionClearInput, deps: SessionDeps): SessionClearOutput {
    const cleared = deps.sessionStore.clearMessages(input.session_id);
    return { session_id: input.session_id, cleared };
}
