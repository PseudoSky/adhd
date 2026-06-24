# Registry-package rules — what every `@adhd/agent-*` package must look like

These are the invariants distilled from the four shipped registry packages
(`agent-registry`, `agent-tool-registry`, `agent-provider`, `agent-policy`) and
their `contexts/_shared.md` design docs. `@adhd/agent-nx`'s `registry-package`
generator emits a package that satisfies every rule here on day one; this
document is the standard the package must keep meeting as it grows.

> **A registry package is a `platform:node` Drizzle store over one shared SQLite
> file.** Everything below follows from that sentence.

## 1. Platform & dependency purity

- **`platform:node`** (`tags: ["layer:ai", "platform:node"]`). The package is
  pure Node + SQLite. It MUST NOT import browser code — `react`, `window`,
  `document`, CSS, or any `platform:browser` package.
- **Declare only the deps you import.** The skeleton imports `drizzle-orm` and
  `better-sqlite3`; those are the only runtime `dependencies`. Add `zod` (or
  anything else) ONLY when a source file actually imports it — an unused entry
  trips the `@nx/dependency-checks` lint rule and fails `lint`.

## 2. The one shared SQLite file

- **All registry-family packages share ONE database file**
  (`REGISTRY_DATABASE_PATH` → `DATABASE_PATH` → `./data/registry.db`). Each
  package opens its **own** Drizzle instance against that same file.
- **NO `ATTACH DATABASE`.** Never join across attached files.
- **NO cross-package SQL foreign keys.** A column that references another
  package's table is a **plain text logical key**, resolved/validated at compile
  time — never a Drizzle `.references()` across package prefixes. The compile
  step is what guarantees integrity between packages, not SQLite.
- **Within-package FKs ARE real.** Inside one package, use `.references()`
  normally and let SQLite enforce them.

## 3. Table naming — the prefix is the collision guard

- Because every package shares one file, **table names are the only thing
  keeping packages from colliding.** Every table in a package is named with that
  package's prefix (e.g. `registry_`, `tool_`, `provider_`, `policy_`). The
  generator wires a default prefix (`<name>_`, hyphens → underscores) into the
  schema header; keep using it for every table.

## 4. Controlled vocabularies: lookup tables, never SQL enums

- Prompt types, tool types, policy types, statuses, postures, and every other
  controlled vocabulary are **seeded lookup tables with a text PK**, or plain
  text columns — **never** a SQLite/SQL `enum`. Adding a value is inserting a
  row (or writing a string), **not** a schema migration.

## 5. Keys & history

- **Composite primary keys are real** `primaryKey({ columns: [a, b] })`. A
  non-unique `index()` is NOT a primary key and must never stand in for one.
- **Split identity from history where versions matter.** Keep a single-column PK
  on the head row (e.g. `slug`) and a single-column surrogate PK on the version
  row (e.g. `version_id`) so downstream tables can target an **enforced**
  single-column FK. A `(slug, version)` composite PK cannot be referenced that
  way.
- **Version-retained / bump-don't-delete.** Where a table retains versions,
  bumping `version` inserts a new row and NEVER deletes the prior version's row;
  old versions stay for audit/rollback.

## 6. Store classes

- Each table group is wrapped by a **store class** (`ComponentStore`,
  `AgentStore`, …) that takes a `BetterSQLite3Database` in its constructor and
  exposes thin Drizzle queries.
- Stores surface **typed error codes** — an `Error` subclass with a `code` union
  (`"COMPONENT_NOT_FOUND" | …`), mirroring `agent-mcp`'s `ToolError` style — not
  bare thrown strings.

## 7. Tests — proof, not vibes

- **Real on-disk SQLite + real migrations.** Store tests run against a real
  SQLite file (a `tmp` path) with the real `drizzle/` migrations applied — never
  a mock, never an in-memory DB for anything that claims persistence.
- **Prove persistence by CLOSE + REOPEN.** Write with one handle, close it,
  reopen from the same path, and assert the read-back row. In-memory state is
  not proof.
- **Assertions with teeth (negative control).** A behavioral test must go RED if
  the behaviour regresses — verify by reverting the fix or running a
  deliberately-wrong variant. A test that stays green when the code is broken
  proves nothing.
- **Deterministic without timing.** Use latches/barriers and bounded deadlines;
  prove persistence by reopening the store. Never `sleep` / wall-clock.
- **Gate on the EXIT CODE, never stdout.** `better-sqlite3` can segfault on
  vitest teardown *after* tests pass; `… | grep -q passed` hides that. Key on
  `nx test <project>`'s exit status. The generated `vite.config.ts` already sets
  `pool: 'forks'` + `fileParallelism: false` to keep native finalizers stable.

## 8. Nx target hygiene (cache + `^build` are inherited)

- Targets are named `build` / `test` / `typecheck` and use the standard
  executors (`@nx/js:tsc`, `@nx/vite:test`) so they **inherit `cache: true` and
  `dependsOn: ["^build"]` from `nx.json` `targetDefaults`**. Do NOT hardcode
  `cache` or `dependsOn` in the package's `project.json` — that duplicates (and
  can drift from) the workspace defaults.
- `build` ships the `drizzle/**/*` migrations as an asset so `runMigrations()`
  finds them in the published package.
- `nx-release-publish` depends on `["build", "test"]` — you cannot publish a
  package whose tests don't pass.

## 9. Lintability & docs

- Ship a `.eslintrc.json` that `extends ["../../../.eslintrc.base.json"]` so the
  inferred `@nx/eslint` `lint` target appears and inherits the base rules.
- Ship a per-package `README.md` (what it is + build/test/db commands) and a
  `CLAUDE.md` stub that links back to this document.
