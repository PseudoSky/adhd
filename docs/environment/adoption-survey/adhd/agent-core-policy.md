---
package: '@adhd/agent-core-policy'
path: /Users/nix/dev/node/adhd/packages/agent/agent-core-policy
root: adhd
language: node
self_internal: false
current_scope_behavior: cwd-relative
env_vars: ['DATABASE_PATH']
writes: [
  {path: './data/agents.db', kind: 'data', purpose: 'SQLite policy database (WAL mode)'},
  {path: './data/agents.db-wal', kind: 'state', purpose: 'SQLite WAL checkpoint file'},
  {path: './data/agents.db-shm', kind: 'state', purpose: 'SQLite shared memory file'}
]
config_files: []
logging:
  has_logging: false
  logger: none
  persists_log_files: false
  log_destination: 'stdout/stderr only'
  structured: false
  error_handling: robust
  maps_to_env_logs: false
supported_by_env: partial
gaps: ['G1', 'G2']
value: high
effort: low
recommend: adopt
---

## Current state

**Env vars:**
- `DATABASE_PATH` · read in `drizzle.config.js:13` and `src/db/client.ts:9` · default `./data/agents.db` if absent

**Writes:**
- `./data/agents.db` · kind: data · SQLite database (WAL mode enabled at line 23 of src/db/client.ts)
- `./data/agents.db-wal` · kind: state · Write-ahead log file (implicit, created by SQLite)
- `./data/agents.db-shm` · kind: state · Shared memory file (implicit, created by SQLite)

**Config files:**
- None explicitly tracked; `.env` is loaded only by drizzle.config.js at build time via `import 'dotenv/config'` (line 1), not at runtime.

**Scope decision today:**
Hardcoded cwd-relative: `path.resolve(databasePath)` in `src/db/client.ts:11` resolves `DATABASE_PATH` or `./data/agents.db` relative to process.cwd(). Directory is auto-created recursively if missing (line 16). No per-instance, per-scope, or user-home isolation.

## Proposed `EnvironmentSpec`

```typescript
const spec: EnvironmentSpec<PolicyConfig> = {
  config: {
    'database.filename': {
      type: 'string',
      env: 'DATABASE_PATH',
      default: 'agents.db',
      at: 'runtime',
      secret: false,
      description: 'SQLite filename (path only, directory managed by env.paths.data)',
    },
  },
  dirs: {
    data: {
      kind: 'data',
      share: 'per-instance',
    },
  },
  files: {
    policyDb: {
      in: 'data',
      name: 'agents.db',
    },
  },
  envPrefixOverride: 'ADHD_AGENT_CORE_POLICY',
};

// Usage in src/db/client.ts:
// import { Environment } from '@adhd/environment';
// import spec from './config.js';
// const env = new Environment(spec);
// const dbPath = env.files.policyDb; // resolves to ~/.adhd/agent-core-policy/default/data/agents.db (global) or <projectRoot>/.adhd/agent-core-policy/default/data/agents.db (project scope)
// const sqlite = new Database(dbPath);
```

## Gap detail

- **G1:** `DATABASE_PATH` is a non-`ADHD_*` env var; `isEnvNameAllowed('DATABASE_PATH')` would reject it under the default prefix model. Mitigation: accept both `ADHD_AGENT_CORE_POLICY_DATABASE_PATH` (new) and `DATABASE_PATH` (legacy) for a transition period, or document the breaking change.

- **G2:** `./data/agents.db` is a repo-root-relative hardcoded path, not an absolute path or standard directory. Adoption replaces it with `env.files.policyDb`, which resolves to `~/.adhd/agent-core-policy/default/data/agents.db` (global scope) or `<projectRoot>/.adhd/agent-core-policy/default/data/agents.db` (project scope). This is a breaking change for persisted data; users must migrate or symlink existing `.db` files.

## Logging audit

The package **does not emit logs** in the flagged production files. `drizzle.config.js:16` sets `verbose: true` for the Drizzle CLI (drizzle-kit), which outputs to stdout at build/migration time, but the runtime library (drizzle-orm) does not log. Error handling is robust: exceptions are thrown and caught by callers (e.g., `src/db/migrate-runner.ts:41–47` uses try/finally to restore FK pragma state). No persistent log files are written. The package would **not benefit** from `env.paths.logs` because it has no runtime logging surface today.

## File-location table — corrected to the new standard

| current path | kind | new-standard path (global scope) | env accessor |
|---|---|---|---|
| `./data/agents.db` | data | `~/.adhd/agent-core-policy/default/data/agents.db` | `env.files.policyDb` |
| `./data/agents.db-wal` | state | `~/.adhd/agent-core-policy/default/data/agents.db-wal` | (implicit with policyDb) |
| `./data/agents.db-shm` | state | `~/.adhd/agent-core-policy/default/data/agents.db-shm` | (implicit with policyDb) |

**Project-scope variant:** when `ADHD_ENV_SCOPE=project` or a `.git`/`.adhd` marker is detected, paths resolve under `<projectRoot>/.adhd/agent-core-policy/default/data/…` instead of `~/.adhd/…`.
