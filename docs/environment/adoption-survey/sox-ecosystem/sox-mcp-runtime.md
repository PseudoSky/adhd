---
package: @adhd/sox-mcp-runtime
path: /Users/nix/dev/ai/sox-ecosystem/libs/mcp-runtime
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: mixed
env_vars: [SOX_PERM_ENFORCE, SOX_PERM_FS_READ, SOX_PERM_FS_WRITE, SOX_PERM_SOCKET, SOX_PERM_NETWORK, SOX_MCP_TRANSPORT, SOX_MCP_PORT, HOME]
writes: [{path: "~/.sox/sockets/<name>.sock", kind: "run", purpose: "UDS listen socket for MCP transport"}, {path: "process.stderr", kind: "logs", purpose: "diagnostic output"}]
config_files: []
logging:
  has_logging: true
  logger: console
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: false
  error_handling: adhoc
  maps_to_env_logs: true
supported_by_env: partial
gaps: [G1, G2]
value: med
effort: med
recommend: adopt-after-gap
---

## Current state

**Environment variables:**
- `SOX_PERM_ENFORCE` · enforce.ts:getPolicy() · read via compilePolicyFromEnv; gate for policy enforcement (default: false when absent)
- `SOX_PERM_FS_READ`, `SOX_PERM_FS_WRITE` · enforce.ts:checkFsAccess() · filesystem allowlist; injected by supervisor, no file default
- `SOX_PERM_SOCKET` · enforce.ts:checkSocketAccess() · socket allowlist; injected by supervisor, no file default
- `SOX_PERM_NETWORK` · enforce.ts:checkNetworkAccess() · network allowlist; injected by supervisor, no file default
- `SOX_MCP_TRANSPORT` · transport.ts:resolveTransportMode() · transport mode (stdio|uds|http|sse); priority: CLI flag > env > "stdio"
- `SOX_MCP_PORT` · transport.ts:connectStreamableHttp() · HTTP listen port; defaults to 3000
- `HOME` · serve.ts:resolveDefaultUdsPath() · home directory for socket path; fallback to /tmp if absent

**Writes:**
- `~/.sox/sockets/<name>.sock` · serve.ts:resolveDefaultUdsPath()+transport.ts:connectUds() · UDS socket created when uds transport selected; hardcoded home-relative path, sanitized server name
- process.stderr · serve.ts:serve() line 204 + transport.ts:connectUds() line 272 · diagnostic markers "[serve] real-path:" and "[mcp-runtime uds]" — no persistent log file created

**Config files:** None. Configuration is fully environment-variable and CLI-flag driven.

**Scope behavior:** Mixed. Home directory is hardcoded via `process.env['HOME']` lookup (no scope marker recognition). Transport mode, port, and enforcement gates are env-scoped under SOX_* prefix. CLI flag `--transport` overrides environment. No project/global scope marker (.git/.adhd) detection.

---

## Proposed `EnvironmentSpec`

```typescript
const specSoxMcpRuntime: EnvironmentSpec<{
  transport: 'stdio' | 'uds' | 'http' | 'sse';
  port: number;
  socketPath?: string;
  bindAddress: string;
  authToken?: string;
  permEnforce: boolean;
  permFsRead: string[];
  permFsWrite: string[];
  permSocket: string[];
  permNetwork: string[];
}> = {
  namespace: 'default',
  config: {
    transport: {
      type: 'string',
      enum: ['stdio', 'uds', 'http', 'sse'],
      default: 'stdio',
      env: 'SOX_MCP_TRANSPORT',
      at: 'runtime',
      description: 'Transport mode; also settable via --transport CLI flag (priority: flag > env)',
    },
    port: {
      type: 'integer',
      default: 3000,
      minimum: 1024,
      maximum: 65535,
      env: 'SOX_MCP_PORT',
      at: 'runtime',
    },
    socketPath: {
      type: 'string',
      env: 'SOX_MCP_SOCKET_PATH',
      at: 'runtime',
      description: 'Override default UDS socket path; defaults to env.paths.sockets/<name>.sock',
    },
    bindAddress: {
      type: 'string',
      default: '127.0.0.1',
      env: 'SOX_MCP_BIND_ADDRESS',
      at: 'runtime',
      description: 'HTTP bind address; defaults to loopback per CONTRACTS §I',
    },
    authToken: {
      type: 'string',
      env: 'SOX_MCP_AUTH_TOKEN',
      at: 'runtime',
      secret: true,
      description: 'Bearer token for HTTP requests; required if bindAddress is non-loopback',
    },
    permEnforce: {
      type: 'boolean',
      default: false,
      env: 'SOX_PERM_ENFORCE',
      at: 'runtime',
      description: 'Enable C6 policy enforcement on resource access',
    },
    permFsRead: {
      type: 'array',
      items: { type: 'string' },
      default: [],
      env: 'SOX_PERM_FS_READ',
      at: 'runtime',
    },
    permFsWrite: {
      type: 'array',
      items: { type: 'string' },
      default: [],
      env: 'SOX_PERM_FS_WRITE',
      at: 'runtime',
    },
    permSocket: {
      type: 'array',
      items: { type: 'string' },
      default: [],
      env: 'SOX_PERM_SOCKET',
      at: 'runtime',
    },
    permNetwork: {
      type: 'array',
      items: { type: 'string' },
      default: [],
      env: 'SOX_PERM_NETWORK',
      at: 'runtime',
    },
  },
  dirs: {
    sockets: {
      kind: 'run',
      share: 'per-instance',
      description: 'Unix Domain Socket directory for MCP server listener',
    },
    logs: {
      kind: 'logs',
      share: 'per-instance',
      description: 'Optional persistent log directory for diagnostic output',
    },
  },
  files: {},
  envPrefixOverride: 'SOX',
};
```

