---
package: "@adhd/sox-blob-store"
path: /Users/nix/dev/ai/sox-ecosystem/libs/data/store/blob-store
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes:
  - path: "<basePath>"
    kind: data
    purpose: "blob files stored with SHA-256 content hash"
  - path: "<basePath>/.tmp"
    kind: temp
    purpose: "staging directory for writes before atomic rename"
  - path: "<basePath>/refs.db"
    kind: data
    purpose: "SQLite reference tracking database"
  - path: "<basePath>/refs.db-wal"
    kind: data
    purpose: "SQLite Write-Ahead Log"
  - path: "<basePath>/refs.db-shm"
    kind: data
    purpose: "SQLite shared memory file"
  - path: "<basePath>/.lock"
    kind: run
    purpose: "GC process lock (flock-based cross-process guard)"
config_files: []
logging:
  has_logging: true
  logger: console
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: false
  error_handling: robust
  maps_to_env_logs: false
supported_by_env: full
gaps: []
value: high
effort: low
recommend: adopt
---

## Current state

**Environment variables:** None. The package reads zero environment variables; all configuration is passed via the `StoreConfig` interface at instantiation.

**Writes:**
- `<basePath>` (root blob store directory) — data kind; stores content-addressable blobs indexed by SHA-256 hash
- `<basePath>/.tmp` (ephemeral staging) — temp kind; short-lived files during `put()` and `putStream()` before atomic rename
- `<basePath>/refs.db` (SQLite database) — data kind; stores reference tracking (`refs`, `blob_meta`, `gc_runs` tables)
- `<basePath>/refs.db-wal` (WAL file) — data kind; SQLite journal for `journal_mode = WAL`
- `<basePath>/refs.db-shm` (shared memory) — data kind; SQLite concurrent-access coordination
- `<basePath>/.lock` (GC lock file) — run kind; flock-based guard for cross-process GC exclusion

**Scope decision:** `basePath` is passed to `createBlobStore(config: StoreConfig)` at instantiation and never read from env. The package has zero hardcoded absolute paths and zero XDG/homedir lookups.

**Logging:** Uses bare `console.info()`, `console.error()`, `console.warn()`, `console.debug()` for:
- Store open/close events (`basePath=…` logged once)
- Auto-GC failures (errors logged with stack)
- GC completion summaries (blob count, bytes freed, duration)
- Integrity mismatches and corrupt blob deletion (hash prefix logged)
- Stream abandonment warnings (60s timeout)

All output goes to stdout/stderr; no log files are persisted by the package itself.

## Proposed `EnvironmentSpec`

```typescript
export const blobStoreEnvSpec = {
  config: {
    basePath: {
      type: 'string',
      description: 'Root directory for blob storage and metadata',
      at: 'runtime',
      default: undefined, // required
    },
    tempDir: {
      type: 'string',
      description: 'Staging directory for writes before atomic rename. Defaults to <basePath>/.tmp',
      at: 'runtime',
      default: undefined,
    },
    refDbPath: {
      type: 'string',
      description: 'Path to SQLite reference-tracking database. Defaults to <basePath>/refs.db',
      at: 'runtime',
      default: undefined,
    },
    maxBlobSize: {
      type: 'integer',
      description: 'Maximum bytes per blob; enforced in put() and putStream()',
      at: 'runtime',
      default: 1073741824, // 1 GiB
      minimum: 1,
    },
    'gc.gracePeriodMs': {
      type: 'integer',
      description: 'Grace period (ms) before a blob becomes eligible for GC after last ref touch',
      at: 'runtime',
      default: 0,
      minimum: 0,
    },
    'gc.maxDeletePerCycle': {
      type: 'integer',
      description: 'Maximum blobs to delete in a single GC run',
      at: 'runtime',
      default: 1000,
      minimum: 1,
    },
    'gc.autoGcIntervalMs': {
      type: 'integer',
      description: 'Auto-GC interval in ms; 0 or undefined disables background GC',
      at: 'runtime',
      default: 0,
      minimum: 0,
    },
    verifyOnRead: {
      type: 'boolean',
      description: 'Verify SHA-256 hash on blob read (default: true)',
      at: 'runtime',
      default: true,
    },
    verifyOnWrite: {
      type: 'boolean',
      description: 'Verify SHA-256 hash immediately after write to disk (default: false)',
      at: 'runtime',
      default: false,
    },
  },
  dirs: {
    data: {
      kind: 'data',
      description: 'Primary blob store and SQLite database',
      defaultSubkey: 'blobs',
    },
    temp: {
      kind: 'temp',
      description: 'Temporary files during write staging',
      defaultSubkey: 'staging',
    },
    run: {
      kind: 'run',
      description: 'Runtime lock files for GC coordination',
      defaultSubkey: 'locks',
    },
  },
  files: {
    refDb: {
      in: 'data',
      name: 'refs.db',
      description: 'SQLite reference tracking database',
    },
  },
  share: 'per-instance', // Each instance has its own blob store and lock
} as const satisfies EnvironmentSpec<typeof blobStoreEnvSpec>;
```

