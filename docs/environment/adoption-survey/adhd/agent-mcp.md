---
package: "@adhd/agent-mcp"
path: /Users/nix/dev/node/adhd/entrypoint/agent-mcp
root: adhd
language: node
self_internal: false
current_scope_behavior: cascading (zero-config @adhd/environment)
env_vars: [ADHD_AGENT_DATABASE_PATH, ADHD_AGENT_LOG_LEVEL, ADHD_AGENT_QUEUE_CONCURRENCY, ADHD_AGENT_MAX_DEPTH, ADHD_AGENT_MAX_TOOL_LOOPS, ADHD_AGENT_DEFAULT_MAX_TOKENS, ADHD_AGENT_CONTEXT_LIMIT, ADHD_AGENT_ALLOWED_AGENTS, ADHD_AGENT_REGISTRY_DB_PATH, ADHD_AGENT_TRANSPORT, ADHD_AGENT_PORT, ADHD_AGENT_SSE_PORT, ADHD_AGENT_SSE_HOST, ADHD_AGENT_SSE_BASE_URL, ADHD_AGENT_CONFIG, ADHD_AGENT_PLUGINS, ADHD_AGENT_OPENAI_SECRET, ADHD_AGENT_ANTHROPIC_SECRET, ADHD_AGENT_DEEPSEEK_SECRET]
writes: [{path: "~/.adhd/agent-mcp/production/data/agents.db", kind: "data", purpose: "SQLite runtime DB for agents/sessions/tasks"}, {path: "~/.adhd/agent-mcp/registry.db", kind: "data", purpose: "Registry DB for agent definitions and compiler metadata"}]
config_files: []
logging:
  has_logging: true
  logger: pino
  persists_log_files: false
  log_destination: "stderr only"
  structured: true
  error_handling: robust
  maps_to_env_logs: true
supported_by_env: full
gaps: []
value: high
effort: low
recommend: adopt
---

## Current State

**This package is ALREADY the reference consumer for the redesigned `@adhd/environment`.** Per `src/config.ts` §1, it is explicitly used as the model implementation for `@adhd/environment` zero-config cascading design (ARCHITECTURE.md §6).

### Environment Variables (all ADHD_AGENT_* prefix)

- **ADHD_AGENT_DATABASE_PATH** · read in `db/client.ts` · default: unset (falls back to `env.files.db` zero-config location)
- **ADHD_AGENT_LOG_LEVEL** · read in `logger.ts` and `config.ts` · default: `"info"` · enum: trace|debug|info|warn|error|fatal|silent
- **ADHD_AGENT_QUEUE_CONCURRENCY** · read in `config.ts` · default: `5` · minimum: 1
- **ADHD_AGENT_MAX_DEPTH** · read in `config.ts` · default: `5` · minimum: 1
- **ADHD_AGENT_MAX_TOOL_LOOPS** · read in `config.ts` · default: `50` · minimum: 1
- **ADHD_AGENT_DEFAULT_MAX_TOKENS** · read in `config.ts` · default: `8192` · minimum: 1
- **ADHD_AGENT_CONTEXT_LIMIT** · read in `config.ts` · default: `0` · minimum: 0
- **ADHD_AGENT_ALLOWED_AGENTS** · read in `config.ts` · array (comma-separated), optional
- **ADHD_AGENT_REGISTRY_DB_PATH** · read in `config.ts` and `index.ts` · default: `~/.adhd/agent-mcp/registry.db`
- **ADHD_AGENT_TRANSPORT** · read in `config.ts` · default: `"stdio"` · enum: stdio|http|sse
- **ADHD_AGENT_PORT** · read in `config.ts` · default: `3000` · minimum: 1
- **ADHD_AGENT_SSE_PORT** · read in `config.ts` and `index.ts` · default: `3001` · minimum: 1
- **ADHD_AGENT_SSE_HOST** · read in `config.ts` and `index.ts` · default: `"127.0.0.1"`
- **ADHD_AGENT_SSE_BASE_URL** · read in `config.ts` · optional, description: "Public base URL for stream_url links"
- **ADHD_AGENT_CONFIG** · read in `config.ts` and `index.ts` · optional, path to plugin config
- **ADHD_AGENT_PLUGINS** · read in `config.ts` and `index.ts` · array (comma-separated), default: `[]`
- **ADHD_AGENT_OPENAI_SECRET**, **ADHD_AGENT_ANTHROPIC_SECRET**, **ADHD_AGENT_DEEPSEEK_SECRET** · read via `env.resolveEnvName()` in `getProviderConfig()` (config.ts) and `index.ts` · optional

