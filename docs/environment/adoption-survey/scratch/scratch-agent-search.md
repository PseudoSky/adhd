---
package: scratch-agent-search
path: /Users/nix/dev/ai/scratch/agent-browser
root: scratch
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: [SCRATCH_FETCH_VERBOSE, SEARCH_AUDIT_MAX_SIZE, SEARCH_AUDIT_PATH]
writes: [{path: /tmp/stealth-browser-heartbeat, kind: run, purpose: multi-process idle coordination}, {path: ~/.adhd/reverse/data/tripwire/<provider>.lock, kind: data, purpose: per-provider ban locks}, {path: ~/.adhd/reverse/data/audit.log, kind: logs, purpose: audit trail}]
config_files: []
logging:
  has_logging: true
  logger: console
  persists_log_files: true
  log_destination: ~/.adhd/reverse/data/audit.log (audit log only; stderr for interactive status)
  structured: true
  error_handling: adhoc
  maps_to_env_logs: true
supported_by_env: partial
gaps: [G1, G2]
value: med
effort: low
recommend: adopt
---

## Current state

**Environment variables:**
- `SCRATCH_FETCH_VERBOSE` · line 253 of search-fetch.ts · optional, toggles verbose challenge logging to stderr
- `SEARCH_AUDIT_MAX_SIZE` · line 65 of search-tripwire.ts · optional, capped audit log in bytes (default 5 × 10^6)
- `SEARCH_AUDIT_PATH` · line 66 of search-tripwire.ts · optional, audit log path (default `~/.adhd/reverse/data/audit.log`)

**Files and directories written:**
- `/tmp/stealth-browser-heartbeat` · line 114 of chrome-manager.ts · heartbeat file: newline-separated `${pid}:${timestamp}` for multi-process idle coordination; written on every activity
- `~/.adhd/reverse/data/tripwire/` · created line 70 of search-tripwire.ts · directory: per-provider `.lock` files; one file per provider (duckduckgo.lock, github.lock, etc.); contains JSON `TripwireRecord`
- `~/.adhd/reverse/data/audit.log` · line 160 of search-tripwire.ts · newline-delimited JSON (NDJSON) audit log; capped at 5 MB by byte count; events: `tripwire-fired`, `tripwire-gate-blocked`, `tripwire-cleared`, `tripwire-resolved`

**Scope behavior:** hardcoded absolute paths. Heartbeat uses `/tmp/` (process-temp, per kernel session). All other state uses `~/.adhd/reverse/data/`, which is hard-coded in search-tripwire.ts (lines 66, 69, 134); no per-project or per-scope isolation.

## Proposed EnvironmentSpec

```typescript
const spec: EnvironmentSpec<SearchConfig> = {
  envPrefixOverride: 'ADHD_SCRATCH_AGENT_SEARCH',
  config: {
    verbose: { type: 'boolean', default: false, at: 'runtime', env: 'VERBOSE', secret: false },
    auditMaxSize: { type: 'integer', default: 5 * 1024 * 1024, env: 'AUDIT_MAX_SIZE', minimum: 100_000, secret: false },
    cdpHost: { type: 'string', default: '127.0.0.1:9222', env: 'CDP_HOST', secret: false },
    idleTimeoutMs: { type: 'integer', default: 120_000, env: 'IDLE_TIMEOUT_MS', minimum: 5000, secret: false },
    challengeWaitMs: { type: 'integer', default: 25_000, env: 'CHALLENGE_WAIT_MS', minimum: 0, secret: false },
  },
  dirs: [
    { key: 'tripwire', kind: 'data', share: 'per-instance' },
    { key: 'audit', kind: 'logs', share: 'per-instance' },
    { key: 'heartbeat', kind: 'run', share: 'per-instance' },
  ],
  files: [
    { key: 'auditLog', in: 'audit', name: 'audit.log' },
  ],
  share: 'per-instance',
}
```

## Gap detail

