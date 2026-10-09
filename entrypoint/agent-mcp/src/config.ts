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
import { join } from "node:path";

import { Environment } from "@adhd/environment";
import { nativeToolingConfigFieldSpecs } from "@adhd/environment-base-spec";
import type { EnvironmentSpec } from "@adhd/environment-base-spec";
import { DEFAULT_TOOL_RESULT_MAX_CHARS, parseToolResultMaxChars } from "@adhd/agent-engine-orchestrator";
import type { EngineConfig } from "@adhd/agent-engine-orchestrator";
import type { PartialBinding } from "@adhd/agent-base-types";

import { loadEnvHierarchy } from "./utils/load-env.js";
import { defaultPermissionGate } from "./defaults.js";

// BUG-MCP-CREDENTIALS-001: populate `process.env` from the `.env` file
// hierarchy (`~/.adhd/.env` → `<cwd>/.adhd/.env` → `<cwd>/.env`) BEFORE the
// `Environment` singleton below is constructed and BEFORE any
// `getProviderConfig`/`resolveEnvName` call. Provider secrets
// (`PROVIDER_DEFAULTS` below, plus any agent-declared `provider.env.secret`
// name) are intentionally NOT `EnvironmentSpec` config fields — they are
// resolved only by a live `process.env` read (`Environment#resolveEnvName`,
// see `environment-core-node`) — so a file-cascade layer for them can only
// come from populating `process.env` itself, exactly as this loader does.
// See `utils/load-env.ts`'s header comment for the full history.
loadEnvHierarchy();

// ============================================================================
// AgentMcpConfig — the resolved, nested `env.config` shape
// ============================================================================

