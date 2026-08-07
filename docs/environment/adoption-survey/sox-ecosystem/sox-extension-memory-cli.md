---
package: "@adhd/sox-extension-memory-cli"
path: "/Users/nix/dev/ai/sox-ecosystem/extensions/bundles/sox-memory-bundle/members/memory-cli"
root: "sox-ecosystem"
language: "node"
self_internal: false
current_scope_behavior: "mixed"
env_vars: ["HOME", "USERPROFILE", "SOX_CONFIG_EXPORT_DIR", "SOX_CONFIG_EXPORT_ENABLED", "SOX_CONFIG_DB_PATH"]
writes: [
  {path: "~/.memory/*.db", kind: "data", purpose: "scope-specific memory stores (user/org)"},
  {path: "<cwd>/.memory/*.db", kind: "data", purpose: "scope-specific memory stores (project/local)"},
  {path: "~/.memory/registry.json", kind: "config", purpose: "scope→dbpath registry"},
  {path: "~/.memory/export/", kind: "data", purpose: "markdown export of live episodes (user/org)"},
  {path: "<cwd>/.memory/export/", kind: "data", purpose: "markdown export of live episodes (project/local)"}
]
config_files: ["~/.memory/registry.json"]
logging:
  has_logging: true
  logger: "console"
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: false
  error_handling: "robust"
  maps_to_env_logs: false
supported_by_env: "partial"
gaps: ["G1"]
value: "med"
effort: "med"
recommend: "adopt-after-gap"
---

## Current State

**Environment Variables:**
- `HOME` · read in `defaultDbPath()`, `defaultExportDir()`, `cmdRegistry()`, `cmdReembed()`, `cmdBackup()`, `cmdCompact()` · fallback to `USERPROFILE` or `/tmp`
- `USERPROFILE` · Windows fallback for `HOME` (lines 51, 416, 467, 512)
- `SOX_CONFIG_EXPORT_DIR` · read in `resolveExportDir()` · override for export directory
- `SOX_CONFIG_EXPORT_ENABLED` · read in `resolveExportEnabled()` · bool flag (default true)
- `SOX_CONFIG_DB_PATH` · read in `cmdExport()` · override for DB path

**Writes:**
- `~/.memory/<scope>.db` (user/org scopes): user and org DB files written to homedir
- `<cwd>/.memory/<scope>.db` (project/local scopes): project and local DB files written to cwd
- `~/.memory/registry.json`: JSON registry of scope→dbpath mappings, written by `writeRegistry()`
- `~/.memory/export/` and `<cwd>/.memory/export/`: markdown exports per scope

**Scope Behavior:**
Hardcoded cascade: `--scope` flag (user|org|project|local) → `--path` override → default location. Scopes are semantic partitions:
- `project`: `<cwd>/.memory/project.db` (via `process.cwd()`)
- `user`: `~/.memory/user.db` (via `HOME` / `USERPROFILE`)
- `org`: `~/.memory/org.db` (via homedir)
- `local`: `<cwd>/.memory/local.db` (via `cwd`)

Export directories also follow scope: user/org → `~/.memory/export/`, project/local → `<cwd>/.memory/export/`.

## Proposed EnvironmentSpec

```typescript
const memoryCliSpec = {
  envPrefix: 'ADHD_SOX_EXTENSION_MEMORY_CLI',
  envPrefixOverride: 'ADHD_SOX_MEMORY',  // shorter, user-facing
  config: {
    store: {
      type: 'string',
      env: 'SCOPE',
      default: 'project',
      enum: ['project', 'user', 'org', 'local'],
      at: 'runtime',
    },
    exportEnabled: {
      type: 'boolean',
      env: 'EXPORT_ENABLED',
      default: true,
      at: 'runtime',
      secret: false,
    },
  },
  dirs: {
    // scope-specific DBs
    storeProject: {kind: 'data', share: 'per-instance'},  // .memory/ for project scope
    storeUser: {kind: 'data', share: 'per-instance'},     // ~/.memory/ for user scope
    storeOrg: {kind: 'data', share: 'singleton'},         // ~/.memory/ for org scope (shared)
    storeLocal: {kind: 'data', share: 'per-instance'},    // .memory/ for local scope
    // export
    exportProject: {kind: 'data', share: 'per-instance'}, // .memory/export/
    exportUser: {kind: 'data', share: 'per-instance'},    // ~/.memory/export/
    exportOrg: {kind: 'data', share: 'singleton'},        // ~/.memory/export/ (shared)
    exportLocal: {kind: 'data', share: 'per-instance'},   // .memory/export/
  },
  files: {
    registry: {in: 'storeUser', name: 'registry.json', share: 'singleton'},  // ~/.memory/registry.json
  },
} as const satisfies EnvironmentSpec<SoxMemoryCliConfig>;
```

