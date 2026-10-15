import type {
  ExecutionContext,
  Message,
  ToolDefinition,
  Session,
  AgentDefinition,
  TokenUsage,
  PermissionAction,
  AskResolution,
} from './domain.js';
import type {
  AttemptFailedPayload,
  FailedPayload,
  TrippedPayload,
  RecoveredPayload,
} from './failure-events.js';

export interface TaskStartPayload {
  executionContext: ExecutionContext;
  messages: Message[];
  rootTaskId?: string;
}
export interface PreModelRequestPayload {
  executionContext: ExecutionContext;
  messages: Message[];
  tools: ToolDefinition[];
}
export interface PostModelResponsePayload {
  executionContext: ExecutionContext;
  stopReason: string;
  toolCallCount: number;
  /**
   * Model calls this single provider response represents. Optional: absent means 1
   * (every provider that returns one model call per response). Providers that run
   * an internal multi-turn loop in one invocation (claudecli's `num_turns`) report
   * the real count here so usage accounting is not under-counted.
   */
  modelCalls?: number;
  tokenUsage?: TokenUsage;
  /**
   * Model id the provider says actually served this call (the response's own `model`
   * field). Absent when the provider does not report one. Distinct from the configured
   * model: an alias or router can resolve to a different concrete model.
   */
  responseModel?: string;
  /** MODEL_RESPONSE.created_at − MODEL_REQUEST.created_at for this turn's model call. */
  computeMs: number;
  /**
   * Time to first byte: milliseconds from the provider request starting to its first streamed
   * byte/event. Present only when the provider measured it (anthropic: first stream event;
   * claudecli: first non-`system` CLI event); absent otherwise, never a guess. Same value as
   * `MODEL_RESPONSE.payload.ttfb_ms`.
   */
  ttfbMs?: number;
  /**
   * Engine overhead before this call: milliseconds from the previous model call of the same task
   * returning to this request starting (context assembly, tool execution, hooks, persistence).
   * Absent for a task's first model call. Same value as `MODEL_RESPONSE.payload.overhead_ms`.
   */
  overheadMs?: number;
  /**
   * The `thinking` configuration this call was sent with: `'none'` when the request carried no
   * `thinking` field (the API default), else the configured `type`. Absent when the provider has
   * no such option (R10 trace signal).
   */
  thinkingConfig?: 'none' | 'adaptive' | 'disabled';
  /** Thinking content blocks (`thinking` and `redacted_thinking`) in this response. Absent when not measured. */
  thinkingBlocks?: number;
  /**
   * Total bytes of tool-result content sent to the model in this request's history (the
   * tool_result blocks the call carried in). Absent when not measured.
   */
  toolResultBytesIn?: number;
  /** Zero-based index of this model call within its task. Absent when not tracked. */
  turnIndex?: number;
}
/** Concurrency class a tool call was scheduled under (`unordered` = never gated by the limiter's ordering). */
export type ToolCallConcurrencyClass = 'safe' | 'barrier' | 'unordered';
/** Coarse outcome class of a tool call, for trace analysis. */
export type ToolCallErrorClass =
  | 'none'
  | 'policy_rejected'
  | 'arg_mismatch'
  | 'arg_coerced'
  | 'exit_nonzero'
  | 'tool_error';
