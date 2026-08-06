# Build Executor Choice — `@nx/vite:build` vs `@nx/js:tsc`

**Status:** active convention · **Written:** 2026-08-06

This convention was investigated but never documented until now — `BUILD-CONSIST-008`
found that the split between `@nx/vite:build` (bundled, via Rollup) and `@nx/js:tsc`
(unbundled transpile) across the workspace's buildable projects is **principled, not
accidental drift**, but the rationale lived only in that backlog item. Without a doc,
the risk is that a future maintainer sees a `@nx/js:tsc` project, assumes it's
inconsistent with the rest of the workspace, and "fixes" it onto `@nx/vite:build` —
reintroducing exactly the runtime breakage this split exists to avoid. This file is
the single source of truth; cite it by path, not by backlog ID.

## The rule

**`@nx/vite:build` is the default for every package.** `@nx/js:tsc` is the deliberate
exception, used only when bundling would break the package at runtime or violate an
external tool's loading contract.

This is **not** a `platform:node` vs `platform:browser` split. `agent-generator-plugin`,
`agent-plugin-budget`, and `agent-plugin-sanitize` are all `platform:node`, yet
`agent-plugin-budget` and `agent-plugin-sanitize` correctly build with
`@nx/vite:build` while `agent-generator-plugin` correctly builds with `@nx/js:tsc`
(confirmed against each project's `project.json` `build.executor` and `tags`) —
`platform:node` alone never predicts the executor. What predicts it is the three
categories below.

As of this writing, 14 projects use `@nx/js:tsc` against 40+ on `@nx/vite:build`
(verified via `grep -rl '"executor": "@nx/js:tsc"' --include=project.json packages
entrypoint`).

## The three justified categories

### (a) Native addon (`better-sqlite3`) dependents

**Mechanism:** bundlers (Rollup, via `@nx/vite:build`) rewrite or inline `require()`
calls. A compiled `.node` native addon must be loaded through a literal, unrewritten
`require()` at runtime, or the load fails. `@nx/js:tsc`'s plain transpile-without-bundle
leaves `require()` calls untouched, so this is the only safe choice for anything that
transitively loads `better-sqlite3`.

**Members** (grep-verified against source usage of `better-sqlite3` — either a direct
`dependencies` entry, or the `drizzle-orm/better-sqlite3` driver imported in `src/`):

- `agent-core-policy`
- `agent-core-provider`
- `agent-engine-compiler`
- `agent-engine-orchestrator`
- `agent-mcp`
- `agent-store-prompts`
- `agent-store-runtime`
- `agent-store-tools`

### (b) Nx-devkit plugin-loader dependents

**Mechanism:** Nx's own generator/executor loader performs a synchronous `require()`
on the entrypoint module named by `package.json`'s `"generators"`/`"executors"` field.
That loader expects plain, unbundled CJS output — a Rollup-bundled ESM/CJS-hybrid
output is not guaranteed to satisfy it.

**Members verified to actually meet this bar** (grep-verified: each ships a
`generators.json`/`executors.json` on disk **and** registers it via a
`"generators"`/`"executors"` field in its own `package.json` — confirmed with `find
<pkg-dir> -maxdepth 1 -iname "*generators*" -o -iname "*executors*"` plus `grep -n
'"generators"\|"executors"' <pkg-dir>/package.json`):

- `apigen-generator-nx` — ships both `generators.json` and `executors.json`,
  registers `"generators": "./generators.json"`.
- `workspace-codegen-nx` — ships `generators.json`, registers
  `"generators": "./generators.json"`.
- `agent-generator-plugin` — newest addition to this category. Ships
  `generators.json` and registers `"generators": "./generators.json"` (confirmed in
  `packages/agent/agent-generator-plugin/package.json`), the same devkit/CLI-loading
  rationale as the two members above.

**`workspace-base-tools` — kept on `@nx/js:tsc`, but lower-confidence, unlike the
three members above.** It depends on `@nx/devkit` (imports `workspaceRoot` in
`src/get-package-info.ts`) but ships **neither** a `generators.json` nor an
`executors.json`, and its `package.json` has no `"generators"`/`"executors"` field.
It also has **zero repo-wide importers**: `grep -rl "workspace-base-tools"
--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.nx .` finds no
consuming `.ts` file anywhere in the workspace, including
`workspace-codegen-nx` (the one package it would plausibly feed). In other words,
the synchronous-`require()` mechanism that justifies this category for the other
three members is **not currently exercised** by `workspace-base-tools` at all — its
`@nx/js:tsc` build is a defensive/precautionary choice from when it was scaffolded
as a devkit-adjacent utility, not evidence the mechanism applies today. Treat this
membership exactly like `decompile-cli` in category (c): retained, unverified, not
settled fact — until either a real consumer proves the sync-require path or someone
confirms it's safe to move to `@nx/vite:build`.

### (c) Legacy/CJS-heavy surface — lower-confidence

**Member:** `decompile-cli`.

Its dependency surface (`cheerio`, `depcheck`, `dependency-cruiser`, `fs-extra`,
`tough-cookie`, `babel-polyfill`, `react`) makes bundling risk plausible — several of
these are legacy CJS packages with dynamic `require()` patterns Rollup can mishandle —
but this is **honestly lower-confidence** than categories (a) and (b): no one has
actually attempted a `@nx/vite:build` for this project and observed a concrete
failure. Treat this as "keep on `tsc` until someone either proves the failure or
proves it's safe to move," not as settled fact.

The pointer comment in `entrypoint/decompile-cli/vite.config.ts` (around line 13)
links here rather than only citing the backlog ID, so a reader lands on the full
category writeup instead of a bare ticket number.

## What changed since this was first investigated

`BUILD-CONSIST-008`'s original investigation counted 12 `@nx/js:tsc` projects. Two
have been added since:

- **`agent-generator-plugin`** — added to category (b) (Nx-devkit plugin-loader);
  see above.
- **`environment-cli`** — moved onto `@nx/js:tsc` as the fix for `BUILD-CONSIST-002`
  (an incompletely-scaffolded stub with an uncached, mis-pathed `nx:run-commands`
  build). Its fix direction was to match `decompile-cli`'s pattern
  (`tsconfig.lib.json`, `generatePackageJson: true`) — i.e. the same devkit/CLI-loading
  rationale category as (b), recorded here so this doc doesn't silently drift stale
  the next time someone audits the split.

This section exists specifically so the count and membership above don't go stale
unnoticed on the next audit — if you add or remove a `@nx/js:tsc` project, update the
relevant category list above **and** add a line here.

## How to decide for a new package

1. **Does it depend on a native/compiled addon** (transitively or directly, e.g.
   `better-sqlite3`)? → `@nx/js:tsc`.
2. **Is it an Nx generator/executor/plugin actually loaded via synchronous
   `require()`?** Verify concretely, don't infer from the dependency alone: does it
   ship a `generators.json`/`executors.json` **and** does its own `package.json`
   register that file via a `"generators"`/`"executors"` field? If both are true →
   `@nx/js:tsc`, high confidence (this is category (b)'s bar — three of its four
   members meet it). Merely depending on `@nx/devkit` without that registration is
   **not** sufficient evidence the mechanism applies — `workspace-base-tools` is the
   cautionary example: it depends on `@nx/devkit` and has zero registration and zero
   importers, and its category-(b) membership is explicitly flagged there as
   unverified rather than treated as settled.
3. **Otherwise** → `@nx/vite:build` (the default). If you're genuinely unsure
   whether bundling is safe (e.g. a CJS-heavy legacy dependency surface with no
   concrete failure observed yet), don't guess either way — add it to category (c)
   as lower-confidence rather than asserting a mechanism you haven't verified.

Do **not** add a `project.json` comment field to record this decision — JSON has no
comment syntax in this repo's schema (`.eslintrc.json`/Nx project-schema validation
would reject it, and even if it didn't, it'd be a second, driftable source of truth).
This doc is the single source of truth for the executor split; if a project-local
pointer is warranted (as in `decompile-cli`'s `vite.config.ts`), cite this doc **by
path** — `docs/contributing/conventions/build-executor-choice.md` — not by backlog ID,
since backlog items get resolved/archived and a doc path doesn't.
