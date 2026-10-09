import type { LLMProvider } from '../providers/types.js';
import { serverSideToolsForProvider } from '../providers/server-side-tools.js';
import type { ExecutionContext, Message } from '../validation/index.js';
import type {
  IHookRegistry,
  IEnforcementError,
  IToolWarning,
  PostToolCallPayload,
} from '@adhd/agent-base-types';
import { effectiveHitl } from '@adhd/agent-base-types';
import { encode } from 'gpt-tokenizer';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../validation/errors.js';
import { generateId } from '../utils/ids.js';
import { nowIso } from '../utils/timestamps.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import {
  capToolResult,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  validateToolResultMaxChars,
} from './tool-result-cap.js';
import { coerceToolArguments } from './tool-arg-coercion.js';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../interfaces.js';
import { selectionOf, wireModelOf } from '../providers/resolve-selection.js';

import type { McpClientRegistry } from '../clients/registry.js';
import type { PolicyEngine } from './policy.js';
import {
  renderToolPromptDoc,
  toNameOnlyTools,
  type ToolAdvertisementMode,
} from './tool-advertisement.js';
import {
  estimateMessageTokens,
  groupIntoAtomicUnits,
  decideCompaction,
  compactMessages,
} from './context-window.js';

// ── HITL (Human-in-the-Loop) support ─────────────────────────────────────────

const HITL_TOOL_NAME = 'request_human_input';

// Re-exported for existing importers (`../engine/orchestrator.js`); the
// canonical definition now lives in interfaces.ts so provider adapters can
// share it without an import cycle.
export { DEFAULT_PROVIDER_TIMEOUT_MS };

/**
 * Default bound on parent-chain escalation depth (ADR-0008 D6/D11).
 *
 * When `nativeTooling.hitl` is disabled, an `ask` climbs the parent chain
 * toward the root until it reaches an INTERACTIVE ancestor (one whose
 * definition does not disable HITL) — that ancestor becomes the decision
 * surface and is the only task parked holding the resumeToken. Non-interactive
 * ancestors passed on the way are parked tokenless for the duration and
 * restored afterwards. If every ancestor up to the root is non-interactive the
 * walk terminates in the `deny` floor AT the root.
 *
 * The climb is bounded twice by `escalationMaxDepth`: a task may escalate only
 * while its `recursionDepth` is strictly below the bound, and the walk visits at
 * most that many ancestors (cycle-safe). At or beyond the bound the ask fails
 * CLOSED (`PERMISSION_ASK_DENIED`), exactly like the no-parent floor — an
 * unanswered ask never hangs and is never unbounded.
 * Overridable per host via `EngineConfig.escalationMaxDepth`.
 */
export const DEFAULT_MAX_ESCALATION_DEPTH = 3;

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

// ── Permission gate (ADR-0008 D5/D6) ─────────────────────────────────────────

/**
 * Affirmative answers accepted when a suspended permission `ask` is resumed via
 * `task_resume`. Anything else (including an empty string) DECLINES the ask and
 * the tool is not executed.
 *
 * The vocabulary is deliberately restricted to EXPLICIT approval words. A
 * permission `ask` gates a privileged tool, and its answer can arrive from a
 * path that was never meant as an approval: the chat gateway auto-resumes an
 * `awaiting_input` task with whatever chat message comes in
 * (`entrypoint/agent-mcp/src/streaming/chat-gateway.ts`), so a bare
 * conversational affirmative (`ok` / `yes` / `y` / `true`) sent for an unrelated
 * reason must NOT approve a privileged call. Only unambiguous permission verbs
 * qualify as a bare-word approval. Accepted forms:
 *
 *  - one of the words below (case insensitive), or
 *  - a structured approval signal: JSON carrying `{"allow":true}` or
 *    `{"approved":true}`.
 *
 * Normal HITL resume (`request_human_input`, whose free-text answer is handed to
 * the model verbatim) does NOT pass through this predicate and is unaffected.
 */
const PERMISSION_APPROVAL_WORDS = new Set([
  'allow',
  'approve',
  'approved',
]);

/** Does the human's resume input approve the ask? See {@link PERMISSION_APPROVAL_WORDS}. */
export function isPermissionApproval(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.length === 0) return false;
  if (PERMISSION_APPROVAL_WORDS.has(trimmed.toLowerCase())) return true;
  try {
    const parsed = JSON.parse(trimmed) as { allow?: unknown; approved?: unknown };
    if (parsed !== null && typeof parsed === 'object') {
      if (parsed.allow === true || parsed.approved === true) return true;
    }
  } catch {
    // not JSON — fall through to decline
  }
  return false;
}

/**
 * Marker the adopted argv-allowlist shell server (`mcp-shell-server`,
 * `command_validator.py`) puts in the MCP `isError` result for a non-allowlisted
 * command: `Command not allowed: <cmd>`. The MCP client wraps every `isError` result
 * into a thrown `ToolError('MCP_CLIENT_ERROR', …)` that embeds the server text, so the
 * text is the only signal that survives to the engine (df7c3af9).
 */
const ALLOWLIST_DENIAL_MARKER = /Command not allowed:/;

/**
 * True when a tool call failed because an allowlist DENIED it — a refusal, not a
 * fault. Emitted as `isDenial` on `post:tool_call` so error-cap consumers skip it.
 */
function isAllowlistDenial(error: unknown): boolean {
  return (
    error instanceof ToolError &&
    error.code === 'MCP_CLIENT_ERROR' &&
    ALLOWLIST_DENIAL_MARKER.test(error.message)
  );
}

/**
 * The typed refusal returned to the model when a native tool call is refused by
 * the permission gate (`PERMISSION_DENIED`) or when an `ask` fails closed
 * (`PERMISSION_ASK_DENIED`, ADR-0008 D6). Matches the `AgentMcpErrorCode` union.
 */
function permissionRefusalResult(
  server: string,
  tool: string,
  code: 'PERMISSION_DENIED' | 'PERMISSION_ASK_DENIED',
  detail?: string
): { error: { code: string; tool: string; message: string } } {
  const qualified = `${server}.${tool}`;
  const lead =
    code === 'PERMISSION_DENIED'
      ? `Tool '${qualified}' is denied by the agent's permission policy and was not executed.`
      : `Tool '${qualified}' requires human approval, which could not be obtained, so it was not executed.`;
  return {
    error: {
      code,
      tool: qualified,
      message: detail ? `${lead} ${detail}` : lead,
    },
  };
}