export interface PreToolCallPayload {
  executionContext: ExecutionContext;
  toolName: string;
  callId: string;
  toolInput: unknown;
  /** Class the call was scheduled under. Absent when the engine did not classify it. */
  concurrencyClass?: ToolCallConcurrencyClass;
  /** Zero-based index of the model turn whose response requested this call. */
  turnIndex?: number;
  /** Zero-based index of the ordered execution group the call ran in. */
  groupIndex?: number;
  /** Milliseconds the call waited for a concurrency slot or an earlier group before starting. */
  queuedMs?: number;
}
export interface PostToolCallPayload {
  executionContext: ExecutionContext;
  toolName: string;
  callId: string;
  toolInput: unknown;
  result: unknown;
  isError: boolean;
  /**
   * `true` when the failed result is a policy / allowlist DENIAL (e.g. the adopted
   * shell server refusing a non-allowlisted command) rather than a fault. A denial
   * is an ordinary, expected refusal the agent may legitimately retry, so
   * fault-bounding consumers (the budget plugin's `errors` / `consecutiveErrors`
   * caps) must not count it. Absent ⇒ not a denial (df7c3af9).
   */
  isDenial?: boolean;
  /**
   * The shell command's exit status (61358b6f), present only on a SUCCESSFUL
   * `shell_execute` result whose last text part carries the exit shim's
   * `[exit status: N]` trailer (i.e. a non-zero exit). A non-zero exit is not a
   * fault, so `isError` is unchanged; absent ⇒ exit 0, a non-shell tool, or no
   * shim. Also recorded on the persisted `TOOL_RESULT` event.
   */
  exitStatus?: number;
  /**
   * Token estimate for the FULL, untruncated tool result (tokenized before the
   * 500-char truncation applied to the stored `task_events.TOOL_RESULT.result` summary).
   */
  estResultTokens: number;
  /** Outcome class of the call. Absent when the engine did not classify it. */
  errorClass?: ToolCallErrorClass;
  /** UTF-8 byte length of the full result content as returned by the tool. */
  resultBytes?: number;
  /** `true` when the host appended a guidance note to this result before it reached the model. */
  noteAppended?: boolean;
}
export interface MessageAppendedPayload {
  executionContext: ExecutionContext;
  message: Message;
}
/**
 * Advisory flags a task can complete with. A warning never changes the task's status or result.
 * - `no_tool_use`: the final stop was `completed`, the task made zero tool calls, and the agent was
 *   granted at least one tool (cbd559eb).
 */
export type TaskCompletionWarning = 'no_tool_use';

export interface TaskCompletedPayload {
  executionContext: ExecutionContext;
  result: string;
  /** Present only when the task completed with at least one warning. */
  warnings?: TaskCompletionWarning[];
}
export interface TaskFailedPayload {
  executionContext: ExecutionContext;
  error: string;
}
export interface TaskCancelledPayload {
  executionContext: ExecutionContext;
}
export interface SessionCreatedPayload {
  session: Session;
}
export interface AgentMutatedPayload {
  agent: AgentDefinition;
  operation: 'update' | 'delete';
}

/**
 * Notification payload shared by the budget events. Emitted by budget plugins
 * when a cap is exceeded on the model path:
 *  - `budget:warning` — cap mode "warning" (the default): enforcement resolves
 *    and the run continues; the event is purely a notification layer.
 *  - `budget:block`   — cap mode "block": emitted immediately BEFORE the
 *    `IEnforcementError` throw, so hosts can observe the block before the
 *    orchestrator converts it into `ToolError('BUDGET_EXCEEDED')`.
 * No handler registered = no-op (see HookRegistry.emit).
 */
export interface BudgetWarningPayload {
  executionContext: ExecutionContext;
  field: string;
  maximum: number;
  current: number;
  message: string;
}
/** Same shape as `BudgetWarningPayload`; see its docs for the event contract. */
export interface BudgetBlockPayload {
  executionContext: ExecutionContext;
  field: string;
  maximum: number;
  current: number;
  message: string;
}

/**
 * A model had no rate-card price, so its spend could not be priced into the `cost` cap (20772a0b AC1).
 * Emitted once per task+model by the budget plugin.
 */
export interface BudgetUnpricedModelPayload {
  executionContext: ExecutionContext;
  /** The model that could not be priced. */
  model: string;
  /** The budget field affected (always `cost`). */
  field: 'cost';
  /** True when configured flat rates billed the turn instead; false when its spend is NOT counted. */
  usedFlatRates: boolean;
  message: string;
}

/** Where the live claudecli built-in set came from. */
export type ProviderBuiltinBypassSource =
  | 'allowedBuiltinTools'
  | 'compiledTools'
  | 'agent-spec';

/**
 * A claudecli task exposes CLI built-in tools that run outside the engine's tool pipeline (20772a0b AC1,
 * e0d71436 G4). Emitted once per `chat()` and only when at least one built-in is live.
 */
export interface ProviderBuiltinBypassPayload {
  executionContext: ExecutionContext;
  source: ProviderBuiltinBypassSource;
  /** Built-ins the CLI exposes (`['*']` in agent-spec mode with no `tools:` header). */
  builtins: string[];
  /** Engine behaviours these built-ins skip. */
  skipped: string[];
  /** Recommended path. */
  advice: string;
}

