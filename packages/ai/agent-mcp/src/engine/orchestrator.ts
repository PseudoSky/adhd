import { logger } from "../logger.js";
import type { LLMProvider } from "../providers/types.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import type { IHookRegistry } from "@adhd/agent-mcp-types";
import { ToolError } from "../validation/errors.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { emitTaskEvent } from "../streaming/event-bus.js";

import type { McpClientRegistry } from "../clients/registry.js";
import type { PolicyEngine } from "./policy.js";
import type { TaskStore } from "../store/task-store.js";
import type { SessionStore } from "../store/session-store.js";
import { windowMessages } from "../store/session-store.js";

// ── HITL (Human-in-the-Loop) support ─────────────────────────────────────────

/** Built-in tool name intercepted before any MCP client dispatch. */
const HITL_TOOL_NAME = "request_human_input";

/**
 * Tool definition advertised to the model when `allowHumanInput === true` on
 * the agent and the task is non-ephemeral.
 *
 * Name encodes as `builtin__request_human_input`:
 *  - server = "builtin"  (both OpenAI and Anthropic split on first "__")
 *  - tool   = "request_human_input"  ← matches HITL_TOOL_NAME
 *
 * The existing Phase-1 intercept (`tc.tool === HITL_TOOL_NAME`) catches it
 * before Phase-2 dispatch, so it is never forwarded to any MCP client.
 */
const HITL_BUILTIN_TOOL_DEFINITION = {
    name: "builtin__request_human_input",
    description:
        "Pause the task to ask the human operator a question. The task suspends " +
        "until a human answers via task_resume. Use when you need human confirmation, " +
        "a decision, or missing information you cannot obtain yourself.",
    inputSchema: {
        type: "object",
        properties: {
            prompt: {
                type: "string",
                description: "The question to ask the human.",
            },
        },
        required: ["prompt"],
    },
} as const;

/**
 * Module-scoped resolver map: taskId → resolver function.
 * Populated when an orchestrator suspends awaiting human input.
 * Entries are cleared when resolved or when the task is cancelled.
 */
const hitlResolvers = new Map<string, (userInput: string) => void>();

/**
 * Resolve a suspended HITL task with the provided user input.
 * Returns `true` if the resolver was found and called; `false` if the
 * process restarted and the in-memory resolver no longer exists.
 */
