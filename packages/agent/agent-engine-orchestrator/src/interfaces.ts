/**
 * EngineConfig — injectable config interface for the engine layer.
 *
 * The engine MUST NOT import config.js (a process.env-reading singleton).
 * Instead, the host (entrypoint) constructs an object satisfying this interface
 * and passes it where needed (constructor params, function arguments).
 */

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

export interface EngineConfig {
  server: {
    /** Estimated token limit for the message window passed to each provider call.
     *  When > 0, oldest non-system messages are dropped to fit. */
    contextLimit: number;
    /** Default max_tokens for providers that don't set maxTokens in their config. */
    defaultMaxTokens: number;
  };
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
