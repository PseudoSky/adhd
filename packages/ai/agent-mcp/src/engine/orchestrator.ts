import { logger } from "../logger.js";
import type { LLMProvider } from "../providers/types.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import type { IHookRegistry } from "@adhd/agent-mcp-types";
import { ToolError } from "../validation/errors.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";

import type { McpClientRegistry } from "../clients/registry.js";
import type { PolicyEngine } from "./policy.js";
import type { TaskStore } from "../store/task-store.js";
import type { SessionStore } from "../store/session-store.js";

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
        } = input;

        // Working copy of messages — we append to this as the loop progresses
        const currentMessages: Message[] = [...input.messages];

        try {
            // Mark task as running
            taskStore.updateStatus(taskId, "running");
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
                    providerResponse = await provider.chat({
                        messages: currentMessages,
                        tools: tools.length > 0 ? tools : undefined,
                        signal: composedSignal,
                        // executeTool is used by providers (e.g. claudecli) that manage
                        // their own internal tool loop. Standard providers (anthropic,
                        // openai, lmstudio) return stopReason "tool_calls" and ignore this.
                        executeTool: async (server, tool, args) => {
                            const client = await registry.getClient(server);
                            try {
                                const result = await client.callTool(tool, args);
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
                    if (signal.aborted) {
                        throw new ToolError("PROVIDER_ERROR", "Task was cancelled during provider call");
                    }
                    if (
                        composedSignal.aborted ||
                        (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
                    ) {
                        const ms = executionContext.agentDefinition.provider.timeoutMs ?? 60_000;
                        throw new ToolError(
                            "PROVIDER_ERROR",
                            `Provider call timed out after ${ms}ms. Increase timeoutMs on the agent's provider config.`
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

                for (const toolCall of toolCalls) {
                    // Check for cancellation before each tool call
                    if (signal.aborted) {
                        throw new ToolError("PROVIDER_ERROR", "Task was cancelled before tool call");
                    }

                    const qualifiedToolName = `${toolCall.server}__${toolCall.tool}`;

                    // Emit pre:tool_call hook (observational in Phase 1)
                    await hooks.emit("pre:tool_call", {
                        executionContext,
                        toolName: qualifiedToolName,
                        callId: toolCall.id,
                        toolInput: toolCall.arguments,
                    });

                    // Policy check before executing the tool
                    policy.check({
                        executionContext,
                        targetTool: qualifiedToolName,
                        targetAgentName:
                            qualifiedToolName === "agent-mcp__agent"
                                ? (toolCall.arguments as { name?: string })?.name
                                : undefined,
                    });

                    // Emit TOOL_CALL event
                    taskStore.appendEvent({
                        taskId,
                        type: "TOOL_CALL",
                        payload: {
                            tool: qualifiedToolName,
                            callId: toolCall.id,
                        },
                    });

                    logger.info(
                        {
                            taskId,
                            agentName: executionContext.agentName,
                            tool: qualifiedToolName,
                            callId: toolCall.id,
                        },
                        "TOOL_CALL"
                    );

                    let toolResult: unknown;
                    let isError = false;

                    try {
                        const client = await registry.getClient(toolCall.server);
                        toolResult = await client.callTool(toolCall.tool, toolCall.arguments);
                    } catch (error) {
                        isError = true;
                        toolResult = error instanceof Error ? error.message : String(error);

                        logger.warn(
                            {
                                taskId,
                                tool: qualifiedToolName,
                                error: toolResult,
                            },
                            "TOOL_RESULT error"
                        );

                        // Re-throw policy violations and cancellation — these are fatal
                        if (error instanceof ToolError) {
                            const fatalCodes = [
                                "MAX_DEPTH_EXCEEDED",
                                "MAX_TOOL_LOOPS_EXCEEDED",
                                "DELEGATION_NOT_ALLOWED",
                            ] as const;
                            if (fatalCodes.includes(error.code as typeof fatalCodes[number])) {
                                throw error;
                            }
                        }
                    }

                    // Emit TOOL_RESULT event
                    taskStore.appendEvent({
                        taskId,
                        type: "TOOL_RESULT",
                        payload: {
                            callId: toolCall.id,
                            tool: qualifiedToolName,
                            isError,
                        },
                    });

                    logger.debug(
                        {
                            taskId,
                            tool: qualifiedToolName,
                            isError,
                        },
                        "TOOL_RESULT"
                    );

                    await hooks.emit("post:tool_call", {
                        executionContext,
                        toolName: qualifiedToolName,
                        callId: toolCall.id,
                        toolInput: toolCall.arguments,
                        result: toolResult,
                        isError,
                    });

                    // Append tool result message
                    const toolResultMessage: Message = {
                        id: generateId(),
                        sessionId: executionContext.sessionId,
                        role: "tool",
                        toolResults: [
                            {
                                toolCallId: toolCall.id,
                                result: toolResult,
                                isError,
                            },
                        ],
                        createdAt: nowIso(),
                    };

                    await sessionStore.appendMessage(executionContext.sessionId, toolResultMessage);
                    currentMessages.push(toolResultMessage);
                    await hooks.emit("message:appended", { executionContext, message: toolResultMessage });

                    // Increment toolCallCount AFTER the result is appended
                    // so the next policy check sees the updated value
                    executionContext.toolCallCount++;
                }
            }

            // Task completed successfully
            taskStore.updateStatus(taskId, "completed", {
                result: finalContent,
                completedAt: nowIso(),
            });

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

            return { result: finalContent };
        } catch (error) {
            // Determine if this is a cancellation or a real failure
            const isCancelled =
                signal.aborted ||
                (error instanceof ToolError && error.code === "PROVIDER_ERROR" && error.message.includes("cancelled"));

            if (isCancelled) {
                // Status update handled by TaskStore.cancel() in most cases;
                // update here only if not already cancelled
                try {
                    taskStore.updateStatus(taskId, "cancelled", {
                        cancelledAt: nowIso(),
                    });
                } catch {
                    // already cancelled — ignore
                }

                taskStore.appendEvent({ taskId, type: "TASK_CANCELLED" });
                await hooks.emit("task:cancelled", { executionContext });
            } else {
                const errorMessage = error instanceof Error ? error.message : String(error);

                taskStore.updateStatus(taskId, "failed", {
                    error: errorMessage,
                });

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
            }

            throw error;
        } finally {
            // Per-task registry teardown — always runs
            await registry.closeAll();
            taskStore.unregisterCancellation(taskId);
        }
    }
}