## Gap Detail

**G1** — Non-`ADHD_*` env vars that cannot be guarded by prefix:
- `HOME` and `USERPROFILE`: hardcoded OS environment fallbacks for homedir discovery. `env.isEnvNameAllowed('HOME')` returns false; `resolveEnvName('HOME')` cannot remap to `ADHD_SOMETHING`. A generic `ADHD_SOX_MEMORY_HOME` override would work, but loses the OS semantics.

## Logging Audit

**Has Logging:** Yes — uses `console.log()` and `console.error()` throughout.

**Logger:** `console` (Node.js built-in).

**Persists Log Files:** No — all output goes to stdout/stderr only. No `.log` files written to disk.

**Log Destination:** stdout/stderr only. Example: `console.log('Registry updated: ...')` prints to stdout; errors via `console.error()` go to stderr.

**Structured:** No — plaintext, human-readable output. Example: `"${verb}: ${dbPath}"` is plain string interpolation, not JSON.

**Error Handling:** Robust — try/catch blocks in store-discovery (line 270, 302, 333, 354), explicit `process.exit(1)` on fatal errors (lines 109, 421, 443, 448, 486, 497, 517, 544), and error logging before exit.

**Maps to env.paths.logs:** No — logging is ephemeral console-only. The `cmdReembed()` and `cmdBackup()` functions accept a `log()` callback (lines 431, 482, 526) that could be redirected to a file sink, but currently logs to console. A persisted `env.paths.logs` destination would be a low-value addition (logs are transient operational output, not audit records).

## File-Location Table — Corrected to New Standard

| Current Path | Kind | New-Standard Path (global scope) | Env Accessor |
|---|---|---|---|
| `~/.memory/project.db` | data | `~/.adhd/sox-extension-memory-cli/default/data/project.db` | `env.paths.storeProject / 'project.db'` |
| `~/.memory/user.db` | data | `~/.adhd/sox-extension-memory-cli/default/data/user.db` | `env.paths.storeUser / 'user.db'` |
| `~/.memory/org.db` | data | `~/.adhd/sox-extension-memory-cli/default/data/org.db` | `env.paths.storeOrg / 'org.db'` |
| `~/.memory/local.db` | data | `~/.adhd/sox-extension-memory-cli/default/data/local.db` | `env.paths.storeLocal / 'local.db'` |
| `<cwd>/.memory/project.db` | data | `<cwd>/.adhd/sox-extension-memory-cli/default/data/project.db` | `env.paths.storeProject / 'project.db'` |
| `<cwd>/.memory/user.db` | data | `<cwd>/.adhd/sox-extension-memory-cli/default/data/user.db` | `env.paths.storeUser / 'user.db'` |
| `<cwd>/.memory/org.db` | data | `<cwd>/.adhd/sox-extension-memory-cli/default/data/org.db` | `env.paths.storeOrg / 'org.db'` |
| `<cwd>/.memory/local.db` | data | `<cwd>/.adhd/sox-extension-memory-cli/default/data/local.db` | `env.paths.storeLocal / 'local.db'` |
| `~/.memory/registry.json` | config | `~/.adhd/sox-extension-memory-cli/default/config/registry.json` | `env.files.registry` |
| `~/.memory/export/` | data | `~/.adhd/sox-extension-memory-cli/default/data/export/` | `env.paths.exportUser` |
| `<cwd>/.memory/export/` | data | `<cwd>/.adhd/sox-extension-memory-cli/default/data/export/` | `env.paths.exportProject` |

**Project-Scope Variant:** When `ADHD_ENV_SCOPE=project` or a `.adhd`/`.git` marker is detected, paths shift to `<projectRoot>/.adhd/sox-extension-memory-cli/default/<kind>/…` — e.g., `~/.memory/user.db` → `<projectRoot>/.adhd/sox-extension-memory-cli/default/data/user.db` for global scope and `<projectRoot>/.adhd/sox-extension-memory-cli/default/data/project.db` for project scope. Note: The current hardcoded behavior conflates "scope" (user|project|org|local partition) with "location" (homedir vs cwd); `@adhd/environment` decouples them via `ADHD_ENV_SCOPE`, making the semantic cleaner and migrations easier.

## Recommendation

**adopt-after-gap** — The package is a good fit for `@adhd/environment` (structured config, predictable dir layout, multi-scope awareness). The `G1` gap (`HOME` / `USERPROFILE` hardcoding) is surmountable with a small addition: an optional `ADHD_HOME` override env var (or keep the OS `HOME` fallback inline in the env spec's `default` field). Effort is moderate (refactor scope/path resolution to use `env.resolveDbPath()`, `env.paths.<dirKey>`, and `env.files.registry`). Value is medium (removes hand-rolled cascade logic and aligns with the @adhd ecosystem's zero-config story).
