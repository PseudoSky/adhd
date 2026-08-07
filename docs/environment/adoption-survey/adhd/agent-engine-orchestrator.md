---
package: "@adhd/agent-engine-orchestrator"
path: "/Users/nix/dev/node/adhd/packages/agent/agent-engine-orchestrator"
root: adhd
language: node
self_internal: false
current_scope_behavior: tmpdir
env_vars: [process.env, ADHD_AGENT_ANTHROPIC_SECRET]
writes: [{path: "tmpdir()/agent-mcp-claudecli-*.json", kind: "temp", purpose: "MCP server config for Claude CLI subprocess"}, {path: "tmpdir()/agent-mcp-spec-*", kind: "temp", purpose: "Agent spec directory for Claude CLI agent mode"}]
config_files: []
logging:
  has_logging: true
  logger: custom
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: false
  error_handling: robust
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G1, G2]
value: med
effort: low
recommend: adopt-after-gap
---

## Current state

**Env vars:**
- `process.env` (passthrough): Full environment passed to Claude CLI subprocess via `buildSubprocessEnv()` (claudecli.ts:192–200). All vars are copied directly without filtering.
- `ADHD_AGENT_ANTHROPIC_SECRET`: Referenced in error fallback message (claudecli.ts:413) as an example location for Anthropic credentials.
- `ADHD_AGENT_*`: Prefix-scoped vars injected via `config.subprocessEnv()` (claudecli.ts:197–198), determined by host's EngineConfig implementation.

**Writes:**
- `tmpdir()/agent-mcp-claudecli-${Date.now()}.json` · kind: temp · MCP server configuration written as JSON before spawning claude CLI subprocess. Created by `writeMcpConfigFile()` (claudecli.ts:228–230). Cleaned up in finally block (claudecli.ts:432–433).
- `tmpdir()/agent-mcp-spec-*` · kind: temp · Ephemeral directory containing `.claude/agents/<name>.md` agent spec. Created by `writeAgentSpecDir()` (claudecli.ts:233–241). Cleaned up in finally block (claudecli.ts:435–436).

**Config files:**
None. Configuration is injected via constructor parameters (EngineConfig, logger, MCP servers map). No persistent config files are read from disk. The engine interfaces are intentionally singleton-free.

**Scope/path logic:**
- All ephemeral writes use `os.tmpdir()` (system temp directory) for isolation.
- No hardcoded absolute paths (other than tmpdir).
- No cwd-relative or home-relative paths.
- EngineConfig interface declares `resolveEnvName()` and `isEnvNameAllowed()` methods (interfaces.ts:57–63), but claudecli.ts reads `process.env` directly (claudecli.ts:192–196), bypassing the allowlist check.

## Proposed `EnvironmentSpec`

```typescript
export const orchestratorSpec: EnvironmentSpec<OrchestratorConfig> = {
  config: {
    server: {
      contextLimit: {
        type: 'integer',
        default: 100000,
        description: 'Estimated token limit for message window',
        minimum: 0,
      },
      defaultMaxTokens: {
        type: 'integer',
        default: 4096,
        description: 'Default max_tokens for providers',
        minimum: 1,
      },
    },
    queue: {
      concurrency: {
        type: 'integer',
        default: 10,
        description: 'Max concurrent background tasks',
        minimum: 1,
        env: 'QUEUE_CONCURRENCY',
        at: 'runtime',
      },
    },
    sse: {
      baseUrl: {
        type: 'string',
        default: 'http://localhost:3000',
        description: 'Public base URL for stream_url links',
        env: 'SSE_BASE_URL',
        at: 'runtime',
      },
    },
    plugins: {
      configPath: {
        type: 'string',
        optional: true,
        description: 'Explicit path to agent-mcp config file',
        env: 'PLUGINS_CONFIG_PATH',
        at: 'runtime',
      },
      entries: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Comma-separated plugin entry paths',
        env: 'PLUGINS_ENTRIES',
        at: 'runtime',
      },
    },
    claudecli: {
      claudePath: {
        type: 'string',
        default: 'claude',
        description: 'Path to claude CLI binary',
      },
      model: {
        type: 'string',
        optional: true,
        env: 'CLAUDE_MODEL',
        at: 'runtime',
      },
      systemPromptIsAgentSpec: {
        type: 'boolean',
        default: false,
      },
      allowedBuiltinTools: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        at: 'runtime',
      },
    },
  },
  dirs: {
    temp: {
      kind: 'temp',
      description: 'Temporary files for MCP config and agent specs',
    },
  },
  envPrefixOverride: 'ADHD_AGENT_ORCHESTRATOR',
  share: {
    temp: 'per-instance',
  },
};
```

