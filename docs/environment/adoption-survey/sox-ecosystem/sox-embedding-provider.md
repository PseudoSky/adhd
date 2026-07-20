---
package: @adhd/sox-embedding-provider
path: /Users/nix/dev/ai/sox-ecosystem/libs/data/embed/embedding-provider
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: xdg
env_vars: [SOX_EMBED_CACHE_DIR, XDG_CACHE_HOME, SOX_EMBED_WARMUP_TIMEOUT_MS]
writes: [{path: "~/.cache/sox/models/<modelId>/main/model.onnx", kind: "cache", purpose: "ONNX model binary"}, {path: "~/.cache/sox/models/<modelId>/main/model.onnx.sha256", kind: "cache", purpose: "SHA-256 verification sidecar"}]
config_files: []
logging:
  has_logging: false
  logger: none
  persists_log_files: false
  log_destination: "none"
  structured: false
  error_handling: robust
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G1, G5]
value: high
effort: medium
recommend: adopt
---

## Current state

- **Env var `SOX_EMBED_CACHE_DIR`** (index.ts:209) · optional override for model cache directory · no default in code
- **Env var `XDG_CACHE_HOME`** (index.ts:285) · standard XDG spec for cache root · fallback to `~/.cache`
- **Env var `SOX_EMBED_WARMUP_TIMEOUT_MS`** (index.ts:261) · optional timeout budget for ONNX model warmup during provider initialization · default 180_000 (3 minutes)
- **Config path resolution (index.ts:207-210):** `config.options.cacheDir` → `SOX_EMBED_CACHE_DIR` → `$XDG_CACHE_HOME/sox/models` → `~/.cache/sox/models`
- **Writes:** Model binaries downloaded to `<cacheDir>/<modelId>/main/model.onnx` + `<cacheDir>/<modelId>/main/model.onnx.sha256` (cache.ts:66-68, 100, 127, 186, 216)
- **Error handling:** Loud-fail via `ResolutionError` (factory-time) and `TransientEmbeddingError`/`PermanentEmbeddingError` (runtime); no silent downgrades (index.ts:48-69)
- **Logging:** No persistent logs; errors are thrown to caller or posted to worker/process port (embedWorker.ts:344-348, fastembedProcessHost.ts:173, cache.ts:113-114)
- **Config shape:** Open-ended `EmbeddingProviderConfig.options` object allows arbitrary keys (`apiKey`, `endpoint`, `dimensions`, `cacheDir`); no strict schema validation

---

## Proposed `EnvironmentSpec`

```typescript
import { EnvironmentSpec } from '@adhd/environment';

const spec: EnvironmentSpec<{
  cacheDir?: string;
  warmupTimeoutMs?: number;
  apiKey?: string;
  endpoint?: string;
  dimensions?: number;
}> = {
  config: {
    cacheDir: {
      type: 'string',
      env: 'SOX_EMBED_CACHE_DIR',
      at: 'runtime',
      default: undefined, // falls through to XDG cascade below
    },
    warmupTimeoutMs: {
      type: 'integer',
      env: 'SOX_EMBED_WARMUP_TIMEOUT_MS',
      at: 'runtime',
      default: 180_000,
      minimum: 1,
    },
    apiKey: {
      type: 'string',
      env: 'SOX_EMBED_API_KEY',
      at: 'runtime',
      secret: true,
    },
    endpoint: {
      type: 'string',
      env: 'SOX_EMBED_ENDPOINT',
      at: 'runtime',
    },
    dimensions: {
      type: 'integer',
      env: 'SOX_EMBED_DIMENSIONS',
      at: 'runtime',
      default: 768,
      minimum: 1,
    },
  },
  dirs: {
    cache: { kind: 'cache', share: 'per-instance' },
  },
  files: [],
  envPrefixOverride: 'SOX_EMBED',
};
```

---

## Gap detail

- **G1:** `XDG_CACHE_HOME` is a standard XDG env var (non-`ADHD_*` prefix). @adhd/environment's `envPrefixOverride` cannot guard it. Mitigation: explicitly declare it in spec as a read-once at boot (list in `spec.env` or document as a known external dependency). The current code's fallback to `~/.cache` is safe; env-scoped resolution (`project` vs `global`) would then manage the sox-specific subdirs.

- **G5:** `config.options` is an open-ended map. Strict FieldSpec dot-paths (`cacheDir`, `apiKey`, `endpoint`, `dimensions`, `warmupTimeoutMs`) can be pinned in the spec above; any future arbitrary keys (e.g. `config.options.customSetting`) would still require runtime validation or a union type. Current code has no validation — it silently ignores unknown keys and uses `.apiKey` as a destructured fallback.

## Logging audit

- **has_logging:** false
- **logger:** none — only error *throwing* via ResolutionError / TransientEmbeddingError
- **persists_log_files:** false
- **log_destination:** none (errors are thrown or posted to worker/process, not written to disk)
- **structured:** N/A
- **error_handling:** robust — factory throws synchronously or rejects on ResolutionError; runtime errors thrown/posted with full message context (embedWorker.ts:343-347, fastembedProcessHost.ts:172-173)
- **maps_to_env_logs:** false — no observability hook into `env.paths.logs`. Would benefit from optional structured logging (JSON to disk under `env.paths.logs`) for long-running embed batches in production; currently silent except on exception.

## File-location table — corrected to the new standard

| current path | kind | new-standard path (global scope) | env accessor |
|---|---|---|---|
| `~/.cache/sox/models/<modelId>/main/model.onnx` | cache | `~/.adhd/sox-embedding-provider/default/cache/models/<modelId>/main/model.onnx` | `env.paths.cache/models/<modelId>/main/model.onnx` |
| `~/.cache/sox/models/<modelId>/main/model.onnx.sha256` | cache | `~/.adhd/sox-embedding-provider/default/cache/models/<modelId>/main/model.onnx.sha256` | `env.paths.cache/models/<modelId>/main/model.onnx.sha256` |

**Project-scope variant:** same subtree rooted at `<projectRoot>/.adhd/sox-embedding-provider/default/cache/…` when scope is `project` (auto-detected by `.git` marker or `ADHD_ENV_SCOPE=project`).