export interface AgentMcpConfig {
  readonly db: {
    readonly path: string | undefined;
    /**
     * Skip the flat→namespaced legacy operational-DB migration at boot
     * (backlog af567fb8). Hermetic test harnesses set this so a fresh scratch
     * DB is never seeded from the developer's real `~/.adhd` store.
     */
    readonly skipLegacyMigration: boolean;
  };
  /**
   * Level + the wire/ops log tree (backlog c536ce29). VALUES only: the sole off-switch is
   * `api` (`on|off`), which stops RAW API BODY capture and never touches ops/trace logs.
   * Byte sizes are plain integers; retention is in days.
   */
  readonly logging: {
    readonly level: string;
    /** Override of the log root. Unset ⇒ `env.paths.logs` (`~/.adhd/agent-mcp/<ns>/logs`). */
    readonly dir: string | undefined;
    /** Stable per-deployment label embedded in log FILE NAMES (instanceId changes every start). */
    readonly instanceLabel: string;
    readonly api: "on" | "off";
    readonly apiBodyMaxBytes: number;
    readonly apiRotateBytes: number;
    readonly apiRetentionDays: number;
    readonly apiMaxDirBytes: number;
    readonly opsRotateBytes: number;
    readonly opsRetentionDays: number;
    readonly opsMaxDirBytes: number;
    readonly traceRetentionDays: number;
    readonly traceMaxDirBytes: number;
    readonly floodMaxBytes: number;
    readonly floodWindowSeconds: number;
  };
  readonly queue: { readonly concurrency: number };
  /**
   * Agent-loop value knobs. `toolResult.maxChars` bounds the model-visible size of a single tool
   * result (backlog 3ad735bb): head+tail truncation with an in-band marker above the cap, `0`
   * disables, error results <= 4000 chars are never truncated.
   */
  readonly agent: { readonly toolResult: { readonly maxChars: string } };
  readonly server: {
    readonly maxDepth: number;
    readonly maxToolLoops: number;
    readonly defaultMaxTokens: number;
    readonly contextLimit: number;
    readonly allowedAgents: readonly string[] | undefined;
    /** Unset by default — see the `"server.registryDbPath"` FieldSpec below
     *  for why `@adhd/agent-core-env` owns the canonical fallback. */
    readonly registryDbPath: string | undefined;
    /**
     * The `global` tier of the provider selection chain
     * `task ?? session ?? agent ?? global` (D-G(2)). Both unset by default: there
     * is NO implicit default provider, and an unbound task fails closed with
     * `NO_PROVIDER_SELECTED`.
     */
    readonly defaultProvider: string | undefined;
    readonly defaultModel: string | undefined;
  };
  readonly transport: { readonly kind: string; readonly port: number; readonly host: string };
  readonly sse: {
    readonly enabled: boolean;
    readonly port: number;
    readonly host: string;
    readonly baseUrl: string | undefined;
  };
  readonly plugins: { readonly configPath: string | undefined; readonly entries: readonly string[] };
  /**
   * Typed config of the default-loaded `@adhd/agent-plugin-tracing` plugin (TRACE-4, backlog
   * 0f760dcd). VALUES only — there is deliberately NO enable/disable switch: tracing is
   * default-on (adhd ADR-0001 / sox ADR-0013). Field names and defaults mirror the plugin's own
   * `configSchema`, which re-validates the block at load time.
   */
  readonly tracing: {
    readonly service: string;
    readonly logSink: string;
    readonly logDir: string | undefined;
    readonly captureArgs: boolean;
  };
  /**
   * The portable native-tooling config surface (ADR-0008 D10 / NAT-TOOL-7),
   * spread from `nativeToolingConfigFieldSpecs("ADHD_AGENT")`. TYPED CONFIG
   * ONLY — no feature-switch env var (adhd ADR-0001 / sox ADR-0013). Every leaf
   * is optional except `hitl` (default `true`); `fs.root`/`shell.root` carry NO
   * default because the root is resolved at TASK time against the dispatching
   * cwd (ADR-0008 D4). Session retention is a session/run surface and is
   * deliberately absent, as are the retired ask-policy knobs.
   */
  readonly nativeTooling: {
    readonly fs: {
      readonly root: string | undefined;
      /**
       * GLOBAL allowed-root map (ADR-0008 D7): `alias=absolute-path` entries
       * (comma-separated env / config-file array). The operator owns the
       * machine-specific absolute targets; a definition references an alias
       * portably. Consumed at task time, never stored on a definition.
       */
      readonly allowedRoots: readonly string[] | undefined;
      readonly readOnly: boolean | undefined;
      readonly allowedTools: readonly string[] | undefined;
      readonly disallowedTools: readonly string[] | undefined;
    };
    readonly shell: {
      readonly root: string | undefined;
      readonly allowCommands: readonly string[] | undefined;
      readonly allowPatterns: readonly string[] | undefined;
      readonly timeoutMs: number | undefined;
    };
    readonly dispatch: {
      readonly allowedTools: readonly string[] | undefined;
      readonly disallowedTools: readonly string[] | undefined;
    };
    readonly hitl: boolean;
  };
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
    // `scope` is PINNED to `'global'` (not left to auto-detect project vs.
    // global from the invoking cwd's `.git`/`.adhd` marker) —
    // DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001. This repo's own `.mcp.json`
    // sets `ADHD_ENV_SCOPE=project` for the project-local `agent-mcp`
    // server entry (so `plugins.configPath`/`server.registryDbPath`'s
    // explicit-override defaults stay project-relative when wanted), and
    // this worktree root itself carries a `.git`/`.adhd` marker — so
    // WITHOUT this pin, `resolveScope()` (environment-builder/src/scope.ts)
    // resolves `'project'`, and the zero-config `db.path` default
    // (`env.files.db` below) roots the operational SQLite store under
    // `<repoRoot>/.adhd/agent-mcp/production/data/agents.db` — inside the
    // repo tree, violating AGENTS.md §10 ("persistent app stores belong in
    // the user home … never in the tree"). agent-mcp's OWN operational
    // store (agents/tasks/messages/sessions) is not project-shareable data
    // like a registry catalog might be, and MUST be one canonical location
    // regardless of which repo/cwd a given agent-mcp instance happens to be
    // invoked from — exactly the same reasoning `@adhd/agent-core-env`'s
    // `agentRegistryEnvironmentSpec` already applies to `registry.db` (see
    // `packages/agent/agent-core-env/src/spec.ts`). Mirrors that precedent.
    // An explicit `ADHD_AGENT_DATABASE_PATH` (as the global `agent-mcp`
    // server config already pins) or a future explicit `scope` override
    // still wins over this default — this only changes what the ZERO-CONFIG
    // fallback resolves to when nothing else is set.
    data: { kind: "data", scope: "global" },
    // c536ce29 (wire/ops tracing): the log tree and the claudecli scratch dir.
    // Both are PINNED `scope:'global'` for the same reason as `data` above:
    // `ADHD_ENV_SCOPE=project` (this repo's `.mcp.json`) must never put logs or
    // credential-bearing scratch files inside a repo tree.
    // Both are ALSO explicitly `share:'shared'`: the `logs`/`temp` kinds default
    // to `per-instance` (DEFAULT_SHARE_BY_KIND), which appends `env.instanceId`
    // to the path — and `generateInstanceId()` (environment-builder snapshot.ts)
    // is `${pid}-${random}`, a NEW value on EVERY process start. A per-instance
    // dir would therefore mint a fresh, never-swept tree per restart, so
    // retention/size caps could not bound the aggregate. The instance dimension
    // moves into FILE NAMES (`<date>.<logging.instanceLabel>.<pid>.jsonl`).
    logs: { kind: "logs", scope: "global", share: "shared" },
    temp: { kind: "temp", scope: "global", share: "shared" },
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
      description:
        "SQLite DB path. Unset by default — falls back to the zero-config env.files.db location (db/client.ts), resolved from the scope-forced operationalEnv instance (DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001) so ADHD_ENV_SCOPE=project can never relocate the operational store.",
    },
    "db.skipLegacyMigration": {
      type: "boolean",
      env: "ADHD_AGENT_SKIP_LEGACY_MIGRATION",
      default: false,
      description:
        "Skip the flat legacy ~/.adhd/agent-mcp/agents.db → namespaced-store " +
        "migration on boot. Set to `true` by hermetic test harnesses so a fresh " +
        "scratch DB is never seeded from the developer's real legacy store " +
        "(backlog af567fb8).",
    },
    "logging.level": {
      type: "string",
      env: "ADHD_AGENT_LOG_LEVEL",
      default: "info",
      enum: ["trace", "debug", "info", "warn", "error", "fatal", "silent"],
    },
    // c536ce29 — wire/ops log tree. VALUES with defaults; the only off-switch is `logging.api`,
    // which disables raw API body capture and leaves ops/trace logs on.
    "logging.dir": {
      type: "string",
      env: "ADHD_AGENT_LOGGING_DIR",
      description:
        "Override of the log root (contains api/, ops/, trace/). Unset by default — resolved " +
        "through @adhd/environment to ~/.adhd/agent-mcp/<namespace>/logs (never the repo tree).",
    },
    "logging.instanceLabel": {
      type: "string",
      env: "ADHD_AGENT_LOGGING_INSTANCE_LABEL",
      default: "default",
      pattern: "^[A-Za-z0-9._-]{1,64}$",
      description:
        "Stable label embedded in log file names (<date>.<label>.<pid>.jsonl). The environment " +
        "instanceId changes on every start, so the label is what keeps a long-lived deployment " +
        "(e.g. `sox-dev`) greppable. Letters, digits, `.`, `_`, `-` only.",
    },
    "logging.api": {
      type: "string",
      env: "ADHD_AGENT_LOGGING_API",
      default: "on",
      enum: ["on", "off"],
      description:
        "Raw API wire logging (request/response bodies, spawn and MCP traffic) under <logs>/api. " +
        "`off` stops ONLY api/ capture; ops/ and trace/ stay on and a `log.disabled` warning is " +
        "emitted at every start so it cannot be left off silently.",
    },
    "logging.apiBodyMaxBytes": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_API_BODY_MAX_BYTES",
      default: 4194304,
      minimum: 0,
      description: "Per-body capture cap in bytes (4 MiB). Larger bodies are truncated; sha256 of the full body is kept.",
    },
    "logging.apiRotateBytes": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_API_ROTATE_BYTES",
      default: 67108864,
      minimum: 1048576,
      description: "Rotate an api/ file at this size in bytes (64 MiB); rotated files are gzipped.",
    },
    "logging.apiRetentionDays": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_API_RETENTION_DAYS",
      default: 14,
      minimum: 1,
      description: "Delete api/ files older than this many days.",
    },
    "logging.apiMaxDirBytes": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_API_MAX_DIR_BYTES",
      default: 2147483648,
      minimum: 1048576,
      description: "Cap on the total size of api/ in bytes (2 GiB); oldest files are removed first.",
    },
    "logging.opsRotateBytes": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_OPS_ROTATE_BYTES",
      default: 16777216,
      minimum: 1048576,
      description: "Rotate an ops/ file at this size in bytes (16 MiB).",
    },
    "logging.opsRetentionDays": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_OPS_RETENTION_DAYS",
      default: 60,
      minimum: 1,
      description: "Delete ops/ files older than this many days.",
    },
    "logging.opsMaxDirBytes": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_OPS_MAX_DIR_BYTES",
      default: 268435456,
      minimum: 1048576,
      description: "Cap on the total size of ops/ in bytes (256 MiB).",
    },
    "logging.traceRetentionDays": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_TRACE_RETENTION_DAYS",
      default: 30,
      minimum: 1,
      description: "Delete trace/ (sox-telemetry spans + metrics snapshots) files older than this many days.",
    },
    "logging.traceMaxDirBytes": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_TRACE_MAX_DIR_BYTES",
      default: 536870912,
      minimum: 1048576,
      description: "Cap on the total size of trace/ in bytes (512 MiB).",
    },
    "logging.floodMaxBytes": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_FLOOD_MAX_BYTES",
      default: 268435456,
      minimum: 1048576,
      description:
        "Flood breaker: if one process writes more than this many bytes to api/ inside " +
        "logging.floodWindowSeconds it drops to digest-only records (no bodies) until the window clears.",
    },
    "logging.floodWindowSeconds": {
      type: "integer",
      env: "ADHD_AGENT_LOGGING_FLOOD_WINDOW_SECONDS",
      default: 600,
      minimum: 1,
      description: "Flood breaker window in seconds (10 minutes).",
    },
    "queue.concurrency": {
      type: "integer",
      env: "ADHD_AGENT_QUEUE_CONCURRENCY",
      default: 5,
      minimum: 1,
    },
    // Declared `string` (not `integer`) on purpose: the cascade's integer coercion is `parseInt`,
    // which silently turns "1.5" into 1 and "20000abc" into 20000 and so cannot fail loud on a
    // malformed value. `toEngineConfig()` parses it strictly via `parseToolResultMaxChars`.
    "agent.toolResult.maxChars": {
      type: "string",
      env: "ADHD_AGENT_TOOL_RESULT_MAX_CHARS",
      default: String(DEFAULT_TOOL_RESULT_MAX_CHARS),
      description:
        "Max chars of one tool result the model sees (head 75% + tail 25% + a truncation marker). " +
        "0 disables the cap; error results up to 4000 chars are never truncated.",
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
      description:
        "SQLite registry-DB path shared with the agent-registry package family " +
        "(agent-store-prompts/-tools, agent-core-policy/-provider, " +
        "agent-engine-compiler). Unset by default — falls back to " +
        "@adhd/agent-core-env's resolveRegistryDbPath() canonical default " +
        "(buildPromptResolver() in index.ts), so this field and the 5 family " +
        "packages always agree on ONE path without duplicating a default here.",
    },
    "server.defaultProvider": {
      type: "string",
      env: "ADHD_AGENT_DEFAULT_PROVIDER",
      description:
        "Host-wide default provider type (anthropic|openai|claudecli) — the `global` " +
        "tier of the selection chain task ?? session ?? agent ?? global. Unset by " +
        "default: no implicit provider; an unbound task fails closed " +
        "(NO_PROVIDER_SELECTED).",
    },
    "server.defaultModel": {
      type: "string",
      env: "ADHD_AGENT_DEFAULT_MODEL",
      description:
        "Host-wide default model (a canonical ref such as claude_sonnet_4_6, or a " +
        "provider-native string) — the `global` tier's model. Pair with " +
        "ADHD_AGENT_DEFAULT_PROVIDER.",
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
    "transport.host": {
      type: "string",
      env: "ADHD_AGENT_HOST",
      default: "127.0.0.1",
      description:
        "Interface the streamable-HTTP transport (ADHD_AGENT_TRANSPORT=http) binds. " +
        "Loopback by default: the MCP surface has no authentication, so binding a " +
        "non-loopback address (e.g. 0.0.0.0) exposes every agent/tool to the network " +
        "and must be an explicit operator choice. The SSE/gateway server has its own " +
        "knob, ADHD_AGENT_SSE_HOST (also 127.0.0.1 by default).",
    },
    "sse.enabled": {
      type: "boolean",
      env: "ADHD_AGENT_SSE_ENABLED",
      default: true,
      description:
        "Whether to start the SSE/OpenAI-compat-gateway HTTP server at all. " +
        "Set to false to opt an instance out entirely (no bind attempt) when " +
        "it will never serve task streaming or /v1/chat/completions — " +
        "`stream_url` is then omitted from task responses and the gateway " +
        "endpoints are unreachable on this instance.",
    },
    "sse.port": {
      type: "integer",
      env: "ADHD_AGENT_SSE_PORT",
      default: 3001,
      minimum: 1,
      description:
        "Port to attempt FIRST. Honored exactly when explicitly set (this " +
        "env var, or a config-file layer) — see resolveInitialSsePort(). " +
        "When left at default, a per-instance port is derived instead so " +
        "concurrent instances don't all race for 3001. Either way, " +
        "startSseServer() falls back to an OS-assigned ephemeral port on " +
        "EADDRINUSE, so a busy port never leaves an instance without SSE.",
    },
    "sse.host": {
      type: "string",
      env: "ADHD_AGENT_SSE_HOST",
      default: "127.0.0.1",
      description:
        "Interface the SSE/OpenAI-compat-gateway server binds. Loopback by default; " +
        "the gateway is unauthenticated, so binding elsewhere must be explicit.",
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
    // TRACE-4 (backlog 0f760dcd) — typed config of the default-loaded tracing plugin. Values only,
    // never a feature switch (no `*_ENABLED` field exists or may be added).
    "tracing.service": {
      type: "string",
      env: "ADHD_AGENT_TRACING_SERVICE",
      default: "agent-mcp",
      description:
        "Telemetry `service` resource attribute of the tracing plugin; also the default log directory name.",
    },
    "tracing.logSink": {
      type: "string",
      env: "ADHD_AGENT_TRACING_LOG_SINK",
      default: "file",
      enum: ["file", "stderr", "none"],
      description:
        "Where the tracing plugin's records land. `file` persists to `tracing.logDir` " +
        "(default `<logs>/trace` = `~/.adhd/agent-mcp/<namespace>/logs/trace`).",
    },
    "tracing.logDir": {
      type: "string",
      env: "ADHD_AGENT_TRACING_LOG_DIR",
      description:
        "Override of the tracing file-sink directory. Unset by default — agent-mcp then passes " +
        "`<logs>/trace` (resolveLogRoots().trace, c536ce29) to the plugin.",
    },
    "tracing.captureArgs": {
      type: "boolean",
      env: "ADHD_AGENT_TRACING_CAPTURE_ARGS",
      default: false,
      description:
        "Record (truncated) tool arguments verbatim instead of only their sha256 digest.",
    },
    // ADR-0008 D10 / NAT-TOOL-7 — the portable native-tooling config surface.
    // Built with this spec's `ADHD_AGENT` prefix so each field gets an explicit
    // env name (e.g. `ADHD_AGENT_NATIVE_TOOLING_FS_ROOT`). TYPED CONFIG ONLY:
    // these are values, never feature switches.
    ...nativeToolingConfigFieldSpecs("ADHD_AGENT"),
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

// ============================================================================
// operationalEnv — scope-forced instance for the OPERATIONAL store ONLY
// ============================================================================

/**
 * DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001 (design decision 2): a
 * scope-FORCED (`scope: 'global'`) `Environment` instance used EXCLUSIVELY to
 * resolve the operational SQLite store path (`db/client.ts`).
 *
 * Why it exists on top of the `dirs.data.scope:'global'` pin (which already
 * wins over `ADHD_ENV_SCOPE` for `env.files.db` — see the `data` dir comment
 * above): the environment CONFIG-FILE layers follow the ACTIVE scope, so with
 * `ADHD_ENV_SCOPE=project` a project-scope `config.yaml` (at
 * `<projectRoot>/.adhd/agent-mcp/production/config.yaml`) can set the
 * declared `db.path` config field — and `db/client.ts` previously opened
 * `env.config.db.path ?? env.files['db']`, i.e. the project layer would
 * relocate the operational agents.db into the repo tree (probe-verified red
 * before this fix). Forcing `scope:'global'` here means `roots.project` is
 * never populated, so the project/local layers never load and `db.path` can
 * only ever come from the env var layer (`ADHD_AGENT_DATABASE_PATH`) or a
 * system/global `config.yaml` — both user-level, both legitimate. This is
 * what the `dirs.data` pin alone cannot guarantee.
 *
 * `ADHD_ENV_SCOPE=project` (as this repo's `.mcp.json` sets) therefore
 * relocates ONLY config-file layers (`plugins.configPath`,
 * `server.registryDbPath` — already explicit project-relative overrides in
 * `.mcp.json`), never agents.db. Only an explicit `ADHD_AGENT_DATABASE_PATH`
 * still wins over the resolved default.
 */
export const operationalEnv = new Environment<AgentMcpConfig>("agent-mcp", agentMcpEnvironmentSpec, {
  namespace: "production",
  scope: "global",
});

// ============================================================================
// Log roots (backlog c536ce29 — wire/ops tracing)
// ============================================================================

/** Resolved, absolute directories of the wire/ops log tree plus the scratch dir. */
export interface LogRoots {
  /** The log root itself (`<logs>`): `logging.dir` if set, else `paths.logs`. */
  readonly root: string;
  /** Raw wire records (`api.*`). */
  readonly api: string;
  /** Structured core-ops events. */
  readonly ops: string;
  /** sox-telemetry spans + metrics snapshots (`tracing.logDir` default). */
  readonly trace: string;
  /** Credential-bearing scratch (claudecli mcp-config / agent-spec). */
  readonly temp: string;
}

/**
 * Resolves the log tree through the Environment cascade — never hard-coded. Defaults to
 * {@link operationalEnv} (scope-forced `global`) so a project-scope `config.yaml` under
 * `ADHD_ENV_SCOPE=project` can never relocate `logging.dir` into a repo tree, exactly the hole
 * `operationalEnv` closes for `db.path`. Pure: creates nothing on disk.
 *
 * @param target the Environment to resolve against (tests pass an isolated instance).
 */
export function resolveLogRoots(
  target: Pick<Environment<AgentMcpConfig>, "paths" | "config"> = operationalEnv
): LogRoots {
  const root = target.config.logging.dir ?? target.paths["logs"];
  if (!root) throw new Error("agent-mcp environment spec declares no `logs` dir");
  const temp = target.paths["temp"];
  if (!temp) throw new Error("agent-mcp environment spec declares no `temp` dir");
  return {
    root,
    api: join(root, "api"),
    ops: join(root, "ops"),
    trace: join(root, "trace"),
    temp,
  };
}

// ============================================================================
// SSE port selection (BUG-AGENTMCP-SSE-PORT-CONTENTION-001)
// ============================================================================

/** Lower/upper bound of the per-instance derived-port range (avoids the
 *  well-known/privileged range and common dev-server defaults). */
const DERIVED_PORT_RANGE_START = 20000;
const DERIVED_PORT_RANGE_SIZE = 20000;

/**
 * Deterministic-per-process candidate port derived from `env.instanceId`
 * (`pid` + short random per `Environment`'s own doc comment — see
 * `environment-core-node/src/environment.ts`). Mirrors the per-instance
 * path-suffixing intent in `@adhd/environment-builder`'s `dirs.ts` (a
 * `share: 'per-instance'` dir gets `instanceId` appended so instances never
 * collide) — same intent, applied to a port instead of a path. Not
 * globally coordinated, so a collision between two instances is possible;
 * `startSseServer`'s EADDRINUSE→ephemeral fallback covers that case.
 */
export function deriveInstancePort(instanceId: string): number {
  let hash = 0;
  for (let i = 0; i < instanceId.length; i++) {
    hash = (Math.imul(hash, 31) + instanceId.charCodeAt(i)) >>> 0;
  }
  return DERIVED_PORT_RANGE_START + (hash % DERIVED_PORT_RANGE_SIZE);
}

/**
 * Decides which port `startSseServer` should attempt FIRST, and whether
 * that choice was an explicit user pin (for logging/diagnostics only —
 * `startSseServer` falls back to an ephemeral port on EADDRINUSE either
 * way).
 *
 * - `env.provenance['sse.port'].source !== 'default'` means the user
 *   actually set `ADHD_AGENT_SSE_PORT` or pinned `sse.port` via a config
 *   file layer — honor it exactly as the first attempt.
 * - Otherwise derive a per-instance candidate so N concurrent instances
 *   spread across different ports instead of all racing for 3001.
 *
 * @param targetEnv — defaults to the live `env` singleton; tests pass an
 * isolated `Environment<AgentMcpConfig>` instance (constructed the same way
 * `config.zero-config.test.ts` does) to exercise both branches without any
 * process-wide state.
 */
export function resolveInitialSsePort(
  targetEnv: Pick<typeof env, "provenance" | "config" | "instanceId"> = env
): { port: number; explicit: boolean } {
  const explicit = targetEnv.provenance["sse.port"]?.source !== "default";
  if (explicit) {
    return { port: targetEnv.config.sse.port, explicit: true };
  }
  return { port: deriveInstancePort(targetEnv.instanceId), explicit: false };
}

/**
 * The ACTUAL port the SSE/gateway HTTP server bound to, once
 * `startSseServer()`'s returned promise resolves (may differ from both
 * `resolveInitialSsePort()`'s candidate AND `env.config.sse.port`, e.g. on
 * an EADDRINUSE→ephemeral fallback). `undefined` until set, or if the
 * server never managed to bind at all, or if `sse.enabled` is `false`.
 * Read by `toEngineConfig()` below so every `stream_url`/gateway-baseUrl
 * consumer reflects reality, not the originally-requested port.
 */
let resolvedSseBoundPort: number | undefined;

/**
 * Records the actual bound SSE port. Called exactly once, from `main()` in
 * `index.ts`, immediately after `startSseServer()` resolves — BEFORE any
 * consumer reads `toEngineConfig().sse.baseUrl` (including the one
 * snapshot of it cached into `taskDepsRef.value` at startup).
 */
export function setSseBoundPort(port: number | undefined): void {
  resolvedSseBoundPort = port;
}

/**
 * Precedence for the advertised SSE/gateway base URL, extracted as a pure
 * function so it's directly testable without the `env` singleton:
 *   1. An explicit `sse.baseUrl` config override (`ADHD_AGENT_SSE_BASE_URL`
 *      or a config-file layer) always wins — if an operator pinned a
 *      public base URL, honor it verbatim regardless of what actually
 *      bound.
 *   2. Otherwise, the ACTUAL bound port (`resolvedSseBoundPort`, set by
 *      `setSseBoundPort()` once `startSseServer()` resolves) — correct
 *      even when it differs from `configuredPort` (EADDRINUSE→ephemeral
 *      fallback, or a per-instance-derived candidate).
 *   3. Otherwise (nothing has bound yet), the configured/candidate port —
 *      matches pre-fix behavior for the window before the server binds.
 */
export function computeSseBaseUrl(
  configuredOverride: string | undefined,
  boundPort: number | undefined,
  configuredPort: number
): string {
  return configuredOverride ?? `http://localhost:${boundPort ?? configuredPort}`;
}

/** The `global` tier binding from the resolved config, or `undefined` when unset. */
function globalSelection(): PartialBinding | undefined {
  const providerType = env.config.server.defaultProvider;
  const modelRef = env.config.server.defaultModel;
  if (providerType === undefined && modelRef === undefined) return undefined;
  if (
    providerType !== undefined &&
    providerType !== "anthropic" &&
    providerType !== "openai" &&
    providerType !== "claudecli"
  ) {
    throw new Error(
      `ADHD_AGENT_DEFAULT_PROVIDER='${providerType}' is not one of anthropic|openai|claudecli`
    );
  }
  return {
    ...(providerType !== undefined && { providerType }),
    ...(modelRef !== undefined && { modelRef }),
  };
}

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
    defaultSelection: globalSelection(),
    server: {
      contextLimit: env.config.server.contextLimit,
      defaultMaxTokens: env.config.server.defaultMaxTokens,
    },
    queue: { concurrency: env.config.queue.concurrency },
    // Fails loud (RangeError) on a negative / NaN / non-integer / non-numeric cap, before any task runs.
    toolResult: { maxChars: parseToolResultMaxChars(env.config.agent.toolResult.maxChars) },
    sse: {
      baseUrl: computeSseBaseUrl(env.config.sse.baseUrl, resolvedSseBoundPort, env.config.sse.port),
    },
    plugins: {
      configPath: env.config.plugins.configPath,
      entries: env.config.plugins.entries as string[],
    },
    getProviderConfig: env.getProviderConfig,
    subprocessEnv: env.subprocessEnv,
    resolveEnvName: (name: string) => env.resolveEnvName(name),
    isEnvNameAllowed: (name: string) => env.isEnvNameAllowed(name),
    // ADR-0008 D5 — the resolved native-tooling permission gate, evaluated by the
    // engine before `pre:tool_call` for every native tool. This is the ONLY
    // production wiring of `AgentDefinition.nativeTooling.*.permissions`; without
    // it the field would be validated + persisted but never enforced.
    permissionGate: defaultPermissionGate,
  };
}