**Notes:**
- `SOX_PERM_*` vars are injected by the supervisor and are policy-environment-scoped; they do NOT map to the ADHD_ prefix model. Keeping the SOX prefix preserves supervisor injection semantics.
- `socketPath` and `bindAddress` are configurable but default to sensible targets (env.paths.sockets and 127.0.0.1 respectively).
- `dirs.logs` is optional; if provided, diagnostic output would be redirected to env.paths.logs.

---

## Gap detail

**G1** — `HOME` is a system environment variable read directly via `process.env['HOME']` (serve.ts:270). The @adhd/environment prefix model (`ADHD_SOX_MCP_*`) cannot guard non-ADHD_* names. The fallback `/tmp` is hardcoded. **Solution:** Either (a) add a `system` scope to @adhd/environment that reads HOME verbatim, or (b) use os.homedir() directly in a `home` reserved key in the EnvironmentSpec and resolve it without env-scoping.

**G2** — Writes to `~/.sox/sockets/<name>.sock` (hardcoded homedir-relative, serve.ts:270-271). Not under ~/.adhd scoping, not generated by env.paths. **Solution:** Migrate socket creation to use `env.paths.sockets + '/<name>.sock'` where dirs.sockets is scoped to the standard hierarchy (global or project-relative), falling back to ~/.sox/sockets/ only if explicitly configured via `dirs.sockets.location: 'legacy'` or similar.

---

## Logging audit

**Has logging:** Yes. Diagnostic output emitted to process.stderr.

**Logger mechanism:** Plain `process.stderr.write()` — no logger library (pino/winston/log4js/bunyan).

**Persists log files:** No. All output goes to stdout/stderr; no `.log` file is written to disk by the package itself.

**Log destination:** `process.stderr only`. Markers: `[serve] real-path: <dir>` (serve.ts:204), `[mcp-runtime uds] <line>` (transport.ts:272 via onDiagnostic callback in serveBackend).

**Structured:** No. Plaintext prefixed format. JSON or structured logging not used.

**Error handling:** Adhoc. Errors propagate as exceptions (e.g., validateBindAuth() throws when non-loopback bind lacks auth token; transport layer errors bubble to caller). No try/catch wrapping that logs errors before rethrowing. Handler errors caught inside callTool (serve.ts:150-163) and returned as isError results, but no error logging to persistent storage.

**Would benefit from `env.paths.logs`:** Yes. A persistent `env.paths.logs` (kind: `logs`, share: `per-instance`) destination would allow:
- Diagnostic output to be written to disk for post-mortem analysis.
- Concurrent instances (multi-uds, multi-http) to log without stdout/stderr collision.
- Log rotation and archival separate from application output.
- Structured error logging (JSON + timestamp) if a pino/winston wrapper is added.

Currently, all diagnostics go to stderr, which is acceptable for stdio mode but limits observability for detached uds/http servers running in the background. A config flag like `enableFileLogging: boolean` with optional `logFilePath` would be valuable.

**Recommendation:** Add optional `env.files.logFile` (in: `dirs.logs`, name: `runtime.log`), and provide a wrapper function for diagnostic output that tees to both stderr (for real-time) and logFile (for persistence) when enabled.

---

## File-location table — corrected to the new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| `~/.sox/sockets/<name>.sock` | run | `~/.adhd/sox-mcp-runtime/default/run/<name>.sock` | `env.paths.sockets/<name>.sock` |
| process.stderr (diagnostic output) | logs | `~/.adhd/sox-mcp-runtime/default/logs/runtime.log` | `env.files.logFile` or `env.paths.logs/runtime.log` |
| `process.env.HOME` | (system) | (no standard — G1 blocker) | (blocked by lack of system scope) |

**Project-scope variant:** When `ADHD_ENV_SCOPE=project` or `.adhd` marker is detected, the paths resolve to `<projectRoot>/.adhd/sox-mcp-runtime/default/<kind>/…` instead of global `~/.adhd/…`.

**Example:** In project scope, the socket becomes `<projectRoot>/.adhd/sox-mcp-runtime/default/run/<name>.sock`, accessed via `env.paths.sockets/<name>.sock` (the accessor is identical; scope is transparent to the package).
