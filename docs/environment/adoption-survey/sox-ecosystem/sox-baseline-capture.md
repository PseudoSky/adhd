---
package: @adhd/sox-baseline-capture
path: /Users/nix/dev/ai/sox-ecosystem/tools/baseline-capture
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: cwd-relative hardcoded
env_vars: []
writes: [{path: "docs/plan/runtime-productionization/_shared/baselines/enrichment-baseline-snapshot.db", kind: data, purpose: "SQLite snapshot of live memory store for enrichment baseline"}, {path: "docs/plan/runtime-productionization/_shared/baselines/enrichment-parity.json", kind: data, purpose: "Enrichment baseline counters and checksums"}, {path: "docs/plan/runtime-productionization/_shared/baselines/write-perf-temp.db", kind: temp, purpose: "Disposable temp SQLite db for write-perf measurement"}, {path: "docs/plan/runtime-productionization/_shared/baselines/write-perf.json", kind: data, purpose: "Write-perf p50/p99 measurements"}]
config_files: []
supported_by_env: no
gaps: [G2]
value: low
effort: low
recommend: skip
---

## Current state

**Env vars:** None. All configuration is passed as function options with sensible defaults.

**Writes:**
- `docs/plan/runtime-productionization/_shared/baselines/enrichment-baseline-snapshot.db` · data · Snapshot of live memory store (WAL-checkpointed copy via `copyFileSync`)
- `docs/plan/runtime-productionization/_shared/baselines/enrichment-parity.json` · data · Baseline JSON with batch-enrich result counters and snapshot sha256
- `docs/plan/runtime-productionization/_shared/baselines/write-perf-temp.db` · temp · Disposable SQLite store for write-perf timing measurement (+ `-wal`, `-shm` WAL files)
- `docs/plan/runtime-productionization/_shared/baselines/write-perf.json` · data · Baseline JSON with p50/p99 latency measurements

**Reads:**
- `~/.memory/memory.db` · live memory store snapshot source (hardcoded via `join(homedir(), '.memory', 'memory.db')`)
- Default baseline directory resolved from `process.cwd()`: `docs/plan/runtime-productionization/_shared/baselines`

**Config:** No config files or environment variables. Configuration surface is function parameters with defaults (e.g., `CaptureEnrichmentBaselineOptions.liveDbPath`, `CaptureEnrichmentBaselineOptions.snapshotDir`). Scope is determined entirely by `process.cwd()` when invoked.

## Proposed `EnvironmentSpec`

This package is development tooling (not published, `private: true`). Its current design — hardcoded, deterministic paths with optional function-parameter overrides — is appropriate for baseline capture. Adoption is not recommended, but the spec below shows the shape if alignment were needed:

```typescript
const spec: EnvironmentSpec<{
  enrichmentLiveDbPath: string;
  enrichmentSnapshotDir: string;
  writePerfBaselineDir: string;
  batchEnrichClusterThreshold: number;
  batchEnrichNodeCap: number;
}> = {
  config: {
    enrichmentLiveDbPath: {
      type: 'string',
      env: 'ENRICHMENT_LIVE_DB_PATH',
      default: '~/.memory/memory.db',
      description: 'Absolute path to the live memory store',
    },
    enrichmentSnapshotDir: {
      type: 'string',
      env: 'ENRICHMENT_SNAPSHOT_DIR',
      default: './docs/plan/runtime-productionization/_shared/baselines',
      description: 'Output directory for enrichment baseline snapshot and JSON',
    },
    writePerfBaselineDir: {
      type: 'string',
      env: 'WRITE_PERF_BASELINE_DIR',
      default: './docs/plan/runtime-productionization/_shared/baselines',
      description: 'Output directory for write-perf baseline JSON and temp DB',
    },
    batchEnrichClusterThreshold: {
      type: 'number',
      env: 'BATCH_ENRICH_CLUSTER_THRESHOLD',
      default: 0.82,
      minimum: 0,
      maximum: 1,
    },
    batchEnrichNodeCap: {
      type: 'integer',
      env: 'BATCH_ENRICH_NODE_CAP',
      default: 10000,
      minimum: 1,
    },
  },
  dirs: {
    baselines: {
      kind: 'data',
      default: './docs/plan/runtime-productionization/_shared/baselines',
    },
  },
  envPrefixOverride: 'SOX_BASELINE_CAPTURE',
};
```

## Gap detail

**G2** · Hardcoded repo-relative path `docs/plan/runtime-productionization/_shared/baselines` (defaults in both functions resolve via `process.cwd()`, not a scoped root). Also hardcoded homedir-relative path `~/.memory/memory.db` for live store source. @adhd/environment's `env.paths` and `env.files` would normalize these under a project-scoped root, but this package intentionally uses deterministic paths for baseline reproducibility.

## File-location table

| Current path | Kind | Proposed env.paths/env.files key |
|---|---|---|
| `~/.memory/memory.db` | source (read-only) | `env.files.enrichmentLiveDb` (in: `homedir`, name: `memory.db`) |
| `docs/plan/runtime-productionization/_shared/baselines/enrichment-baseline-snapshot.db` | data | `env.paths.baselines` + name |
| `docs/plan/runtime-productionization/_shared/baselines/enrichment-parity.json` | data | `env.paths.baselines` + name |
| `docs/plan/runtime-productionization/_shared/baselines/write-perf-temp.db` | temp | `env.paths.baselines` + name |
| `docs/plan/runtime-productionization/_shared/baselines/write-perf.json` | data | `env.paths.baselines` + name |

