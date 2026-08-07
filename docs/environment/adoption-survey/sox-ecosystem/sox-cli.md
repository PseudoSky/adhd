---
package: @adhd/sox-cli
path: /Users/nix/dev/ai/sox-ecosystem/apps/sox
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: mixed
env_vars: [SOX_ECOSYSTEM_HOME, SOX_SANDBOX_ROOT, SOX_HOME, SOX_OS_UNIT_DIR, SOX_PROXY_BACKEND, SOX_PROXY_BACKEND_SOCKET, SOX_PROXY_BACKEND_SCHEMA, SOX_RUNTIME_FILE, SOX_STOP_GRACE_MS, SOX_DOCTOR_TICK_INTERVAL, SOX_EMBED_BACKEND, SOX_EMBED_CACHE_DIR, SOX_CONFIG_*, PATH, HOME, USER, LOGNAME, LANG, LC_ALL, LC_CTYPE, TZ, NODE_*]
writes: [{path: ~/.adhd/sox-ecosystem/run/sox-audit.jsonl, kind: logs, purpose: append-only command audit log}, {path: ~/.adhd/sox-ecosystem/run/supervisors, kind: state, purpose: supervisor runtime state}, {path: ~/.adhd/sox-ecosystem/ext, kind: state, purpose: installed extension state}, {path: ~/.adhd/sox-ecosystem/extensions.json, kind: config, purpose: extension config list}, {path: ~/.adhd/sox-ecosystem/extensions.lock, kind: state, purpose: extension lockfile}, {path: ~/.adhd/sox-ecosystem/registry.json, kind: data, purpose: embedded registry copy}, {path: ~/.adhd/sox-ecosystem/install-registry.json, kind: state, purpose: global install registry}, {path: ~/.adhd/sox-ecosystem/supervisors.json, kind: state, purpose: supervisor records}, {path: ~/.adhd/sox-ecosystem/run/logs, kind: logs, purpose: extension backend logs}, {path: <root>/.sox/registry.json, kind: data, purpose: service registry}, {path: <root>/.adhd/sox-ecosystem, kind: state, purpose: project-scope data root}]
config_files: [extensions.json, extensions.lock]
logging:
  has_logging: true
  logger: custom
  persists_log_files: true
  log_destination: ~/.adhd/sox-ecosystem/run/sox-audit.jsonl; ~/.adhd/sox-ecosystem/run/logs/<extId>-backend-YYYY-MM-DD.log
  structured: partial
  error_handling: adhoc
  maps_to_env_logs: true
supported_by_env: partial
gaps: [G1, G3]
value: high
effort: med
recommend: adopt-after-gap
---

## Current state

