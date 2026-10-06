import type { PartialBinding } from "@adhd/agent-base-types";
import type { AgentStore } from "./agent-crud.js";
import { ToolError } from "../validation/errors.js";
import type { ExecutionContext } from "../validation/index.js";
import type { EngineLogger } from "../interfaces.js";
import type {
    AgentToolInput,
    AgentToolOutput,
    Session,
    SessionCloseInput,
    SessionClearInput,
    SessionClearOutput,
    SessionUpdateInput,
    SessionListInput,
} from "../validation/index.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { PromptResolverDeps } from "../engine/prompt-resolver.js";
import { resolveComposedPrompt } from "../engine/prompt-resolver.js";

export interface SessionStoreForTool {
    create(input: { agentName: string; agentDefinition: unknown; composedPromptId?: string }): { id: string };
    read(sessionId: string): { status: string };
    /**
     * The session's agent definition, resolved against the CURRENT task-time
     * cwd (ADR-0008 D4). `cwd` is the caller-supplied cwd for this task (from
     * the `task` input, or inherited from the dispatching parent); absent ⇒ the
     * host falls back to `process.cwd()` (flagged). Plain stores ignore it.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAgentDefinition(sessionId: string, cwd?: string): any;
    getMessages(sessionId: string): unknown[];
    /**
     * The session-held provider binding (the `session` tier of the selection
     * chain), or `null` when the session holds none. Optional: a store with no
     * binding support behaves as if every session holds none.
     */
    getSelection?(sessionId: string): PartialBinding | null;
    /** Swap the session-held binding (only supplied fields are written). */
    updateSelection?(sessionId: string, binding: PartialBinding): PartialBinding | null;
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
    // Caller-cwd contract (ADR-0008 D4): the caller may supply a `cwd`; a
    // sub-dispatch inherits the parent's. Absent ⇒ the host falls back to its
    // own process.cwd() (flagged on the resolve context).
    const effectiveCwd = input.cwd ?? executionContext?.cwd;
    const agentDefinition = deps.agentStore.read(input.name, effectiveCwd);
    // The session snapshot must be the DECLARATIVE definition (ADR-0008 D4/D8):
    // persist `readUnresolved` when the host exposes it so a task-time resolved
    // root is never frozen into `sessions.agent_data`. The resolved definition is
    // still used for prompt-platform selection and delegation policy below.
    const storedDefinition =
        deps.agentStore.readUnresolved?.(input.name) ?? agentDefinition;

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

    // A provider-less agent has no prompt platform yet (the binding is chosen per
    // session later), so it keeps its flat systemPrompt instead of compiling for
    // an unknown platform.
    if (deps.promptResolver && agentDefinition.provider) {
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
        ? { ...storedDefinition, systemPrompt: resolvedSystemPrompt }
        : storedDefinition;

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

/**
 * `session_update`: set the session-held provider binding — the `session` tier of
 * the selection chain `task ?? session ?? agent ?? global`. Persists the binding
 * only; it takes effect for the NEXT task dispatched on the session (mid-task
 * soft swap is D-G(3)). `model`/`models` are canonical refs, resolved to wire
 * strings at provider construction.
 */
export function sessionUpdate(
    input: SessionUpdateInput,
    deps: SessionDeps
): { session_id: string; selection: PartialBinding | null } {
    if (!deps.sessionStore.updateSelection) {
        throw new ToolError(
            "VALIDATION_ERROR",
            "This session store does not support provider bindings"
        );
    }
    const binding: PartialBinding = {};
    if (input.provider !== undefined) binding.providerType = input.provider;
    if (input.model !== undefined) binding.modelRef = input.model;
    if (input.models !== undefined) binding.models = input.models;
    const selection = deps.sessionStore.updateSelection(input.session_id, binding);
    return { session_id: input.session_id, selection };
}
