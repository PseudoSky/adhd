---
package: @adhd/sox-graph-store
path: /Users/nix/dev/ai/sox-ecosystem/libs/data/graph/graph-store
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: none
env_vars: []
writes: []
config_files: []
supported_by_env: full
gaps: []
value: low
effort: low
recommend: skip
---

## Current state

**Environment variables:** None. The package reads zero env vars; all configuration is passed programmatically.

**Writes:** None. The package is a pure library that operates on a Database instance passed at construction time. The database file path, creation, and lifecycle are managed by the caller (e.g., sox-memory-store or similar). Drizzle migrations are applied at startup via `migrate(drizzleDb, { migrationsFolder })` using the `__drizzle_migrations` table for version tracking, but this is entirely internal to the database handle — no filesystem paths are hardcoded or resolved.

**Config files:** The `drizzle.config.ts` exists but is build-time only (for `drizzle-kit generate` to emit migration SQL). At runtime, migrations are discovered from `../drizzle/migrations` relative to the compiled `index.js` via `fileURLToPath(new URL(..., import.meta.url))`, which is a module-relative path hardcoded in the source.

## Proposed `EnvironmentSpec`

Not applicable. The package is a zero-config library — it accepts configuration exclusively via constructor parameters:

```typescript
export function createGraphBackend(db: Database.Database): GraphBackend {
  return new SqliteGraphBackend(db);
}
```

The caller is responsible for opening the database, managing its file path, and passing the instance to `createGraphBackend()`. If a consumer needs to externalize database path decisions, that consumer (not this library) should adopt `@adhd/environment` and pass the opened database handle downstream.

## Gap detail

None. The package has zero configuration surface — no env vars to remap, no paths to externalize, no files to scope.

## File-location table

| Current path | Kind | Note |
|---|---|---|
| N/A — no writes | N/A | Package is pure library; database managed externally |

