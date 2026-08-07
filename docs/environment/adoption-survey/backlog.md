---
package: "@adhd/backlog"
path: /Users/nix/dev/node/adhd/entrypoint/backlog
root: adhd
language: node
self_internal: true
current_scope_behavior: environment-managed
env_vars:
  - ADHD_BACKLOG_DATABASE_PATH
  - ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS
  - ADHD_BACKLOG_LOG_LEVEL
  - ADHD_BACKLOG_MIGRATION_PHASE
  - ADHD_BACKLOG_SCOPE
  - ADHD_ENV_SCOPE
writes:
  - path: "~/.adhd/backlog/production/data/backlog.db"
    kind: data
    purpose: "SQLite backlog graph store (task DAG + audit log)"
config_files:
  - none (env-var and defaults only)
logging:
  has_logging: true
  logger: unknown
  persists_log_files: unknown
  log_destination: "unknown (not declared in env.ts)"
  structured: unknown
  error_handling: unknown
  maps_to_env_logs: false
supported_by_env: full
gaps: []
value: high
effort: low
recommend: adopt
---

## Current state

**Env vars (all ADHD-prefixed, no non-standard reads):**
- `ADHD_BACKLOG_DATABASE_PATH` · resolves to config field `db.path` · fallback: `env.files.db` when unset
- `ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS` · resolves to config field `db.busyTimeoutMs` · default: 5000
- `ADHD_BACKLOG_LOG_LEVEL` · resolves to config field `logging.level` · default: 'info', enum: [trace|debug|info|warn|error|fatal|silent]
- `ADHD_BACKLOG_MIGRATION_PHASE` · resolves to config field `migration.phase` · default: 'not-started', enum: [not-started|phase-1|phase-2|phase-3|phase-4|phase-5|complete]
- `ADHD_BACKLOG_SCOPE` · meta: selects active scope (global|project|system) · precedence: explicit arg → env → default 'global'
- `ADHD_ENV_SCOPE` · meta: fallback scope selector (for sharing across packages)

**Writes:**
- `~/.adhd/backlog/production/data/backlog.db` · kind: data · SQLite store for backlog graph (task DAG + audit log metadata). Intentionally separate from agent-mcp and memory-server stores (DESIGN.md §12).

**Config files:**
- None. Spec is purely environment-var + code-default driven. No `.adhd/backlog.yaml` or per-env overlay files.

**Scope behavior:**
- Deliberately defaults to `'global'` (NOT the auto-detect `project`-if-marker-found default), per SPEC.md §3 requirement #3/#4: one shared task graph spanning every repo on the machine, by default.
- Overridable via `ADHD_BACKLOG_SCOPE` or generic `ADHD_ENV_SCOPE`.

**Current-to-environment mapping:**
Already using Environment class. Paths are resolved via:
- `env.files.db` → `~/.adhd/backlog/production/data/backlog.db` (global scope)
- `env.config.db.path` → env var with `env.files.db` fallback
- `env.config.db.busyTimeoutMs` → env var with default 5000
- `env.config.logging.level` → env var with default 'info'
- `env.config.migration.phase` → env var with default 'not-started'

---

## Proposed `EnvironmentSpec`

**This is the CURRENT spec already declared in the code (env.ts) — no changes needed:**

```typescript
export interface BacklogConfig {
  readonly db: { readonly path: string | undefined; readonly busyTimeoutMs: number };
  readonly logging: { readonly level: string };
  readonly migration: { readonly phase: string };
}

export const backlogEnvironmentSpec: EnvironmentSpec<BacklogConfig> = {
  envPrefixOverride: 'ADHD_BACKLOG',
  namespaces: ['production'],
  dirs: {
    data: { kind: 'data' },
  },
  files: {
    db: { in: 'data', name: 'backlog.db' },
  },
  config: {
    'db.path': {
      type: 'string',
      env: 'ADHD_BACKLOG_DATABASE_PATH',
      description: 'SQLite backlog-graph DB path. Unset ⇒ falls back to env.files.db under the resolved scope root.',
    },
    'db.busyTimeoutMs': {
      type: 'integer',
      env: 'ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS',
      default: 5000,
      description: 'SQLite `busy_timeout` (ms) each write waits for a contended lock before retrying (DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001). Raise this when scaling toward more concurrent agents writing the same global-scope store.',
    },
    'logging.level': {
      type: 'string',
      env: 'ADHD_BACKLOG_LOG_LEVEL',
      default: 'info',
      enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'],
    },
    'migration.phase': {
      type: 'string',
      env: 'ADHD_BACKLOG_MIGRATION_PHASE',
      default: 'not-started',
      enum: ['not-started', 'phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5', 'complete'],
      description: 'MIGRATION.md §4.4 — a queried signal for whether BACKLOG.md or the tool is authoritative. Read via `migrationStatus(ctx)`/`backlog migration-status`. NOT yet per-repo-keyed (MIGRATION.md §9 open decision 6).',
    },
  },
};
```