- **G1**: `SCRATCH_FETCH_VERBOSE` reads a non-prefixed direct env var (not `ADHD_SCRATCH_AGENT_SEARCH_VERBOSE`). The package drives this via `-v` / `--verbose` CLI flag, which takes precedence; env-override is a convenience for CI. `@adhd/environment`'s prefix model supports this via `env.isEnvNameAllowed()`, but the current code doesn't guard it — a stray `VERBOSE` or `DEBUG` in the shell clobbers the intended semantic.
- **G2**: Heartbeat written to `/tmp/stealth-browser-heartbeat` — a process-temp directory outside user home. The rationale is OS-session isolation: the heartbeat should NOT persist across reboots (if the machine reboots, old PIDs are dead anyway, and the heartbeat is best-effort). `@adhd/environment` supports `kind:run`, which defaults to `~/.adhd/<project>/<namespace>/run/` and is intended for ephemeral runtime state; the migration path is to use `env.paths.heartbeat + '/stealth.lock'` instead and document that the `run/` dir is cleaned by ops at boot (standard for systemd temp dirs, common in user `.adhd` setups).

## Logging audit

**has_logging:** true
- Package logs three categories: (1) Chrome lifecycle events (start, shutdown, idle timeout) → stderr via `chrome-manager.ts` line 41 `defaultLogger`; (2) tripwire state changes (fired, blocked, cleared, resolved) → disk-persisted audit log (NDJSON); (3) challenge status (Cloudflare wait, timeout, cleared) → stderr via `search-fetch.ts` line 191–215.

**logger:** console + custom NDJSON
- Interactive logs (chrome lifecycle, challenge status) use `console.error` (stderr), routed through a single `defaultLogger` function.
- Audit log is custom NDJSON, not structured JSON per line (each line is a stringified `AuditEntry` object), stored in `~/.adhd/reverse/data/audit.log`.

**persists_log_files:** true
- `~/.adhd/reverse/data/audit.log` is persisted to disk and capped at 5 MB (oldest 50% trimmed when exceeded).
- Lifecycle and challenge logs go to stderr only (ephemeral, not persisted).

**log_destination:** mixed
- Interactive: `stderr` (unbuffered, visible in terminal)
- Audit: `~/.adhd/reverse/data/audit.log` (persisted NDJSON)

**structured:** partial
- Audit log is structured (each line is a JSON object with `event`, `ts`, `provider`, `searchSessionId`, etc.), facilitating machine parsing and grep.
- Interactive logs are plaintext: `[chrome-manager] shutting down...`, `🔓 [fetch] Challenge detected...`.

**error_handling:** adhoc
- Errors in heartbeat read/write are caught and ignored (lines 107–116 of chrome-manager.ts: `try { … } catch { /* best effort */ }`).
- Errors in audit log write are caught and ignored (lines 158–161 of search-tripwire.ts: `try { … } catch { /* best effort */ }`).
- No explicit error-level logging; errors silently degrade (heartbeat unsynced, audit entry dropped).
- The tripwire mechanism itself is an error-handling pattern: if a provider is banned, the record is persisted and checked before the next search, with user prompts to retry or clear.

**maps_to_env_logs:** true
- The audit log (`audit.log`) is a perfect fit for `env.paths.logs` (kind:`logs`). The current hardcoded path `~/.adhd/reverse/data/audit.log` would become `env.paths.audit + '/audit.log'` or, if using env's single-file support, `env.files.auditLog`. This would (a) make it portable across scopes (global vs. project), (b) allow per-instance audit files via multi-instance policy, (c) surface it in observability tools that scan `~/.adhd/<project>/<namespace>/logs/`.

## File-location table — corrected to the new standard

| current path | kind | new-standard path (global scope) | env accessor |
|---|---|---|---|
| `/tmp/stealth-browser-heartbeat` | run | `~/.adhd/scratch-agent-search/default/run/stealth.lock` | `env.paths.heartbeat + '/stealth.lock'` |
| `~/.adhd/reverse/data/tripwire/<provider>.lock` | data | `~/.adhd/scratch-agent-search/default/data/tripwire/<provider>.lock` | `env.paths.tripwire + '/<provider>.lock'` |
| `~/.adhd/reverse/data/audit.log` | logs | `~/.adhd/scratch-agent-search/default/logs/audit.log` | `env.files.auditLog` |

**Project-scope variant:** when `ADHD_ENV_SCOPE=project` or `.adhd` marker is detected, all paths root at `<projectRoot>/.adhd/scratch-agent-search/default/…` instead of `~/.adhd/scratch-agent-search/default/…`. The `heartbeat/`, `tripwire/`, and `audit.log` locations remain the same relative to that root, preserving multi-instance isolation.
