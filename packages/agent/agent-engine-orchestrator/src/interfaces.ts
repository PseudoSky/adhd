import type { spawn } from 'node:child_process';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { AgentDefinition, PermissionAction } from '@adhd/agent-base-types';

/**
 * EngineConfig — injectable config interface for the engine layer.
 *
 * The engine MUST NOT import config.js (a process.env-reading singleton).
 * Instead, the host (entrypoint) constructs an object satisfying this interface
 * and passes it where needed (constructor params, function arguments).
 */

/**
 * The decision context handed to a {@link PermissionGate} (ADR-0008 D5).
 *
 * `server`/`tool` are the resolved server and tool names of the call being gated
 * (never command text — the gate matches TOOL NAMES only); `agentDefinition` is
 * the definition of the agent whose task is making the call, so the gate can
 * resolve that agent's `nativeTooling.*.permissions` map at call time.
 */
export interface PermissionDecisionContext {
  server: string;
  tool: string;
  agentDefinition: AgentDefinition;
}

/**
 * The resolved permission gate (ADR-0008 D5) — the **policy hook** the host
 * injects into the engine. Evaluated host-side, *before* `pre:tool_call`, for
 * **every tool call** the engine is about to make (the engine holds no server
 * taxonomy and cannot tell "native" from non-native). Returns one of:
 *
 *  - `'allow'` — run the tool;
 *  - `'deny'`  — refuse with a typed `PERMISSION_DENIED` result, never executed;
 *  - `'ask'`   — resolve through the fixed ask chain (`suspend` → `escalate` →
 *                `deny`) implemented by the orchestrator (ADR-0008 D6).
 *
 * **Blast radius (documented, not accidental).** Because the gate is consulted
 * for every tool call, a rule matching `'*'` applies to every server the agent
 * can call — including non-native ones (e.g. `backlog`, `memory`), not only
 * `fs`/`shell`/`agent-mcp`. The production `defaultPermissionGate` merges each
 * `nativeTooling.*.permissions` member into one flat map with a `'*'` baseline,
 * so a bare `{'*':'deny'}` declared under ANY member denies every tool call.
 * Rules SHOULD therefore scope by server-qualified name (`fs.*`, `shell.*`,
 * `agent-mcp.*`). The engine does NOT narrow the gate to a catalog.
 *
 * It is a pure decision function: the engine owns the *enforcement* (and the
 * session/parent graph the ask chain needs); the host owns the rule map. When no
 * gate is injected the engine defaults to `'allow'` (the base toolset posture).
 */
export type PermissionGate = (
  ctx: PermissionDecisionContext
) => PermissionAction;

/**
 * Default per-`provider.chat()` timeout when an agent definition does not set
 * `provider.timeoutMs`.
 *
 * Was 60_000ms, which proved a footgun under real fan-out: a genuine agentic
 * turn (Read/Grep/Bash plus at least one MCP round-trip) routinely exceeds 60s,
 * and a 29-way concurrent dispatch of `claudecli` tasks failed ~72% on the first
 * pass (backlog 36a73117). The clock is per model call — it starts inside the
 * turn, not at task creation — so a longer per-call budget does not penalize
 * queued tasks. 300_000ms (5 min) matches the operator-verified override from
 * that incident. Callers who need tighter bounds set `provider.timeoutMs`.
 *
 * Lives here (not in engine/orchestrator.ts) so provider adapters — e.g. the
 * OpenAI/DeepSeek SDK client — can apply the SAME default without importing
 * the engine module (which would create an import cycle). The engine URL/signal
 * timeout and the provider SDK client timeout MUST agree: a shorter SDK client
 * timeout silently aborts a call the outer signal would still allow.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;

/**
 * The outbound-I/O seams the host injects so every API call the engine makes can be logged raw
 * (backlog c536ce29). ADR-0006 dependency injection: the engine never imports the logging
 * library; the host builds these (e.g. traced `fetch`/`spawn`) and the engine just calls them.
 *
 * When {@link EngineConfig.wire} is absent the engine uses the plain globals
 * (`globalThis.fetch`, `node:child_process` `spawn`) and does no wire logging.
 */
export interface WireSeams {
  /** Replacement for `globalThis.fetch` used by every provider HTTP call. */
  fetch: typeof fetch;
  /** Replacement for `child_process.spawn` used to launch subprocess providers/servers. */
  spawn: typeof spawn;
  /**
   * Wraps an MCP client transport so its JSON-RPC traffic is logged. Must return a transport that
   * behaves identically to `t` ( `meta` only labels the log records).
   */
  wrapTransport(t: Transport, meta: { server: string; transport: string }): Transport;
  /** Runs `fn` with `ctx` ids (session/task/turn/...) attached to every record logged inside it. */
  withContext<T>(ctx: Record<string, string | number | boolean | null | undefined>, fn: () => T): T;
  /**
   * Namespaced directory for ephemeral, credential-bearing files (claudecli mcp-config / agent-spec).
   * Required when the claudecli provider runs (it throws without it - there is no OS-tmpdir
   * fallback); other providers ignore it. The host sets it to its `@adhd/environment` temp root.
   */
  tempDir?: string;
}

/** Default for {@link EngineConfig.toolCallConcurrency}. */
export const DEFAULT_TOOL_CALL_CONCURRENCY = 8;

