---
package: @adhd/dispatch-orchestrator
path: /Users/nix/dev/node/adhd/packages/dispatch/dispatch-orchestrator
root: adhd
language: node
self_internal: false
current_scope_behavior: injected-toolsRoot-default-cwd
env_vars: []
writes: [{path: "toolsRoot scoped (default cwd)", kind: "unknown", purpose: "fs.move/fs.delete/fs.scaffold tool-call operations"}]
config_files: []
logging:
  has_logging: false
  logger: none
  persists_log_files: false
  log_destination: "none"
  structured: false
  error_handling: adhoc
  maps_to_env_logs: false
supported_by_env: no
gaps: [G2]
value: low
effort: low
recommend: skip
---

## Current state

**Environment variables:** None read. All configuration is dependency-injected (clock, sleep, guardExec, toolCallExec).

**Writes:** `fs.move`, `fs.delete`, `fs.scaffold` tool-call operations are scoped to an injectable `toolsRoot` (defaults to `process.cwd()` if not provided via `OrchestratorDeps`). Paths are validated and escaped — writes outside toolsRoot are rejected as failed outcomes, never executed. All file writes flow through Node.js `fs/promises` API (mkdir, rename, rm, writeFile).

**Config files:** None. The orchestrator consumes:
- A DAG JSON (loaded/persisted via injected `IDagClient`)
- Injected `IOptimizerDeps` (dispatch-core-optimizer)
- Injected `IDispatchAgentRunner` (agent-runner wrapper over agent-mcp)
- Injected optional plugins (io, gitnexus)

**Logging:** None. No console logging, no file logging. Errors are recorded as `DispatchNote` entries in the dispatch_log (in-memory, persisted back to DAG via the client).

**Scope behavior:** All paths are parameterized via `toolsRoot` (OrchestratorDeps). Default is `process.cwd()`, but it's always an injected parameter — no hardcoded `/var`, `/tmp`, or home-dir paths.

## Proposed `EnvironmentSpec`

```typescript
{
  configFields: [],
  dirs: [],
  files: [],
  envPrefixOverride: undefined,
  share: 'per-instance'
}
```

## Gap detail

- **G2:** `fs.move`/`fs.delete`/`fs.scaffold` write to an injectable `toolsRoot` (default `process.cwd()`) — not a filesystem root that maps naturally to `env.paths` kinds (data/logs/cache/state/etc). The toolsRoot is an **execution scope boundary** for sandboxing tool-call operations, not a config/state/cache directory. It should remain injected, not adopted into @adhd/environment.

## Logging audit

No logging. The orchestrator records execution traces (dispatch_log entries: started_at, completed_at, turns, results, notes) purely in memory, appended to the DAG JSON and persisted via the injected IDagClient. There are no file-based logs, no structured logging library (console, pino, winston), no error-level logging mechanism — errors are surfaced as `{ level: 'error', text: '...' }` `DispatchNote` entries in the persisted log.

Would adopting `env.paths.logs` improve visibility? **No.** The orchestrator has no standalone logging lifecycle — it is part of a larger dispatch loop that owns persistence. Log output would belong in the DAG itself (which is already in a user-controlled location, injected via the client), not in a separate logs directory.

## File-location table

| Current path | Kind | New-standard path (global scope) | Env accessor | Notes |
|---|---|---|---|---|
| N/A | N/A | N/A | N/A | No files read or written by this package; all file operations are user-supplied tool-call commands scoped to an injectable `toolsRoot` parameter. |

**Project-scope variant:** When `toolsRoot` is set to `<projectRoot>/.adhd/<project>/`, the same operations occur under that subtree (e.g. `<projectRoot>/.adhd/dispatch-orchestrator/…`).

---

The orchestrator is a **pure orchestration loop**: it marshals execution (agent-mcp, guard shells, tool-call dispatch), persists results via an injected client, and owns nothing on disk. Adoption is not recommended.
