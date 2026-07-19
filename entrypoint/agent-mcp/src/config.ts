/**
 * `config.ts` — agent-mcp's zero-config `Environment<AgentMcpConfig>` (per
 * `packages/environment/ARCHITECTURE.md` §6, the reference consumer for the
 * redesigned `@adhd/environment`).
 *
 * The spec is defined IN CODE with a `default` for every field, so the
 * server runs with zero files on disk and zero env vars set (`ARCHITECTURE.md`
 * §0/§2.1). Files (`~/.adhd/agent-mcp/<namespace>/config.yaml` etc.) and
 * `ADHD_AGENT_*` env vars layer on top only when present.
 *
 * `envPrefixOverride: "ADHD_AGENT"` (rather than the inferred
 * `"ADHD_AGENT_MCP"`) is deliberate: it preserves the pre-redesign
 * `ADHD_AGENT_*` env var surface byte-for-byte — including the
 * provider-credential vars (`ADHD_AGENT_OPENAI_SECRET` etc., see
 * `PROVIDER_DEFAULTS` below) that are NOT themselves declared `config`
 * fields of this spec but must still pass `env.isEnvNameAllowed` (a plain
 * `name.startsWith(prefix)` check — see `environment-core-node`). Inferring
 * `"ADHD_AGENT_MCP"` instead would silently break every provider credential
 * lookup and the agent-definition env-ref allowlist guard.
 */
import os from "node:os";
import path from "node:path";

import { Environment } from "@adhd/environment";
import type { EnvironmentSpec } from "@adhd/environment-base-spec";
import type { EngineConfig } from "@adhd/agent-engine-orchestrator";

// ============================================================================
// AgentMcpConfig — the resolved, nested `env.config` shape
// ============================================================================

export interface AgentMcpConfig {
  readonly db: { readonly path: string | undefined };
  readonly logging: { readonly level: string };
  readonly queue: { readonly concurrency: number };
  readonly server: {
    readonly maxDepth: number;
    readonly maxToolLoops: number;
    readonly defaultMaxTokens: number;
    readonly contextLimit: number;
    readonly allowedAgents: readonly string[] | undefined;
    readonly registryDbPath: string;
  };
  readonly transport: { readonly kind: string; readonly port: number };
  readonly sse: { readonly port: number; readonly host: string; readonly baseUrl: string | undefined };
  readonly plugins: { readonly configPath: string | undefined; readonly entries: readonly string[] };
}

// ============================================================================
// The spec — one FieldSpec per `AgentMcpConfig` leaf, every one defaulted
// ============================================================================

/**
 * Exported so tests (and any other real consumer that needs an isolated
 * instance — e.g. `__tests__/integration/harness.ts`) can construct their
 * own `new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {...})`
 * against a temp `adhdRoot` without touching the real machine's `~/.adhd`.
 */
export const agentMcpEnvironmentSpec: EnvironmentSpec<AgentMcpConfig> = {
  envPrefixOverride: "ADHD_AGENT",
  namespaces: ["production"],
  dirs: {
    data: { kind: "data" },
  },
  files: {
    // Zero-config default DB location — `env.files.db` — under the resolved
    // scope root (never the repo tree; ARCHITECTURE.md §6, AGENTS.md §10).
    db: { in: "data", name: "agents.db" },
  },
  config: {
    "db.path": {
      type: "string",
      env: "ADHD_AGENT_DATABASE_PATH",
      description: "SQLite DB path. Unset by default — falls back to the zero-config env.files.db location (db/client.ts).",
    },
    "logging.level": {
      type: "string",
      env: "ADHD_AGENT_LOG_LEVEL",
      default: "info",
      enum: ["trace", "debug", "info", "warn", "error", "fatal", "silent"],
    },
    "queue.concurrency": {
      type: "integer",
      env: "ADHD_AGENT_QUEUE_CONCURRENCY",
      default: 5,
      minimum: 1,
    },
    "server.maxDepth": {
      type: "integer",
      env: "ADHD_AGENT_MAX_DEPTH",
      default: 5,
      minimum: 1,
    },
    "server.maxToolLoops": {
      type: "integer",
      env: "ADHD_AGENT_MAX_TOOL_LOOPS",
      default: 50,
      minimum: 1,
    },
    "server.defaultMaxTokens": {
      type: "integer",
      env: "ADHD_AGENT_DEFAULT_MAX_TOKENS",
      default: 8192,
      minimum: 1,
    },
    "server.contextLimit": {
      type: "integer",
      env: "ADHD_AGENT_CONTEXT_LIMIT",
      default: 0,
      minimum: 0,
    },
    "server.allowedAgents": {
      type: "array",
      env: "ADHD_AGENT_ALLOWED_AGENTS",
      description: "Comma-separated allowlist of agent names. Unset ⇒ all agents allowed.",
    },
    "server.registryDbPath": {
      type: "string",
      env: "ADHD_AGENT_REGISTRY_DB_PATH",
      default: path.join(os.homedir(), ".adhd", "agent-mcp", "registry.db"),
    },
    "transport.kind": {
      type: "string",
      env: "ADHD_AGENT_TRANSPORT",
      default: "stdio",
      enum: ["stdio", "http", "sse"],
    },
    "transport.port": {
      type: "integer",
      env: "ADHD_AGENT_PORT",
      default: 3000,
      minimum: 1,
    },
    "sse.port": {
      type: "integer",
      env: "ADHD_AGENT_SSE_PORT",
      default: 3001,
      minimum: 1,
    },
    "sse.host": {
      type: "string",
      env: "ADHD_AGENT_SSE_HOST",
      default: "127.0.0.1",
    },
    "sse.baseUrl": {
      type: "string",
      env: "ADHD_AGENT_SSE_BASE_URL",
      description: "Public base URL for stream_url links. Unset ⇒ computed as http://localhost:<sse.port> (see engineConfig() in index.ts).",
    },
    "plugins.configPath": {
      type: "string",
      env: "ADHD_AGENT_CONFIG",
    },
    "plugins.entries": {
      type: "array",
      env: "ADHD_AGENT_PLUGINS",
      default: [],
      description: "Comma-separated external plugin entry paths.",
    },
  },
};

