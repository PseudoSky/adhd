---
package: @adhd/sox-host-runtime
path: /Users/nix/dev/ai/sox-ecosystem/libs/host-runtime
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: hardcoded paths under ~/.adhd/sox-ecosystem
env_vars: ["SOX_ECOSYSTEM_HOME", "SOX_SANDBOX_ROOT", "NODE_*"]
writes: [
  {path: "~/.adhd/sox-ecosystem/", kind: "config", purpose: "global soxe data root"},
  {path: "~/.adhd/sox-ecosystem/supervisors.json", kind: "state", purpose: "registered supervisors"},
  {path: "~/.adhd/sox-ecosystem/install-registry.json", kind: "state", purpose: "install ledger"},
  {path: "~/.adhd/sox-ecosystem/extensions.json", kind: "config", purpose: "scope config"},
  {path: "~/.adhd/sox-ecosystem/extensions.lock", kind: "config", purpose: "scope lock"},
  {path: "~/.adhd/sox-ecosystem/ledger.json", kind: "state", purpose: "provenance ledger"},
  {path: "~/.adhd/sox-ecosystem/ownership.json", kind: "state", purpose: "ownership index"},
  {path: "~/.adhd/sox-ecosystem/run/", kind: "run", purpose: "runtime state, sockets, locks"},
  {path: "~/.adhd/sox-ecosystem/run/locks/", kind: "run", purpose: "concurrent-start locks"},
  {path: "~/.adhd/sox-ecosystem/run/supervisors/", kind: "run", purpose: "exec sockets (unix)"},
  {path: "~/.adhd/sox-ecosystem/run/logs/", kind: "logs", purpose: "supervisor & extension logs"},
  {path: "<root>/.adhd/sox-ecosystem/", kind: "config", purpose: "project-scope root"},
  {path: "/Library/LaunchAgents/com.sox.*.plist", kind: "config", purpose: "macOS OS unit config (external)"},
  {path: "~/.config/systemd/user/com.sox.*.service", kind: "config", purpose: "systemd OS unit config (external)"}
]
config_files: ["extensions.json", "extensions.local.json", "org.extensions.json", "ledger.json", "ownership.json", "supervisors.json", "install-registry.json"]
logging:
  has_logging: true
  logger: custom LogManager class + console.warn
  persists_log_files: true
  log_destination: "~/.adhd/sox-ecosystem/run/logs/<supervisorId>/<extId>-<YYYY-MM-DD>.log"
  structured: false
  error_handling: adhoc
  maps_to_env_logs: true
supported_by_env: partial
gaps: ["G1", "G2", "G8"]
value: high
effort: med
recommend: adopt-after-gap
---

## Current state

**Env vars:**
- `SOX_ECOSYSTEM_HOME` (read in data-paths.ts `userDataRoot()`): override the global data root. Default: `~/.adhd/sox-ecosystem/`. Governs soxe's own bookkeeping only, never reroutes host placements.
- `SOX_SANDBOX_ROOT` (referenced in data-paths.ts `[inv:data-root-never-reroutes]`): test isolation switch; the ONLY thing that reroutes host discovery paths. Not read in data-paths.ts itself — used by host-registry.
- `NODE_*` (mentioned in os-unit.ts): part of the scrub allowlist when rendering OS units (EnvironmentVariables).

**Writes:**
- Global soxe root: `~/.adhd/sox-ecosystem/` (per ADR-0004 §D1).
  - `supervisors.json` (state): global registry of live supervisors, read/written by registry.ts and gc.ts.
  - `install-registry.json` (state): global install ledger (ADR-0004 §D7).
  - `run/` (run): supervisors, locks, logs subdirectories.
    - `run/locks/<supervisorId>.lock` (run): concurrent-start lock, written by lock.ts `acquireStartLock()`, released after runtime record is written.
    - `run/supervisors/` (run): exec Unix sockets (one per supervisor); created by supervisor, probed by gc.ts `probeSocket()`, cleaned by gc.ts `cleanUpDeadEntry()`.
    - `run/logs/<supervisorId>/` (logs): supervisor extension logs, managed by log-manager.ts LogManager class.
      - `<extId>-<YYYY-MM-DD>.log` (logs): daily log files, max 50 MB each, max 7 files per extId prefix (rotation policy).
      - `run-history.json` (state): appended on spawn/stop, records ISO timestamps and exit codes.
- Per-scope roots: `<dataRoot>/` where dataRoot = userDataRoot() for user/org scope, or `<root>/.adhd/sox-ecosystem/` for project/local scope (ADR-0004 §D2).
  - `extensions.json` / `extensions.lock` (config): user/org scope.
  - `extensions.local.json` / `extensions.local.lock` (config): local scope only, coexists under project data root.
  - `ledger.json` (state): per-scope provenance ledger (ADR-0004 §D2).
  - `ownership.json` (state): per-scope ownership index (ADR-0004 §D5).
  - `ext/` (data): materialized service-store root (ADR-0004 §D2).
