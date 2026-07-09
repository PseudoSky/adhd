# Reference: Current Entrypoint Config Patterns

How each ADHD entrypoint handles configuration today, and what moves to `@adhd/environment`.

## agent-mcp (the canonical config system)

**Source:** `entrypoint/agent-mcp/src/config.ts` (299 lines), `src/utils/load-env.ts` (9 lines)

### What it does now

1. `loadEnvHierarchy()` — loads 3-tier dotenv: `~/.adhd/.env` → `./.adhd/.env` → `./.env`
2. `rawFromEnv(env)` — reads every env var by explicit name (27 env vars mapped one-by-one)
3. `configSchema.parse(rawFromEnv(env))` — Zod validates + applies defaults
4. Returns a frozen `Config` object with typed accessors (`config.db.path`, `config.getProviderConfig(opts)`)

### Env vars used

| Config key | Env var | Default | Zod type |
|---|---|---|---|
| `db.path` | `ADHD_AGENT_DATABASE_PATH` | `~/.adhd/agent-mcp/agents.db` | `z.string()` |
| `logging.level` | `ADHD_AGENT_LOG_LEVEL` | `info` | `z.enum(LOG_LEVELS)` |
| `queue.concurrency` | `ADHD_AGENT_QUEUE_CONCURRENCY` | `5` | `z.coerce.number().int().positive()` |
| `server.maxDepth` | `ADHD_AGENT_MAX_DEPTH` | `5` | `z.coerce.number().int().positive()` |
| `server.maxToolLoops` | `ADHD_AGENT_MAX_TOOL_LOOPS` | `50` | `z.coerce.number().int().positive()` |
| `server.defaultMaxTokens` | `ADHD_AGENT_DEFAULT_MAX_TOKENS` | `8192` | `z.coerce.number().int().positive()` |
| `server.contextLimit` | `ADHD_AGENT_CONTEXT_LIMIT` | `0` | `z.coerce.number().int().nonnegative()` |
| `server.allowedAgents` | `ADHD_AGENT_ALLOWED_AGENTS` | — | comma-split → string[] |
| `server.registryDbPath` | `ADHD_AGENT_REGISTRY_DB_PATH` | `~/.adhd/agent-mcp/registry.db` | `z.string()` |
| `transport.kind` | `ADHD_AGENT_TRANSPORT` | `stdio` | `z.enum(["stdio","http"])` |
| `transport.port` | `ADHD_AGENT_PORT` | `3000` | `z.coerce.number().int().positive()` |
| `sse.port` | `ADHD_AGENT_SSE_PORT` | `3001` | `z.coerce.number().int().positive()` |
| `sse.host` | `ADHD_AGENT_SSE_HOST` | `127.0.0.1` | `z.string()` |
| `plugins.configPath` | `ADHD_AGENT_CONFIG` | — | `z.string().optional()` |
| `plugins.entries` | `ADHD_AGENT_PLUGINS` | — | comma-split → string[] |
| `security.envAllowlist` | `ADHD_AGENT_ENV_ALLOWLIST` | — | comma-split → string[] |

Plus provider credentials (not in config schema, resolved dynamically via `getProviderConfig()`):
| Provider | Secret Env Var | URL Env Var | Model Env Var |
|---|---|---|---|
| openai | `ADHD_AGENT_OPENAI_SECRET` | `ADHD_AGENT_OPENAI_BASE_URL` | `ADHD_AGENT_OPENAI_MODEL` |
| anthropic | `ADHD_AGENT_ANTHROPIC_SECRET` | `ADHD_AGENT_ANTHROPIC_BASE_URL` | `ADHD_AGENT_ANTHROPIC_MODEL` |
| deepseek | `ADHD_AGENT_DEEPSEEK_SECRET` | `ADHD_AGENT_DEEPSEEK_BASE_URL` | `ADHD_AGENT_DEEPSEEK_MODEL` |

### Directories
- `~/.adhd/agent-mcp/` — agents.db + registry.db (auto-created by DB client)
- No formal directory catalog — paths are resolved ad-hoc

### Problems with current approach
- Every env var is hardcoded by name — no inference, no prefix convention enforcement
- Zod schema + defaults are disconnected from env var names (duplication of `default` values)
- No provenance: can't tell where a value came from (env? default? which scope?)
- No scope cascade: one flat config with no org-level vs project-level distinction
- No snapshot: can't detect drift between runs
- Provider config is a separate code path from the Zod schema (dynamic lookup vs static validation)

---

## dispatch-cli

**Source:** `entrypoint/dispatch-cli/src/lib/core.ts`

