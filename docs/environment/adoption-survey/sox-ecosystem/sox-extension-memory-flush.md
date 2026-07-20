---
package: @adhd/sox-extension-memory-flush
path: /Users/nix/dev/ai/sox-ecosystem/extensions/bundles/sox-memory-bundle/members/memory-flush
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: none
env_vars: []
writes: [{path: "export_dir (runtime payload)", kind: data, purpose: "markdown export mirror via memCoreExportMarkdown"}, {path: "db_path (runtime payload, SQLite)", kind: data, purpose: "session/episode storage + WAL artifacts"}]
config_files: []
logging:
  has_logging: true
  logger: console
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: false
  error_handling: robust
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G8]
value: low
effort: med
recommend: skip
---

## Current State

**Package type:** Hook handler (not a daemon). Binds two host events: `SessionEnd` and `ScopePromotionProposed`. Stateless; all state is in the database or payloads.

**Configuration delivery:** Runtime-injected via two mechanisms:
- `setExportConfig(cfg: ExportConfig | null)` — module-level override for tests.
- `SessionEndPayload.export_config` — per-event config passed by host at SessionEnd dispatch.

Priority: module override > payload > code defaults.

**Env vars:** None read.

**Writes:**
- Markdown files: written to `export_dir` (from payload) via `memCoreExportMarkdown()` — gated: only if `export_enabled=true` AND `export_dir` is non-empty; throttled to at most once per `export_throttle_secs` (default 60s).
- SQLite database: `db_path` (from payload), opened via `better-sqlite3` + `sqlite-vec`. Creates `*.db`, `*.db-wal` (write-ahead log), `*.db-shm` (shared memory lock file).

**Scope:** Not applicable. This is a stateless event handler. No hardcoded paths, no `cwd`-relative, no `os.homedir()`. All paths come pre-resolved from payloads.

## Proposed `EnvironmentSpec`

Not recommended. This handler is designed to receive config via runtime payloads from its parent (sox-memory-server). An `EnvironmentSpec` would be appropriate only if:
1. The parent (sox-memory-server) adopts `@adhd/environment`, and
2. sox-memory-server resolves export_dir + db_path via environment, then passes those to memory-flush via payload.

If needed for testing or standalone operation, the spec would be:

```typescript
type MemoryFlushConfig = {
  exportEnabled: boolean;
  exportDir: string;
  exportThrottleSecs: number;
};

const spec: EnvironmentSpec<MemoryFlushConfig> = {
  config: {
    exportEnabled: {
      type: 'boolean',
      default: false,
      at: 'runtime',
      env: 'ADHD_MEMORY_FLUSH_EXPORT_ENABLED',
    },
    exportDir: {
      type: 'string',
      default: '',
      at: 'runtime',
      env: 'ADHD_MEMORY_FLUSH_EXPORT_DIR',
    },
    exportThrottleSecs: {
      type: 'integer',
      default: 60,
      minimum: 0,
      at: 'runtime',
      env: 'ADHD_MEMORY_FLUSH_EXPORT_THROTTLE_SECS',
    },
  },
  dirs: {
    exportDir: {
      kind: 'data',
      share: 'per-instance',
    },
  },
};
```

## Gap Detail

- **G8**: SQLite creates `.db-wal` (write-ahead log) and `.db-shm` (shared memory) sidecar files alongside the main database. These are engine-specific locking/journaling artifacts, not one of the seven standard directory kinds. @adhd/environment does not wrap SQLite-specific files.

## Logging Audit

**Has logging:** Yes. Emits to `console.log()` and `console.error()` with `[memory-flush]` prefix.

**Logger mechanism:** Console (no structured logging library).

**Persists log files:** No. Output goes to stdout/stderr only. Parent process (sox-memory-server) captures and routes it.

**Structured:** No. Plaintext. Example: `[memory-flush] auto-export complete: 5 nodes written, 2 topics → /path/to/dir`

**Error handling:** Robust.
- SessionEnd export failure: caught, logged, never re-thrown (fail-isolated by design).
- ScopePromotionProposed handler errors: caught, logged.
- Both wrap their work in try/catch; handler itself never re-throws.
- Database open failures are caught and return early.

**Maps to env.paths.logs:** No. This handler does not own a log destination. Console output is captured by the parent's logging setup, not by memory-flush directly. If sox-memory-server later adopts `@adhd/environment` and centralizes logging, memory-flush's console output would flow to that destination via the parent's own logging configuration.

## File-location Table

| Current Path | Kind | New-standard Path (global scope) | Env Accessor |
|---|---|---|---|
| `export_dir` (payload param) | data | `~/.adhd/sox-memory-core/default/data/markdown-export/` | `env.paths.data` (if parent adopts env) |
| `db_path` (payload param, SQLite) | data | `~/.adhd/sox-memory-core/default/data/memory.db` | `env.files.memoryDb` or `env.paths.data/memory.db` |
| `*.db-wal`, `*.db-shm` | (sqlite-internal) | same parent dir as `db_path` + suffixes | (managed by sqlite, not configurable) |

**Project-scope variant:** When scope is `project`, replace `~/.adhd/` with `<projectRoot>/.adhd/`:
- Global: `~/.adhd/sox-memory-core/default/data/memory.db`
- Project: `<projectRoot>/.adhd/sox-memory-core/default/data/memory.db`

**Note:** Today memory-flush receives paths via payload; it assumes nothing about their location. If the parent sox-memory-server adopts `@adhd/environment`, the parent would resolve paths and pass them to memory-flush. Memory-flush itself does not need @adhd/environment.
