---
package: @adhd/sox-memory-core
path: /Users/nix/dev/ai/sox-ecosystem/libs/memory-core
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes:
  - path: ~/.memory/**
    kind: data
    purpose: SQLite database files and backup copies
  - path: WAL sidecar files (-wal, -shm)
    kind: state
    purpose: SQLite write-ahead log and shared memory
  - path: parent directories of db_path
    kind: data
    purpose: ensure destination parent exists before VACUUM INTO
config_files: []
logging:
  has_logging: true
  logger: custom
  persists_log_files: false
  log_destination: stdout/stderr only
  structured: false
  error_handling: adhoc
  maps_to_env_logs: true
supported_by_env: partial
gaps:
  - G2
value: high
effort: med
recommend: adopt-after-gap
---

## Current state

### Environment variables
None read. Database paths are expanded via `expandDbPath()` which resolves `~` to `os.homedir()`.

### File writes
- **`~/.memory/**`** (backup.ts) — destination for VACUUM INTO backups; allowlist enforced at entry point, permits any subpath under `~/.memory`. Parent directory created via `fs.mkdirSync(..., { recursive: true })`.
- **Database file** (db.ts `openDb()`) — SQLite file at expanded `dbPath`, plus WAL sidecar (`-wal`, `-shm`) if journal_mode=WAL. Parent directory created implicitly.
- **No log files** — logging output goes only to the provided `opts.log` callback or console.error; no persistent logs.

### Config files
None. All configuration is hardcoded or passed via function arguments:
- Compaction interval: `DEFAULT_COMPACTION_INTERVAL_MS = 5 * 60 * 1000` (5 min).
- Backup allowlist: `~/.memory/**` hardcoded.
- Pragmas and schema: inlined in `schema.js`, DDL applied idempotent on every open.

### Path decisions
1. **Database path** (`db.ts`): caller passes `dbPath` string (e.g., `~/.memory/memory.db`). At every file-create sink (openDb, openDbReadOnly), `expandDbPath()` resolves `~` to `os.homedir()`.
2. **Backup destination** (`backup.ts`): caller passes `destPath`. Both source and dest must be inside `~/.memory/**` allowlist; any path outside triggers E_ALLOWLIST.
3. **Scope** (db.ts `initScope()`): hardcoded scope kinds (project | user | org | local) but database row is stamped at open-for-write, never re-read from config.

---

## Proposed `EnvironmentSpec`

```typescript
interface SoxMemoryCoreConfig {
  // Database file path (default: ~/.memory/memory.db)
  db_path: { type: 'string'; default: '~/.memory/memory.db'; env: 'ADHD_SOX_MEMORY_CORE_DB_PATH' };
  
  // Backup destination directory (default uses env.paths.data)
  backup_dir: { type: 'string'; default: null; env: 'ADHD_SOX_MEMORY_CORE_BACKUP_DIR'; kind: 'data' };
  
  // Compaction interval in milliseconds
  compaction_interval_ms: { type: 'integer'; default: 300000; minimum: 10000; env: 'ADHD_SOX_MEMORY_CORE_COMPACTION_INTERVAL_MS' };
  
  // Enable PRAGMA optimize before ANALYZE
  run_optimize: { type: 'boolean'; default: true; env: 'ADHD_SOX_MEMORY_CORE_RUN_OPTIMIZE' };
  
  // Skip integrity_check on backup (not recommended for production)
  skip_integrity_check: { type: 'boolean'; default: false; env: 'ADHD_SOX_MEMORY_CORE_SKIP_INTEGRITY_CHECK'; secret: false };
  
  // Scope kind for the database
  scope: { type: 'string'; enum: ['project', 'user', 'org', 'local']; default: 'user'; env: 'ADHD_SOX_MEMORY_CORE_SCOPE' };
  
  // Scope ID (e.g., user UUID, org slug)
  scope_id: { type: 'string'; default: 'default'; env: 'ADHD_SOX_MEMORY_CORE_SCOPE_ID' };
}

const spec: EnvironmentSpec<SoxMemoryCoreConfig> = {
  config: {
    db_path: {
      type: 'string',
      default: '~/.memory/memory.db',
      env: 'ADHD_SOX_MEMORY_CORE_DB_PATH',
    },
    backup_dir: {
      type: 'string',
      env: 'ADHD_SOX_MEMORY_CORE_BACKUP_DIR',
    },
    compaction_interval_ms: {
      type: 'integer',
      default: 300000,
      minimum: 10000,
      env: 'ADHD_SOX_MEMORY_CORE_COMPACTION_INTERVAL_MS',
    },
    run_optimize: {
      type: 'boolean',
      default: true,
      env: 'ADHD_SOX_MEMORY_CORE_RUN_OPTIMIZE',
    },
    skip_integrity_check: {
      type: 'boolean',
      default: false,
      env: 'ADHD_SOX_MEMORY_CORE_SKIP_INTEGRITY_CHECK',
    },
    scope: {
      type: 'string',
      enum: ['project', 'user', 'org', 'local'],
      default: 'user',
      env: 'ADHD_SOX_MEMORY_CORE_SCOPE',
    },
    scope_id: {
      type: 'string',
      default: 'default',
      env: 'ADHD_SOX_MEMORY_CORE_SCOPE_ID',
    },
  },
  dirs: {
    data: { kind: 'data', share: 'per-instance' },
    logs: { kind: 'logs', share: 'per-instance' },
  },
  files: {
    db: { in: 'data', name: 'memory.db' },
    backup: { in: 'data', name: 'memory.backup.db' },
  },
  envPrefixOverride: 'ADHD_SOX_MEMORY_CORE',
};
```

---

## Gap detail

**G2: Hardcoded allowlist path** — The allowlist `~/.memory/**` (backup.ts) is enforced at the library entry point, preventing adoption of project-scoped or multi-instance directory layouts without migrating the check to memory-server (a higher layer). To adopt @adhd/environment, this allowlist logic should move into the memory-server permission guard and the library should accept a normalized backup destination from config.

---

## Logging audit

**Has logging**: yes.

**Logger mechanism**: custom — the package accepts an optional `opts.log` function parameter (backup.ts, compaction.ts) or logs via `console.error` directly (db.ts for embed_model mismatch warnings). No structured logger (pino/winston/log4js).

**Persists log files to disk**: no. All logging is either stdout/stderr (via passed callback or console) or silent (no-op default).

**Structured logs**: no. Format is plaintext; compaction.ts emits `[compaction] <message>`, backup.ts emits `[backup] <message>`. No JSON.

**Error handling**: adhoc. 
- backup.ts: try-catch with inline cleanup (delete partial dest file on VACUUM INTO failure), returns error object.
- compaction.ts: try-catch with error message capture, returns error in result.
- db.ts: try-catch/finally pattern for database operations; console.error for mismatch warnings; migrateOrganizerQueueCheckConstraint reconstructs tables on constraint drift with no logging.
- curate.ts: no error logging; operations fail silently if SQL errors occur (e.g., missing node).

Error propagation is mixed: backup.ts returns error objects (result | error); compaction.ts captures and surfaces in CompactionResult.error; db.ts throws EStoreMismatch, console.error on soft mismatches, and lets other errors propagate.

**Would benefit from `env.paths.logs`**: yes. Persistent log files would improve debugging (backup operations, compaction runs, schema migrations). Currently no way to configure where/whether logs persist; adoption of env.paths.logs (kind: 'logs', share: 'per-instance') with a structured logger (e.g., pino) would enable:
- Per-instance log files (one per scope) without collision.
- Configurable log level and destination.
- Structured error context for troubleshooting store mismatches and failed operations.

---

## File-location table — corrected to new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| `~/.memory/memory.db` (or caller-supplied) | data | `~/.adhd/sox-memory-core/default/data/memory.db` | `env.files.db` |
| `~/.memory/<dest>` (VACUUM INTO output) | data | `~/.adhd/sox-memory-core/default/data/memory.backup.db` | `env.files.backup` |
| WAL sidecar (`-wal`, `-shm`) | state | `~/.adhd/sox-memory-core/default/state/memory.db-wal` (etc.) | (automatic, co-located with db file) |
| stdout/stderr (current logging) | logs | `~/.adhd/sox-memory-core/default/logs/memory.log` | `env.paths.logs/<file>` |
| FTS virtual table (in-DB) | data | (embedded in db file) | (no separate accessor) |

**Project-scope variant**: when ADHD_ENV_SCOPE=project (auto-detected by `.git`/`.adhd` marker):
- `~/.adhd/sox-memory-core/default/data/memory.db` → `<projectRoot>/.adhd/sox-memory-core/default/data/memory.db`
- `~/.adhd/sox-memory-core/default/logs/memory.log` → `<projectRoot>/.adhd/sox-memory-core/default/logs/memory.log`
- WAL sidecars, backups, and ephemeral state follow the same subtree.

Namespace defaults to `'default'` in the database (`memory_scope.scope_id = 'default'`); multi-instance support would partition by namespace under the same directory.
