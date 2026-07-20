---
package: @adhd/agent-core-provider
path: /Users/nix/dev/node/adhd/packages/agent/agent-core-provider
root: adhd
language: node
self_internal: false
current_scope_behavior: homedir
env_vars: [DATABASE_PATH]
writes: [{path: "~/.adhd/agent-core-provider/agents.db", kind: data, purpose: "SQLite agent registry database"}]
config_files: []
logging:
  has_logging: false
  logger: none
  persists_log_files: false
  log_destination: "none"
  structured: false
  error_handling: none
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G1]
value: high
effort: med
recommend: adopt
---

## Current State

**Environment Variables:**
- `DATABASE_PATH` · read in `src/db/client.ts:10` · defaults to `~/.adhd/agent-core-provider/agents.db`

**Writes:**
- SQLite database file at `~/.adhd/agent-core-provider/agents.db` · kind: `data` · purpose: agent registry storage (models, providers, tool formats)
- SQLite WAL/SHM journal files (auto-created by SQLite via `pragma('journal_mode = WAL')` in client.ts:24)
- Directory creation: parent of DB file created with `fs.mkdirSync(directory, { recursive: true })` if missing (client.ts:16-20)

**Config Files:**
- None — package uses Drizzle ORM schema defined in `src/db/schema.js` (referenced but not in flagged files)
- Drizzle migrations in `drizzle/` directory (Drizzle-kit generated; not parsed at runtime)

**Logging:**
- NONE. No console, pino, winston, log4js, or custom logging in any flagged file. All files are pure data-access logic (stores, seed functions, migration runner).

**Scope Behavior:**
- Homedir-based via `os.homedir()`. Path is `~/.adhd/agent-core-provider/agents.db` — partially aligned with @adhd/environment standard (`~/.adhd/<project>/<namespace>/<kind>/<file>`) but missing the `<namespace>` and `<kind>` tiers.

---

## Proposed EnvironmentSpec

```typescript
import { EnvironmentSpec } from '@adhd/environment';

export interface AgentCoreProviderConfig {
  'database.filename': string;
}

export const AGENT_CORE_PROVIDER_SPEC: EnvironmentSpec<AgentCoreProviderConfig> = {
  namespace: 'default',
  // envPrefixOverride omitted — defaults to ADHD_AGENT_CORE_PROVIDER
  config: {
    'database.filename': {
      type: 'string',
      default: 'agents.db',
      env: 'DATABASE_PATH',  // backwards-compat: remaps to ADHD_AGENT_CORE_PROVIDER_DATABASE_FILENAME
      at: 'runtime',
      doc: 'SQLite database filename within the data directory'
    }
  },
  dirs: {
    data: {
      kind: 'data',
      doc: 'Persisted agent registry (models, providers, tool formats)'
    }
  },
  files: {
    database: {
      in: 'data',
      name: 'agents.db',
      doc: 'SQLite agent registry database'
    }
  },
  share: 'per-instance'  // each instance (CLI invocation, server) gets its own registry copy
};
```

**Usage pattern** (in place of current client.ts):

```typescript
import { Environment } from '@adhd/environment';
import { AGENT_CORE_PROVIDER_SPEC } from './config.js';

const env = new Environment(AGENT_CORE_PROVIDER_SPEC);
const dbPath = env.files.database;  // e.g., ~/.adhd/agent-core-provider/default/data/agents.db
const sqlite = new Database(dbPath);
```

---

## Gap Detail

**G1** · `DATABASE_PATH` is read verbatim, not remapped under `ADHD_*` prefix. Under @adhd/environment, the env remapping rule would normalize it to `ADHD_AGENT_CORE_PROVIDER_DATABASE_FILENAME` (or use an explicit `env` key in the field spec for backwards compatibility, as shown above).

---

## Logging Audit

This package **does not log**. All eight flagged files contain zero logging statements:

- `src/db/client.ts` — database connection setup only.
- `src/db/migrate-runner.ts` — migration execution wrapper; no logging.
- `src/seed/*.ts` — three seed modules (bindings, models, providers) — insert-only, no error handling beyond Drizzle's error propagation.
- `src/store/*.ts` — three store classes (ModelStore, ProviderStore, ToolFormatStore) — CRUD operations with typed error classes; no logging (errors thrown, not logged).

**Error handling:** Present but asymmetric — stores throw custom `*StoreError` classes with readable messages (e.g., `MODEL_ALREADY_EXISTS`, `PROVIDER_NOT_FOUND`), but these errors are NOT logged. Callers (agent-mcp runtime, tests) are responsible for catching and logging.

**Recommendation:** No impact on adoption. If persistent logging becomes a requirement (e.g., audit trail for seed operations, migration warnings), the package would benefit from `env.paths.logs` (kind: `logs`, share: `per-instance`) — one log file per instance, auto-rotated by caller if desired.

---

## File-Location Table

| Current Path | Kind | New-Standard Path (Global Scope) | Env Accessor |
|---|---|---|---|
| `~/.adhd/agent-core-provider/agents.db` | `data` | `~/.adhd/agent-core-provider/default/data/agents.db` | `env.files.database` |
| (auto WAL) `-wal` | `data` | `~/.adhd/agent-core-provider/default/data/agents.db-wal` | (auto, with .db file) |
| (auto SHM) `-shm` | `data` | `~/.adhd/agent-core-provider/default/data/agents.db-shm` | (auto, with .db file) |

**Project-scope variant** (when `ADHD_ENV_SCOPE=project` or `.adhd` marker detected):
- `<projectRoot>/.adhd/agent-core-provider/default/data/agents.db`
- `<projectRoot>/.adhd/agent-core-provider/default/data/agents.db-wal`
- `<projectRoot>/.adhd/agent-core-provider/default/data/agents.db-shm`