/**
 * The host permission gate's verdict for one tool call (observational — a
 * handler can never alter the decision).
 *
 * `action` is the gate's raw verdict; `resolution` is what actually happened:
 * `'allow'` when `action` is `'allow'`, otherwise the `AskResolution` link
 * (`suspend` | `escalate` | `deny`) the ask chain settled on — or `'deny'`
 * for a straight deny.
 */
export interface PermissionDecisionPayload {
  executionContext: ExecutionContext;
  /** MCP server (or native-tooling namespace) that owns the tool. */
  server: string;
  /** Bare tool name, without the server prefix. */
  tool: string;
  callId: string;
  /** `<server>__<tool>`, the name the permission rules match against. */
  qualifiedToolName: string;
  action: PermissionAction;
  resolution: 'allow' | AskResolution;
  reason?: string;
}
/** Why a task was parked awaiting a human (or ancestor) answer. */
export type HitlSuspendKind =
  | 'request_human_input'
  | 'permission_ask'
  | 'escalation'
  /** A credential-scoped provider failure (billing/auth/permission) parked for a human (provider-failure SPEC §6). */
  | 'provider_blocked';
/** A task suspended (`awaiting_input`) pending a human answer. */
export interface HitlSuspendPayload {
  executionContext: ExecutionContext;
  kind: HitlSuspendKind;
  /** The task that is parked (the escalated-to parent for `escalation`). */
  parkedTaskId: string;
  /** Opaque token a caller presents to `task_resume`. */
  resumeToken: string;
  /** For `escalation`: the child task whose ask was escalated. */
  escalatedFrom?: string;
}
/** How a suspension ended. */
export type HitlResumeOutcome =
  | 'resumed'
  | 'approved'
  | 'declined'
  | 'cancelled';
/** A suspended task resumed (or was released) with the human's answer. */
export interface HitlResumePayload {
  executionContext: ExecutionContext;
  /** Correlates with the matching `hitl:suspend`. */
  parkedTaskId: string;
  outcome: HitlResumeOutcome;
}
/** A session transitioned to `closed`. */
export interface SessionClosedPayload {
  session: Session;
}
/** Where a task's startup wall time went (R10 trace signal), emitted once per task before its first model call. */
export interface TaskStartupPayload {
  executionContext: ExecutionContext;
  /** Per MCP server: milliseconds to connect and list tools. */
  mcpConnectMs: Record<string, number>;
  /** Milliseconds from task start until the full tool list was ready. */
  toolsReadyMs: number;
  /**
   * Milliseconds the task waited in the queue before starting. Optional: present only when the emitter
   * measured it (enqueue to dequeue); absent otherwise, never a guess and never 0.
   */
  queueWaitMs?: number;
  /**
   * Milliseconds spent resolving or creating the session. Optional: present only when the emitter measured
   * it; absent otherwise, never a guess and never 0.
   */
  sessionMs?: number;
  /** Number of tools advertised to the model. */
  toolCount: number;
}
/** A dispatching tool (`task`, `tasks_batch`, an agent task) finished handing work to child tasks. */
export interface DispatchCompletedPayload {
  executionContext: ExecutionContext;
  /**
   * `task` / `tasks_batch` / `agent_task`: the call started child tasks. `result`: a `result` tool call that
   * waited (`wait_ms`) for one existing child; it starts nothing, so it is not a dispatch in the counters.
   */
  kind: 'task' | 'tasks_batch' | 'agent_task' | 'result';
  mode: 'sync' | 'background';
  childTaskIds: string[];
  /**
   * The id of the parent's tool call (the model's `tool_use` / `tool_calls[].id`, or `bridge-N` for a claudecli
   * bridged call) that made this dispatch, so concurrent dispatch calls on one parent are told apart exactly.
   * Absent when the dispatch was not made through an engine tool call (e.g. a direct REST call).
   */
  toolCallId?: string;
  /** Milliseconds the parent was blocked by this dispatch (about 0 for `background`). */
  parentBlockedMs: number;
  /** Milliseconds spent waiting for the children, when the dispatch waited. */
  waitMs?: number;
}
/**
 * A background child's result reached its parent. Type only: no emitter exists yet
 * (background auto-delivery is a later segment).
 */
export interface BackgroundDeliveredPayload {
  executionContext: ExecutionContext;
  childTaskId: string;
  /** Milliseconds from the child finishing to the parent receiving the result. */
  latencyMs: number;
  consumedVia: 'delivery' | 'result';
}

