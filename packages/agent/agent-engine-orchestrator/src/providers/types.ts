import type { Message } from '../validation/index.js';
import type { IProviderEcho, PermissionAction, ToolDefinition, TokenUsage } from '@adhd/agent-base-types';
export type { ToolDefinition, TokenUsage, IProviderEcho };
import type { ProviderLimitWarning } from './provider-failure.js';
export type { ProviderLimitWarning };
import type { ProviderTokenUsage } from './partial-usage.js';
export type { ProviderTokenUsage };

/**
 * The server name the permission gate sees for the `claude` CLI's own built-in tools
 * (`claude-builtin.Bash`, `claude-builtin.Read`, ...). Rules scope them like any server-qualified
 * tool name (`'claude-builtin.*': 'deny'`); a `'*'` rule also matches them.
 */
export const CLAUDE_BUILTIN_SERVER = 'claude-builtin';

/**
 * A provider-native (server-side) tool entry: emitted to the provider API as
 * a type-tagged object (`{ type: 'web_search_20250305', name: 'web_search' }`)
 * and executed by the PROVIDER, never by the client. Mirrors the
 * `EmittedServerSideTool` shape from `@adhd/agent-core-provider`'s emitter
 * (backlog 1abd2d84 — wiring that emitter into the live provider path).
 */
export interface ServerSideTool {
  type: string;
  name: string;
}

export interface ProviderChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  /** Provider-native type-tagged tools the provider executes server-side. */
  serverSideTools?: ServerSideTool[];
  signal?: AbortSignal;
  /**
   * GOV (f9dadeaa): the permission verdict for one provider-INTERNAL built-in tool (the `claude`
   * CLI's Bash/Read/Edit/Write/...). The engine answers it from its `permissionGate` with
   * `server = {@link CLAUDE_BUILTIN_SERVER}`. A provider that runs its own tool loop MUST NOT expose
   * a built-in whose verdict is not `'allow'` (`'ask'` cannot be answered inside the provider's loop).
   * Absent => no governance info (providers treat every built-in as allowed).
   */
  builtinToolPolicy?: (tool: string) => PermissionAction;
  executeTool?: (
    server: string,
    tool: string,
    args: unknown
  ) => Promise<{ result: unknown; isError: boolean }>;
  /**
   * R9-hist: provider-native assistant content to replay, keyed by the assistant `Message.id`
   * (thinking, server_tool_use and server tool results; see {@link IProviderEcho}). A provider that
   * does not echo, or an entry whose `provider`/`model` does not match this request, ignores it and
   * rebuilds the turn from `messages` exactly as before. Absent => legacy history.
   */
  echoes?: ReadonlyMap<string, IProviderEcho>;
  /**
   * R9-hist: awaited by a provider that continues a paused turn itself (Anthropic `pause_turn`)
   * BEFORE each continuation request, with the 1-based continuation number. The engine uses it to
   * check cancellation and enforce `pre:model_request` (budget/USD caps) per continuation; a
   * rejection aborts the continuation and propagates out of `chat()`. Absent => no per-continuation hook.
   */
  beforeContinuation?: (n: number) => Promise<void>;
}

export interface ProviderChatResponse {
  message: Message;
  stopReason: 'completed' | 'tool_calls';
  usage?: ProviderTokenUsage;
  rawUsage?: unknown;
  /**
   * Usage-accounting only. Tool invocations the provider executed ITSELF inside this
   * single response (e.g. the claude CLI running built-in tools). Never executed or
   * re-driven by the orchestrator — do not confuse with `message.toolCalls`, which
   * the orchestrator loop executes. Absent for providers that don't run tools internally.
   */
  reportedToolUses?: number;
  /**
   * Usage-accounting only. Real model-call count behind this response when the provider
   * ran several internal turns in one invocation (claudecli `num_turns`). Absent means 1.
   */
  reportedModelCalls?: number;
  /**
   * Model id the provider says actually served this call (`response.model`). Absent when
   * the provider does not report one (claudecli: its `result` event has no verified
   * single-model field, so it is deliberately left unset).
   */
  responseModel?: string;
  /**
   * Usage-window / limit warnings the provider reported while the call still SUCCEEDED (claudecli
   * `rate_limit_event` with `allowed_warning`). Surfaced, never swallowed (de6bee5d FLT-4).
   */
  limitWarnings?: ProviderLimitWarning[];
  /**
   * P6: milliseconds from request start to the first streamed byte/event of the call that
   * produced this response. Absent when the provider could not observe one.
   */
  ttfbMs?: number;
  /**
   * R9-hist: the provider-native content of this assistant turn (see {@link IProviderEcho}), to be
   * kept by the engine under `message.id` and passed back through {@link ProviderChatRequest.echoes}.
   * Absent for providers that do not echo and when nothing replay-relevant was returned.
   */
  echo?: IProviderEcho;
  /**
   * R9-hist: set when the provider retried WITHOUT the echoed blocks because the API rejected the
   * replay (`invalid_request` naming the echoed block types). `apiMessage` is the API's error text
   * (the engine truncates it to 300 chars for the task event); `echoedMessages` is how many assistant
   * messages had echoed blocks in the rejected request. The engine stops supplying echoes for the rest of the run.
   */
  echoDegraded?: { apiMessage: string; echoedMessages: number };
  /**
   * R9-hist: what was replayed in THIS request (inspectability): number of assistant messages sent
   * with echoed blocks and the JSON byte length of those blocks. Absent when nothing was replayed.
   */
  echoReplay?: { messages: number; bytes: number };
}

export interface LLMProvider {
  chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;
}
