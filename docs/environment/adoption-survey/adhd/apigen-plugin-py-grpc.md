---
package: @adhd/apigen-plugin-py-grpc
path: /Users/nix/dev/node/adhd/packages/apigen/apigen-plugin-py-grpc
root: adhd
language: node
self_internal: false
current_scope_behavior: none
env_vars: []
writes: []
config_files: []
logging:
  has_logging: true
  logger: console
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: partial
  error_handling: robust
  maps_to_env_logs: false
supported_by_env: no
gaps: [G1]
value: low
effort: low
recommend: skip
---

## Current state

**Environment variables:**
None read directly by this plugin. The plugin passes `process.env` verbatim to the spawned Python subprocess (line 149); the subprocess may require non-ADHD_* environment variables like `PYTHONPATH` or `HOME`, but those are subprocess concerns, not managed by this plugin.

**Writes:**
None. The plugin is stateless and performs no file I/O. The spawned Python gRPC server handles all network I/O.

**Config files:**
None. Configuration is provided via CLI options (`input.options`, lines 109–120) with hardcoded defaults:
- `port` (default 50051) · read line 109
- `host` (default 127.0.0.1) · read line 110
- `namespace` (fallback pkg.id) · read line 120

These options are forwarded as command-line arguments to the spawned subprocess; there is no environment variable or file-based config override mechanism.

## Proposed `EnvironmentSpec`

```typescript
// Not recommended for adoption at this layer. This plugin is a stateless subprocess wrapper;
// configuration ownership belongs in the spawned apigen_python.grpc_server if needed.
// If adoption were considered, the spec would be:

const pyGrpcPluginConfig = {
  port: { type: 'number', default: 50051, minimum: 1, maximum: 65535 },
  host: { type: 'string', default: '127.0.0.1' },
  namespace: { type: 'string' },
} as const;

// However, since this plugin is a thin orchestration layer with no persistent state,
// adoption is not justified. The cascade (code default only) is already optimal.
```

## Gap detail

**G1:** The plugin passes `process.env` to the subprocess (line 149), which may require non-ADHD_* environment variables (e.g., `PYTHONPATH`, `HOME`, `GRPC_VERBOSITY`). These cannot be expressed in an @adhd/environment spec with the prefix model — they would bypass the cascade entirely. The subprocess's env-var dependencies are outside the scope of this plugin's configuration.

## Logging audit

**Has logging:** Yes. The plugin forwards stderr from the Python subprocess to `process.stderr` (lines 156–158).
**Logger:** Console (native Node `process.stderr` stream).
**Persists log files:** No. All output is stdio-only; no `.log` files are written to disk.
**Log destination:** stdout/stderr only. Logs from the Python server appear in the parent terminal/CI output but are not persisted.
**Structured:** Partial. The Python server emits a JSON readiness signal (`{"ready":true}`, parsed lines 84–88); other logs from the server are plaintext pass-through.
**Error handling:** Robust. The `waitForReady` function uses try/catch (line 84) to parse JSON, sets a 10-second timeout (line 76), and rejects on subprocess exit (lines 94–100). The main `run` function handles abort signals (lines 175–179) and rejects on non-zero exit codes (line 171).
**Maps to `env.paths.logs`:** No. This plugin has no persistent logging to manage. The Python subprocess (`apigen_python.grpc_server`) would be responsible for its own log output if it ever adopts @adhd/environment.

## File-location table — corrected to the new standard

This plugin writes no files and manages no directories. No paths to remap.

| Current path | Kind | New-standard path (global scope) | env accessor |
|---|---|---|---|
| N/A | N/A | N/A | N/A |

**Project-scope variant:** Not applicable; no files or directories are managed by this plugin.
