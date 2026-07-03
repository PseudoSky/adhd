import type { AgentStore } from "./agent-crud.js";
import type { ExecutionContext } from "../validation/index.js";
import type { EngineLogger } from "../interfaces.js";
import type {
    AgentToolInput,
    AgentToolOutput,
    Session,
    SessionCloseInput,
    SessionClearInput,
    SessionClearOutput,
    SessionListInput,
} from "../validation/index.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { PromptResolverDeps } from "../engine/prompt-resolver.js";
import { resolveComposedPrompt } from "../engine/prompt-resolver.js";

export interface SessionStoreForTool {
    create(input: { agentName: string; agentDefinition: unknown; composedPromptId?: string }): { id: string };
    read(sessionId: string): { status: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAgentDefinition(sessionId: string): any;
    getMessages(sessionId: string): unknown[];
    list(input: SessionListInput): Session[];
    close(sessionId: string): Session;
    clearMessages(sessionId: string): number;
}

export interface SessionDeps {
    agentStore: AgentStore;
    sessionStore: SessionStoreForTool;
    policy: PolicyEngine;
    promptResolver?: PromptResolverDeps;
    logger?: EngineLogger;
}

export async function agentTool(
    input: AgentToolInput,
    deps: SessionDeps,
    executionContext?: ExecutionContext
): Promise<AgentToolOutput> {
    const agentDefinition = deps.agentStore.read(input.name);

    if (executionContext) {
        deps.policy.check({
            executionContext,
            targetTool: "agent-mcp__agent",
            targetAgentName: input.name,
        });

        const log = deps.logger;
        if (log) {
            log.info(
                {
                    taskId: executionContext.taskId,
                    targetAgent: input.name,
                    newDepth: executionContext.recursionDepth + 1,
                },
                "AGENT_DELEGATION"
            );
        }
    }

    let resolvedSystemPrompt: string | undefined;
    let composedPromptId: string | undefined;

    if (deps.promptResolver) {
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
    return deps.sessionStore.close(input.session_id);
}

export function sessionClear(input: SessionClearInput, deps: SessionDeps): SessionClearOutput {
    const cleared = deps.sessionStore.clearMessages(input.session_id);
    return { session_id: input.session_id, cleared };
}
