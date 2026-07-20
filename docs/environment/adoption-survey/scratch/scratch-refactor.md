---
package: scratch-refactor
path: /Users/nix/dev/ai/scratch/refactor
root: scratch
language: node
self_internal: false
current_scope_behavior: cwd-relative
env_vars: []
writes: [{path: "grammars/cache/", kind: "cache", purpose: "grammar node-types.json cache"}, {path: "grammars/cache/.index.json", kind: "cache", purpose: "cache manifest with SHA256 hashes"}, {path: "test/cases/", kind: "data", purpose: "test case definitions and calibration output"}, {path: "tmpdir()/refactor-dag-*", kind: "temp", purpose: "parse/op/render temp files for DAG orchestration"}]
config_files: ["grammars/sources.json"]
logging:
  has_logging: true
  logger: console
  persists_log_files: false
  log_destination: "stdout/stderr only"
  structured: false
  error_handling: adhoc
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G10]
value: med
effort: low
recommend: adopt-after-gap
---

## Current state

**Environment variables:** None read.

**Writes:**
- `grammars/cache/` (and `grammars/cache/{lang}.json`, `grammars/cache/.index.json`) — downloaded grammar node-types.json caches with SHA256 index
- `test/cases/*.json` — test case definitions, updated in-place during calibration
- `tmpdir()/refactor-dag-*` — ephemeral parse/op/render working files, cleaned up after DAG runs
- Target files (any file passed via `applyLive(result)`) — written back with edits in-place

**Config files:**
- `grammars/sources.json` — map of grammar language → GitHub repo + optional path to node-types.json

**Scope/paths:** Cwd-relative and repo-root-relative. Scripts run from project root; `grammars/` and `test/cases/` are repo-local. Temp files scatter into system `tmpdir()`.

## Proposed EnvironmentSpec

```typescript
const spec: EnvironmentSpec<Config> = {
  config: {
    cacheEnabled: { type: 'boolean', default: true, at: 'runtime' },
  },
  dirs: [
    { name: 'cache', kind: 'cache', share: 'shared' },
    { name: 'temp', kind: 'temp', share: 'per-instance' },
    { name: 'testData', kind: 'data', share: 'shared' },
  ],
  files: [
    { name: 'cacheIndex', in: 'cache', name: '.index.json' },
    { name: 'sources', in: 'cache', name: 'sources.json' }, // or read from repo if non-portable
  ],
  envPrefixOverride: 'SCRATCH_REFACTOR',
};

type Config = typeof spec;

export async function useEnv(): Promise<{ cache: string; temp: string; testData: string; }> {
  const env = new Environment(spec);
  return {
    cache: env.paths.cache,
    temp: env.paths.temp,
    testData: env.paths.testData,
  };
}
```

## Gap detail

- **G10** — No persistent log files. Logs emit to console only. Would benefit from `env.paths.logs` (kind:`logs`, `share:'per-instance'` to avoid collisions during parallel calibration). Currently no logging rotation or retention.

## Logging audit

The package emits logs via `console.log()`, `console.warn()`, and `console.error()`:
- `scripts/update-grammar-cache.ts` logs download status, cache hits/misses, and errors (lines 83, 108).
- `scripts/calibrate-dag.ts` logs calibration progress and counts (lines 94, 98-99).
- `src/ops/dag-ops.ts` logs parse/render/read-json results via `preview` fields (no direct console calls in flagged file).

All output is plaintext, unstructured, sent to stdout/stderr. No file rotation, no structured JSON logs, no persistent log directory. Error handling is minimal — fetch errors in update-grammar-cache are caught and reported as "FAIL", but no stack traces or error detail. Logs are transient (lost on process exit).

**Would adoption of `env.paths.logs` (kind:logs, share:per-instance) help?** Yes — if calibration DAGs run in parallel across multiple instances, each would write unique logs to a per-instance subdirectory, eliminating file contention and improving debuggability. Currently all logs collapse into shared stdout.

## File-location table — corrected to the new standard

| current path | kind | new-standard path (global scope) | env accessor |
|---|---|---|---|
| `grammars/cache/{lang}.json` | cache | `~/.adhd/scratch-refactor/default/cache/{lang}.json` | `env.paths.cache + '/{lang}.json'` |
| `grammars/cache/.index.json` | cache | `~/.adhd/scratch-refactor/default/cache/.index.json` | `env.files.cacheIndex` |
| `tmpdir()/refactor-dag-*` | temp | `~/.adhd/scratch-refactor/default/temp/refactor-dag-*` | `env.paths.temp + '/' + randomId()` |
| `test/cases/*.json` | data | `~/.adhd/scratch-refactor/default/data/cases/*.json` | `env.paths.testData + '/cases/'` |

**Project scope:** When `ADHD_ENV_SCOPE=project` or `.git` marker is detected, the same subtree roots at `<projectRoot>/.adhd/scratch-refactor/default/…` instead of `~/.adhd/scratch-refactor/default/…`.