**Environment variables (read verbatim):**
- `SOX_ECOSYSTEM_HOME` · main.ts:147, 149 · data root override; cascades to `dataRoot()` function · no default, uses `~/.adhd/sox-ecosystem` if unset
- `SOX_SANDBOX_ROOT` · referenced in ADR-0004 · test isolation override · default: none
- `SOX_HOME` · main.ts:147 · legacy, inert (retired per ADR-0004); no longer read by soxe but still accepted to avoid collisions with unrelated tools
- `SOX_OS_UNIT_DIR` · main.ts:2530, 3051, 4622 · systemd unit directory override · default: platform-specific
- `SOX_PROXY_BACKEND` · main.ts:2325 · signal flag ('1') for proxy backend mode · set by CLI itself
- `SOX_PROXY_BACKEND_SOCKET` · main.ts:2326 · socket path for proxy backend communication · computed/passed by CLI
- `SOX_PROXY_BACKEND_SCHEMA` · main.ts:2327 · schema path for proxy backend (optional) · computed by CLI
- `SOX_RUNTIME_FILE` · main.ts:3209, 3310, 3801, 3953, 4440 · override path for runtime state file (supervisors.json) · default: `~/.adhd/sox-ecosystem/supervisors.json`
- `SOX_STOP_GRACE_MS` · main.ts:4476 · graceful shutdown timeout in ms · default: none
- `SOX_DOCTOR_TICK_INTERVAL` · main.ts:5017 · doctor reconciliation tick interval · default: none
- `SOX_EMBED_BACKEND`, `SOX_EMBED_CACHE_DIR` · main.ts:4634 · backend embedding + cache control · passed through to child processes
- `SOX_CONFIG_*` · main.ts:332–357, 351 · extension config values generated from cascade (config key → `SOX_CONFIG_<KEY>` with env var substitution); read by child extensions
- `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `NODE_*` · main.ts:4633–4638 · system env vars passed through to supervised processes

**Files/directories written:**
- `~/.adhd/sox-ecosystem/run/sox-audit.jsonl` · append-only JSONL audit log of every CLI invocation (pid, ppid, verb, argv, cwd, scope) · main.ts:154–173
- `~/.adhd/sox-ecosystem/run/supervisors/` · directory for supervisor runtime state files · main.ts:5526
- `~/.adhd/sox-ecosystem/ext/` · directory for installed extension stores
- `~/.adhd/sox-ecosystem/extensions.json` · extension config list (cascade-resolved from all scopes, filtered by active scope) · written via loadConfig/writeFileSync
- `~/.adhd/sox-ecosystem/extensions.lock` · extension lockfile (pinned versions) · written via install/update lifecycle
- `~/.adhd/sox-ecosystem/registry.json` · embedded copy of the registry snapshot at build time (scripts/embed-registry.cjs)
- `~/.adhd/sox-ecosystem/install-registry.json` · global install registry (historical; being GC'd)
- `~/.adhd/sox-ecosystem/supervisors.json` · supervisor records (install registry + unit metadata for all scopes)
- `~/.adhd/sox-ecosystem/run/logs/<extId>-backend-YYYY-MM-DD.log` · daily backend extension logs · main.ts:2336
- `<root>/.sox/registry.json` · service registry (written by run-service.ts, read by main.ts:4060)
- `<root>/.adhd/sox-ecosystem/` · project-scope data root when scope='project' (auto-detected by `.git`/`.adhd` markers or `ADHD_ENV_SCOPE=project`)

**Config files:**
- `extensions.json` · list of installed extensions with per-extension config keys + values (JSON object with `{install: [{id, config?: {...}}]}`)
- `extensions.lock` · lockfile pinning resolved versions

**Scope hierarchy:**
- `user` (default) → `~/.adhd/sox-ecosystem/`
- `org` (global) → `~/.adhd/sox-ecosystem/` (shared)
- `project` → `<workspaceRoot>/.adhd/sox-ecosystem/` (auto-detected via `.git` or `.adhd` marker)
- `local` → `<cwd>/.adhd/sox-ecosystem/` (current working directory)
- Cascade (low to high precedence): code defaults → system env → global `~/.adhd` → project `<root>/.adhd` → local `<cwd>/.adhd` → env var

## Gap detail

- **G1** `SOX_HOME` · legacy, non-standard env var; must continue accepting it for backward compat even though it is now inert. Also, system env vars like `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ` must pass through to child processes verbatim and cannot be scoped under `SOX_` prefix.
- **G3** Non-Node implementation gap: sox-ecosystem is Node-only; Python/Rust/Go implementations of the core environment manager do not exist. Any non-Node satellite tools cannot use @adhd/environment directly.

## Logging audit

**Does it log?** Yes.

**Logger mechanism:** Custom inline via `process.stdout.write()`, `process.stderr.write()`, and `appendFileSync()` for audit log.

**Log files persisted to disk?**
- Yes: `~/.adhd/sox-ecosystem/run/sox-audit.jsonl` — append-only JSONL audit trail (every CLI invocation logged). Main.ts lines 154–173.
- Yes: `~/.adhd/sox-ecosystem/run/logs/<extId>-backend-YYYY-MM-DD.log` — daily backend extension logs captured when running `soxe serve` or supervised extensions. Main.ts line 2336.

**Structured vs. plaintext:**
- Audit log is structured JSON (one JSON object per line, keys: `t`, `pid`, `ppid`, `verb`, `argv`, `cwd`, `scope`).
- CLI stdout/stderr output is human-readable plaintext.
- Backend logs are mixed (stdout from the extension + our wrapper's structured metadata).

**Error handling:**
- Audit logging wrapped in try/catch that swallows errors (line 171–173) — audit failure never crashes the CLI.
- File I/O errors during config load/write are caught and logged to stderr but do not halt the command (e.g., main.ts:1582, 3044, 3106).
- No systematic error-level logging; errors are surfaced ad-hoc via stderr writes.

**Would it benefit from `env.paths.logs`?**
- Yes, strongly. The CLI manually composes log paths (e.g., `~/.adhd/sox-ecosystem/run/logs/`) and daily-rotates them by hand. `env.paths.logs` with `kind: logs` and `share: per-instance` would eliminate path composition, ensure isolation between concurrent CLI instances, and standardize the daily-rotation pattern.

## File-location table

For every path the package reads or writes:

| current path | kind | new-standard path (global scope) | env accessor |
|---|---|---|---|
| `~/.sox/install-registry.json` | state | `~/.adhd/sox-cli/default/state/install-registry.json` | `env.files.installRegistry` |
| `~/.sox/supervisors.json` | state | `~/.adhd/sox-cli/default/state/supervisors.json` | `env.files.supervisors` |
| `~/.adhd/sox-ecosystem/run/sox-audit.jsonl` | logs | `~/.adhd/sox-cli/default/logs/audit.jsonl` | `env.files.auditLog` |
| `~/.adhd/sox-ecosystem/run/logs/<extId>-backend-YYYY-MM-DD.log` | logs | `~/.adhd/sox-cli/default/logs/<extId>-backend-YYYY-MM-DD.log` | `env.paths.logs/<extId>-backend-YYYY-MM-DD.log` |
| `~/.adhd/sox-ecosystem/extensions.json` | config | `~/.adhd/sox-cli/default/config/extensions.json` | `env.files.extensionsConfig` |
| `~/.adhd/sox-ecosystem/extensions.lock` | state | `~/.adhd/sox-cli/default/state/extensions.lock` | `env.files.extensionsLock` |
| `~/.adhd/sox-ecosystem/supervisors.json` | state | `~/.adhd/sox-cli/default/state/supervisors.json` | `env.files.supervisors` |
| `~/.adhd/sox-ecosystem/registry.json` | data | `~/.adhd/sox-cli/default/data/registry.json` | `env.files.registry` |
| `~/.adhd/sox-ecosystem/run/supervisors/` | state | `~/.adhd/sox-cli/default/state/supervisors/` | `env.paths.state/supervisors` |
| `~/.adhd/sox-ecosystem/ext/` | state | `~/.adhd/sox-cli/default/state/ext/` | `env.paths.state/ext` |
| `<root>/.sox/registry.json` | data | `~/.adhd/sox-cli/default/data/service-registry.json` | `env.files.serviceRegistry` |

Project-scope variant: Same subtree rooted at `<projectRoot>/.adhd/sox-cli/<namespace>/…` where `<namespace>` = `default`.
