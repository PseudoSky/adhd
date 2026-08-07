---
package: "@adhd/dispatch-cli"
path: "/Users/nix/dev/node/adhd/entrypoint/dispatch-cli"
root: adhd
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes: [{path: "~/.adhd/dispatch-calibration.json", kind: "config", purpose: "model-tier B-cost calibration store"}, {path: "tmp/dispatch-cli/run-debug", kind: "temp", purpose: "mock agent runner debug artifacts (dry-run only)"}]
config_files: ["~/.adhd/dispatch-calibration.json"]
logging:
  has_logging: false
  logger: none
  persists_log_files: false
  log_destination: "none"
  structured: false
  error_handling: adhoc
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G2]
value: high
effort: low
recommend: adopt
---

## Current state

**Environment Variables:** None read directly by this package.

**Writes:**
- **`~/.adhd/dispatch-calibration.json`** · config · Contains JSON map of `ModelTier` → `measuredB` (baseline token cost per tier). Hardcoded path via `DEFAULT_CALIBRATION_PATH` (line 274). Read via `readFileSync` (line 319), merged, written via `writeFileSync` (line 368). Created by `calibrateCore()` on each model-tier calibration run.
- **`tmp/dispatch-cli/run-debug/`** · temp · Mock-agent dry-run debug output. Path is `process.cwd()`-relative via `DEFAULT_RUN_DEBUG_DIR` constant (line 217). Created by `MockAgentRunner` to dump inspectable artifacts; only written when `dryRun: true`.

**Config Files:** Single file — `dispatch-calibration.json` — read as JSON, merged with new tier measurements, reserialized.

**Scope Behavior:** Hardcoded paths. Debug output is `cwd`-relative (scatters across consumers' working directories if they run from different paths). Calibration is locked to `~/.adhd/` with no override mechanism. No env-var reads; no prefix model applied.

## Proposed `EnvironmentSpec`

```typescript
const dispatchCliSpec: EnvironmentSpec<{
  calibrationFile: string;
  runDebugDir: string;
}> = {
  defaults: {
    calibrationFile: 'dispatch-calibration.json',
    runDebugDir: 'run-debug',
  },
  config: {
    calibrationFile: {
      type: 'string',
      env: 'CALIBRATION_FILE',
      default: 'dispatch-calibration.json',
      at: 'runtime',
      secret: false,
    },
    runDebugDir: {
      type: 'string',
      env: 'RUN_DEBUG_DIR',
      default: 'run-debug',
      at: 'runtime',
      secret: false,
    },
  },
  dirs: {
    config: { kind: 'config' },
    temp: { kind: 'temp' },
  },
  files: {
    calibration: { in: 'config', name: 'dispatch-calibration.json' },
  },
  envPrefixOverride: 'ADHD_DISPATCH_CLI',
  share: 'per-instance',
};
```

## Gap detail

- **G2** · `tmp/dispatch-cli/run-debug/` is `cwd`-relative (via `process.cwd()` at line 217). `@adhd/environment` restricts directories to named `kind` entries under the scope root (`.adhd/<project>/<namespace>/`). Must migrate to `env.paths.temp` instead. This is the only blocking gap; all other surface is scope-ready.

## Logging audit

**Has logging:** No. The flagged file imports no logging library (console, pino, winston, log4js, custom). Error conditions throw exceptions (lines 67, 264) without logging or error-level propagation.

**Logger mechanism:** none.

**Persists log files:** No — does not write `.log` files to disk.

**Log destination:** none — errors are thrown, not logged.

**Structured logging:** Not applicable (no logging subsystem).

**Error handling:** adhoc. Errors are thrown without try/catch or error-level logging within this module. The calling `api.ts` (not flagged) is responsible for catching and reporting to the CLI user.

**Maps to `env.paths.logs`:** No — there is no logging infrastructure to route. Adding structured logging (e.g., pino with `env.paths.logs` transport) would be a secondary improvement post-adoption.

## File-location table — corrected to new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| `~/.adhd/dispatch-calibration.json` | config | `~/.adhd/dispatch-cli/default/config/dispatch-calibration.json` | `env.files.calibration` |
| `tmp/dispatch-cli/run-debug` | temp | `~/.adhd/dispatch-cli/default/temp/run-debug` | `env.paths.temp` |

**Project-scope variant** (when `ADHD_ENV_SCOPE=project` or `.git`/`.adhd` marker selects project scope):
- Calibration: `<projectRoot>/.adhd/dispatch-cli/default/config/dispatch-calibration.json`
- Debug dir: `<projectRoot>/.adhd/dispatch-cli/default/temp/run-debug`

Current `tmp/dispatch-cli/` lives at repo root, shared across all invocations. Per-instance scoping (`share: 'per-instance'`) with the `~/.adhd/…` structure allows concurrent runs to use isolated debug directories.