// ============================================================================
// Default plugins (backlog 5339c2e5)
// ============================================================================

export const DEFAULT_BUDGET_PLUGIN_MODULE = "@adhd/agent-plugin-budget";
export const DEFAULT_TRACING_PLUGIN_MODULE = "@adhd/agent-plugin-tracing";

export interface DefaultPluginEntry {
  module: string;
  config: Record<string, unknown>;
}

/**
 * The typed `tracing` config block as the tracing plugin's `configSchema` wants it: only the keys
 * that are set (an unset `logDir` is omitted, never `undefined` — the schema is `.strict()`).
 * Exported for the tests; the plugin re-validates the result at load time.
 */
export function tracingPluginConfig(
  tracing: AgentMcpConfig["tracing"]
): Record<string, unknown> {
  return {
    service: tracing.service,
    logSink: tracing.logSink,
    ...(tracing.logDir !== undefined ? { logDir: tracing.logDir } : {}),
    captureArgs: tracing.captureArgs,
  };
}

/**
 * The plugins agent-mcp loads BY DEFAULT, before any `ADHD_AGENT_PLUGINS` /
 * config-file entries — so an unattended `dispatch-cli` setup gets a spend cap
 * and a durable trace without the operator hand-authoring
 * `agent-mcp.config.json` (backlog 5339c2e5, 0f760dcd):
 *
 *  - `@adhd/agent-plugin-budget`, configured with a conservative,
 *    always-enforceable model-call cap (a rate-independent axis, so it bites
 *    even with zero cost rates configured).
 *  - `@adhd/agent-plugin-tracing` (ALWAYS present), configured from the typed
 *    `tracing.*` config block (`env.config.tracing`). There is NO enable/disable
 *    switch: an absent block still loads it with the spec defaults, and an
 *    invalid block makes the loader skip it with a logged reason. It reuses
 *    the process's telemetry provider if one is already initialised.
 *
 * The tracing sink directory defaults to `<logs>/trace` (see {@link resolveLogRoots}) unless
 * `tracing.logDir` is set; `traceDir` is the injectable default for tests.
 *
 * Opt OUT of the BUDGET plugin only with `ADHD_AGENT_DISABLE_BUDGET_PLUGIN=1`
 * (this never affects tracing). Env knobs:
 *  - `ADHD_AGENT_BUDGET_MAX_CALLS` — cumulative model-call cap (default 500;
 *    ≤0 disables the call cap).
 *  - `ADHD_AGENT_BUDGET_COST_USD`  — optional USD cost cap; when set, flat
 *    per-token rates are configured so the cap is enforceable.
 *
 * A user entry that names the same module (config file or `ADHD_AGENT_PLUGINS`)
 * overrides the default — the loader de-dupes by module and the user wins.
 */
