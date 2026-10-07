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
  tokenUsage?: TokenUsage;
  /** MODEL_RESPONSE.created_at − MODEL_REQUEST.created_at for this turn's model call. */
  computeMs: number;
}
export interface PreToolCallPayload {
  executionContext: ExecutionContext;
  toolName: string;
  callId: string;
  toolInput: unknown;
}
export interface PostToolCallPayload {
  executionContext: ExecutionContext;
  toolName: string;
  callId: string;
  toolInput: unknown;
  result: unknown;
  isError: boolean;
  /**
   * Token estimate for the FULL, untruncated tool result (tokenized before the
   * 500-char truncation applied to the stored `task_events.TOOL_RESULT.result` summary).
   */
  estResultTokens: number;
}
export interface MessageAppendedPayload {
  executionContext: ExecutionContext;
  message: Message;
}
export interface TaskCompletedPayload {
  executionContext: ExecutionContext;
  result: string;
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
