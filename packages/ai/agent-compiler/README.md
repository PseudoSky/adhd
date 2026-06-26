# @adhd/agent-compiler

Registry-family store for agent-compiler: drizzle-backed SQLite tables sharing the one registry database.

A `platform:node` registry-family package: a Drizzle-backed store over **one
shared SQLite file** (`REGISTRY_DATABASE_PATH` / `DATABASE_PATH`, default
`./data/registry.db`). It owns the tables prefixed **`compiler_`** and never
ATTACHes another database or declares a cross-package SQL foreign key — those
keys are logical and resolved at compile time.

Scaffolded by `@adhd/agent-nx` (`nx g @adhd/agent-nx:registry-package compiler`).
The rules every registry package must follow live in
[`../agent-nx/REGISTRY-PACKAGE-RULES.md`](../agent-nx/REGISTRY-PACKAGE-RULES.md);
this package's local copy of the invariants is in [`./CLAUDE.md`](./CLAUDE.md).

## Layout

```
src/
  db/
    client.ts         shared-file better-sqlite3 connection (WAL) + Drizzle db
    schema.ts         Drizzle tables — all prefixed `compiler_`
    migrate.ts        runMigrations() — applies ./drizzle migrations
    migrate-runner.ts FK-safe migrator (reused by tests)
  __tests__/          real-DB, close+reopen store tests
  index.ts            public barrel
drizzle/              drizzle-kit generated migrations (shipped in the package)
```

## Commands

```bash
# Build (emits to dist/, ships the drizzle/ migrations as assets).
nx build agent-compiler

# Test (real on-disk SQLite + real migrations; gate on the EXIT CODE).
nx test agent-compiler

# Type-check without emitting.
nx typecheck agent-compiler

# Generate a new migration from src/db/schema.ts into ./drizzle.
nx db:generate agent-compiler

# Apply pending migrations to the database.
nx db:migrate agent-compiler
```

`build`, `test`, and `typecheck` inherit caching and the `^build` dependency
from the workspace `nx.json` `targetDefaults` — do not redefine `cache` or
`dependsOn` in this package's `project.json`.

## Adding a table

1. Define it in `src/db/schema.ts` with the `compiler_` prefix.
2. `nx db:generate agent-compiler` to write the migration into `drizzle/`.
3. Export the table (and any store class) from `src/index.ts`.
4. Add a real-DB, close+reopen test under `src/__tests__/`.