export interface EngineConfig {
  /** Outbound-I/O seams (traced fetch/spawn/transport). Absent => plain globals, no wire logging. */
  wire?: WireSeams;
  /**
   * The host-wide default binding — the `global` tier of the selection chain
   * `task ?? session ?? agent ?? global`. Unset (the default) means there is no
   * default provider and an unbound task fails closed with `NO_PROVIDER_SELECTED`.
   */
  defaultSelection?: import('@adhd/agent-base-types').PartialBinding;
  server: {
    /** Estimated token limit for the message window passed to each provider call.
     *  When > 0, oldest non-system messages are dropped to fit. */
    contextLimit: number;
    /** Default max_tokens for providers that don't set maxTokens in their config. */
    defaultMaxTokens: number;
  };
  /**
   * Model-visible tool-result bound (config key `agent.toolResult.maxChars`, env
   * `ADHD_AGENT_TOOL_RESULT_MAX_CHARS`). Absent => 6000. `0` disables. See
   * `engine/tool-result-cap.ts`.
   */
  toolResult?: {
    maxChars: number;
    /**
     * Optional spill-to-file mode (config keys `agent.toolResult.spill.*`, default OFF): an
     * over-cap result is written in full to `<dir>/<taskId>/<callId>.txt` and the model sees a
     * short stub naming the path. Any spill failure falls back to the head+tail cap. See
     * `engine/tool-result-spill.ts`.
     */
    spill?: import('./engine/tool-result-spill.js').ToolResultSpillConfig;
  };
  /**
   * Schema-driven tolerance for stringified array/object tool arguments
   * (backlog 114e014c, `engine/tool-arg-coercion.ts`). Absent => enabled.
   * `enabled: false` is the negative-control switch for tests.
   */
  toolArgCoercion?: {
    enabled: boolean;
  };
  /**
   * Max same-turn tool calls the engine runs concurrently. A host sets it on the
   * `EngineConfig` it passes to `run()`. Absent, non-integer or < 1 => 8
   * ({@link DEFAULT_TOOL_CALL_CONCURRENCY}). Calls beyond the limit wait for a
   * free slot; results keep call order; human-input (HITL) calls never enter
   * the pool; one failing call does not cancel the others. Does not affect the
   * `task` tool's `background` default.
   */
  toolCallConcurrency?: number;
  queue: {
    /** Max concurrent background tasks. */
    concurrency: number;
  };
  sse: {
    /** Public base URL used in stream_url links. */
    baseUrl: string;
  };
  plugins: {
    /** Explicit path to agent-mcp config file (or undefined). */
    configPath?: string;
    /** Comma-separated plugin entry paths from env var (or empty array). */
    entries: string[];
  };
  /**
   * Resolve a provider's credential, URL, and model from the env var name pointers
   * stored in the agent definition.
   */
  getProviderConfig(opts: {
    provider: "anthropic" | "openai" | "claudecli";
    secret?: string;
    url?: string;
    model?: string;
    inlineBaseURL?: string;
    inlineModel?: string;
  }): {
    secret?: string;
    baseURL?: string;
    model?: string;
  };
  /**
   * The task-time dispatching working directory (ADR-0008 D4/D9).
   *
   * Set by the host at dispatch time — never persisted on an agent definition.
   * It is the directory the `claudecli` provider spawns `claude` in, so every
   * MCP child `claude` launches inherits it (Claude Code's `--mcp-config` has
   * no per-server `cwd` field).
   *
   * Engine-spawned stdio children are scoped by their own
   * `McpServerConfig.cwd`; when that is absent the child inherits the parent
   * process cwd (unchanged behavior, AC4). This field does NOT override that.
   */
  cwd?: string;
  /**
   * Return a snapshot of ADHD_AGENT_*-prefixed env vars for subprocess consumption.
   * Merged with the live process.env at subprocess spawn time.
   */
  subprocessEnv(): Record<string, string>;
  /**
   * Resolve a single env var name against the runtime environment, applying the
   * structural naming allowlist. Returns `undefined` if the name is disallowed
   * or the env var is unset.
   */
  resolveEnvName(name: string): string | undefined;
  /**
   * Validate that an env var name (referenced by agent definitions as an env.secret
   * etc. pointer) is allowed. Only ADHD_AGENT_-prefixed names pass by default;
   * the allowlist (ADHD_AGENT_ENV_ALLOWLIST) extends this set.
   */
  isEnvNameAllowed(name: string): boolean;
  /**
   * The resolved permission gate (ADR-0008 D5/D6), evaluated before
   * `pre:tool_call` for **every tool call** (not only native-tooling servers —
   * see {@link PermissionGate} for the documented `'*'` blast radius). Injected
   * by the host so the engine owns no rule map and no config singleton.
   * Omitted ⇒ `'allow'`.
   */
  permissionGate?: PermissionGate;
  /**
   * Maximum parent-chain depth at which an `ask` may escalate to the PARENT
   * (ADR-0008 D6/D11: "bounded (v1: by parent-chain depth)"). A task escalates
   * only while its `recursionDepth` is strictly below this bound; at/over it the
   * ask fails closed (`PERMISSION_ASK_DENIED`). Omitted ⇒
   * {@link DEFAULT_MAX_ESCALATION_DEPTH} (3).
   */
  escalationMaxDepth?: number;
}

/**
 * EngineLogger — injectable logger interface for the engine layer.
 *
 * The engine MUST NOT import logger.js (a pino-to-stderr singleton).
 * Instead, the host passes a logger satisfying this interface.
 */
export interface EngineLogger {
  info(msg: string | Record<string, unknown>, ...args: unknown[]): void;
  warn(msg: string | Record<string, unknown>, ...args: unknown[]): void;
  error(msg: string | Record<string, unknown>, ...args: unknown[]): void;
  debug(msg: string | Record<string, unknown>, ...args: unknown[]): void;
}