### File/Directory Writes

- **SQLite DB**: `~/.adhd/agent-mcp/production/data/agents.db` (via `env.files.db` zero-config location; created if missing in `db/client.ts`)
  - WAL/journal sidecars: `-wal`, `-shm` files
  - **Kind**: `data` (agent sessions, tasks, events)
- **Registry DB**: `~/.adhd/agent-mcp/registry.db` (hardcoded default from `config.ts` line 120)
  - WAL/journal sidecars: `-wal`, `-shm` files
  - **Kind**: `data` (agent definitions, compiler metadata)

### Configuration Files

- Plugin config path: via `ADHD_AGENT_CONFIG` env var (optional, path to external plugin config file)

### Scope Resolution

- Constructor: `new Environment<AgentMcpConfig>("agent-mcp", agentMcpEnvironmentSpec, { namespace: "production" })` (config.ts line 250)
- Cascades: code default → system → global `~/.adhd` → project `.adhd` → local `*.local` → env var
- Zero-config: all FieldSpecs have defaults; runs with zero files on disk if env vars are unset
- `envPrefixOverride: "ADHD_AGENT"` preserves pre-redesign surface byte-for-byte (not the inferred `ADHD_AGENT_MCP`)

---

## Proposed EnvironmentSpec (Already Implemented)

The package defines and exports its spec in `src/config.ts` (lines 59–161):

```typescript
export const agentMcpEnvironmentSpec: EnvironmentSpec<AgentMcpConfig> = {
  envPrefixOverride: "ADHD_AGENT",
  namespaces: ["production"],
  dirs: {
    data: { kind: "data" },
  },
  files: {
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
```

Interface `AgentMcpConfig` (lines 32–47) reflects all cascaded values with complete type safety.

---

## Gap Detail

**No gaps.** The package's configuration surface is fully expressible by `@adhd/environment` and already uses it.

The provider-credential env vars (`ADHD_AGENT_OPENAI_SECRET`, etc.) are guarded by `env.isEnvNameAllowed()` (a prefix check) and resolved via `env.resolveEnvName()` — they are NOT explicit config fields but are intentionally passed through to allow agent definitions to reference provider credentials. This design is documented in config.ts §1.

---

## Runtime-Necessity Assessment (`at:'build'` vs `at:'runtime'`)

> **Terminology, because "build" misleads:** in `@adhd/environment`, `at:'build'` means *resolved once at `Environment` construction (process start), then frozen* — **not** compile/bundle time. Deploy-time env vars ARE honored under `build` (construction runs after the process boots). `at:'runtime'` differs only by *re-reading live `process.env` on every access* (ARCHITECTURE.md §"Runtime-vs-build proof"; `environment-base-spec/src/index.ts:127`). The test for `runtime` is a real read site that (a) executes more than once per process AND (b) must observe an env change made *after* construction.

The shipped `config.ts` declares **no `at:` on any field**, so all default to `at:'build'`. Independently applying the rule (not transcribing source) confirms this is **correct**, field by field:

| Field | Read site | Re-read after boot? | Correct `at:` |
|---|---|---|---|
| `transport.kind`, `transport.port`, `sse.*` | `index.ts` server bootstrap, once | no | `build` ✓ |
| `db.path`, `server.registryDbPath` | DB connection open, once | no | `build` ✓ |
| `queue.concurrency`, `server.max*`, `server.defaultMaxTokens`, `server.contextLimit` | `toEngineConfig()` at startup | no | `build` ✓ |
| `server.allowedAgents` | allowlist check, evaluated from resolved config | no | `build` ✓ |
| `plugins.configPath`, **`plugins.entries`** | **`index.ts:149` `loadExternalPlugins(...)`, exactly once at boot** | no (plugins are not hot-reloaded) | `build` ✓ |
| `logging.level` | `logger.ts` at logger construction | no (Pino level fixed at construction today) | `build` ✓ (see note) |

**`ADHD_AGENT_PLUGINS` specifically:** correctly `build`. It is read once at `index.ts:149` to load external plugins at startup; there is no code path that re-reads it, and the loaded plugin set is not mutated live. A deploy-time value is fully honored (construction happens after boot). Marking it `at:'runtime'` would change nothing observable — no consumer re-reads it.

