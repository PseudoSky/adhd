---
package: @adhd/apigen-engine-conformance
path: /Users/nix/dev/node/adhd/packages/apigen/apigen-engine-conformance
root: adhd
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes: [{path: "os.tmpdir()/apigen-gate-matrix-*.py", kind: temp, purpose: "Python conformance matrix script"}, {path: "os.tmpdir()/apigen-gate-vectors-*.json", kind: temp, purpose: "Vector test cases JSON"}]
config_files: ["packages/apigen/python/apigen_logical.py", "packages/apigen/hosts/**/host-manifest.json", "nx.json"]
logging:
  has_logging: true
  logger: console
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: false
  error_handling: robust
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G3, G2]
value: low
effort: low
recommend: skip
---

## Current state

- **Env vars:** None read.
- **Writes:** Temp files written to `os.tmpdir()` with auto-cleanup (lines 669–679):
  - `apigen-gate-matrix-<pid>.py` — Python gate script
  - `apigen-gate-vectors-<pid>.json` — vectors as JSON
- **Config files read:**
  - `packages/apigen/python/apigen_logical.py` (existence check)
  - `packages/apigen/hosts/**/host-manifest.json` (glob discovery)
  - `nx.json` (to find workspace root via upward walk)
- **Scope/paths:** Hardcoded absolute/relative paths. Workspace root discovered by walking up from `__dirname` or `process.cwd()` until `nx.json` found. Temp files always in system temp.
- **Logging:** Plain-text to `console.log` / `console.error`. No persisted log files.

## Proposed `EnvironmentSpec`

This package has no runtime configuration surface — it is purely a test/gate runner with hardcoded artifact paths. Adopting `@adhd/environment` would provide:

```typescript
const conformanceSpec = {
  // No config fields; gates don't have tunable runtime parameters.
  dirs: {
    temp: { kind: 'temp', share: 'per-instance' },  // Matrix script & vectors
  },
  files: {},
  envPrefixOverride: 'ADHD_APIGEN_CONFORMANCE',
} as const;

type ConformanceEnv = InstanceType<typeof Environment<typeof conformanceSpec>>;
```

Usage:
```typescript
const env = new Environment(conformanceSpec);
const tmpDir = env.paths.temp;  // ~/.adhd/apigen-engine-conformance/default/temp/
// Write matrix script & vectors there, clean up on exit
```

## Gap detail

- **G3** — Python subprocess execution. The gate embeds a Python script and spawns `python3` (line 632). There is no Python support in `@adhd/environment` (Node/TS only). The gate will always require direct subprocess/Python calls.
- **G2** — Current write target is `os.tmpdir()`, not a project-managed scope. Adopting env would relocate temp files to `~/.adhd/apigen-engine-conformance/default/temp/`, which is outside the system temp dir but still ephemeral.

## Logging audit

The gate emits diagnostic output to `console.log` (lines 922–963 show host results, vectors passed/failed, detailed error messages) and `console.error` (lines 931, 970 for FATAL and gate failure). No files are persisted; all output is stdout/stderr only.

Error handling is robust: the gate wraps subprocess invocation in try/catch (line 867), catches vector decode/invariant failures and logs them (lines 283–335), and has explicit error messages for each phase (encode, decode, invariant, negative-control, supported-ids).

**Would adopting `env.paths.logs` help?** No. The gate is a CI/test runner, not a long-lived service. All diagnostic output is meant for the terminal and CI logs. Routing to a persistent `env.paths.logs` (kind:`logs`, `share:'per-instance'`) would create noise in the user's `~/.adhd/` and add no value.

## File-location table — corrected to the new standard

| current path | kind | new-standard path (global scope) | env accessor |
|---|---|---|---|
| `os.tmpdir()/apigen-gate-matrix-*.py` | temp | `~/.adhd/apigen-engine-conformance/default/temp/apigen-gate-matrix.py` | `env.paths.temp/<file>` |
| `os.tmpdir()/apigen-gate-vectors-*.json` | temp | `~/.adhd/apigen-engine-conformance/default/temp/apigen-gate-vectors.json` | `env.paths.temp/<file>` |

When the active scope is `project` (auto-detected by `.git`/`.adhd` marker or `ADHD_ENV_SCOPE=project`), the same subtree is rooted at: `<projectRoot>/.adhd/apigen-engine-conformance/default/temp/…`