## Gap detail

- **G1**: `process.env` read directly in claudecli.ts:192–200 without filtering through `EngineConfig.isEnvNameAllowed()`. The code copies all environment variables into the subprocess without prefix or allowlist validation. Mitigation: the subprocess (Claude CLI) is already sandboxed, but the pattern does not follow the env prefix model and should be enforced.
- **G2**: Hardcoded `os.tmpdir()` for ephemeral writes. Environment does not support generic temp-directory scoping; the current design is outside `@adhd/environment` scope. Mitigation: moving to `env.paths.temp` would ensure per-instance isolation and cleanup coordination with `nx reset`.

## Logging audit

The package defines an injectable `EngineLogger` interface (interfaces.ts:72–77) with methods `info()`, `warn()`, `error()`, `debug()`. The logger is optional; if not supplied, a no-op default is used (dag-engine.ts:45, prompt-resolver.ts:57, usage-plugin.ts:53).

**Logging behavior by file:**
- **dag-engine.ts**: Logs info-level messages on task dispatch and cycle detection (lines 116–119, 156–159). Structured payloads with task IDs and status context.
- **prompt-resolver.ts**: Logs debug-level on cache hits/misses (lines 64–71), info-level on composition completion (line 105–108). Structured payloads with `agentSlug`, `composedPromptId`, compilation errors.
- **usage-plugin.ts**: Logs errors on handler failures (lines 83, 168, 195). Error context includes exception object.
- **claudecli.ts**: Logs warnings on tool config conflicts (lines 281–285). Errors are thrown as ToolError exceptions, not logged.

**Has logging?** Yes. **Logger mechanism?** Custom injected interface (not pino, winston, or console directly). **Persists log files?** No. **Log destination?** Depends on host logger implementation — package does not write logs to disk. **Structured?** Partially — payloads are objects passed to logger, serialization is host's responsibility. **Error handling?** Robust — try-catch blocks in handlers (usage-plugin.ts), error propagation via exceptions (claudecli.ts).

**Would benefit from `env.paths.logs`?** No. The package is a library, not a daemon or service. Its logs are ephemeral and contextual to request handling. Persistent logging is the host's responsibility (the entrypoint that constructs the logger). If the host wants to add persistent logging, it passes a logger that targets a file or sink; that logic belongs outside this package.

## File-location table — corrected to the new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| `tmpdir()/agent-mcp-claudecli-*.json` | temp | `~/.adhd/agent-engine-orchestrator/default/temp/mcp-config-<timestamp>.json` | `env.paths.temp/<filename>` |
| `tmpdir()/agent-mcp-spec-*/.claude/agents/*.md` | temp | `~/.adhd/agent-engine-orchestrator/default/temp/agent-spec-<timestamp>` | `env.paths.temp/<dirname>` |

**Project-scope variant:** The same paths rooted at `<projectRoot>/.adhd/agent-engine-orchestrator/default/temp/…` when `ADHD_ENV_SCOPE=project` is set (auto-detected by `.git`/`.adhd` marker).

Note: Temp files are subprocess-local and cleaned up in finally blocks. Moving to `env.paths.temp` would eliminate timestamp-based uniqueness (directory isolation is automatic) and ensure cleanup under `nx reset` or equivalent cache-clear operations.