export function resolveHitl(taskId: string, userInput: string): boolean {
    const resolve = hitlResolvers.get(taskId);
    if (!resolve) return false;
    hitlResolvers.delete(taskId);
    resolve(userInput);
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface OrchestratorRunInput {
    executionContext: ExecutionContext;
    messages: Message[];
    registry: McpClientRegistry;
    provider: LLMProvider;
    policy: PolicyEngine;
    taskStore: TaskStore;
    sessionStore: SessionStore;
    signal: AbortSignal;
    taskId: string;
    hooks?: IHookRegistry;
    /**
     * Set to `true` for ephemeral (one-shot) tasks (agent_name mode).
     * Ephemeral tasks DO persist a tasks row + task_events + task_usage, but
     * have no sessions row and no messages rows. When `true`,
     * `request_human_input` is forbidden because HITL cannot be resumed across
     * a process restart without a durable session context.
     */
    isEphemeral?: boolean;
}

/** No-op IHookRegistry used as a fallback when none is provided. */
const noopHooks: IHookRegistry = {
    register: () => undefined,
    emit: async () => undefined,
};

export interface OrchestratorRunResult {
    result: string;
}

export class Orchestrator {
    async run(input: OrchestratorRunInput): Promise<OrchestratorRunResult> {
        const {
            executionContext,
            registry,
            provider,
            policy,
            taskStore,
            sessionStore,
            signal,
            taskId,
            hooks = noopHooks,
            isEphemeral = false,
        } = input;

        // Working copy of messages — we append to this as the loop progresses
        const currentMessages: Message[] = [...input.messages];
        const contextLimit = parseInt(process.env["AGENT_MCP_CONTEXT_LIMIT"] ?? "0", 10);

        // BUG-002: track sessions opened by delegation during this task so we can
        // close them on failure or cancellation, preventing orphaned active sessions
        // that make sub-agents undeletable (AGENT_HAS_ACTIVE_SESSIONS).
        // On success we leave them open — the caller has the session IDs and may
        // want to continue using them. Only failure/cancel paths close them.
        const delegationSessions = new Set<string>();
        let taskSucceeded = false;

        try {
            // Mark task as running
            taskStore.updateStatus(taskId, "running");
            emitTaskEvent({ type: "status_change", taskId, status: "running" });
            await hooks.emit("task:start", { executionContext, messages: currentMessages, rootTaskId: executionContext.rootTaskId });

            let finalContent = "";

            // Tool-use loop — break on "completed" stop reason, throw on cancellation/policy
            let looping = true;
            while (looping) {
                // Check for cancellation at the top of each iteration
                if (signal.aborted) {
                    throw new ToolError("PROVIDER_ERROR", "Task was cancelled");
                }

                // Compose per-iteration signal: task cancellation OR provider timeout
                const composedSignal = AbortSignal.any([
                    signal,
                    AbortSignal.timeout(
                        executionContext.agentDefinition.provider.timeoutMs ?? 60_000
                    ),
                ]);

                // Gather available tools from the registry
                const tools = await registry.listAllTools();

                // Append the built-in HITL tool when the agent opts in AND the
                // task is durable (non-ephemeral has a DB row for the resume token).
                if (executionContext.agentDefinition.allowHumanInput === true && !isEphemeral) {
                    tools.push(HITL_BUILTIN_TOOL_DEFINITION);
                }

                // Emit MODEL_REQUEST event
                taskStore.appendEvent({
                    taskId,
                    type: "MODEL_REQUEST",
                    payload: { messageCount: currentMessages.length, toolCount: tools.length },
                });

                logger.debug(
                    {
                        taskId,
                        sessionId: executionContext.sessionId,
                        agentName: executionContext.agentName,
                        messageCount: currentMessages.length,
                    },
                    "MODEL_REQUEST"
                );

                // Emit pre:model_request hook
                await hooks.emit("pre:model_request", { executionContext, messages: currentMessages, tools });

                // Call the LLM provider
                let providerResponse;
                try {
                    const messagesToSend = contextLimit > 0
                        ? windowMessages(currentMessages, contextLimit)
                        : currentMessages;
                    providerResponse = await provider.chat({
                        messages: messagesToSend,
                        tools: tools.length > 0 ? tools : undefined,
                        signal: composedSignal,
                        // executeTool is used by providers (e.g. claudecli) that manage
                        // their own internal tool loop. Standard providers (anthropic,
                        // openai, lmstudio) return stopReason "tool_calls" and ignore this.
                        executeTool: async (server, tool, args) => {
                            const client = await registry.getClient(server);
                            try {
                                const result = await client.callTool(tool, args, composedSignal);
                                return { result, isError: false };
                            } catch (error) {
                                return {
                                    result: error instanceof Error ? error.message : String(error),
                                    isError: true,
                                };
                            }
                        },
                    });
                } catch (error) {
                    // Order matters — see [inv:provider-error-dispatch]:
                    // cancellation first, then timeout, then auth, then rate-limit, then generic.
                    // signal.aborted = user-initiated task cancel; composedSignal.aborted-only = timeout.
                    if (signal.aborted) {
                        throw new ToolError("PROVIDER_ERROR", "Task was cancelled");
                    }
                    if (
                        composedSignal.aborted ||
                        (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
                    ) {
                        const ms = executionContext.agentDefinition.provider.timeoutMs ?? 60_000;
                        throw new ToolError(
                            "PROVIDER_TIMEOUT",
                            `Provider call timed out after ${ms}ms. Increase timeoutMs on the agent's provider config.`
                        );
                    }
                    if (
                        error instanceof Error && (
                            error.constructor.name === "AuthenticationError" ||
                            ("status" in error && (error as { status?: number }).status === 401)
                        )
                    ) {
                        throw new ToolError(
                            "PROVIDER_AUTH_ERROR",
                            `Provider authentication failed: ${error.message}. ` +
                            `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
                        );
                    }
                    if (
                        error instanceof Error && (
                            ("status" in error && (error as { status?: number }).status === 429) ||
                            error.message?.includes("rate limit") ||
                            error.message?.includes("429")
                        )
                    ) {
                        throw new ToolError(
                            "PROVIDER_RATE_LIMITED",
                            `Provider rate limit exceeded: ${error.message}`
                        );
                    }
                    if (
                        error instanceof Error && (
                            ("code" in error && (error as { code?: string }).code === "context_length_exceeded") ||
                            error.message?.includes("context_length_exceeded") ||
                            error.message?.includes("prompt is too long")
                        )
                    ) {
                        throw new ToolError(
                            "CONTEXT_WINDOW_EXCEEDED",
                            `Context window exceeded. Set AGENT_MCP_CONTEXT_LIMIT to enable automatic truncation.`
                        );
                    }
                    throw new ToolError(
                        "PROVIDER_ERROR",
                        `Provider call failed: ${error instanceof Error ? error.message : String(error)}`
                    );
                }

                const assistantMessage: Message = {
                    ...providerResponse.message,
                    sessionId: executionContext.sessionId,
                };

                // Persist and append the assistant message
                await sessionStore.appendMessage(executionContext.sessionId, assistantMessage);
                currentMessages.push(assistantMessage);
                await hooks.emit("post:model_response", {
                    executionContext,
                    stopReason: providerResponse.stopReason,
                    toolCallCount: assistantMessage.toolCalls?.length ?? 0,
                    tokenUsage: providerResponse.usage,
                });
                await hooks.emit("message:appended", { executionContext, message: assistantMessage });

                // Emit MODEL_RESPONSE event
                taskStore.appendEvent({
                    taskId,
                    type: "MODEL_RESPONSE",
                    payload: {
                        stopReason: providerResponse.stopReason,
                        hasContent: !!assistantMessage.content,
                        toolCallCount: assistantMessage.toolCalls?.length ?? 0,
                    },
                });

                logger.debug(
                    {
                        taskId,
                        agentName: executionContext.agentName,
                        stopReason: providerResponse.stopReason,
                    },
                    "MODEL_RESPONSE"
                );

                if (providerResponse.stopReason === "completed") {
                    finalContent = assistantMessage.content ?? "";
                    looping = false;
                    continue;
                }

                // Process tool calls
                const toolCalls = assistantMessage.toolCalls ?? [];

                // Phase 1 — serial pre-dispatch loop (policy + count).
                // Uses variable name `tc` to distinguish from the old sequential per-tool dispatch
                // that has been replaced by Phase 2 (Promise.all concurrent execution below).
                //
                // HITL intercept: `request_human_input` is intercepted here (before Phase 2)
                // and never reaches the MCP client. [inv:request-human-input-intercept]
                const hitlResults = new Map<string, string>(); // toolCall.id → userInput
                for (const tc of toolCalls) {
                    if (signal.aborted) {
                        throw new ToolError("PROVIDER_ERROR", "Task was cancelled before tool call");
                    }

                    // ── HITL intercept ──────────────────────────────────────
                    if (tc.tool === HITL_TOOL_NAME) {
                        // Ephemeral tasks have no session row — cannot persist resume_token
                        // (no DB row means task_resume cannot validate it and HITL cannot
                        // be resumed after a process restart). Reject via isEphemeral flag.
                        if (isEphemeral) {
                            throw new ToolError(
                                "VALIDATION_ERROR",
                                "request_human_input is not supported for ephemeral tasks"
                            );
                        }

                        // 1. Generate a resumeToken
                        const resumeToken = crypto.randomUUID();

                        // 2. Persist suspension to DB BEFORE awaiting [inv:resume-token-db-persisted]
                        //    This ordering ensures the token survives a process restart.
                        await taskStore.updateStatus(taskId, "awaiting_input", { resumeToken });
                        emitTaskEvent({ type: "status_change", taskId, status: "awaiting_input" });

                        // 3. Register resolver and await userInput.
                        //    Wire into the AbortSignal so task_cancel unblocks this promise —
                        //    without this, cancelling an awaiting_input task leaves the promise
                        //    pending forever and the orchestrator's async context leaks.
                        let abortHandler: (() => void) | undefined;
                        const userInput = await new Promise<string>((resolve, reject) => {
                            hitlResolvers.set(taskId, resolve);
                            abortHandler = () => {
                                hitlResolvers.delete(taskId);
                                reject(new ToolError("PROVIDER_ERROR", "Task cancelled while awaiting human input"));
                            };
                            signal.addEventListener("abort", abortHandler, { once: true });
                        }).finally(() => {
                            // Remove the abort listener once the promise settles so a
                            // later cancellation of this (now-resumed) task does not fire
                            // a stale handler / leak a listener on the long-lived signal.
                            if (abortHandler) signal.removeEventListener("abort", abortHandler);
                        });

                        // 4. Mark running again
                        await taskStore.updateStatus(taskId, "running");
                        emitTaskEvent({ type: "status_change", taskId, status: "running" });

                        // 5. Store userInput to inject as tool result in Phase 3
                        hitlResults.set(tc.id, userInput);

                        // Return resume token to the caller via event log; continue to next tc
                        taskStore.appendEvent({
                            taskId,
                            type: "TOOL_CALL",
                            payload: { tool: HITL_TOOL_NAME, callId: tc.id, resumeToken },
                        });
                        continue;
                    }
                    // ── end HITL intercept ──────────────────────────────────

                    // Resolve the REAL {server,tool}: OpenAI-compatible/local models
                    // rewrite '-' → '_' in tool names, so the returned name may not
                    // match what we advertised. Resolving here keeps the qualified
                    // name correct for the policy delegation check (otherwise a
                    // mangled name would bypass the allowedAgents gate) and dispatch.
                    const resolved =
                        registry.resolveToolName?.(`${tc.server}__${tc.tool}`) ??
                        { server: tc.server, tool: tc.tool };
                    const qualifiedToolName = `${resolved.server}__${resolved.tool}`;
                    await hooks.emit("pre:tool_call", {
                        executionContext,
                        toolName: qualifiedToolName,
                        callId: tc.id,
                        toolInput: tc.arguments,
                    });
                    policy.check({
                        executionContext,
                        targetTool: qualifiedToolName,
                        targetAgentName:
                            qualifiedToolName === "agent-mcp__agent"
                                ? (tc.arguments as { name?: string })?.name
                                : undefined,
                    });
                    // Increment AFTER policy.check — see [inv:toolCallCount-increment-after-check].
                    // policy.check enforces "allow while toolCallCount < max" (it expects the
                    // count of calls already accounted for), so incrementing BEFORE the check
                    // fired the cap one call early (effective max-1). Counting per tool here —
                    // still inside the serial pre-dispatch loop, not Phase 3 — keeps the limit
                    // enforced WITHIN a single concurrent batch: each tool's check sees the
                    // running count from prior tools in this same loop.
                    executionContext.toolCallCount++;
                }

                // Phase 2 — Promise.all concurrent execution.
                // HITL calls are excluded (already handled in Phase 1 — their results
                // are in hitlResults and will be injected in Phase 3).
                const nonHitlToolCalls = toolCalls.filter(tc => tc.tool !== HITL_TOOL_NAME);
                const toolResults = await Promise.all(
                    nonHitlToolCalls.map(async (toolCall) => {
                        const resolved =
                            registry.resolveToolName?.(`${toolCall.server}__${toolCall.tool}`) ??
                            { server: toolCall.server, tool: toolCall.tool };
                        const qualifiedToolName = `${resolved.server}__${resolved.tool}`;

                        // Emit tool_call SSE event before dispatch
                        emitTaskEvent({
                            type: "tool_call",
                            taskId,
                            toolName: qualifiedToolName,
                            toolCallId: toolCall.id,
                            input: toolCall.arguments,
                        });

                        taskStore.appendEvent({
                            taskId,
                            type: "TOOL_CALL",
                            payload: { tool: qualifiedToolName, callId: toolCall.id },
                        });

                        logger.info(
                            { taskId, agentName: executionContext.agentName, tool: qualifiedToolName, callId: toolCall.id },
                            "TOOL_CALL"
                        );

                        let toolResult: unknown;
                        let isError = false;
                        try {
                            const client = await registry.getClient(resolved.server);
                            // Thread the composed task-cancel/timeout signal so a
                            // cancel mid-batch interrupts this in-flight call
                            // instead of waiting for the whole batch (DEBT-003).
                            toolResult = await client.callTool(resolved.tool, toolCall.arguments, composedSignal);

                            // BUG-002: capture session IDs opened by delegation so we
                            // can close them on failure, preventing undeletable sub-agents.
                            if (qualifiedToolName === "agent-mcp__agent" && toolResult != null) {
                                const maybeId = (toolResult as Record<string, unknown>)["session_id"];
                                if (typeof maybeId === "string") {
                                    delegationSessions.add(maybeId);
                                }
                            }
                        } catch (error) {
                            // Re-throw fatal ToolError codes — these abort the entire task, not just this call.
                            // See [inv:fatal-policy-codes] in _shared.md.
                            const FATAL_CODES = ["MAX_DEPTH_EXCEEDED", "MAX_TOOL_LOOPS_EXCEEDED", "DELEGATION_NOT_ALLOWED"];
                            if (error instanceof ToolError && FATAL_CODES.includes(error.code)) {
                                throw error;
                            }
                            isError = true;
                            toolResult = error instanceof Error ? error.message : String(error);
                            logger.warn({ taskId, tool: qualifiedToolName, error: toolResult }, "TOOL_RESULT error");
                        }

                        taskStore.appendEvent({
                            taskId,
                            type: "TOOL_RESULT",
                            payload: { callId: toolCall.id, tool: qualifiedToolName, isError },
                        });

                        // Emit tool_result SSE event after result received
                        emitTaskEvent({
                            type: "tool_result",
                            taskId,
                            toolCallId: toolCall.id,
                            content: toolResult,
                        });

                        logger.debug({ taskId, tool: qualifiedToolName, isError }, "TOOL_RESULT");

                        await hooks.emit("post:tool_call", {
                            executionContext,
                            toolName: qualifiedToolName,
                            callId: toolCall.id,
                            toolInput: toolCall.arguments,
                            result: toolResult,
                            isError,
                        });

                        return { toolCall, toolResult, isError };
                    })
                );

                // Phase 3 — serial result append (preserves order per [inv:message-order]).
                // Build a lookup for non-HITL results; then iterate original toolCalls
                // order so HITL and non-HITL results are interleaved correctly.
                const toolResultByCallId = new Map(toolResults.map(r => [r.toolCall.id, r]));
                for (const tc of toolCalls) {
                    let toolResult: unknown;
                    let isError = false;

                    if (hitlResults.has(tc.id)) {
                        // HITL tool: inject userInput as the result
                        toolResult = hitlResults.get(tc.id);
                    } else {
                        const r = toolResultByCallId.get(tc.id);
                        if (!r) continue; // should not happen
                        toolResult = r.toolResult;
                        isError = r.isError;
                    }

                    const toolResultMessage: Message = {
                        id: generateId(),
                        sessionId: executionContext.sessionId,
                        role: "tool",
                        toolResults: [{
                            toolCallId: tc.id,  // [inv:call-id-keying]
                            result: toolResult,
                            isError,
                        }],
                        createdAt: nowIso(),
                    };
                    await sessionStore.appendMessage(executionContext.sessionId, toolResultMessage);
                    currentMessages.push(toolResultMessage);
                    await hooks.emit("message:appended", { executionContext, message: toolResultMessage });
                }

                // Guard: provider signalled tool_calls but sent no tool call blocks —
                // prevents infinite spin on a malformed response.
                if (
                    providerResponse.stopReason === "tool_calls" &&
                    (assistantMessage.toolCalls ?? []).length === 0
                ) {
                    finalContent = assistantMessage.content ?? "";
                    looping = false;
                }
            }

            // Task completed successfully
            taskStore.updateStatus(taskId, "completed", {
                result: finalContent,
                completedAt: nowIso(),
            });
            emitTaskEvent({ type: "status_change", taskId, status: "completed" });

            taskStore.appendEvent({
                taskId,
                type: "TASK_COMPLETED",
                payload: { result: finalContent },
            });

            logger.info(
                { taskId, agentName: executionContext.agentName },
                "TASK_COMPLETED"
            );

            await hooks.emit("task:completed", { executionContext, result: finalContent });

            // Emit done on the successful completion path
            emitTaskEvent({ type: "done", taskId, result: finalContent, error: null });

            taskSucceeded = true;
            return { result: finalContent };
        } catch (error) {
            // Determine if this is a cancellation or a real failure
            const isCancelled = signal.aborted;

            if (isCancelled) {
                // Status update handled by TaskStore.cancel() in most cases;
                // update here only if not already cancelled
                try {
                    taskStore.updateStatus(taskId, "cancelled", {
                        cancelledAt: nowIso(),
                        // Persist the reason so a later SSE terminal-on-connect read
                        // surfaces it instead of error:null (matches the live-bus done).
                        error: "Task was cancelled",
                    });
                } catch {
                    // already cancelled — ignore
                }
                emitTaskEvent({ type: "status_change", taskId, status: "cancelled" });

                taskStore.appendEvent({ taskId, type: "TASK_CANCELLED" });
                await hooks.emit("task:cancelled", { executionContext });

                // Emit done on the cancellation path — SSE clients must not hang
                emitTaskEvent({ type: "done", taskId, result: null, error: "Task was cancelled" });
            } else {
                const errorMessage = error instanceof Error ? error.message : String(error);

                taskStore.updateStatus(taskId, "failed", {
                    error: errorMessage,
                });
                emitTaskEvent({ type: "status_change", taskId, status: "failed" });

                taskStore.appendEvent({
                    taskId,
                    type: "TASK_FAILED",
                    payload: { error: errorMessage },
                });

                logger.error(
                    { taskId, agentName: executionContext.agentName, error },
                    "TASK_FAILED"
                );
                await hooks.emit("task:failed", { executionContext, error: errorMessage });

                // Emit done on the failure path
                emitTaskEvent({ type: "done", taskId, result: null, error: errorMessage });
            }

            throw error;
        } finally {
            // BUG-002: close delegation-scoped sessions on failure/cancellation so
            // sub-agents don't become undeletable (AGENT_HAS_ACTIVE_SESSIONS guard).
            // On success the caller keeps the session IDs; on failure/cancel they're
            // orphaned and must be reaped here.
            if (!taskSucceeded) {
                for (const sessionId of delegationSessions) {
                    try {
                        sessionStore.close(sessionId);
                    } catch {
                        // Already closed or not found — ignore
                    }
                }
            }
            // Per-task registry teardown — always runs
            await registry.closeAll();
            taskStore.unregisterCancellation(taskId);
        }
    }
}