**The one honest nuance:** `logging.level` is the only field where a *runtime* variant would be meaningful — a long-running server could want to change log verbosity without restart. Today the Pino logger fixes its level at construction (no live re-read), so `build` matches the actual code. If a future feature adds live log-level toggling, that field (and only that one) would move to `at:'runtime'`. This is a latent enhancement, not a current defect — filed as friction item 5 below.

**Provider secrets are already effectively runtime, and correctly so:** `ADHD_AGENT_*_SECRET` are resolved via `env.resolveEnvName()` on **each** `getProviderConfig()` call (config.ts:205–228), i.e. live-resolved per invocation — the `secret:true` semantics — rather than frozen config fields. This is the right model for rotating credentials and is why they are deliberately outside the `config` block.

**Verdict:** for agent-mcp, `at:'build'`-everything is not an unexamined default — it is the correct classification given the read sites. The only reclassification the code could ever warrant is `logging.level → at:'runtime'`, and only after live-toggle support is added.

---

## Logging Audit

- **Logs emitted**: Yes (via Pino)
- **Logger used**: Pino (JSON-structured, level-configurable via `ADHD_AGENT_LOG_LEVEL` env var)
- **Persisted to disk**: No — logs are emitted to stderr only (`pino.destination(2)` in `logger.ts`)
- **Structured**: Yes (JSON format; each log is a complete JSON object)
- **Error handling**: Robust
  - Global uncaught exception handler (index.ts line 86–89)
  - Global unhandled rejection handler (index.ts line 91–94)
  - Startup env-ref verification with warning logging for missing/disallowed credentials (index.ts `verifyAgentEnvRefs()`)
  - Failure modes logged at `warn`/`info`/`fatal` levels with structured payloads
- **Would benefit from env.paths.logs**: Yes. If persistent logs are needed, `env.paths.logs` (kind:`logs`, `share:'per-instance'`) would provide a per-instance isolated log directory under `~/.adhd/agent-mcp/production/logs/`. Currently all instances share stderr.

---

---

## File-Location Table — Current vs. @adhd/environment Standard

| Current Path | Kind | New-Standard Path (Global Scope) | New-Standard Path (Project Scope) | Env Accessor |
|---|---|---|---|---|
| `~/.adhd/agent-mcp/production/data/agents.db` | data | `~/.adhd/agent-mcp/production/data/agents.db` | `.adhd/agent-mcp/production/data/agents.db` | `env.files.db` |
| `~/.adhd/agent-mcp/registry.db` | data | `~/.adhd/agent-mcp/production/data/registry.db` | `.adhd/agent-mcp/production/data/registry.db` | Could be `env.files.registryDb` if added to spec |
| (stderr) | logs | `~/.adhd/agent-mcp/production/logs/agent-mcp.log` | `.adhd/agent-mcp/production/logs/agent-mcp.log` | `env.paths.logs` (future) |

**Project-scope variant** (when active scope is `project` via `.git`/`.adhd` marker or `ADHD_ENV_SCOPE=project`): Same subtrees rooted at `.adhd/agent-mcp/production/` in the project directory, not `~/.adhd`.

**Note on registry.db**: The registry DB is currently hardcoded to `~/.adhd/agent-mcp/registry.db` (a global, shared location independent of the `production` namespace). A future refactor could move it to `env.paths.data/registry.db` under the namespace cascade to support per-namespace registries; however, this is intentionally separate today (per config.ts line 120 comment context).

---

## Residual Friction & Opportunities

1. **Registry DB location**: Hardcoded to global `~/.adhd/agent-mcp/registry.db` rather than cascading. This is intentional (compiler metadata shared across all namespaces). No action needed.

2. **Logging persistence**: Currently stderr-only. If audit/debug logs must be persisted, could add `env.paths.logs` to the spec and use it for optional file logging. Low priority.

3. **Plugin config path**: Via `ADHD_AGENT_CONFIG` env var, filesystem path is user-specified. Could be wrapped in a `files.pluginConfig` entry if a standard location is desired. Currently flexible by design.

4. **Provider secrets**: Intentionally NOT FieldSpec fields — they are agent-definition references guarded by the prefix allowlist. This avoids hardcoding a provider list in the core spec. Correct design; no change needed.

5. **Live log-level toggle** (`at:'runtime'` candidate): `logging.level` is fixed at logger construction. A long-running server could benefit from changing verbosity without a restart, which would move that single field to `at:'runtime'` and re-read on each log call. Latent enhancement, not a current defect. Low priority.

**Conclusion**: This is the reference consumer implementation. Full adoption achieved. No migration needed. Recommend studying this package as the model for other @adhd packages adopting `@adhd/environment`.