/**
 * Typed refusal when a direct `request_human_input` call cannot suspend — HITL
 * is disabled, or the synchronous transport has no reachable approver
 * (ADR-0008 D6). Never a hang. Uses the same `PERMISSION_ASK_DENIED` code as a
 * fail-closed permission `ask`: both are an unanswered human-approval request.
 */
function hitlUnavailableResult(
  server: string,
  tool: string,
  reason: string
): { error: { code: string; tool: string; message: string } } {
  const qualified = `${server}.${tool}`;
  return {
    error: {
      code: 'PERMISSION_ASK_DENIED',
      tool: qualified,
      message: `Tool '${qualified}' asks for human input, which is unavailable (${reason}), so it was not executed.`,
    },
  };
}

/**
 * TaskStore-like interface for orchestrator consumption.
 *
 * `read` is optional so minimal fakes (unit tests that never take the
 * `escalate` branch) keep compiling; the real `TaskStore` satisfies it. The
 * escalate path uses it to restore the PARENT task to its pre-ask status after
 * routing an ask to it (see {@link DEFAULT_MAX_ESCALATION_DEPTH}); when absent
 * the engine falls back to `'running'`.
 *
 * `fields.resumeToken` is `Record`-typed (as before) but the escalate path
 * passes `null` to explicitly CLEAR a child's prior token — load-bearing: a
 * child parked for escalation must not carry a stale token from an earlier
 * `suspend`, or a direct child resume would find a match and fail the child.
 */
export interface OrchestratorTaskStore {
    updateStatus(taskId: string, status: string, fields?: Record<string, unknown>): void;
    appendEvent(evt: { taskId: string; type: string; payload?: unknown }): void;
    unregisterCancellation(taskId: string): void;
    /** Read a task row (status/parent/recursionDepth) — used to restore a parent. */
    read?(taskId: string): { status?: string; parentTaskId?: string; recursionDepth?: number; sessionId?: string | null } | undefined;
}

/** SessionStore-like interface for orchestrator consumption */
export interface OrchestratorSessionStore {
    appendMessage(sessionId: string, message: Message): Promise<void>;
    close(sessionId: string): void;
    /**
     * Resolve a session's agent definition. Optional so minimal fakes compile;
     * the real `SessionStore` satisfies it. The escalation walk uses it to tell
     * whether an ancestor task is interactive; when absent (or the lookup
     * fails) the ancestor is treated as interactive and the ask is delivered
     * there, exactly as the one-hop behaviour did.
     */
    getAgentDefinition?(sessionId: string): Parameters<typeof effectiveHitl>[0];
}

/** Outcome of climbing the parent chain for an escalated `ask` (fc466f0b). */
type EscalationWalk =
  | { kind: 'deliver'; targetId: string; passed: string[] }
  | { kind: 'deny'; reason: string; passed: string[]; rootId?: string };

/**
 * Climb from `startId` (the asking task's immediate parent) toward the root and
 * pick the decision surface: the first ancestor whose agent is interactive
 * (`effectiveHitl !== false`). Non-interactive ancestors are recorded in
 * `passed` (nearest first) and the walk advances to THEIR parent. Reaching a
 * non-interactive root yields `deny` AT the root. The walk visits at most
 * `maxHops` ancestors and tracks visited ids, so a long or cyclic chain fails
 * closed instead of walking forever. An ancestor whose row/definition cannot be
 * resolved is treated as interactive (delivery then fails closed on its own if
 * the row is truly unreachable).
 */