- OS unit files (external, not under soxe control but required for BL-50/BL-51 reboot persistence):
  - macOS: `/Library/LaunchAgents/com.sox.<scope>.<id>[.sbx-<hash>].plist` (written by os-unit.ts `enableOsUnit()`, read/executed by launchd).
  - Linux: `~/.config/systemd/user/com.sox.<scope>.<id>[.sbx-<hash>].service` (and paired `.timer` for periodic tasks).

**Scope resolution:**
- Data paths are hardcoded via `dataRoot(scope, root?)` in data-paths.ts. No env var controls individual path components (only `SOX_ECOSYSTEM_HOME` overrides the user root).
- Current scopes: `org` (global, user root or explicit org root), `user` (global root), `project` (repo root `.adhd/`), `local` (repo root `.adhd/`, distinct lockfile).

## Proposed EnvironmentSpec

\`\`\`typescript
export const SOX_HOST_RUNTIME_SPEC: EnvironmentSpec<SoxHostRuntimeConfig> = {
  envPrefixOverride: 'SOX',
  config: {
    ecosystem_home: {
      type: 'string',
      env: 'SOX_ECOSYSTEM_HOME',
      default: '~/.adhd/sox-ecosystem',
      at: 'runtime',
      doc: 'Global soxe data root. Do not reroute host placements (use SANDBOX_ROOT for that).',
    },
    sandbox_root: {
      type: 'string',
      env: 'SOX_SANDBOX_ROOT',
      default: undefined,
      at: 'runtime',
      doc: 'Test isolation override; reroutes host discovery. Production: unset.',
    },
  },
  dirs: {
    global_root: {
      kind: 'config',
      share: 'singleton',
      doc: 'Global soxe config/state root (user scope only).',
    },
    run: {
      kind: 'run',
      share: 'per-instance',
      doc: 'Supervisor runtime state, sockets, locks, logs.',
    },
    logs: {
      kind: 'logs',
      share: 'per-instance',
      doc: 'Extension log files, rotated daily. Max 50 MB/file, max 7/extId.',
    },
    data: {
      kind: 'data',
      share: 'per-instance',
      doc: 'Materialized service store (ext/).',
    },
  },
  files: {
    supervisors: {
      in: 'global_root',
      name: 'supervisors.json',
      kind: 'state',
      share: 'singleton',
    },
    install_registry: {
      in: 'global_root',
      name: 'install-registry.json',
      kind: 'state',
      share: 'singleton',
    },
    ledger: {
      in: 'data',
      name: 'ledger.json',
      kind: 'state',
    },
    ownership: {
      in: 'data',
      name: 'ownership.json',
      kind: 'state',
    },
    run_history: {
      in: 'logs',
      name: 'run-history.json',
      kind: 'state',
    },
  },
};
\`\`\`

## Gap detail

- **G1**: \`SOX_ECOSYSTEM_HOME\` and \`SOX_SANDBOX_ROOT\` are NOT prefixed \`ADHD_\`. The @adhd/environment prefix model (\`ADHD_<PROJECT>_*\`) does not guard them. Remapping would require either (a) introducing a new prefix scope for vendor packages like soxe, or (b) accepting that cross-vendor env vars live outside the guarded namespace.
- **G2**: OS unit files (\`/Library/LaunchAgents/\`, \`~/.config/systemd/user/\`) are written OUTSIDE any soxe-controlled root. These paths are mandated by the OS supervisor and cannot be relocated into \`~/.adhd/\`. @adhd/environment has no mechanism for "write to OS-mandated directory" — only user-scoped hierarchy. Flag this as out-of-scope for migration; OS unit generation will remain in os-unit.ts as-is.
- **G8**: Unix sockets (exec sockets in \`run/supervisors/\`, lock files in \`run/locks/\`) are not among the 7 standard kinds. @adhd/environment treats them as \`kind: 'run'\` (runtime artifacts), but a stricter classification schema might distinguish \`unix_socket\` and \`lock_file\` as first-class kinds. For now, grouping them under \`kind: 'run'\` is acceptable.

## Logging audit

**Has logging:** YES.

**Logger mechanism:** Custom \`LogManager\` class (log-manager.ts) + \`console.warn()\` (gc.ts cleanUpDeadEntry).

**Persists log files:** YES. LogManager writes to \`<logDir>/<extId>-<YYYY-MM-DD>.log\` files on disk. Log files survive supervisor restarts (append mode). Run-history is tracked in \`run-history.json\` with ISO timestamps for start/stop and exit codes.

**Log destination:** \`~/.adhd/sox-ecosystem/run/logs/<supervisorId>/<extId>-<YYYY-MM-DD>.log\`. One log directory per supervisor (keyed by supervisorId). Multiple extensions' logs coexist in the same directory, distinguished by extId prefix in the filename.

**Structured:** NO. LogManager writes plaintext chunks to the stream. No JSON envelope, no structured fields (timestamp, level, message).

**Error handling:** ADHOC.
- gc.ts: \`cleanUpDeadEntry()\` logs to stderr via \`process.stderr.write()\` on successful dead-supervisor cleanup. Exceptions in cleanup are silently caught (\`catch { /* ignore */ }\`). No error-level logging for failures.
- log-manager.ts: \`stream()\` handler listens for \`'error'\` events and emits \`console.warn()\`. Write failures are silently ignored in \`_rotateSizeExceeded()\` and \`_pruneOldFiles()\` (catch blocks). Corrupt \`run-history.json\` is skipped (\`catch { /* corrupt — start fresh */ }\`).

**Maps to env.paths.logs:** YES, naturally. LogManager is already scoped per supervisor and persists to a single directory. The \`kind: 'logs'\` and \`share: 'per-instance'\` model map directly: each supervisor instance gets its own log subdirectory under \`env.paths.logs/<supervisorId>/\`, and LogManager manages rotation and file size caps within it.

## File-location table — corrected to the new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| \`~/.adhd/sox-ecosystem/supervisors.json\` | state | \`~/.adhd/sox-host-runtime/default/state/supervisors.json\` | \`env.files.supervisors\` |
| \`~/.adhd/sox-ecosystem/install-registry.json\` | state | \`~/.adhd/sox-host-runtime/default/state/install-registry.json\` | \`env.files.install_registry\` |
| \`~/.adhd/sox-ecosystem/extensions.json\` | config | \`~/.adhd/sox-host-runtime/default/config/extensions.json\` | \`env.files.extensions\` |
| \`~/.adhd/sox-ecosystem/extensions.lock\` | config | \`~/.adhd/sox-host-runtime/default/config/extensions.lock\` | \`env.files.extensions_lock\` |
| \`~/.adhd/sox-ecosystem/ledger.json\` | state | \`~/.adhd/sox-host-runtime/default/state/ledger.json\` | \`env.files.ledger\` |
| \`~/.adhd/sox-ecosystem/ownership.json\` | state | \`~/.adhd/sox-host-runtime/default/state/ownership.json\` | \`env.files.ownership\` |
| \`~/.adhd/sox-ecosystem/run/locks/<supervisorId>.lock\` | run | \`~/.adhd/sox-host-runtime/default/run/locks/<supervisorId>.lock\` | \`env.paths.run/<supervisorId>.lock\` |
| \`~/.adhd/sox-ecosystem/run/supervisors/<id>.sock\` | run | \`~/.adhd/sox-host-runtime/default/run/supervisors/<id>.sock\` | \`env.paths.run/<id>.sock\` |
| \`~/.adhd/sox-ecosystem/run/logs/<supervisorId>/<extId>-<YYYY-MM-DD>.log\` | logs | \`~/.adhd/sox-host-runtime/default/logs/<supervisorId>/<extId>-<YYYY-MM-DD>.log\` | \`env.paths.logs/<supervisorId>/<extId>-<YYYY-MM-DD>.log\` |
| \`~/.adhd/sox-ecosystem/run/logs/<supervisorId>/run-history.json\` | state | \`~/.adhd/sox-host-runtime/default/logs/<supervisorId>/run-history.json\` | \`env.files.run_history\` or \`env.paths.logs/<supervisorId>/run-history.json\` |
| \`~/.adhd/sox-ecosystem/ext/<extId>/\` | data | \`~/.adhd/sox-host-runtime/default/data/ext/<extId>/\` | \`env.paths.data/ext/<extId>/\` |
| \`<projectRoot>/.adhd/sox-ecosystem/extensions.local.json\` | config | \`<projectRoot>/.adhd/sox-host-runtime/default/config/extensions.local.json\` | \`env.files.extensions_local\` |
| \`<projectRoot>/.adhd/sox-ecosystem/ledger.json\` | state | \`<projectRoot>/.adhd/sox-host-runtime/default/state/ledger.json\` | \`env.files.ledger\` |

**Project-scope variant:** When \`ADHD_ENV_SCOPE=project\` (or detected via \`.git\` marker), the same file layout applies under \`<projectRoot>/.adhd/sox-host-runtime/default/…\` (replacing \`~/.adhd/sox-host-runtime/…\`). Unix sockets and locks remain in the global scope (no project-scoped sockets; they are supervisor-global).

**Note on OS unit files:** \`/Library/LaunchAgents/com.sox.*.plist\` and \`~/.config/systemd/user/com.sox.*.service\` remain outside the @adhd/environment tree. These paths are OS-mandated and cannot be redirected. Treat as a documented out-of-scope gap (G2).
