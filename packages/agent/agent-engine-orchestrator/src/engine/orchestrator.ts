import type { LLMProvider } from '../providers/types.js';
import type { ExecutionContext, Message } from '../validation/index.js';
import type {
  IHookRegistry,
  IEnforcementError,
  IToolWarning,
  PostToolCallPayload,
} from '@adhd/agent-base-types';
import { ToolError } from '../validation/errors.js';
import { generateId } from '../utils/ids.js';
import { nowIso } from '../utils/timestamps.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';

import type { McpClientRegistry } from '../clients/registry.js';
import type { PolicyEngine } from './policy.js';
import {
  renderToolPromptDoc,
  toNameOnlyTools,
  type ToolAdvertisementMode,
} from './tool-advertisement.js';

// ── HITL (Human-in-the-Loop) support ─────────────────────────────────────────

const HITL_TOOL_NAME = 'request_human_input';

const HITL_BUILTIN_TOOL_DEFINITION = {
  name: 'builtin__request_human_input',
  description:
    'Pause the task to ask the human operator a question. The task suspends ' +
    'until a human answers via task_resume. Use when you need human confirmation, ' +
    'a decision, or missing information you cannot obtain yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The question to ask the human.',
      },
    },
    required: ['prompt'],
  },
} as const;

/** TaskStore-like interface for orchestrator consumption */
export interface OrchestratorTaskStore {
    updateStatus(taskId: string, status: string, fields?: Record<string, unknown>): void;
    appendEvent(evt: { taskId: string; type: string; payload?: unknown }): void;
    unregisterCancellation(taskId: string): void;
}

/** SessionStore-like interface for orchestrator consumption */
export interface OrchestratorSessionStore {
    appendMessage(sessionId: string, message: Message): Promise<void>;
    close(sessionId: string): void;
}

const hitlResolvers = new Map<string, (userInput: string) => void>();

export function resolveHitl(taskId: string, userInput: string): boolean {
  const resolve = hitlResolvers.get(taskId);
  if (!resolve) return false;
  hitlResolvers.delete(taskId);
  resolve(userInput);
  return true;
}

export interface OrchestratorRunInput {
  executionContext: ExecutionContext;
  messages: Message[];
  registry: McpClientRegistry;
  provider: LLMProvider;
  policy: PolicyEngine;
  taskStore: OrchestratorTaskStore;
  sessionStore: OrchestratorSessionStore;
  signal: AbortSignal;
  taskId: string;
  hooks?: IHookRegistry;
  isEphemeral?: boolean;
  /** Injected emitTaskEvent callback (replaces streaming/event-bus import). */
  emitTaskEvent?: (event: { type: string; taskId: string; status?: string; result?: string | null; error?: string | null; toolName?: string; toolCallId?: string; input?: unknown; content?: unknown }) => void;
  /** Injected logger (replaces logger.js import). */
  logger?: EngineLogger;
  /** Injected config (replaces config.js import). */
  config?: EngineConfig;
}

export interface OrchestratorRunResult {
  result: string;
}

/** Duck-type check */
function isEnforcementError(err: unknown): err is IEnforcementError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as IEnforcementError).isEnforcementError === true
  );
}

