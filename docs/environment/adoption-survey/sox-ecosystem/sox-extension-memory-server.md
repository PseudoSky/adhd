---
package: @adhd/sox-extension-memory-server
path: /Users/nix/dev/ai/sox-ecosystem/extensions/bundles/sox-memory-bundle/members/memory-server
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: [SOX_CONFIG_DB_PATH, SOX_PERM_ENFORCE, SOX_PERM_FS_READ, SOX_PERM_FS_WRITE, SOX_PROXY_BACKEND]
writes: [{path: "~/.memory/memory.db", kind: data, purpose: "SQLite graph store for memory episodes, nodes, topics, embeddings, and enrichment queue"}, {path: "~/.memory/memory.db-wal", kind: data, purpose: "SQLite write-ahead log (if present)"}, {path: "~/.memory/memory.db-shm", kind: data, purpose: "SQLite shared memory file (if present)"}, {path: "<schemaPath>", kind: config, purpose: "Published MCP tools schema for service-proxy cache"}, {path: "<schemaPath>.tmp-<pid>", kind: temp, purpose: "Temporary schema file during atomic write"}]
config_files: [extension.json]
supported_by_env: no
gaps: [G1, G2]
value: low
effort: high
recommend: skip
---

## Current state

**Environment variables read:**
- `SOX_CONFIG_DB_PATH` (string) · resolved in `resolveDbPath()` · no default; falls through to DEFAULT_DB_PATH if unset
- `SOX_PERM_ENFORCE` (flag) · read in `compilePolicyFromEnv()` · no default; absence = enforced=false
- `SOX_PERM_FS_READ` (JSON array) · permission guard, fs allowlist · no default
- `SOX_PERM_FS_WRITE` (JSON array) · permission guard, fs allowlist · no default
- `SOX_PROXY_BACKEND` (flag '1') · checked in memory_ping tool response · indicates backend transport mode

**Files/dirs written:**
- `~/.memory/memory.db` · persistent SQLite store (default) · created on first db open; host-injected `SOX_CONFIG_DB_PATH` overrides
- `~/.memory/memory.db-wal` · SQLite WAL file (ephemeral, may not exist)
- `~/.memory/memory.db-shm` · SQLite SHM file (ephemeral, may not exist)
- `<schemaPath>` · MCP tools schema JSON (written once per backend start) · atomic via temp file
- `<schemaPath>.tmp-<pid>` · temp staging file, removed after rename to schemaPath

**Config files:**
- `extension.json` · side-loaded manifest file (discovered relative to entry path, not searched)

**Scope/path resolution:**
- Hardcoded `DEFAULT_DB_PATH = '~/.memory/memory.db'`
- Per-call override: explicit `db_path` arg → `SOX_CONFIG_DB_PATH` env var → DEFAULT_DB_PATH
- No per-project or per-instance scoping; all tools use the same store by default
- `socketPath` and `schemaPath` passed as function arguments (runBackend opts), not from config/env
- No per-instance, per-user, or per-project isolation — all callers share one store

## Proposed `EnvironmentSpec`

```typescript
const spec: EnvironmentSpec<{
  store: {
    db_path: string;  // dot-path for nested config
  };
  perm: {
    enforce: boolean;
    fs_read: string[];
    fs_write: string[];
  };
  proxy: {
    backend: boolean;
  };
}> = {
  envPrefixOverride: 'SOX',  // Override cascaded env prefix from package name
  config: {
    'store.db_path': {
      type: 'string',
      env: 'CONFIG_DB_PATH',
      default: '~/.memory/memory.db',
      at: 'runtime',
      description: 'Path to the SQLite memory store',
    },
    'perm.enforce': {
      type: 'boolean',
      env: 'PERM_ENFORCE',
      default: false,
      at: 'runtime',
      description: 'Enable permission enforcement (policy-env guard)',
    },
    'perm.fs_read': {
      type: 'array',
      items: { type: 'string' },
      env: 'PERM_FS_READ',
      default: [],
      at: 'runtime',
      description: 'Allowed file read paths (JSON array of globs/patterns)',
    },
    'perm.fs_write': {
      type: 'array',
      items: { type: 'string' },
      env: 'PERM_FS_WRITE',
      default: [],
      at: 'runtime',
      description: 'Allowed file write paths (JSON array of globs/patterns)',
    },
    'proxy.backend': {
      type: 'boolean',
      env: 'PROXY_BACKEND',
      default: false,
      at: 'runtime',
      description: 'Running in backend (UDS) mode vs. stdio mode',
    },
  },
  dirs: {
    store: {
      kind: 'data',
      description: 'Memory store directory',
    },
  },
  files: {
    schema_cache: {
      in: 'store',
      name: 'schema.json',
      share: 'shared',
      description: 'Published MCP tools schema for service-proxy cache',
    },
  },
};
```

## Gap detail

- **G1** `SOX_CONFIG_DB_PATH`, `SOX_PERM_ENFORCE`, `SOX_PERM_FS_READ`, `SOX_PERM_FS_WRITE`, `SOX_PROXY_BACKEND` — all use the `SOX_*` namespace, not `ADHD_*`. The prefix model in @adhd/environment is `ADHD_<PROJECT>_*`; these vars are SOX-domain-specific and outside that contract. `isEnvNameAllowed()` would reject them as non-ADHD-prefixed.
- **G2** `socketPath` and `schemaPath` arguments passed to `runBackend()` are hardcoded/caller-supplied, not discoverable via config cascade. No built-in directory path resolution for these runtime artifacts.

## File-location table

| current path | kind | proposed env.paths/env.files key |
|---|---|---|
| `~/.memory/memory.db` | data | `env.paths.store` + `env.files.db` |
| `~/.memory/memory.db-wal` | data | (ephemeral, under store) |
| `~/.memory/memory.db-shm` | data | (ephemeral, under store) |
| `<schemaPath>` (arg-supplied) | config | `env.files.schema_cache` (if scoped under store) |
| `extension.json` (manifest) | config | (side-loaded, not managed by env) |
| `socketPath` (UDS arg) | run | (caller-supplied, not config-discoverable) |

