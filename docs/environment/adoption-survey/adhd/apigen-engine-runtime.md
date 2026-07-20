---
package: "@adhd/apigen-engine-runtime"
path: "/Users/nix/dev/node/adhd/packages/apigen/apigen-engine-runtime"
root: adhd
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes: [{path: "opts.destination (file path)", kind: "logs", purpose: "pino logger output when destination is a file"}]
config_files: []
logging:
  has_logging: true
  logger: pino
  persists_log_files: true
  log_destination: "stderr by default, or user-provided file path"
  structured: partial
  error_handling: robust
  maps_to_env_logs: true
supported_by_env: full
gaps: []
value: high
effort: low
recommend: adopt
---

## Current state

**Environment variables:** None read directly. The logger accepts runtime-provided options (level, format, destination) and reads `process.stderr.isTTY` to auto-detect if output is a TTY (system property, not env var).

**Writes:**
- `/dev/stderr` (fd 2) by default, or any user-provided filesystem path.
- Directory creation: pino.destination with `mkdir: true` will create parent directories if writing to a new file path.

**Config files:** None. All configuration flows through the `CreateLoggerOptions` interface passed to `createLogger()`.

---

## Proposed `EnvironmentSpec`

```typescript
const spec: EnvironmentSpec<{
  log_level: string;
  log_format: 'json' | 'pretty' | 'auto';
}> = {
  config: {
    log_level: {
      type: 'string',
      default: 'info',
      env: 'LOG_LEVEL',
      at: 'runtime',
    },
    log_format: {
      type: 'string',
      default: 'auto',
      enum: ['json', 'pretty', 'auto'],
      env: 'LOG_FORMAT',
      at: 'runtime',
    },
  },
  dirs: {
    logs: { kind: 'logs' },
  },
  files: {
    log_file: {
      in: 'logs',
      name: 'runtime.log',
    },
  },
  share: 'per-instance',
};
```

---

## Gap detail

None. The package is fully expressible under `@adhd/environment`.

---

## Logging audit

The `createLogger()` function uses pino with the following behavior:

- **Logs:** Yes, comprehensive logging via pino.
- **Logger mechanism:** pino v10.3.1, configured with optional pino-pretty transport for human-readable output.
- **Persists log files:** Yes. When `opts.destination` is a string path, logs are written to disk. pino.destination with `mkdir: true` ensures parent directories exist.
- **Log destination:**
  - Default: stderr (fd 2). This preserves stdout for MCP JSON-RPC.
  - User-provided: any filesystem path via the `destination` parameter.
- **Structured:** Partial. Supports two formats:
  - `format: 'json'`: raw JSONL (structured), emitted to file or stderr.
  - `format: 'pretty'`: colorized, human-readable plaintext via pino-pretty. Colorization is disabled if writing to a file.
  - Default format: auto-detected from TTY status.
- **Error handling:** Robust. pino handles errors internally without crashing.
- **Maps to env.paths.logs:** Yes. This package would benefit from `env.paths.logs` (kind: `logs`, share: `per-instance`) to eliminate path construction and prevent collisions in concurrent instances.

---

## File-location table — corrected to the new standard

| current path | kind | new-standard path (global scope) | env accessor |
|---|---|---|---|
| stderr (fd 2) | logs | N/A (stdout/stderr are not managed by env) | N/A |
| user-provided string path | logs | `~/.adhd/apigen-engine-runtime/default/logs/runtime.log` | `env.files.log_file` or `env.paths.logs/runtime.log` |

**Project-scope variant:** `<projectRoot>/.adhd/apigen-engine-runtime/default/logs/…` when the active scope is `project` (auto-detected by `.git`/`.adhd` marker or `ADHD_ENV_SCOPE=project`).
