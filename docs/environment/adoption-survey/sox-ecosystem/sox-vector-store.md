---
package: @adhd/sox-vector-store
path: /Users/nix/dev/ai/sox-ecosystem/libs/data/vectors/vector-store
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: none
env_vars: []
writes: [{path: "<caller-supplied>", kind: data, purpose: "SQLite DB / LanceDB table storage"}, {path: "<caller-supplied>-wal", kind: data, purpose: "SQLite WAL journal"}, {path: "<caller-supplied>-shm", kind: data, purpose: "SQLite shared memory"}]
config_files: []
supported_by_env: no
gaps: []
value: low
effort: low
recommend: skip
---

## Current state

This is a library package with **no runtime configuration surface of its own**. All configuration is API-driven and delegated to callers.

**Database paths:** Both vector backends require explicit path arguments:
  - `SqliteVectorBackend(db: Database.Database)` — caller constructs and passes the Database instance
  - `openVectorStore(path: string, opts: { dim, modelId })` — caller supplies path
  - `LanceDbVectorBackend(config: LanceDbVectorBackendConfig & { db })` — caller provides `lancedbPath` in config

**Index configuration (LanceDB only):** Optional `config.index` with fields for HNSW/IVF-PQ tuning (M, efConstruction, numPartitions, bitsPerSubVector, metric).

**No environment variables:** Package reads zero env vars.

**No config files:** Package reads zero config files.

**Writes:** SQLite DB files (including WAL/SHM) and LanceDB table directories at caller-supplied paths. All paths are explicit arguments, not hardcoded or scoped.

## Proposed `EnvironmentSpec`

```typescript
import type { EnvironmentSpec } from '@adhd/environment';
import type { LanceDbVectorBackendConfig } from '@adhd/sox-vector-store';

export const vectorStoreEnv = {
  sqliteDbPath: {
    type: 'string' as const,
    env: 'VECTOR_STORE_SQLITE_PATH',
    default: './.adhd/vector-store/default.db',
    at: 'runtime' as const,
  },
  lancedbPath: {
    type: 'string' as const,
    env: 'VECTOR_STORE_LANCEDB_PATH',
    default: './.adhd/vector-store/lancedb',
    at: 'runtime' as const,
  },
  lancedbIndex: {
    type: 'string' as const,  // JSON serialized: 'hnsw' | 'ivf-pq'
    env: 'VECTOR_STORE_LANCEDB_INDEX_TYPE',
    default: 'hnsw',
    at: 'runtime' as const,
  },
} satisfies EnvironmentSpec;
```

If callers adopted this (optional), they could read DB paths from env/config rather than hardcoding them.

## Gap detail

No gaps. The package has zero configuration ownership.

## File-location table

| current path | kind | proposed env.paths/env.files key |
|---|---|---|
| caller-provided (SqliteVectorBackend) | data | `env.config.sqliteDbPath` |
| caller-provided (LanceDbVectorBackend) | data | `env.config.lancedbPath` |
| caller-provided (index config) | config | `env.config.lancedbIndex` (if adopted) |

---

## Notes

**This package is library-first, not config-first.** It exports a `VectorBackend` interface with two concrete implementations (Sqlite, LanceDB). Callers are responsible for:
  1. Constructing or providing the Database/path
  2. Choosing the backend
  3. Deciding where to store data

**No adoption value without a wrapping entrypoint.** A library that always receives paths as arguments has no built-in env/config needs. The value of `@adhd/environment` would only appear if:
  - This library were wrapped in an entrypoint (CLI, server, or daemon) that instantiates it
  - That entrypoint wanted to read DB paths from env/config/scoped dirs instead of hardcoding them

**Recommendation: skip.** Do not migrate this package. If a consuming entrypoint (e.g., an agent-mcp plugin or sox data service) wants env-scoped DB paths, that entrypoint should adopt `@adhd/environment` and pass the resolved paths into this library's API.
