---
package: @adhd/agent-store-prompts
path: /Users/nix/dev/node/adhd/packages/agent/agent-store-prompts
root: adhd
language: node
self_internal: false
current_scope_behavior: cwd-relative
env_vars: [REGISTRY_DATABASE_PATH, DATABASE_PATH]
writes: [{path: "./data/registry.db", kind: data, purpose: "SQLite registry database (shared by agent-registry, agent-tool-registry, agent-provider, agent-policy)"}, {path: "./data/registry.db-wal", kind: data, purpose: "SQLite WAL journal (auto-created)"}, {path: "./data/registry.db-shm", kind: data, purpose: "SQLite shared-memory file (auto-created)"}]
config_files: [drizzle.config.ts]
logging:
  has_logging: false
  logger: none
  persists_log_files: false
  log_destination: "none"
  structured: false
  error_handling: adhoc
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G1, G2]
value: high
effort: high
recommend: adopt-after-gap
---

## Current state

**Environment variables:**
- `REGISTRY_DATABASE_PATH` · read in `src/db/client.ts` line 14 · no default (primary override)
- `DATABASE_PATH` · read in `src/db/client.ts` line 15 · no default (fallback override)
- Both resolve to hardcoded `./data/registry.db` if neither env var is set (lines 14-16)

**Files/directories written:**
- `./data/registry.db` — SQLite database created at import time of `src/db/client.ts` (line 28). Directory auto-created via `fs.mkdirSync(directory, { recursive: true })` if missing (lines 22–26).
- `./data/registry.db-wal` — Write-Ahead Log file, auto-created by better-sqlite3 when pragma `journal_mode = WAL` is set (line 30).
- `./data/registry.db-shm` — Shared-memory coordination file for WAL mode, auto-created by better-sqlite3.

**Config files:**
- `drizzle.config.ts` — Drizzle Kit configuration; reads the same env vars and default path (lines 10–15); `out: './drizzle'` specifies migration output directory.

**Scope/path decisions:**
- Path resolution: `path.resolve(databasePath)` in `src/db/client.ts` line 18 makes the relative path `./data/registry.db` resolve to `<cwd>/data/registry.db`, not under a scope root.
- Scope detection: none. No `.adhd` marker, no `ADHD_ENV_SCOPE`, hardcoded relative path.
- Shared database: Per Decision 1 in `src/db/client.ts` comment (line 9), one SQLite file is shared across `@adhd/agent-registry`, `@adhd/agent-tool-registry`, `@adhd/agent-provider`, and `@adhd/agent-policy`. Each package opens its own Drizzle instance against the same file; no ATTACH DATABASE.

---

## Proposed `EnvironmentSpec`

```typescript
import { EnvironmentSpec } from '@adhd/environment';

export const spec: EnvironmentSpec = {
  config: {
    databasePath: {
      type: 'string',
      env: 'REGISTRY_DATABASE_PATH',
      at: 'runtime',
      default: undefined, // require explicit env var or use scope-aware default
    },
  },
  dirs: {
    data: {
      kind: 'data',
      namespace: 'default',
      share: 'shared', // all registry-family packages share one DB
    },
  },
  files: {
    registryDb: {
      in: 'data',
      name: 'registry.db',
    },
  },
  envPrefixOverride: 'ADHD_REGISTRY', // shared across agent-registry family
};
```

**Usage:**
```typescript
import { Environment } from '@adhd/environment';
import { spec } from './config.js';

const env = new Environment(spec);
const dbPath = env.files.registryDb; // ~/.adhd/adhd-registry/default/data/registry.db (global)
                                      // or <projectRoot>/.adhd/adhd-registry/default/data/registry.db (project scope)

const sqlite = new Database(dbPath);
```

---

## Gap detail

- **G1**: `REGISTRY_DATABASE_PATH` and `DATABASE_PATH` are non-`ADHD_*` env vars read verbatim. `@adhd/environment` uses prefix-scoped env names (e.g., `ADHD_REGISTRY_DATABASE_PATH`), guarded by `env.isEnvNameAllowed()`. The current env var names do not fit the prefix model. Adoption requires renaming env vars and updating all callers (4 packages).

- **G2**: Writes to `./data/registry.db`, a hardcoded cwd-relative path. `@adhd/environment` resolves all writes under `<scope-root>/.adhd/<project>/…`. A path outside that scope is not expressible in the declarative spec. Adoption requires moving the DB to `.adhd/adhd-registry/data/registry.db` (global scope) or `<projectRoot>/.adhd/adhd-registry/data/registry.db` (project scope) and updating all four consumers to read from `env.files.registryDb`. **Coordination hazard**: shared database across 4 packages; migration must be synchronized and tested end-to-end.

---

## Logging audit

**Assessment:** No logging observed in flagged files.

- `drizzle.config.ts` sets `verbose: true` (line 17), but this is a Drizzle Kit build-time flag, not persistent log file output.
- `src/db/client.ts` instantiates the database and sets pragmas silently; no logging.
- `src/db/migrate-runner.ts` runs migrations without logging errors or progress.
- `src/seed/index.ts` performs database inserts silently.
- `src/store/agent-store.ts` and `src/store/composed-prompt-store.ts` throw errors (`AgentError`, `ComposedPromptError`) but do not log them.

**Logging output:** None to disk. Any stdout/stderr output is ephemeral and not persisted.

**Error handling:** Adhoc — errors are thrown; the caller is responsible for logging.

**Would it benefit from `env.paths.logs`?** Not immediately, as this is a library. However, if used in a daemon/server context (e.g., agent-mcp runtime), wrapping store calls with a logging harness that writes to `env.paths.logs` would improve observability of DB operations.

---

## File-location table — corrected to the new standard

| Current path | Kind | New-standard path (global scope) | Env accessor |
|---|---|---|---|
| `./data/registry.db` | data | `~/.adhd/adhd-registry/default/data/registry.db` | `env.files.registryDb` |
| `./data/registry.db-wal` | data | `~/.adhd/adhd-registry/default/data/registry.db-wal` | `env.paths.data + '/registry.db-wal'` |
| `./data/registry.db-shm` | data | `~/.adhd/adhd-registry/default/data/registry.db-shm` | `env.paths.data + '/registry.db-shm'` |

**Project scope variant:** When `ADHD_ENV_SCOPE=project` or `.git`/`.adhd` marker is detected, the same subtree is rooted at `<projectRoot>/.adhd/adhd-registry/default/…`:
- `<projectRoot>/.adhd/adhd-registry/default/data/registry.db`
- `<projectRoot>/.adhd/adhd-registry/default/data/registry.db-wal`
- `<projectRoot>/.adhd/adhd-registry/default/data/registry.db-shm`