export function defaultPluginEntries(
  processEnv: NodeJS.ProcessEnv = process.env,
  tracing: AgentMcpConfig["tracing"] = env.config.tracing,
  traceDir: string = resolveLogRoots().trace
): DefaultPluginEntry[] {
  // c536ce29: the tracing file sink defaults to `<logs>/trace` (env-resolved), not the plugin's
  // own `~/.adhd/sox-ecosystem/<service>/logs`. An operator-set `tracing.logDir` always wins.
  const resolvedTracing: AgentMcpConfig["tracing"] =
    tracing.logDir === undefined ? { ...tracing, logDir: traceDir } : tracing;
  const tracingEntry: DefaultPluginEntry = {
    module: DEFAULT_TRACING_PLUGIN_MODULE,
    config: tracingPluginConfig(resolvedTracing),
  };
  const optOut = processEnv["ADHD_AGENT_DISABLE_BUDGET_PLUGIN"];
  if (optOut === "1" || optOut === "true") return [tracingEntry];

  const caps: Array<Record<string, unknown>> = [];
  const maxCalls = Number(processEnv["ADHD_AGENT_BUDGET_MAX_CALLS"] ?? "500");
  if (Number.isFinite(maxCalls) && maxCalls > 0) {
    caps.push({ field: "calls", maximum: maxCalls });
  }

  // `scope` lives INSIDE `defaults` (a dimension field), not at the config
  // root: `pluginConfigSchema` has no top-level `scope` key, so the previous
  // `config: { scope: "global", defaults }` silently dropped it and the caps
  // resolved per-task instead of globally (post-merge bucket-B review, MEDIUM).
  const defaults: Record<string, unknown> = { mode: "block", caps, scope: "global" };

  const rawCost = processEnv["ADHD_AGENT_BUDGET_COST_USD"];
  if (rawCost !== undefined) {
    const costUsd = Number(rawCost);
    if (Number.isFinite(costUsd) && costUsd > 0) {
      // Cost is only enforceable when per-token rates are known; supply flat
      // defaults so a bare ADHD_AGENT_BUDGET_COST_USD produces a real cap.
      defaults["costPerInputToken"] = 0.000003;
      defaults["costPerOutputToken"] = 0.000015;
      caps.push({ field: "cost", maximum: costUsd });
    }
  }

  return [
    {
      module: DEFAULT_BUDGET_PLUGIN_MODULE,
      config: { defaults },
    },
    tracingEntry,
  ];
}
