# @adhd/agent-nx

Nx generator for **golden-path `@adhd/agent-*` registry packages**. It scaffolds
a `platform:node`, Drizzle-over-shared-SQLite registry package that is correct on
day one — lint target present, caching and `^build` inherited from `nx.json`,
drizzle migrations shipped as build assets, a real-DB close+reopen test, a
per-package `README.md`, and a `CLAUDE.md` linking the package rules. It exists so
future agent packages stop drifting (missing lint, inconsistent targets, ad-hoc
db wiring).

## Usage

```bash
# Scaffold packages/ai/agent-budget (@adhd/agent-budget).
nx g @adhd/agent-nx:registry-package budget

# Custom directory / description / table prefix.
nx g @adhd/agent-nx:registry-package billing \
  --directory=packages/ai/agent-billing \
  --description="Billing ledger registry" \
  --tablePrefix=billing_
```

Pass the name **without** the `agent-` prefix — `budget` produces the project
`agent-budget` and the npm package `@adhd/agent-budget`.

### Options

| Option         | Required | Default                          | Notes                                                              |
| -------------- | -------- | -------------------------------- | ------------------------------------------------------------------ |
| `name`         | yes      | —                                | kebab-case, no `agent-` prefix (e.g. `budget`, `tool-registry`).   |
| `directory`    | no       | `packages/ai/agent-<name>`       | Target directory.                                                  |
| `description`  | no       | derived                          | `package.json` description.                                        |
| `tablePrefix`  | no       | `<name>_` (hyphens → underscores)| SQLite table-name prefix; the cross-package collision guard.       |

## What it generates

Under `packages/ai/agent-<name>/`:

- `project.json` — tags `["layer:ai","platform:node"]`; `build` (`@nx/js:tsc`,
  drizzle asset glob), `test` (`@nx/vite:test`), `typecheck`, `clean`,
  `db:generate`, `db:migrate`, and `nx-release-publish` (`dependsOn:
  ["build","test"]`). `build`/`test`/`typecheck` inherit cache + `^build` from
  `nx.json` `targetDefaults`.
- `package.json` — `@adhd/agent-<name>`, only the deps the skeleton imports
  (`drizzle-orm`, `better-sqlite3`) to keep `@nx/dependency-checks` green.
- `.eslintrc.json` extending the workspace base → an inferred `lint` target.
- `vite.config.ts` (vitest, `pool: 'forks'`, `fileParallelism: false` for
  better-sqlite3), `tsconfig.json` / `.lib.json` / `.spec.json`,
  `drizzle.config.ts`.
- `src/db/{client,schema,migrate,migrate-runner}.ts`, `src/index.ts` barrel,
  `src/__tests__/skeleton.test.ts` (real DB + close/reopen), a starter
  `drizzle/meta/_journal.json`.
- `README.md` and a `CLAUDE.md` stub linking
  [`REGISTRY-PACKAGE-RULES.md`](./REGISTRY-PACKAGE-RULES.md).

It also adds `"@adhd/agent-<name>": ["./packages/ai/agent-<name>/src/index.ts"]`
to `tsconfig.base.json` (additive).

## The rules it enforces

See **[REGISTRY-PACKAGE-RULES.md](./REGISTRY-PACKAGE-RULES.md)** for the full set
of invariants every `@adhd/agent-*` registry package must follow (one shared
SQLite file, table prefixes, no cross-package FKs, lookup-tables-not-enums, real
composite PKs, close+reopen tests gated on exit code, inherited cache/`^build`).
