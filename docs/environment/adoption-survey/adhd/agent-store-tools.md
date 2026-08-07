---
package: @adhd/agent-store-tools
path: /Users/nix/dev/node/adhd/packages/agent/agent-store-tools
root: adhd
language: node
self_internal: false
current_scope_behavior: cwd-relative
env_vars:
  - DATABASE_PATH
writes:
  - path: ./data/registry.db
    kind: data
    purpose: SQLite registry store
  - path: ./data/registry.db-wal
    kind: data
    purpose: SQLite write-ahead log (WAL mode)
  - path: ./data/registry.db-shm
    kind: data
    purpose: SQLite shared memory file (WAL mode)
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
gaps:
  - G2
value: high
effort: low
recommend: adopt
---

## Current state

**Environment variables:**
- `DATABASE_PATH` · read in `src/db/client.ts` (line 9) and `drizzle.config.js` (line 11) · default: `./data/registry.db`

**Writes:**
- `./data/registry.db` · data · SQLite canonical registry database; created on first connection via `new Database(resolvedPath)` (src/db/client.ts)
- `./data/registry.db-wal` · data · SQLite write-ahead log file; auto-created by better-sqlite3 when `journal_mode = WAL` is enabled (line 23)
- `./data/registry.db-shm` · data · SQLite shared-memory file; auto-created in WAL mode for concurrent read access

**Config files:**
- `drizzle.config.js` is a build-time config for `drizzle-kit generate`/`migrate` commands; it reads `DATABASE_PATH` env var to determine schema output location, but this file is not a runtime configuration consumed by the package itself — it is tooling-specific.

**Scope behavior:**
- Cwd-relative: default path is hardcoded as `./data/registry.db`, resolved via `path.resolve(databasePath)` which resolves relative to the process's current working directory
- Directory created recursively if missing (lines 15–19, `fs.mkdirSync`)
- No integration with XDG, homedir, or `@adhd/environment` scoping
- Couples store location to caller's working directory — fragile for library consumers that import this store from a different cwd context

## Proposed `EnvironmentSpec`

```typescript
import type { EnvironmentSpec } from '@adhd/environment';

export interface AgentStoreToolsConfig {
  databaseFilename: string;
}

export const agentStoreToolsSpec: EnvironmentSpec<AgentStoreToolsConfig> = {
  config: {
    databaseFilename: {
      type: 'string',
      env: 'DATABASE_PATH',
      default: 'registry.db',
      at: 'runtime',
      secret: false,
      description: 'Filename of the SQLite registry database (not a full path; resolved under env.paths.data)',
    },
  },
  dirs: {
    data: {
      kind: 'data',
      share: 'per-instance',
      description: 'Directory for SQLite registry database and WAL files',
    },
  },
  files: {
    registry: {
      in: 'data',
      name: 'registry.db',
      description: 'SQLite canonical tool and platform registry',
    },
  },
  envPrefixOverride: 'ADHD_AGENT_STORE_TOOLS',
};

// Usage in src/db/client.ts:
// import { Environment } from '@adhd/environment';
// import { agentStoreToolsSpec } from './config.js';
//
// const env = new Environment(agentStoreToolsSpec);
// const databasePath = env.files.registry;  // ~/.adhd/agent-store-tools/default/data/registry.db
//
// const sqlite = new Database(databasePath);
// sqlite.pragma('journal_mode = WAL');
// sqlite.pragma('foreign_keys = ON');
// export const db = drizzle(sqlite, { schema });
```

## Gap detail

- **G2**: Package writes to `./data/registry.db` — a cwd-relative hardcoded default, not under any `@adhd/environment`-managed scope root (`global`, `project`, or `system`). The path should resolve under `env.paths.data` instead. This decouples the store from the caller's working directory and enables multi-instance safe isolation via `share: 'per-instance'`.

## Logging audit

**Summary:** The package has **no logging** (`has_logging: false`, `logger: none`). No logger is imported or used in any of the flagged files.

**Detail:**
- The ToolStore and AgentToolStore classes implement CRUD operations (create, read, update, delete, list, grant, revoke) but emit zero logs — no console, pino, winston, or custom logger.
- Error handling is **robust** (`error_handling: robust`): every operation includes precondition checks and throws typed error codes (ToolStoreError, AgentToolStoreError) with descriptive messages. However, errors are propagated to the caller; there is no error-level logging to a persistent medium.
- **No benefit from `env.paths.logs` today** (`maps_to_env_logs: false`). If observability is added later (debug logs on store operations, mutation audits, performance tracing), a persisted `env.paths.logs/agent-store-tools.log` would improve debuggability.

## File-location table — corrected to the new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| `./data/registry.db` | data | `~/.adhd/agent-store-tools/default/data/registry.db` | `env.files.registry` |
| `./data/registry.db-wal` | data | `~/.adhd/agent-store-tools/default/data/registry.db-wal` | N/A (auto-created sibling) |
| `./data/registry.db-shm` | data | `~/.adhd/agent-store-tools/default/data/registry.db-shm` | N/A (auto-created sibling) |

**Project scope variant:** When the active scope is `project` (auto-detected by `.git`/`.adhd` marker or `ADHD_ENV_SCOPE=project`), paths resolve to `<projectRoot>/.adhd/agent-store-tools/default/data/registry.db` and the same WAL/SHM siblings.

---

## Adoption summary

This is a **high-value, low-effort adoption candidate**. The store already reads `DATABASE_PATH` verbatim, so migration is straightforward:

1. Replace the hardcoded `./data/registry.db` default with `env.files.registry`.
2. Inject an `Environment` singleton at module load time.
3. Update `drizzle.config.js` to use `env.paths.data + '/' + env.config.databaseFilename` (or drop the dynamic path logic if only entrypoint/agent-mcp consumes this; drizzle-kit config is typically static).
4. Wire `env.write()` to persist snapshots if the consumer needs to reload state (currently omitted; optional).

The per-instance share model (`share: 'per-instance'`) ensures concurrent test harnesses and multi-tenant deployments get isolated DB files under distinct instance directories, eliminating SQLite lock contention without manual coordination.