const noopHooks: IHookRegistry = {
  register: () => undefined,
  emit: async () => undefined,
  registerEnforcement: () => undefined,
  enforce: async () => undefined,
};

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
      emitTaskEvent,
      logger: loggerInput,
      config: configInput,
    } = input;

    const logger = loggerInput ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
    const config = configInput ?? { server: { contextLimit: 0, defaultMaxTokens: 8192 } } as EngineConfig;

    const emit = (event: Parameters<NonNullable<typeof emitTaskEvent>>[0]) => {
      emitTaskEvent?.(event);
    };

    const currentMessages: Message[] = [...input.messages];
    const contextLimit = config.server.contextLimit;

    const delegationSessions = new Set<string>();
    let taskSucceeded = false;

    try {
      taskStore.updateStatus(taskId, 'running');
      emit({ type: 'status_change', taskId, status: 'running' });
      await hooks.emit('task:start', {
        executionContext,
        messages: currentMessages,
        rootTaskId: executionContext.rootTaskId,
      });

      let finalContent = '';

      const tools = await registry.listAllTools();

      if (
        executionContext.agentDefinition.allowHumanInput === true &&
        !isEphemeral
      ) {
        tools.push(HITL_BUILTIN_TOOL_DEFINITION);
      }

      const advertisementMode: ToolAdvertisementMode =
        executionContext.agentDefinition.provider.type === 'claudecli'
          ? 'full'
          : (executionContext.agentDefinition.toolAdvertisement ?? 'names');
      const advertisedTools =
        advertisementMode === 'names' ? toNameOnlyTools(tools) : tools;
      const toolDocSystemMessage: Message | null = (() => {
        if (advertisementMode !== 'names' || tools.length === 0) return null;
        const doc = renderToolPromptDoc(tools);
        const existing = currentMessages[0];
        if (existing && existing.role === 'system') {
          return {
            ...existing,
            content: `${doc}\n\n---\n\n${existing.content}`,
          };
        }
        return {
          id: generateId(),
          sessionId: executionContext.sessionId,
          role: 'system',
          content: doc,
          createdAt: nowIso(),
        };
      })();

      let looping = true;
      while (looping) {
        if (signal.aborted) {
          throw new ToolError('PROVIDER_ERROR', 'Task was cancelled');
        }

        const composedSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(
            executionContext.agentDefinition.provider.timeoutMs ?? 60_000
          ),
        ]);

        taskStore.appendEvent({
          taskId,
          type: 'MODEL_REQUEST',
          payload: {
            messageCount: currentMessages.length,
            toolCount: tools.length,
            toolAdvertisement: advertisementMode,
          },
        });

        logger.debug(
          {
            taskId,
            sessionId: executionContext.sessionId,
            agentName: executionContext.agentName,
            messageCount: currentMessages.length,
          },
          'MODEL_REQUEST'
        );

        await hooks.emit('pre:model_request', {
          executionContext,
          messages: currentMessages,
          tools,
        });

        try {
          await hooks.enforce('pre:model_request', {
            executionContext,
            messages: currentMessages,
            tools,
          });
        } catch (err: unknown) {
          if (isEnforcementError(err)) {
            throw new ToolError('BUDGET_EXCEEDED', err.message);
          }
          throw err;
        }

        let providerResponse;
        try {
          const baseMessages =
            contextLimit > 0
              ? windowMessages(currentMessages, contextLimit)
              : currentMessages;
          let messagesToSend = baseMessages;
          if (toolDocSystemMessage) {
            messagesToSend =
              baseMessages[0]?.role === 'system'
                ? [toolDocSystemMessage, ...baseMessages.slice(1)]
                : [toolDocSystemMessage, ...baseMessages];
          }
          providerResponse = await provider.chat({
            messages: messagesToSend,
            tools: advertisedTools.length > 0 ? advertisedTools : undefined,
            signal: composedSignal,
            executeTool: async (server, tool, args) => {
              registry.assertToolAllowed?.(server, tool);
              const client = await registry.getClient(server);
              try {
                const result = await client.callTool(
                  tool,
                  args,
                  composedSignal
                );
                return { result, isError: false };
              } catch (error) {
                return {
                  result:
                    error instanceof Error ? error.message : String(error),
                  isError: true,
                };
              }
            },
          });
        } catch (error) {
          if (signal.aborted) {
            throw new ToolError('PROVIDER_ERROR', 'Task was cancelled');
          }
          if (
            composedSignal.aborted ||
            (error instanceof Error &&
              (error.name === 'AbortError' || error.name === 'TimeoutError'))
          ) {
            const ms =
              executionContext.agentDefinition.provider.timeoutMs ?? 60_000;
            throw new ToolError(
              'PROVIDER_TIMEOUT',
              `Provider call timed out after ${ms}ms. Increase timeoutMs on the agent's provider config.`
            );
          }
          if (
            error instanceof Error &&
            (error.constructor.name === 'AuthenticationError' ||
              ('status' in error &&
                (error as { status?: number }).status === 401))
          ) {
            throw new ToolError(
              'PROVIDER_AUTH_ERROR',
              `Provider authentication failed: ${error.message}. ` +
                `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
            );
          }
          if (
            error instanceof Error &&
            (('status' in error &&
              (error as { status?: number }).status === 429) ||
              error.message?.includes('rate limit') ||
              error.message?.includes('429'))
          ) {
            throw new ToolError(
              'PROVIDER_RATE_LIMITED',
              `Provider rate limit exceeded: ${error.message}`
            );
          }
          if (
            error instanceof Error &&
            (('code' in error &&
              (error as { code?: string }).code ===
                'context_length_exceeded') ||
              error.message?.includes('context_length_exceeded') ||
              error.message?.includes('prompt is too long'))
          ) {
            throw new ToolError(
              'CONTEXT_WINDOW_EXCEEDED',
              `Context window exceeded. Set AGENT_MCP_CONTEXT_LIMIT to enable automatic truncation.`
            );
          }
          throw new ToolError(
            'PROVIDER_ERROR',
            `Provider call failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }

        const assistantMessage: Message = {
          ...providerResponse.message,
          sessionId: executionContext.sessionId,
        };

        await sessionStore.appendMessage(
          executionContext.sessionId,
          assistantMessage
        );
        currentMessages.push(assistantMessage);
        await hooks.emit('post:model_response', {
          executionContext,
          stopReason: providerResponse.stopReason,
          toolCallCount: assistantMessage.toolCalls?.length ?? 0,
          tokenUsage: providerResponse.usage,
        });
        await hooks.emit('message:appended', {
          executionContext,
          message: assistantMessage,
        });

        taskStore.appendEvent({
          taskId,
          type: 'MODEL_RESPONSE',
          payload: {
            stopReason: providerResponse.stopReason,
            hasContent: !!assistantMessage.content,
            toolCallCount: assistantMessage.toolCalls?.length ?? 0,
            inputTokens: providerResponse.usage?.inputTokens,
            outputTokens: providerResponse.usage?.outputTokens,
            cacheReadTokens: providerResponse.usage?.cacheReadTokens,
            cacheCreationTokens: providerResponse.usage?.cacheCreationTokens,
            rawUsage: providerResponse.rawUsage,
          },
        });

        logger.debug(
          {
            taskId,
            agentName: executionContext.agentName,
            stopReason: providerResponse.stopReason,
          },
          'MODEL_RESPONSE'
        );

        if (providerResponse.stopReason === 'completed') {
          finalContent = assistantMessage.content ?? '';
          looping = false;
          continue;
        }

        const toolCalls = assistantMessage.toolCalls ?? [];

        // Phase 1 — serial pre-dispatch loop
        const hitlResults = new Map<string, string>();
        const warningResults = new Map<
          string,
          { result: unknown; isError: boolean }
        >();
        for (const tc of toolCalls) {
          if (signal.aborted) {
            throw new ToolError(
              'PROVIDER_ERROR',
              'Task was cancelled before tool call'
            );
          }

          if (tc.tool === HITL_TOOL_NAME) {
            if (isEphemeral) {
              throw new ToolError(
                'VALIDATION_ERROR',
                'request_human_input is not supported for ephemeral tasks'
              );
            }

            const resumeToken = crypto.randomUUID();

            await taskStore.updateStatus(taskId, 'awaiting_input', {
              resumeToken,
            });
            emit({
              type: 'status_change',
              taskId,
              status: 'awaiting_input',
            });

            let abortHandler: (() => void) | undefined;
            const userInput = await new Promise<string>((resolve, reject) => {
              hitlResolvers.set(taskId, resolve);
              abortHandler = () => {
                hitlResolvers.delete(taskId);
                reject(
                  new ToolError(
                    'PROVIDER_ERROR',
                    'Task cancelled while awaiting human input'
                  )
                );
              };
              signal.addEventListener('abort', abortHandler, { once: true });
            }).finally(() => {
              if (abortHandler)
                signal.removeEventListener('abort', abortHandler);
            });

            await taskStore.updateStatus(taskId, 'running');
            emit({ type: 'status_change', taskId, status: 'running' });

            hitlResults.set(tc.id, userInput);

            taskStore.appendEvent({
              taskId,
              type: 'TOOL_CALL',
              payload: { tool: HITL_TOOL_NAME, callId: tc.id, resumeToken },
            });
            continue;
          }

          const resolved = registry.resolveToolName?.(
            `${tc.server}__${tc.tool}`
          ) ?? { server: tc.server, tool: tc.tool };
          const qualifiedToolName = `${resolved.server}__${resolved.tool}`;
          await hooks.emit('pre:tool_call', {
            executionContext,
            toolName: qualifiedToolName,
            callId: tc.id,
            toolInput: tc.arguments,
          });

          try {
            await hooks.enforce('pre:tool_call', {
              executionContext,
              toolName: qualifiedToolName,
              callId: tc.id,
              toolInput: tc.arguments,
            });
          } catch (err: unknown) {
            const tw = err as IToolWarning;
            if (tw?.isToolWarning === true) {
              warningResults.set(tc.id, {
                result: { type: 'text', text: tw.message },
                isError: true,
              });
              continue;
            }
            if (isEnforcementError(err)) {
              throw new ToolError('BUDGET_EXCEEDED', err.message);
            }
            throw err;
          }

          policy.check({
            executionContext,
            targetTool: qualifiedToolName,
            targetAgentName:
              qualifiedToolName === 'agent-mcp__agent'
                ? (tc.arguments as { name?: string })?.name
                : undefined,
          });
          executionContext.toolCallCount++;
        }

        // Phase 2 — Promise.all concurrent execution
        const nonHitlToolCalls = toolCalls.filter(
          (tc) => tc.tool !== HITL_TOOL_NAME && !warningResults.has(tc.id)
        );
        const toolResults = await Promise.all(
          nonHitlToolCalls.map(async (toolCall) => {
            const resolved = registry.resolveToolName?.(
              `${toolCall.server}__${toolCall.tool}`
            ) ?? { server: toolCall.server, tool: toolCall.tool };
            const qualifiedToolName = `${resolved.server}__${resolved.tool}`;

            emit({
              type: 'tool_call',
              taskId,
              toolName: qualifiedToolName,
              toolCallId: toolCall.id,
              input: toolCall.arguments,
            });

            taskStore.appendEvent({
              taskId,
              type: 'TOOL_CALL',
              payload: {
                tool: qualifiedToolName,
                callId: toolCall.id,
                arguments: JSON.stringify(toolCall.arguments).slice(0, 500),
              },
            });

            logger.info(
              {
                taskId,
                agentName: executionContext.agentName,
                tool: qualifiedToolName,
                callId: toolCall.id,
              },
              'TOOL_CALL'
            );

            registry.assertToolAllowed?.(resolved.server, resolved.tool);

            let toolResult: unknown;
            let isError = false;
            try {
              const client = await registry.getClient(resolved.server);
              toolResult = await client.callTool(
                resolved.tool,
                toolCall.arguments,
                composedSignal
              );

              if (
                qualifiedToolName === 'agent-mcp__agent' &&
                toolResult != null
              ) {
                const maybeId = (toolResult as Record<string, unknown>)[
                  'session_id'
                ];
                if (typeof maybeId === 'string') {
                  delegationSessions.add(maybeId);
                }
              }
            } catch (error) {
              const FATAL_CODES = [
                'MAX_DEPTH_EXCEEDED',
                'MAX_TOOL_LOOPS_EXCEEDED',
                'DELEGATION_NOT_ALLOWED',
              ];
              if (
                error instanceof ToolError &&
                FATAL_CODES.includes(error.code)
              ) {
                throw error;
              }
              isError = true;
              toolResult =
                error instanceof Error ? error.message : String(error);
              logger.warn(
                { taskId, tool: qualifiedToolName, error: toolResult },
                'TOOL_RESULT error'
              );
            }

            const resultSummary =
              typeof toolResult === 'string'
                ? toolResult.slice(0, 500)
                : JSON.stringify(toolResult).slice(0, 500);

            taskStore.appendEvent({
              taskId,
              type: 'TOOL_RESULT',
              payload: {
                callId: toolCall.id,
                tool: qualifiedToolName,
                isError,
                result: resultSummary,
              },
            });

            emit({
              type: 'tool_result',
              taskId,
              toolCallId: toolCall.id,
              content: toolResult,
            });

            logger.debug(
              { taskId, tool: qualifiedToolName, isError },
              'TOOL_RESULT'
            );

            await hooks.emit('post:tool_call', {
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

        // Phase 3 — serial result append
        const toolResultByCallId = new Map(
          toolResults.map((r) => [r.toolCall.id, r])
        );
        for (const tc of toolCalls) {
          let toolResult: unknown;
          let isError = false;

          if (hitlResults.has(tc.id)) {
            toolResult = hitlResults.get(tc.id);
          } else if (warningResults.has(tc.id)) {
            const w = warningResults.get(tc.id);
            if (!w) continue;
            toolResult = w.result;
            isError = w.isError;
          } else {
            const r = toolResultByCallId.get(tc.id);
            if (!r) continue;
            toolResult = r.toolResult;
            isError = r.isError;

            const resolved = registry.resolveToolName?.(
              `${tc.server}__${tc.tool}`
            ) ?? { server: tc.server, tool: tc.tool };
            const qualifiedToolName = `${resolved.server}__${resolved.tool}`;
            const transformPayload: PostToolCallPayload = {
              executionContext,
              toolName: qualifiedToolName,
              callId: tc.id,
              toolInput: tc.arguments,
              result: toolResult,
              isError,
            };
            await hooks.emit('transform:tool_result', transformPayload);
            toolResult = transformPayload.result;
            isError = transformPayload.isError;
          }

          const toolResultMessage: Message = {
            id: generateId(),
            sessionId: executionContext.sessionId,
            role: 'tool',
            toolResults: [
              {
                toolCallId: tc.id,
                result: toolResult,
                isError,
              },
            ],
            createdAt: nowIso(),
          };
          await sessionStore.appendMessage(
            executionContext.sessionId,
            toolResultMessage
          );
          currentMessages.push(toolResultMessage);
          await hooks.emit('message:appended', {
            executionContext,
            message: toolResultMessage,
          });
        }

        if (
          providerResponse.stopReason === 'tool_calls' &&
          (assistantMessage.toolCalls ?? []).length === 0
        ) {
          finalContent = assistantMessage.content ?? '';
          looping = false;
        }
      }

      taskStore.updateStatus(taskId, 'completed', {
        result: finalContent,
        completedAt: nowIso(),
      });
      emit({ type: 'status_change', taskId, status: 'completed' });

      taskStore.appendEvent({
        taskId,
        type: 'TASK_COMPLETED',
        payload: { result: finalContent },
      });

      logger.info(
        { taskId, agentName: executionContext.agentName },
        'TASK_COMPLETED'
      );

      await hooks.emit('task:completed', {
        executionContext,
        result: finalContent,
      });

      emit({
        type: 'done',
        taskId,
        result: finalContent,
        error: null,
      });

      taskSucceeded = true;
      return { result: finalContent };
    } catch (error) {
      const isCancelled = signal.aborted;

      if (isCancelled) {
        try {
          taskStore.updateStatus(taskId, 'cancelled', {
            cancelledAt: nowIso(),
            error: 'Task was cancelled',
          });
        } catch {
          // already cancelled — ignore
        }
        emit({ type: 'status_change', taskId, status: 'cancelled' });

        taskStore.appendEvent({ taskId, type: 'TASK_CANCELLED' });
        await hooks.emit('task:cancelled', { executionContext });

        emit({
          type: 'done',
          taskId,
          result: null,
          error: 'Task was cancelled',
        });
      } else {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        taskStore.updateStatus(taskId, 'failed', {
          error: errorMessage,
        });
        emit({ type: 'status_change', taskId, status: 'failed' });

        taskStore.appendEvent({
          taskId,
          type: 'TASK_FAILED',
          payload: { error: errorMessage },
        });

        logger.error(
          { taskId, agentName: executionContext.agentName, error },
          'TASK_FAILED'
        );
        await hooks.emit('task:failed', {
          executionContext,
          error: errorMessage,
        });

        emit({
          type: 'done',
          taskId,
          result: null,
          error: errorMessage,
        });
      }

      throw error;
    } finally {
      if (!taskSucceeded) {
        for (const sessionId of delegationSessions) {
          try {
            sessionStore.close(sessionId);
          } catch {
            // Already closed or not found — ignore
          }
        }
      }
      await registry.closeAll();
      taskStore.unregisterCancellation(taskId);
    }
  }
}

/**
 * Estimate-then-drop window for context-limit enforcement.
 * Always preserves the system message at index 0.
 */
function windowMessages(messages: Message[], limit: number): Message[] {
    const preserved = messages[0]?.role === 'system' ? [messages[0]] : [];
    const rest = messages.slice(preserved.length);
    // Estimate tokens at ~4 chars/token
    let tokens = preserved.reduce((n, m) => n + (m.content?.length ?? 0) / 4, 0);
    const result: Message[] = [...preserved];
    for (let i = rest.length - 1; i >= 0 && tokens < limit; i--) {
        const msg = rest[i];
        const msgTokens = (msg.content?.length ?? 0) / 4;
        if (tokens + msgTokens <= limit) {
            result.splice(preserved.length, 0, msg);
            tokens += msgTokens;
        }
    }
    return result;
}