### What it does now
- No config.ts, no `.env` loading
- One env var: `DISPATCH_E2E_LIVE` (test gate only)
- Calibration path: `~/.adhd/dispatch-calibration.json` (hardcoded constant)
- Debug dir: `tmp/dispatch-cli/run-debug/` (hardcoded constant)

### What moves to Environment
- `"calibration"` directory (state.data, global scope)
- `"run-debug"` directory (state.data, project scope)

---

## apigen-cli

**Source:** `entrypoint/apigen-cli/src/lib/logging.ts`

### What it does now
- Three env vars: `APIGEN_LOG_LEVEL`, `APIGEN_LOG_FORMAT`, `APIGEN_LOG_FILE`
- No `.env` loading — reads `process.env` directly
- No directories — output paths are user-specified CLI args

### What moves to Environment
- Log level/defaults as system-scoped field definitions

---

## agent-engine-compiler

**Source:** `packages/agent/agent-engine-compiler/src/db/client.ts`, `src/cli/compile.ts`

### What it does now
- Three-env-var cascade: `AGENT_REGISTRY_DB` → `REGISTRY_DATABASE_PATH` → `DATABASE_PATH` → `./data/registry.db`
- CLI has `--db` flag that overrides
- No `.env` loading — reads `process.env` directly
- DB path auto-creates parent directories

### What moves to Environment
- `"registry"` directory (state.data, global scope)
- DB path field with scope cascade: system default (`./data/registry.db`) → global (`~/.adhd/compiler/registry.db`) → project

---

## decompile-cli

**Source:** `entrypoint/decompile-cli/`

### What it does now
- No config, no env vars (one commented-out `process.env.PROJECT` reference)
- Build output to `build/` directory (user-specified)

### What moves to Environment
- `"build"` directory (state.data, project scope)

---

## Builder vs Runtime Client Split

This addresses the architectural issue: the current SPEC conflates config resolution (build-time) with config access (runtime).

### EnvironmentBuilder (build/initialize time)
```ts
const builder = new EnvironmentBuilder({
  project: { name: "agent-mcp" },
  namespace: "production",
  dirs: [ /* directory entries */ ],
  config: {
    system:  { /* framework defaults */ },
    global:  { /* org-wide overrides */ },
    project: { /* project-specific overrides */ },
  },
});

// Does everything heavy:
// 1. Load .env files (configurable hierarchy)
// 2. Merge field definitions (system → global → project)
// 3. Resolve config values (env vars → defaults, interpolate ${VAR})
// 4. Generate fieldSchema from merged definitions
// 5. Validate resolved config against fieldSchema
// 6. Compute contentHash + structureHash
// 7. Track provenance
// 8. Ensure directories exist
// 9. Atomic write snapshot
const snapshot = builder.initialize();
```

### Environment (runtime — reads snapshot only)
```ts
const env = new Environment({
  project: "agent-mcp",
  namespace: "production",        // defaults to "default"
  adhdRoot: "~/.adhd",           // override for testing
});

// Reads ~/.adhd/agent-mcp/production/adhd-environment.json
// Exposes typed access to everything in the snapshot:

env.project          // { name: "agent-mcp", description: "..." }
env.config.db.path   // "/Users/nix/.adhd/agent-mcp/production/data/primary/"
env.config.transport.port // 3000  (real numeric port field — see the "Env vars used" table above; there is no server.port)
env.dirs.path("state.data")              // → "~/.adhd/agent-mcp/production/data/primary/"
env.dirs.path("state.data", "registry")  // → "~/.adhd/agent-mcp/production/data/registry/"
env.dirs.path("runtime.log")             // → "./adhd/log/"
env.provenance["db.path"]   // { source: "project.default", scope: "project" }
env.envPrefix               // "ADHD_AGENT_"  (agent-mcp sets envPrefixOverride: ADHD_AGENT — the namespace is NOT folded into the prefix, preserving the deployed ADHD_AGENT_* names)
env.configHash              // "sha256-..."
env.structureHash           // "sha256-..."

// No initialize(), no ajv, no .env loading, no field merge.
// Just reads JSON. ~30 lines of code.
```

### What the runtime client does NOT do
- Does not load `.env` files
- Does not resolve config — values are already resolved in the snapshot
- Does not validate against fieldSchema — validation happened at build time
- Does not create directories — directories were created at build time
- Does not generate fieldSchema
- Does not track provenance
- Does not write anything to disk

### When the builder runs
- First install: `adhd-env init --project-name agent-mcp`
- Config change: `adhd-env doctor` or `adhd-env config-set` triggers rebuild
- CI: `adhd-env verify` compares runtime snapshot against expected