function walkEscalationChain(
  taskStore: OrchestratorTaskStore,
  sessionStore: OrchestratorSessionStore,
  startId: string,
  maxHops: number
): EscalationWalk {
  const passed: string[] = [];
  const visited = new Set<string>();
  let cursor = startId;
  for (let hop = 0; hop < maxHops; hop++) {
    if (visited.has(cursor)) {
      return {
        kind: 'deny',
        reason: `escalation chain is cyclic at task '${cursor}'`,
        passed,
      };
    }
    visited.add(cursor);

    let row: ReturnType<NonNullable<OrchestratorTaskStore['read']>>;
    try {
      row = taskStore.read?.(cursor);
    } catch {
      return { kind: 'deliver', targetId: cursor, passed };
    }

    let interactive = true;
    if (row?.sessionId && sessionStore.getAgentDefinition) {
      try {
        interactive =
          effectiveHitl(sessionStore.getAgentDefinition(row.sessionId)) !== false;
      } catch {
        interactive = true;
      }
    }
    if (interactive) return { kind: 'deliver', targetId: cursor, passed };

    passed.push(cursor);
    const next = row?.parentTaskId;
    if (!next) {
      return {
        kind: 'deny',
        reason: `every ancestor up to the root task '${cursor}' is non-interactive (HITL disabled)`,
        passed,
        rootId: cursor,
      };
    }
    cursor = next;
  }
  return {
    kind: 'deny',
    reason: `escalation depth bound reached (walked ${maxHops} ancestors without finding an interactive approver; max ${maxHops})`,
    passed,
  };
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
  /**
   * Whether a suspension on this run can actually be ANSWERED by its caller
   * (ADR-0008 D6). Default `true`.
   *
   * A sessioned/background task can be answered: the caller observes the
   * `awaiting_input` status + `resumeToken` and later calls `task_resume`.
   * The SYNCHRONOUS transport — a one-shot `agent_name` dispatch and a
   * `session_id` task with `background:false` — sets this `false`: the caller is
   * blocked for the entire call and can never receive the resumeToken, so no
   * approver is reachable within the call.
   *
   * When `false`, the ask-resolution chain degrades directly to its fail-closed
   * floor (`deny`) and a direct `request_human_input` call is refused — an
   * unanswered ask NEVER hangs (ADR-0008 D6). This is a TRANSPORT property, not
   * the retired `isEphemeral` retention/interactivity conflation: retention
   * (`ephemeral`) is orthogonal (D6).
   */
  suspensionAnswerable?: boolean;
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
      suspensionAnswerable = true,
      emitTaskEvent,
      logger: loggerInput,
      config: configInput,
    } = input;

    const logger = loggerInput ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
    const config = configInput ?? { server: { contextLimit: 0, defaultMaxTokens: 8192 } } as EngineConfig;

    // Bounded parent-chain escalation (ADR-0008 D6/D11). See
    // {@link DEFAULT_MAX_ESCALATION_DEPTH} and `EngineConfig.escalationMaxDepth`.
    const escalationMaxDepth =
      config.escalationMaxDepth ?? DEFAULT_MAX_ESCALATION_DEPTH;

    const emit = (event: Parameters<NonNullable<typeof emitTaskEvent>>[0]) => {
      emitTaskEvent?.(event);
    };

    // Observational trace events (TRACE-2, f376e27a): the permission / HITL
    // events never alter a decision or a task outcome. The default HookRegistry
    // already isolates handler errors; this additionally isolates a registry
    // whose `emit` itself throws or rejects, so no emit can break a task.
    const emitObservational: IHookRegistry['emit'] = async (event, payload) => {
      try {
        await hooks.emit(event, payload);
      } catch (err) {
        logger.warn({ taskId, event, err }, 'Observational hook emit failed (ignored)');
      }
    };

    const currentMessages: Message[] = [...input.messages];
    const contextLimit = config.server.contextLimit;
    // Fails loud (RangeError) on a negative / NaN / non-integer cap.
    const toolResultMaxChars = validateToolResultMaxChars(
      config.toolResult?.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS
    );

    const toolArgCoercionEnabled = config.toolArgCoercion?.enabled !== false;

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

      // HITL enablement is `nativeTooling.hitl` (legacy alias `allowHumanInput`),
      // resolved by `effectiveHitl` and DEFAULT-ON (ADR-0008 D3/D6: `hitl`
      // defaults to true). A definition that sets `hitl:false` — or the legacy
      // `allowHumanInput:false` — HIDES `request_human_input`; the default and an
      // explicit `hitl:true` advertise it. This is the SAME predicate the ask
      // chain uses to prune `suspend` below and the per-call handler uses to fail
      // closed: advertisement, ask resolution, and the handler must agree.
      if (effectiveHitl(executionContext.agentDefinition) !== false) {
        tools.push(HITL_BUILTIN_TOOL_DEFINITION);
      }

      // Default to 'full' JSON function-schemas — the contract models are trained on, and
      // what published 2.0.1 always sent. Full schemas are STATIC, so they sit in the cached
      // prefix and bill at the cache-hit rate after the first call, making name-only's payload
      // saving marginal while its reliability cost (malformed calls -> retries) is real.
      // 'names' remains available as an explicit opt-in. See BUG-ORCH-013.
      const advertisementMode: ToolAdvertisementMode =
        selectionOf(executionContext).providerType === 'claudecli'
          ? 'full'
          : (executionContext.agentDefinition.toolAdvertisement ?? 'full');
      const advertisedTools =
        advertisementMode === 'names' ? toNameOnlyTools(tools) : tools;
      const toolDocSystemMessage: Message | null = (() => {
        if (advertisementMode !== 'names' || tools.length === 0) return null;
        const doc = renderToolPromptDoc(tools);
        const existing = currentMessages[0];
        if (existing?.role === 'system') {
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

      // The provider's own reported prompt_tokens from the last call — the exact, free
      // ground truth for the real context size. Undefined before the first call.
      let lastReportedContext: number | undefined;
      const providerModel = wireModelOf(executionContext);

      let looping = true;
      while (looping) {
        if (signal.aborted) {
          throw new ToolError('PROVIDER_ERROR', 'Task was cancelled');
        }

        // Cache-preserving context management (BUG-ORCH-008): don't trim from the front
        // every call. Let history grow append-only, and only when the REAL context nears
        // the model's true window compact the middle into one summary — rarely, so the
        // cached prefix survives between compactions.
        {
          const decision = decideCompaction(
            lastReportedContext,
            currentMessages,
            providerModel,
          );
          if (decision.shouldCompact) {
            const before = currentMessages.length;
            const compacted = await compactMessages(
              currentMessages,
              async (toSummarise) => {
                // c536ce29 TRC-AC26: tag the summariser's model call so wire/api records carry
                // purpose:'compaction'. No wire seam => the plain call, unchanged.
                const summarise = () => provider.chat({
                  messages: [
                    {
                      id: generateId(),
                      sessionId: executionContext.sessionId,
                      role: 'system',
                      content:
                        'Summarise the following conversation excerpt concisely, preserving ' +
                        'decisions, facts, file paths, and any state a continuation would need. ' +
                        'Output only the summary.',
                      createdAt: nowIso(),
                    },
                    ...toSummarise.map((m) => ({
                      ...m,
                      // Flatten tool traffic to plain text so the summariser needs no tools.
                      role: m.role === 'tool' ? ('user' as const) : m.role,
                      content: flattenForSummary(m),
                      toolCalls: undefined,
                      toolResults: undefined,
                    })),
                  ],
                  tools: undefined,
                  signal,
                });
                const summary = await (config.wire
                  ? config.wire.withContext({ purpose: 'compaction' }, summarise)
                  : summarise());
                return summary.message.content ?? '';
              },
            );
            if (compacted.length < before) {
              currentMessages.length = 0;
              currentMessages.push(...compacted);
              lastReportedContext = undefined; // recompute against the compacted history
              logger.debug(
                { taskId, before, after: currentMessages.length, window: decision.window },
                'context compacted',
              );
              taskStore.appendEvent({
                taskId,
                type: 'CONTEXT_COMPACTED',
                payload: {
                  messagesBefore: before,
                  messagesAfter: currentMessages.length,
                  window: decision.window,
                  threshold: decision.threshold,
                },
              });
            }
          }
        }

        const composedSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(
            selectionOf(executionContext).timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
          ),
        ]);

        // compute_ms capture: turn-level model-call latency, distinct from task
        // wall-clock `latency_ms` (see DESIGN.md §6). Captured right before the
        // MODEL_REQUEST event so it brackets exactly the provider.chat() call below.
        const modelCallStartedAt = Date.now();

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
          // Provider-native web tools (default on, opt out via
          // nativeWebTools:false) — see server-side-tools.ts (backlog 1abd2d84).
          const serverSideTools = serverSideToolsForProvider(
            selectionOf(executionContext).providerType,
            executionContext.agentDefinition.nativeWebTools !== false
          );
          const callProvider = (): ReturnType<typeof provider.chat> => provider.chat({
            messages: messagesToSend,
            tools: advertisedTools.length > 0 ? advertisedTools : undefined,
            serverSideTools:
              serverSideTools.length > 0 ? serverSideTools : undefined,
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
          // Attach task/session/agent ids to every raw wire record this call writes (TRC-AC2/3).
          providerResponse = await (config.wire
            ? config.wire.withContext(
                {
                  task_id: executionContext.taskId,
                  session_id: executionContext.sessionId,
                  agent: executionContext.agentName,
                },
                callProvider
              )
            : callProvider());
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
              selectionOf(executionContext).timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
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
        // Record the provider's own context measurement to drive compaction decisions.
        if (providerResponse.usage?.inputTokens !== undefined) {
          lastReportedContext = providerResponse.usage.inputTokens;
        }
        // compute_ms: MODEL_RESPONSE.created_at - MODEL_REQUEST.created_at for this turn.
        const computeMs = Date.now() - modelCallStartedAt;
        // Prefer the provider's own count of tools it ran internally (claudecli); otherwise
        // the tool calls the orchestrator loop is about to execute. Accounting only —
        // loop control still keys off assistantMessage.toolCalls / executionContext.
        const reportedToolCallCount =
          providerResponse.reportedToolUses ?? assistantMessage.toolCalls?.length ?? 0;
        await hooks.emit('post:model_response', {
          executionContext,
          stopReason: providerResponse.stopReason,
          toolCallCount: reportedToolCallCount,
          modelCalls: providerResponse.reportedModelCalls,
          tokenUsage: providerResponse.usage,
          responseModel: providerResponse.responseModel,
          computeMs,
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
            toolCallCount: reportedToolCallCount,
            modelCalls: providerResponse.reportedModelCalls,
            responseModel: providerResponse.responseModel,
            inputTokens: providerResponse.usage?.inputTokens,
            outputTokens: providerResponse.usage?.outputTokens,
            cacheReadTokens: providerResponse.usage?.cacheReadTokens,
            cacheCreationTokens: providerResponse.usage?.cacheCreationTokens,
            // b726a987: 1h-TTL subset of cacheCreationTokens (priced at the 1h rate on re-pricing).
            cacheCreation1hTokens: providerResponse.usage?.cacheCreation1hTokens,
            // Provider-normalized full-price input (NOT derived here — the provider
            // layer already reconstructs this correctly per-provider, see
            // anthropic.ts/openai.ts `uncached`). Needed at turn grain so
            // usage_query's turn rows don't have to re-derive it from
            // inputTokens - cacheReadTokens - cacheCreationTokens.
            uncachedInputTokens: providerResponse.usage?.uncachedInputTokens,
            reasoningTokens: providerResponse.usage?.reasoningTokens,
            rawUsage: providerResponse.rawUsage,
            computeMs,
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
            // The model may call this whether or not it was advertised. It may
            // only SUSPEND when HITL is enabled AND the suspension is answerable
            // on this transport (ADR-0008 D6). Otherwise the ask FAILS CLOSED —
            // no suspension, a typed refusal, never a hang.
            const hitlDisabled =
              effectiveHitl(executionContext.agentDefinition) === false;
            if (hitlDisabled || !suspensionAnswerable) {
              const reason = hitlDisabled
                ? 'HITL is disabled (nativeTooling.hitl:false)'
                : 'the synchronous call has no reachable approver';
              taskStore.appendEvent({
                taskId,
                type: 'TOOL_CALL',
                payload: {
                  tool: `${tc.server}__${tc.tool}`,
                  callId: tc.id,
                  permission: 'ask',
                  resolution: 'deny',
                  code: 'PERMISSION_ASK_DENIED',
                  reason,
                },
              });
              warningResults.set(tc.id, {
                result: hitlUnavailableResult(tc.server, tc.tool, reason),
                isError: true,
              });
              continue;
            }

            // Every task is sessioned (ADR-0008 D6), so there is no
            // "ephemeral task has no row to persist a resume token" case left:
            // a one-shot `agent_name` task creates a real session row, and
            // `ephemeral` is a retention class, not an interactivity property.
            const resumeToken = randomUUID();

            // DEBT-AGENTMCP-HITL-TEST-CLEANUP-001: register the HITL resolver
            // BEFORE the awaiting_input status write. taskResume (tools/task.ts)
            // consumes the resolver synchronously right after observing the
            // status + resumeToken, which are only published by the
            // updateStatus/emit below — so a resume can never land in a window
            // where the resolver is not yet registered. (Previously the write
            // came first: a resume in that microtask window made resolveHitl
            // return false → TASK_NOT_RESUMABLE and the task was marked FAILED.)
            let abortHandler: (() => void) | undefined;
            const userInputPromise = new Promise<string>((resolve, reject) => {
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
            });

            try {
              await taskStore.updateStatus(taskId, 'awaiting_input', {
                resumeToken,
              });
            } catch (err) {
              // Status write failed → the suspension never became observable;
              // unregister the resolver + abort listener so nothing dangles.
              // DEBT-AGENTMCP-HITL-TEST-CLEANUP-001: if the AbortSignal fired
              // DURING the write, abortHandler already deleted the resolver and
              // rejected userInputPromise — that rejection is never awaited on
              // this path, so mark it handled to avoid an unhandledRejection
              // (process-level crash risk in Node 15+) while rethrowing the
              // write error.
              hitlResolvers.delete(taskId);
              if (abortHandler)
                signal.removeEventListener('abort', abortHandler);
              void userInputPromise.catch(() => {});
              throw err;
            }
            try {
              emit({
                type: 'status_change',
                taskId,
                status: 'awaiting_input',
              });
            } catch (err) {
              // DEBT-AGENTMCP-HITL-TEST-CLEANUP-001: the awaiting_input status
              // write above is the source of truth (taskResume reads the store
              // for status + resumeToken); this emit is only a push
              // notification. A failed broadcast must NOT tear down a genuine
              // suspension — rethrowing here would kill run() while the task
              // sits in 'awaiting_input' holding a live resolver nobody awaits
              // (leak + unhandledRejection on a later abort). Log and continue
              // awaiting; the resolver stays registered by design so
              // taskResume can still complete the suspension.
              logger.warn(
                {
                  taskId,
                  err,
                  status: 'awaiting_input',
                },
                'Failed to emit awaiting_input status_change; status already persisted, suspension continues'
              );
            }

            await emitObservational('hitl:suspend', {
              executionContext,
              kind: 'request_human_input',
              parkedTaskId: taskId,
              resumeToken,
            });
            let userInput: string;
            try {
              userInput = await userInputPromise.finally(() => {
                if (abortHandler)
                  signal.removeEventListener('abort', abortHandler);
              });
            } catch (err) {
              await emitObservational('hitl:resume', {
                executionContext,
                parkedTaskId: taskId,
                outcome: 'cancelled',
              });
              throw err;
            }
            await emitObservational('hitl:resume', {
              executionContext,
              parkedTaskId: taskId,
              outcome: 'resumed',
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

          // ── Permission gate (ADR-0008 D5/D6) — host-side, BEFORE pre:tool_call.
          // The resolved permission map is evaluated over the tool NAME; `deny`
          // is a typed refusal with no execution, `ask` runs the fixed chain
          // (`suspend` → `escalate` → `deny`) below.
          const permissionAction = config.permissionGate
            ? config.permissionGate({
                server: resolved.server,
                tool: resolved.tool,
                agentDefinition: executionContext.agentDefinition,
              })
            : 'allow';

          // Observational verdict record (never alters the decision): `action`
          // is the gate's raw verdict, `resolution` what the chain settled on.
          const emitPermissionDecision = (
            resolution: 'allow' | 'suspend' | 'escalate' | 'deny',
            reason?: string
          ): Promise<void> =>
            emitObservational('permission:decision', {
              executionContext,
              server: resolved.server,
              tool: resolved.tool,
              callId: tc.id,
              qualifiedToolName,
              action: permissionAction,
              resolution,
              ...(reason !== undefined ? { reason } : {}),
            });

          if (permissionAction === 'allow') {
            await emitPermissionDecision('allow');
          }

          if (permissionAction === 'deny') {
            await emitPermissionDecision('deny');
            taskStore.appendEvent({
              taskId,
              type: 'TOOL_CALL',
              payload: {
                tool: qualifiedToolName,
                callId: tc.id,
                permission: 'deny',
                code: 'PERMISSION_DENIED',
              },
            });
            warningResults.set(tc.id, {
              result: permissionRefusalResult(
                resolved.server,
                resolved.tool,
                'PERMISSION_DENIED'
              ),
              isError: true,
            });
            continue;
          }

          if (permissionAction === 'ask') {
            // Fixed ask-resolution chain (ADR-0008 D6):
            //   suspend  — iff HITL is enabled (`nativeTooling.hitl !== false`)
            //              AND the suspension is answerable on this transport
            //   escalate — iff a parent exists AND the child is within the
            //              parent-chain depth bound; the ask climbs the parent
            //              chain to the nearest INTERACTIVE ancestor (never
            //              answered on the child). A chain with no interactive
            //              ancestor denies AT the root (fc466f0b).
            //   deny     — the fail-closed floor
            //
            // A synchronous call (one-shot `agent_name`, `background:false`) is
            // blocked for its entire duration, so it can never receive the
            // resumeToken: neither `suspend` nor `escalate` can be answered, and
            // the ask degrades directly to `deny`. An unanswered ask NEVER hangs
            // (ADR-0008 D6).
            const hitlEnabled =
              effectiveHitl(executionContext.agentDefinition) !== false;
            const parentTaskId = executionContext.parentTaskId;
            const recursionDepth = executionContext.recursionDepth ?? 0;
            // Bounded escalation (ADR-0008 D6/D11): the ask may escalate only
            // while the child's `recursionDepth` is strictly below
            // `escalationMaxDepth`, and the climb visits at most that many
            // ancestors. At/over the bound it fails closed — never unbounded,
            // never a hang.
            const withinEscalationBound = recursionDepth < escalationMaxDepth;
            let walk: EscalationWalk | undefined;
            let resolution: 'suspend' | 'escalate' | 'deny';
            if (!suspensionAnswerable) resolution = 'deny';
            else if (hitlEnabled) resolution = 'suspend';
            else if (parentTaskId && withinEscalationBound) {
              walk = walkEscalationChain(
                taskStore,
                sessionStore,
                parentTaskId,
                escalationMaxDepth
              );
              resolution = walk.kind === 'deliver' ? 'escalate' : 'deny';
            } else resolution = 'deny';

            if (resolution === 'deny') {
              let reason: string;
              if (!suspensionAnswerable) {
                reason = 'the synchronous call has no reachable approver';
              } else if (walk?.kind === 'deny') {
                // The climb ended in the fail-closed floor (root-terminal deny,
                // hop cap, or a cyclic chain).
                reason = walk.reason;
                // Audit EVERY hop the ask visited: each passed ancestor records
                // the forward, and the root records the terminal deny.
                for (const hopId of walk.passed) {
                  taskStore.appendEvent({
                    taskId: hopId,
                    type: 'TOOL_CALL',
                    payload: {
                      tool: qualifiedToolName,
                      callId: tc.id,
                      permission: 'ask',
                      resolution: hopId === walk.rootId ? 'deny' : 'forward',
                      escalatedFrom: taskId,
                      ...(hopId === walk.rootId
                        ? { code: 'PERMISSION_ASK_DENIED', reason }
                        : {}),
                    },
                  });
                }
              } else if (parentTaskId) {
                // A parent exists but the chain is too deep — the bound floored it.
                reason = `escalation depth bound reached (depth ${recursionDepth} >= max ${escalationMaxDepth})`;
              } else {
                reason = 'HITL is disabled and the task has no parent';
              }
              await emitPermissionDecision('deny', reason);
              taskStore.appendEvent({
                taskId,
                type: 'TOOL_CALL',
                payload: {
                  tool: qualifiedToolName,
                  callId: tc.id,
                  permission: 'ask',
                  resolution: 'deny',
                  code: 'PERMISSION_ASK_DENIED',
                  reason,
                },
              });
              warningResults.set(tc.id, {
                result: permissionRefusalResult(
                  resolved.server,
                  resolved.tool,
                  'PERMISSION_ASK_DENIED',
                  reason
                ),
                isError: true,
              });
              continue;
            }

            if (resolution === 'suspend') {
              // ── `suspend` — the CHILD itself is the decision surface ──────
              // (sessioned HITL). Park the child in `awaiting_input` holding its
              // own resumeToken; a caller resumes the child via `task_resume`.
              const resumeToken = randomUUID();
              let askAbortHandler: (() => void) | undefined;
              const approvalPromise = new Promise<string>((resolve, reject) => {
                hitlResolvers.set(taskId, resolve);
                askAbortHandler = () => {
                  hitlResolvers.delete(taskId);
                  reject(
                    new ToolError(
                      'PROVIDER_ERROR',
                      'Task cancelled while awaiting permission approval'
                    )
                  );
                };
                signal.addEventListener('abort', askAbortHandler, { once: true });
              });

              try {
                await taskStore.updateStatus(taskId, 'awaiting_input', {
                  resumeToken,
                });
              } catch (err) {
                hitlResolvers.delete(taskId);
                if (askAbortHandler)
                  signal.removeEventListener('abort', askAbortHandler);
                void approvalPromise.catch(() => {});
                throw err;
              }
              try {
                emit({
                  type: 'status_change',
                  taskId,
                  status: 'awaiting_input',
                });
              } catch (err) {
                logger.warn(
                  { taskId, err, status: 'awaiting_input' },
                  'Failed to emit awaiting_input status_change for permission ask; suspension continues'
                );
              }

              taskStore.appendEvent({
                taskId,
                type: 'TOOL_CALL',
                payload: {
                  tool: qualifiedToolName,
                  callId: tc.id,
                  permission: 'ask',
                  resolution: 'suspend',
                  resumeToken,
                },
              });

              await emitPermissionDecision('suspend');
              await emitObservational('hitl:suspend', {
                executionContext,
                kind: 'permission_ask',
                parkedTaskId: taskId,
                resumeToken,
              });
              let answer: string;
              try {
                answer = await approvalPromise.finally(() => {
                  if (askAbortHandler)
                    signal.removeEventListener('abort', askAbortHandler);
                });
              } catch (err) {
                await emitObservational('hitl:resume', {
                  executionContext,
                  parkedTaskId: taskId,
                  outcome: 'cancelled',
                });
                throw err;
              }
              await emitObservational('hitl:resume', {
                executionContext,
                parkedTaskId: taskId,
                outcome: isPermissionApproval(answer) ? 'approved' : 'declined',
              });
              await taskStore.updateStatus(taskId, 'running');
              emit({ type: 'status_change', taskId, status: 'running' });

              if (!isPermissionApproval(answer)) {
                warningResults.set(tc.id, {
                  result: permissionRefusalResult(
                    resolved.server,
                    resolved.tool,
                    'PERMISSION_ASK_DENIED',
                    'The approver declined.'
                  ),
                  isError: true,
                });
                continue;
              }
              // Approved → fall through to pre:tool_call + policy.check + Phase 2.
              // (No `continue` here — an approved `suspend` runs the tool exactly
              // like an approved `escalate`; only a decline short-circuits above.)
            }

            // ── `escalate` — the nearest INTERACTIVE ANCESTOR is the surface ──
            // The ask is DELIVERED to the ancestor the chain walk selected (the
            // immediate parent when it is interactive): that ancestor is parked
            // in `awaiting_input` holding the resumeToken, a resolver is
            // registered under ITS task id, and the child waits. Non-interactive
            // ancestors passed on the way are parked tokenless (and audited) so
            // every hop is observable, then restored. The child is parked
            // tokenless, so it can never approve its own ask. `task_resume` on
            // the TARGET resolves the child's promise; on approval the child
            // executes, on rejection it denies — exactly as if the target had
            // answered. Bounded by `escalationMaxDepth` (checked above).
            //
            // This is an `else`, not a bare block: the `suspend` branch above no
            // longer unconditionally `continue`s, so an APPROVED `suspend` must
            // fall through to the execution phase — NOT into this escalation
            // branch.
            else {
              const escalationWalk = walk as Extract<EscalationWalk, { kind: 'deliver' }>;
              const parentId = escalationWalk.targetId;
              const passedHops = escalationWalk.passed;

              // One pending decision per task. If the parent already holds a
              // pending escalation (two children asking at once), fail THIS ask
              // closed rather than clobber the live resolver and hang the first.
              if (hitlResolvers.has(parentId)) {
                const reason = `the parent task '${parentId}' already has a pending approval request`;
                await emitPermissionDecision('deny', reason);
                taskStore.appendEvent({
                  taskId,
                  type: 'TOOL_CALL',
                  payload: {
                    tool: qualifiedToolName,
                    callId: tc.id,
                    permission: 'ask',
                    resolution: 'deny',
                    code: 'PERMISSION_ASK_DENIED',
                    reason,
                  },
                });
                warningResults.set(tc.id, {
                  result: permissionRefusalResult(
                    resolved.server,
                    resolved.tool,
                    'PERMISSION_ASK_DENIED',
                    reason
                  ),
                  isError: true,
                });
                continue;
              }

              // Remember each hop's pre-ask status (the target and every passed
              // non-interactive ancestor) so it can be restored once the
              // decision lands (best-effort; `read` is optional on the store).
              const priorStatusOf = (id: string): string => {
                try {
                  return taskStore.read?.(id)?.status ?? 'running';
                } catch {
                  return 'running';
                }
              };
              const parentPriorStatus = priorStatusOf(parentId);
              const hopPriorStatus = new Map<string, string>(
                passedHops.map((id) => [id, priorStatusOf(id)])
              );
              // Every ancestor actually parked so far, for restore-on-failure.
              const parkedHops: string[] = [];

              const resumeToken = randomUUID();
              let askAbortHandler: (() => void) | undefined;
              const approvalPromise = new Promise<string>((resolve, reject) => {
                hitlResolvers.set(parentId, resolve);
                askAbortHandler = () => {
                  hitlResolvers.delete(parentId);
                  reject(
                    new ToolError(
                      'PROVIDER_ERROR',
                      'Task cancelled while awaiting parent approval'
                    )
                  );
                };
                signal.addEventListener('abort', askAbortHandler, { once: true });
              });

              let parentParked = false;
              try {
                // Park the PARENT first — it owns the resumeToken and is the
                // observable surface a caller answers.
                await taskStore.updateStatus(parentId, 'awaiting_input', {
                  resumeToken,
                });
                parentParked = true;
                emit({
                  type: 'status_change',
                  taskId: parentId,
                  status: 'awaiting_input',
                });
                // Park every passed non-interactive ancestor tokenless: each hop
                // is observably waiting on the decision, but only the target
                // holds the token, so no intermediate can answer the ask.
                for (const hopId of passedHops) {
                  await taskStore.updateStatus(hopId, 'awaiting_input', {
                    resumeToken: null,
                  });
                  parkedHops.push(hopId);
                  emit({
                    type: 'status_change',
                    taskId: hopId,
                    status: 'awaiting_input',
                  });
                }
                // Park the CHILD tokenless (`resumeToken: null` CLEARS any stale
                // token from an earlier suspend): the child is NOT directly
                // resumable, so a child self-approve can never satisfy the ask.
                await taskStore.updateStatus(taskId, 'awaiting_input', {
                  resumeToken: null,
                });
                emit({
                  type: 'status_change',
                  taskId,
                  status: 'awaiting_input',
                });
              } catch (err) {
                hitlResolvers.delete(parentId);
                if (askAbortHandler)
                  signal.removeEventListener('abort', askAbortHandler);
                void approvalPromise.catch(() => {});
                if (parentParked) {
                  try {
                    await taskStore.updateStatus(parentId, parentPriorStatus);
                    emit({
                      type: 'status_change',
                      taskId: parentId,
                      status: parentPriorStatus,
                    });
                  } catch {
                    // parent row vanished — nothing to restore
                  }
                }
                for (const hopId of parkedHops) {
                  const prior = hopPriorStatus.get(hopId) ?? 'running';
                  try {
                    await taskStore.updateStatus(hopId, prior);
                    emit({ type: 'status_change', taskId: hopId, status: prior });
                  } catch {
                    // hop row vanished — nothing to restore
                  }
                }
                logger.warn(
                  { taskId, parentId, err },
                  'Failed to route permission ask to the parent task; failing closed'
                );
                const reason = `the parent task '${parentId}' could not be reached for approval`;
                await emitPermissionDecision('deny', reason);
                taskStore.appendEvent({
                  taskId,
                  type: 'TOOL_CALL',
                  payload: {
                    tool: qualifiedToolName,
                    callId: tc.id,
                    permission: 'ask',
                    resolution: 'deny',
                    code: 'PERMISSION_ASK_DENIED',
                    reason,
                  },
                });
                warningResults.set(tc.id, {
                  result: permissionRefusalResult(
                    resolved.server,
                    resolved.tool,
                    'PERMISSION_ASK_DENIED',
                    reason
                  ),
                  isError: true,
                });
                continue;
              }

              // Per-hop audit: each non-interactive ancestor the ask passed
              // through records the forward (no token — not a decision surface).
              for (const hopId of passedHops) {
                taskStore.appendEvent({
                  taskId: hopId,
                  type: 'TOOL_CALL',
                  payload: {
                    tool: qualifiedToolName,
                    callId: tc.id,
                    permission: 'ask',
                    resolution: 'forward',
                    escalatedFrom: taskId,
                    escalatedTo: parentId,
                  },
                });
              }
              // Child-side audit: the ask escalated TO the target ancestor.
              // Deliberately carries NO resumeToken (the child is not the
              // decision surface).
              taskStore.appendEvent({
                taskId,
                type: 'TOOL_CALL',
                payload: {
                  tool: qualifiedToolName,
                  callId: tc.id,
                  permission: 'ask',
                  resolution: 'escalate',
                  escalatedTo: parentId,
                },
              });
              // Parent-side surface: the pending decision + its resumeToken.
              taskStore.appendEvent({
                taskId: parentId,
                type: 'TOOL_CALL',
                payload: {
                  tool: qualifiedToolName,
                  callId: tc.id,
                  permission: 'ask',
                  resolution: 'escalate',
                  escalatedFrom: taskId,
                  resumeToken,
                },
              });

              // The decision, resolved by the PARENT. The restore of BOTH tasks
              // lives in the `finally` so it runs on EVERY outcome — including a
              // rejection (the child signal aborting / cancellation): without it a
              // rejected `approvalPromise` would skip the restore entirely and
              // strand the parent in `awaiting_input` holding a dead resumeToken.
              await emitPermissionDecision('escalate');
              await emitObservational('hitl:suspend', {
                executionContext,
                kind: 'escalation',
                parkedTaskId: parentId,
                resumeToken,
                escalatedFrom: taskId,
              });
              try {
                let answer: string;
                try {
                  answer = await approvalPromise;
                } catch (err) {
                  await emitObservational('hitl:resume', {
                    executionContext,
                    parkedTaskId: parentId,
                    outcome: 'cancelled',
                  });
                  throw err;
                }
                await emitObservational('hitl:resume', {
                  executionContext,
                  parkedTaskId: parentId,
                  outcome: isPermissionApproval(answer)
                    ? 'approved'
                    : 'declined',
                });

                if (!isPermissionApproval(answer)) {
                  warningResults.set(tc.id, {
                    result: permissionRefusalResult(
                      resolved.server,
                      resolved.tool,
                      'PERMISSION_ASK_DENIED',
                      'The approver declined.'
                    ),
                    isError: true,
                  });
                  continue;
                }
                // Approved → fall through to pre:tool_call + policy.check + Phase 2.
              } finally {
                if (askAbortHandler)
                  signal.removeEventListener('abort', askAbortHandler);

                // Restore both. The child resumes either way; the parent returns
                // to its pre-ask status so it is not left parked forever. Each
                // write is guarded so one failure cannot prevent the other.
                try {
                  await taskStore.updateStatus(taskId, 'running');
                  emit({ type: 'status_change', taskId, status: 'running' });
                } catch (err) {
                  logger.warn(
                    { taskId, err },
                    'Failed to restore child task status after an escalated ask'
                  );
                }
                try {
                  await taskStore.updateStatus(parentId, parentPriorStatus);
                  emit({
                    type: 'status_change',
                    taskId: parentId,
                    status: parentPriorStatus,
                  });
                } catch (err) {
                  logger.warn(
                    { taskId, parentId, err },
                    'Failed to restore parent task status after an escalated ask'
                  );
                }
                for (const hopId of passedHops) {
                  const prior = hopPriorStatus.get(hopId) ?? 'running';
                  try {
                    await taskStore.updateStatus(hopId, prior);
                    emit({ type: 'status_change', taskId: hopId, status: prior });
                  } catch (err) {
                    logger.warn(
                      { taskId, hopId, err },
                      'Failed to restore an intermediate ancestor status after an escalated ask'
                    );
                  }
                }
              }
            }
          }

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
            let isDenial = false;
            try {
              // BK2 (114e014c): tolerate a model stringifying an array/object
              // argument, driven by the tool's declared input schema.
              let callArguments: unknown = toolCall.arguments;
              if (toolArgCoercionEnabled) {
                const declared =
                  tools.find((t) => t.name === qualifiedToolName) ??
                  tools.find(
                    (t) => t.name === `${toolCall.server}__${toolCall.tool}`
                  );
                const coerced = coerceToolArguments(
                  declared?.inputSchema,
                  toolCall.arguments
                );
                if (coerced.mismatch) {
                  throw new Error(coerced.mismatch.message);
                }
                callArguments = coerced.arguments;
                for (const c of coerced.coercions) {
                  logger.warn(
                    {
                      taskId,
                      tool: qualifiedToolName,
                      property: c.property,
                      from: c.from,
                      to: c.to,
                    },
                    'TOOL_ARG_COERCED'
                  );
                  taskStore.appendEvent({
                    taskId,
                    type: 'TOOL_ARG_COERCED',
                    payload: {
                      taskId,
                      tool: qualifiedToolName,
                      property: c.property,
                      from: c.from,
                      to: c.to,
                    },
                  });
                }
              }
              const client = await registry.getClient(resolved.server);
              toolResult = await client.callTool(
                resolved.tool,
                callArguments,
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
              isDenial = isAllowlistDenial(error);
              toolResult =
                error instanceof Error ? error.message : String(error);
              logger.warn(
                { taskId, tool: qualifiedToolName, error: toolResult },
                'TOOL_RESULT error'
              );
            }

            // Tokenize the FULL, untruncated result BEFORE the 500-char truncation
            // below — tokenizing the already-truncated summary would undercount
            // every large tool result (DESIGN.md §5).
            const fullResultText =
              typeof toolResult === 'string'
                ? toolResult
                : JSON.stringify(toolResult);
            const toolCallEstResultTokens = encode(fullResultText).length;

            // BK1 (3ad735bb): bound what the MODEL sees (and what the session
            // history persists). Telemetry above and the 500-char summary below
            // keep measuring the FULL result; `post:tool_call` also receives it.
            const capOutcome = capToolResult(
              toolResult,
              isError,
              toolResultMaxChars
            );
            const modelVisibleResult = capOutcome.result;

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
                tool_call_est_result_tokens: toolCallEstResultTokens,
                ...(capOutcome.truncated
                  ? {
                      truncated: true,
                      original_chars: capOutcome.originalChars,
                    }
                  : {}),
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
              ...(isDenial ? { isDenial: true } : {}),
              estResultTokens: toolCallEstResultTokens,
            });

            return {
              toolCall,
              toolResult: modelVisibleResult,
              isError,
              estResultTokens: toolCallEstResultTokens,
            };
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
              // Reuse the token estimate computed in Phase 2 (over the FULL,
              // untruncated result) rather than re-tokenizing here.
              estResultTokens: r.estResultTokens,
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
        // Prefix the error CODE for ToolErrors so a policy stop is
        // identifiable on the stored task — the same `[CODE] message`
        // convention agent-mcp's MCP boundary uses. Downstream consumers
        // (e.g. dispatch-orchestrator's dispatch_log, backlog 4e829a08)
        // can then surface the exact enforcement code, not just prose.
        let errorMessage: string;
        if (error instanceof ToolError) {
          errorMessage = `[${error.code}] ${error.message}`;
        } else if (error instanceof Error) {
          errorMessage = error.message;
        } else {
          errorMessage = String(error);
        }
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
 *
 * Always preserves the system message at index 0, then keeps the most recent
 * atomic units that fit the budget, dropping contiguously from the oldest end.
 * Contiguity matters: skipping an oversized unit and then keeping an older,
 * smaller one would punch a hole in the middle of the history and orphan a
 * `tool` message from its `assistant` call.
 *
 * The most recent unit is always retained even if it alone exceeds the limit,
 * so the loop makes progress; an genuinely oversized turn surfaces as the
 * provider's own context-window error rather than as a silently empty history.
 */
/** Render a message as plain text for the summariser (which is called without tools). */
function flattenForSummary(m: Message): string {
    if (m.content) return m.content;
    if (m.toolResults) return `[tool result] ${JSON.stringify(m.toolResults.map((r) => r.result))}`;
    if (m.toolCalls) {
        return `[tool calls] ${JSON.stringify(m.toolCalls.map((c) => ({ tool: c.tool, args: c.arguments })))}`;
    }
    return '';
}

export function windowMessages(messages: Message[], limit: number): Message[] {
    const preserved = messages[0]?.role === 'system' ? [messages[0]] : [];
    const units = groupIntoAtomicUnits(messages.slice(preserved.length));

    let tokens = preserved.reduce((n, m) => n + estimateMessageTokens(m), 0);
    const kept: Message[][] = [];

    for (let i = units.length - 1; i >= 0; i--) {
        const unitTokens = units[i].reduce((n, m) => n + estimateMessageTokens(m), 0);
        const isMostRecent = i === units.length - 1;
        if (!isMostRecent && tokens + unitTokens > limit) {
            break;
        }
        kept.unshift(units[i]);
        tokens += unitTokens;
    }

    return [...preserved, ...kept.flat()];
}