**Usage pattern:**
```typescript
const env = new Environment(blobStoreEnvSpec);
const store = createBlobStore({
  basePath: env.paths.data,
  tempDir: env.paths.temp,
  refDbPath: env.files.refDb,
  gc: {
    gracePeriodMs: env.config.get('gc.gracePeriodMs'),
    maxDeletePerCycle: env.config.get('gc.maxDeletePerCycle'),
    autoGcIntervalMs: env.config.get('gc.autoGcIntervalMs'),
  },
  verifyOnRead: env.config.get('verifyOnRead'),
  verifyOnWrite: env.config.get('verifyOnWrite'),
});
```

## Gap detail

None. This package has zero gaps:
- Reads no environment variables (ideal for adoption)
- All writes are under configurable `basePath`, with `tempDir` and `refDbPath` also overridable
- Node/TypeScript only
- Simple console logging (no structured requirements)
- No multi-file config, no secrets, no remote config sources

## Logging audit

**Has logging:** Yes. The package uses bare `console.info()`, `console.warn()`, `console.error()`, and `console.debug()` for observability.

**Logger:** `console` (stdout/stderr only)

**Persists log files:** No. All log output goes to process stdout/stderr; the package itself does not write `.log` files.

**Log destination:** stdout/stderr only

**Structured:** No. All logs are plaintext strings with inline context (e.g., `[blob-store] store opened: basePath=…`). No JSON/structured format.

**Error handling:** Robust. The package:
- Wraps filesystem and SQLite errors in domain-specific exceptions (`BlobStoreSystemError`, `IntegrityMismatch`, `BlobNotFound`, `GCInProgress`, `BlobStoreNotOpenError`)
- Logs errors with `console.error()` at critical points (auto-GC failures)
- Uses try/catch blocks to guard cleanup paths (e.g., fallback `unlink()` in write failure)
- Does not suppress errors — they propagate to the caller

**Maps to env.paths.logs:** No, but it *could* benefit from it. If the package were configured to write a structured journal of GC runs, integrity checks, and errors to a persisted log directory (kind: `logs`, share: `per-instance`), monitoring and auditing would improve. Today, operators relying on blob-store observability must capture stdout/stderr at the process level. A dedicated `env.paths.logs` would allow:
- Persistent GC audit trail (one entry per run)
- Integrity-check results appended over time
- Error journal with timestamps
- No risk of stdout buffer loss or log rotation issues at the process level

This is optional and not a blocker.

## File-location table — corrected to the new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| `<basePath>` | data | `~/.adhd/sox-blob-store/default/data/blobs` | `env.paths.data` |
| `<basePath>/.tmp` | temp | `~/.adhd/sox-blob-store/default/temp/staging` | `env.paths.temp` |
| `<basePath>/refs.db` | data | `~/.adhd/sox-blob-store/default/data/refs.db` | `env.files.refDb` |
| `<basePath>/refs.db-wal` | data | `~/.adhd/sox-blob-store/default/data/refs.db-wal` | (auto-managed) |
| `<basePath>/refs.db-shm` | data | `~/.adhd/sox-blob-store/default/data/refs.db-shm` | (auto-managed) |
| `<basePath>/.lock` | run | `~/.adhd/sox-blob-store/default/run/locks/.lock` | (auto-managed) |

**Project-scope variant** (when `ADHD_ENV_SCOPE=project` or `.git`/`.adhd` marker detected):
All paths above are rooted at `<projectRoot>/.adhd/sox-blob-store/default/…` instead of `~/.adhd/sox-blob-store/default/…`