---

## Gap detail

**None.** All env vars are ADHD-prefixed, all paths are managed by Environment, no unsupported types or patterns.

---

## Audit: `at:` field classification

Independent analysis of spec fields against actual usage patterns in env.ts:

| Field | Current `at:` | Read site(s) | Mutability | Verdict |
|-------|---|---|---|---|
| `db.path` | (default `build`) | `buildBacklogEnv()` once at startup | One-time connection setup | ✓ `at: 'build'` correct |
| `db.busyTimeoutMs` | (default `build`) | SQLite constructor at startup | Immutable after connection | ✓ `at: 'build'` correct |
| `logging.level` | (default `build`) | Assumed logger config at startup; no re-read site shown in env.ts | Typically immutable per log instance | ✓ `at: 'build'` correct |
| `migration.phase` | (default `build`) | Comment: "Read via `migrationStatus(ctx)`" — suggests queries during operation | **Operator-mutable** (phase can advance during service lifetime per MIGRATION.md §4.4) | ⚠️ **UNVERIFIABLE** — if `migrationStatus()` is called on every access (e.g., per incoming request), needs `at: 'runtime'`. Cannot confirm without reading actual read site (not in env.ts). |

**Potential finding:** If `migration.phase` is expected to be changeable by an operator without restarting the service (implied by "queried signal" + MIGRATION.md §4.4 describing it as a live gate), then it should be `at: 'runtime'` to allow `process.env` updates to propagate. Recommend checking the actual `migrationStatus()` implementation and `backlog migration-status` command to confirm if re-reading is necessary.

---

## Logging audit

**Declared:** `logging.level` with enum [trace|debug|info|warn|error|fatal|silent] and default 'info'.

**Not declared in env.ts:** Log file destination, logger implementation (pino/winston/bunyan/custom), structured vs plaintext, persistence.

**Assessment:** env.ts only declares the config; actual logging setup (logger creation, file writing, structured format) is deferred to the backlog server code, which is not in the flagged file. Based on env.ts alone:
- Does log to STDOUT/STDERR (inferred from log-level config)
- No `env.paths.logs` mapping visible
- If the backlog server persists logs to disk, a `logs` dir should be declared in the spec and accessed via `env.paths.logs`

**Recommendation:** If backlog writes log files, add to spec:
```typescript
dirs: {
  data: { kind: 'data' },
  logs: { kind: 'logs', share: 'per-instance' },  // or 'shared' if one global log
}
```
Then configure logger to use `env.paths.logs / <timestamp>.log` or similar. Not a gap today (because logging implementation is out of scope of env.ts), but note for future logging work.

---

## File-location table

Current path → new standard (global scope) → env accessor:

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| (fallback if ADHD_BACKLOG_DATABASE_PATH unset) | data | `~/.adhd/backlog/production/data/backlog.db` | `env.files.db` → `env.paths.data / backlog.db` |

**Project scope variant** (if `ADHD_ENV_SCOPE=project` or `.git` marker present and user chooses project scope):
- `<projectRoot>/.adhd/backlog/production/data/backlog.db` (same relative structure under project root instead of `~/.adhd`)

**Namespace:** `production` (declared in spec). Backlog deliberately uses a single global namespace (no per-environment splitting like some other packages).

---

## Summary

**Status:** FULL ADOPTION — backlog entrypoint is a reference implementation of `@adhd/environment` usage. Spec is complete, correct, and well-documented. No migration needed. No gaps. One minor audit note: `migration.phase` may warrant `at: 'runtime'` if the actual server re-polls it; unverifiable from env.ts alone.