/**
 * Persistence veto for the provider-native server-tool result bodies of one assistant message
 * (R9-hist, Anthropic `web_fetch` / `web_search` results and their `server_tool_use` blocks).
 *
 * Server-tool results are executed by the provider, so they never pass through
 * `transform:tool_result` and cannot be rewritten (the blocks are opaque and signed). A plugin that
 * treats third-party content as untrusted therefore has exactly one lever: refuse to let it outlive
 * the run that produced it. The orchestrator emits this event once per assistant message, before
 * persisting its echo, with `persist: true`; a handler MUTATES the payload (passed by reference,
 * same contract as `transform:tool_result`) and sets `persist = false` to veto. After `emit()`
 * returns the orchestrator reads `persist`: `false` means the server-tool blocks of this message
 * are replayed within the producing run only and are never stored.
 *
 * A handler may only veto: it must never set `persist` back to `true` (handlers run in
 * registration order, so a later `true` would silently undo an earlier plugin's veto).
 */
export interface ServerResultPersistPayload {
  sessionId: string;
  agentName?: string;
  /** Bytes of the server-tool blocks that would be persisted (0 means nothing to veto). */
  serverBytes: number;
  /** Starts `true`; set to `false` to prevent the server-tool blocks from being stored. */
  persist: boolean;
}

export interface HookEventMap {
  'task:start': TaskStartPayload;
  'pre:model_request': PreModelRequestPayload;
  'post:model_response': PostModelResponsePayload;
  'pre:tool_call': PreToolCallPayload;
  'post:tool_call': PostToolCallPayload;
  /**
   * Same shape as post:tool_call, but with a transform contract: handlers
   * registered on this event may MUTATE the payload (passed by reference).
   * The orchestrator reads the mutated values after emit() returns.
   * Observational hooks on "post:tool_call" fire first in Phase 2;
   * transform hooks on this event fire in Phase 3 before the result is
   * appended to the conversation history.
   */
  'transform:tool_result': PostToolCallPayload;
  /**
   * Mutation-style persistence veto for provider server-tool result bodies, emitted once per
   * assistant message before its echo is stored. Handlers set `payload.persist = false` to keep
   * the bodies in-run only. See `ServerResultPersistPayload`.
   */
  'transform:server_result_persist': ServerResultPersistPayload;
  /**
   * Emitted by budget plugins when a cap whose mode is "warning" (the default)
   * is exceeded on the model path. Enforcement resolves — the run continues.
   * Hosts opt in via handler; no handler registered = no-op.
   */
  'budget:warning': BudgetWarningPayload;
  /**
   * Emitted by budget plugins when a cap whose mode is "block" is exceeded on
   * the model path, immediately BEFORE the `IEnforcementError` throw. The
   * orchestrator's existing conversion to `ToolError('BUDGET_EXCEEDED')`
   * remains the action; the event is the notification layer.
   */
  'budget:block': BudgetBlockPayload;
  /**
   * Emitted once per task+model when the budget `cost` cap meets a model with no rate-card price. A $-cap that
   * cannot price is reported, never silently uncapped. Persisted as a `budget:unpriced_model` task event.
   */
  'budget:unpriced_model': BudgetUnpricedModelPayload;
  /**
   * Emitted when a claudecli task runs with CLI built-in tools live: they bypass the engine's hooks, argument
   * coercion, result cap, token estimator and concurrency pool. Persisted as a `provider:builtin_bypass` task event.
   */
  'provider:builtin_bypass': ProviderBuiltinBypassPayload;
  'message:appended': MessageAppendedPayload;
  'task:completed': TaskCompletedPayload;
  'task:failed': TaskFailedPayload;
  'task:cancelled': TaskCancelledPayload;
  'session:created': SessionCreatedPayload;
  'agent:mutated': AgentMutatedPayload;
  /** The host permission gate's verdict for a tool call. Observational only. */
  'permission:decision': PermissionDecisionPayload;
  /** A task parked in `awaiting_input` (ask suspension, human-input tool, or escalation). */
  'hitl:suspend': HitlSuspendPayload;
  /** A parked task was answered, approved, declined, or cancelled. */
  'hitl:resume': HitlResumePayload;
  /** A session transitioned to `closed`. */
  'session:closed': SessionClosedPayload;
  /** Task startup timing breakdown (R10). Observational. */
  'task:startup': TaskStartupPayload;
  /** A dispatching tool handed work to child tasks (R10). Observational. */
  'dispatch:completed': DispatchCompletedPayload;
  /** A background child's result reached its parent (R10). Type only: not emitted yet. */
  'background:delivered': BackgroundDeliveredPayload;
  /** A model-call attempt failed and will be retried or failed over (provider-failure SPEC §5.2). */
  'provider:attempt_failed': AttemptFailedPayload<'provider'>;
  /** A provider call ended: terminal, suspended, held, or refused by an open trip. */
  'provider:failed': FailedPayload<'provider'>;
  /** A provider/credential trip opened (system-wide tripwire). */
  'provider:tripped': TrippedPayload<'provider'>;
  /** A provider trip closed: probe ok, cleared by a controller, or expired. */
  'provider:recovered': RecoveredPayload<'provider'>;
}