// ============================================================================
// getProviderConfig — resolves a provider's credential/URL/model
// ============================================================================

export type GetProviderConfigOpts = {
  provider: "openai" | "anthropic" | "claudecli";
  secret?: string;
  url?: string;
  model?: string;
  inlineBaseURL?: string;
  inlineModel?: string;
};

export type ProviderConfigResolved = {
  secret?: string;
  baseURL?: string;
  model?: string;
};

const PROVIDER_DEFAULTS: Record<string, { secret: string; baseUrl: string; model: string }> = {
  openai:    { secret: "ADHD_AGENT_OPENAI_SECRET",    baseUrl: "ADHD_AGENT_OPENAI_BASE_URL",    model: "ADHD_AGENT_OPENAI_MODEL" },
  anthropic: { secret: "ADHD_AGENT_ANTHROPIC_SECRET", baseUrl: "ADHD_AGENT_ANTHROPIC_BASE_URL", model: "ADHD_AGENT_ANTHROPIC_MODEL" },
  deepseek:  { secret: "ADHD_AGENT_DEEPSEEK_SECRET",  baseUrl: "ADHD_AGENT_DEEPSEEK_BASE_URL",  model: "ADHD_AGENT_DEEPSEEK_MODEL" },
};

function normalizeBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/v1";
      return parsed.toString().replace(/\/v1\/$/, "/v1");
    }
    return url;
  } catch { return url; }
}

function isLocalhostUrl(url: string | undefined): boolean {
  if (!url) return false;
  try { return ["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname); }
  catch { return false; }
}

function getProviderConfig(opts: GetProviderConfigOpts): ProviderConfigResolved {
  if (opts.provider === "claudecli") return {};
  const defaults = PROVIDER_DEFAULTS[opts.provider];

  const model = opts.model
    ? env.resolveEnvName(opts.model)
    : opts.inlineModel ?? (defaults ? env.resolveEnvName(defaults.model) : undefined);

  let baseURL: string | undefined;
  if (opts.url) baseURL = env.resolveEnvName(opts.url);
  if (!baseURL) baseURL = opts.inlineBaseURL ?? (defaults ? env.resolveEnvName(defaults.baseUrl) : undefined);
  if (baseURL) baseURL = normalizeBaseUrl(baseURL);

  let secret: string | undefined;
  if (opts.secret) secret = env.resolveEnvName(opts.secret);
  else if (defaults) secret = env.resolveEnvName(defaults.secret);

  if (!secret && !isLocalhostUrl(baseURL)) {
    const usedName = opts.secret ?? defaults?.secret ?? `ADHD_AGENT_${opts.provider.toUpperCase()}_SECRET`;
    throw new Error(`No credential for ${opts.provider}${baseURL ? ` at ${baseURL}` : ""}; set ${usedName}`);
  }

  return { secret, baseURL, model };
}

/**
 * Snapshot of the current `process.env`, for subprocess spawning
 * (`EngineConfig.subprocessEnv`, consumed by the `claudecli` provider and
 * the stdio MCP-client transport to forward the parent's environment to a
 * spawned child). Matches the pre-redesign `Config.subprocessEnv()`
 * behavior exactly: the full current env snapshot, not prefix-filtered.
 */
function subprocessEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

// ============================================================================
// env — the live, zero-config Environment instance
// ============================================================================

export const env = Object.assign(
  new Environment<AgentMcpConfig>("agent-mcp", agentMcpEnvironmentSpec, { namespace: "production" }),
  { getProviderConfig, subprocessEnv },
);

/**
 * Builds the `EngineConfig`-shaped adapter the orchestrator layer (`server.ts`,
 * `index.ts`) is injected with — the engine MUST NOT import `config.ts`
 * directly (`packages/agent/agent-engine-orchestrator/src/interfaces.ts`).
 * Derived live from `env.config` plus `env`'s own methods
 * (`getProviderConfig`/`isEnvNameAllowed`/`subprocessEnv`) on every call, so
 * it always reflects the current cascade (relevant for `at:'runtime'`/
 * `secret` fields, though this spec declares none).
 */
export function toEngineConfig(): EngineConfig {
  return {
    server: {
      contextLimit: env.config.server.contextLimit,
      defaultMaxTokens: env.config.server.defaultMaxTokens,
    },
    queue: { concurrency: env.config.queue.concurrency },
    sse: { baseUrl: env.config.sse.baseUrl ?? `http://localhost:${env.config.sse.port}` },
    plugins: {
      configPath: env.config.plugins.configPath,
      entries: env.config.plugins.entries as string[],
    },
    getProviderConfig: env.getProviderConfig,
    subprocessEnv: env.subprocessEnv,
    resolveEnvName: (name: string) => env.resolveEnvName(name),
    isEnvNameAllowed: (name: string) => env.isEnvNameAllowed(name),
  };
}
