import { logger } from "../logger.js";
import type { AgentStore } from "../store/agent-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { PromptResolverDeps } from "../engine/prompt-resolver.js";
import { resolveComposedPrompt } from "../engine/prompt-resolver.js";
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
    /**
     * Optional prompt-resolver dependencies.  When present, the session-start
     * path resolves the system-prompt via compileAgent and writes
     * sessions.composed_prompt_id.  When absent (legacy / tests that don't
     * exercise the compiler path), the session is created without resolution.
     */
    promptResolver?: PromptResolverDeps;
}

/**
 * `agent` tool — instantiates a session for a named agent.
 *
 * When called from within a running task context (executionContext is
 * defined), the policy engine enforces the allowedAgents check and we
 * log an AGENT_DELEGATION event.
 *
 * When `deps.promptResolver` is provided, the agent's system-prompt is
 * resolved via the compiler (with a composed_prompts cache lookup) and
 * `sessions.composed_prompt_id` is written with the resolved row id.
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

    // Resolve system-prompt via compiler when resolver deps are available.
    // The resolved content replaces the stored agentDefinition.systemPrompt
    // (compat-shim: [def:compat-shim]) and the composed_prompt_id is written
    // to the session row so consumers can trace the exact artifact used.
    let resolvedSystemPrompt: string | undefined;
    let composedPromptId: string | undefined;

    if (deps.promptResolver) {
        // resolveComposedPrompt returns null when the agent has no registry
        // composition (flat-systemPrompt compat fallback path).  In that case
        // resolvedSystemPrompt / composedPromptId remain undefined and the
        // session is created from the stored agentDefinition.systemPrompt below.
        const resolved = resolveComposedPrompt(
            {
                agentSlug: input.name,
                platform: agentDefinition.provider.type,
                context: {},
            },
            deps.promptResolver
        );
        if (resolved !== null) {
            resolvedSystemPrompt = resolved.content;
            composedPromptId = resolved.id;
        }
    }

    // Build the agent definition snapshot: if we resolved a system-prompt via
    // the compiler, populate systemPrompt from the compiled content (compat-shim).
    const snapshotDefinition = resolvedSystemPrompt !== undefined
        ? { ...agentDefinition, systemPrompt: resolvedSystemPrompt }
        : agentDefinition;

    const session = deps.sessionStore.create({
        agentName: input.name,
        agentDefinition: snapshotDefinition,
        composedPromptId,
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