export type HookEvent = keyof HookEventMap;
export type HookHandler<E extends HookEvent> = (
  payload: HookEventMap[E]
) => void | Promise<void>;

// ── Enforcement (no-swallow, blocking) ────────────────────────────────────────

/**
 * Marker interface the orchestrator duck-types to distinguish budget violations
 * from generic errors. Throw this from an enforcement handler; never throw from
 * an observational handler (those are try/caught by HookRegistry.emit()).
 */
export interface IEnforcementError {
  readonly isEnforcementError: true;
  readonly code: string;
  readonly message: string;
}

/**
 * A soft tool-level warning that blocks the tool call but returns a diagnostic
 * message to the agent instead of failing the task.
 *
 * Budget plugins with `mode: "warning"` throw this from a `pre:tool_call`
 * enforcement handler. The orchestrator catches it, skips tool execution,
 * and injects the warning as a tool error result — the agent sees the error
 * and can adapt.
 */
export interface IToolWarning {
  readonly isToolWarning: true;
  readonly toolName: string;
  readonly message: string;
  readonly callId: string;
}

/** Only these events support enforcement handlers (throws propagate). */
export type EnforcementEvent = 'pre:model_request' | 'pre:tool_call';

export type EnforcementHandler<E extends EnforcementEvent> = (
  payload: HookEventMap[E]
) => void | Promise<void>;

export interface IHookRegistry {
  register<E extends HookEvent>(event: E, handler: HookHandler<E>): void;
  emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): Promise<void>;
  /**
   * Register an enforcement handler for an event. Unlike `register`/`emit`,
   * exceptions thrown by enforcement handlers are NOT swallowed — they
   * propagate to the orchestrator so the task can be failed with BUDGET_EXCEEDED.
   */
  registerEnforcement<E extends EnforcementEvent>(
    event: E,
    handler: EnforcementHandler<E>
  ): void;
  /** Run all enforcement handlers for the event. Throws propagate. */
  enforce<E extends EnforcementEvent>(
    event: E,
    payload: HookEventMap[E]
  ): Promise<void>;
}

export interface Plugin {
  name: string;
  install(hooks: IHookRegistry): void | Promise<void>;
}

/**
 * Context object passed to an external plugin factory at server startup.
 *
 * - `db`     — the live SQLite database handle; cast to `BetterSQLite3Database<any>`
 *              inside your plugin package if you need direct DB access.
 * - `config` — the validated plugin options from the `config` block in
 *              `agent-mcp.config.json`. If the plugin exports a `configSchema`,
 *              the server validates `config` against it before calling the factory
 *              (failures skip the plugin). Always an object — defaults to `{}` when
 *              the config block is omitted.
 */
export interface PluginContext {
  db: unknown;
  config: Record<string, unknown>;
}

/**
 * The shape external plugin packages must export as their `default` export
 * **or** as a named `createPlugin` export.
 *
 * Example (plugin package `src/index.ts`):
 * ```ts
 * import { z } from "zod";
 * import type { PluginContext, Plugin } from "@adhd/agent-base-types";
 *
 * export const configSchema = z.object({ maxUSD: z.number().positive() });
 *
 * export default function createPlugin({ db, config }: PluginContext): Plugin {
 *   return new MyPlugin(db, config as { maxUSD: number });
 * }
 * ```
 */
export type PluginFactory = (ctx: PluginContext) => Plugin | Promise<Plugin>;
