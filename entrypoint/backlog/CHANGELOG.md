## 0.1.10 (2026-08-20)


### 🩹 Fixes

- **backlog:** plan repo migrations in two passes so a rename cannot cascade

- **backlog:** don't open the graph store for migration-status/set-migration-phase (DEBT-BACKLOG-CLI-STORE-OPEN-001)

- **backlog:** a failed audit write must not fail an already-committed claim


### ❤️  Thank You

- pseudosky

## 0.1.9 (2026-08-20)


### 🩹 Fixes

- **release:** global-CLI currency gate (BUG-027) + assets/build output-scope cache bug (BUG-026)

- **backlog:** converge @adhd/sox-telemetry to a single instance (BUG-BACKLOG-TELEMETRY-001)

- **backlog:** don't open the graph store for --help/version (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001)


### ❤️  Thank You

- pseudosky

## 0.1.8 (2026-08-19)


### 🩹 Fixes

- **backlog:** singleton writer lock for `serve` — two concurrent servers against one store corrupted the db (BUG-020). O_EXCL PID-file lock keyed on the canonical realpath'd db path, held from before the store opens until after it is fully closed, so a second `serve` during shutdown drain is refused rather than admitted. Dead holders reclaimed; refusal names the holder pid and lock path.
- **backlog:** consume `@adhd/sox-store-adapter` 0.7.0. The dependency was pinned `^0.5.8`, and a caret on a 0.x pins the MINOR — so it could never resolve past 0.6.0 and none of the WAL/durability work reached this store. Brings the adaptive idle-flush debounce (BL-590), baseline-relative WAL cap (BL-587), and verified busy-error classification in the wal-cap backstop (BUG-019).


### ❤️  Thank You

- pseudosky

## 0.1.7 (2026-08-14)


### 🩹 Fixes

- **backlog:** persist citations, atomic repo migration, signal cleanup


### ❤️  Thank You

- pseudosky

## 0.1.6 (2026-08-12)


### 🩹 Fixes

- **backlog:** honor ADHD_BACKLOG_DATABASE_PATH env override (BUG-002)


### ❤️  Thank You

- pseudosky

## 0.1.5 (2026-08-12)


### 🚀 Features

- **backlog:** swap raw better-sqlite3 handle for sox store adapter (F-01)

- **backlog:** F-01 turso adapter migration (resolves blockers)

- **backlog:** convert store to turso store-adapter (F-01+F-02)


### 🩹 Fixes

- **backlog:** dedupe-scan weak FTS match + required-field completeness

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **backlog:** remove better-sqlite3 — turso-native concurrency fixtures (substrate invariant)

- **backlog:** best-effort store close in finally paths (close error must not mask command outcome)

- **backlog:** init telemetry at CLI composition root (stop silent record drop, role:'cli')


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.1.3 (2026-07-30)


### 🚀 Features

- **apigen:** generic batch/bulk fan-out operations (FEAT-APIGEN-BULK-OPS-001)


### 🩹 Fixes

- **backlog:** humanId collision hardening + repo-lookup UX + install/skill packaging


### ❤️  Thank You

- pseudosky

## 0.1.2 (2026-07-27)


### 🚀 Features

- **backlog:** add `backlog install` command — installs the skill AND registers the MCP server into host configs (Claude Code `~/.claude.json` + project `.mcp.json`; opencode `~/.config/opencode/opencode.json` + project) idempotently, at user/project scopes; `install-skill` retained as an alias.


### 🩹 Fixes

- **backlog:** ship `skill/SKILL.md` into `dist/` via a vite `writeBundle` copy plugin (project.json `build.options.assets` is a no-op under `@nx/vite:build`); fix `install-skill` packaged-skill path escaping to `@adhd/skill` in the published rebased layout (BUG-013, BUG-012 class). Harden the inferred `assets` nx target with explicit `outputs` so a `build` cache-hit can't wipe copied assets.


## 0.1.1 (2026-07-27)


### 🩹 Fixes

- **backlog:** fix published tarball crashing at mount — `backlogDistDir()` resolved `client.d.ts` via `import.meta.url + '../dist'`, which escaped to the nonexistent `node_modules/@adhd/dist` once `dist-manifest` rebased the package to its root; now probes for the sibling `client.d.ts` (BUG-012). Adds `server.published-layout.spec.ts` reproducing the published rebased-to-root layout.


### ❤️  Thank You

- pseudosky

## 0.0.3 (2026-07-25)


### 🩹 Fixes

- **apigen,backlog:** killable serve, configurable namespace, flaky test + log spam

- **backlog:** match archived-item exclusion between render and its verify


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-24)


### 🚀 Features

- **backlog:** add CLI entrypoint + bin (live apigen cli-output mount)

- **backlog:** add migration.phase signal + migrationStatus op (MIGRATION.md §4.4)

- **backlog:** Phase 1/2 apigen import + CI parity gate + durable migration.phase admin write

- **backlog:** author backlog-usage skill + install-skill CLI (MIGRATION.md sec 4.2/4.3)

- **backlog:** add `serve` CLI command so .mcp.json has a real entry to spawn (MIGRATION.md sec 4.5)

- **backlog:** rootLevel projection filter so new tool items reach root


### 🩹 Fixes

- **backlog:** close Phase-3 migration gate — CI Node floor, content-hash collision verified, FTS content immutability, bounded busy-retry; plus import provenance/silent-drop fixes

- **backlog:** runBacklogCli no longer eagerly opens the store for --help/no-args (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001)

- **backlog:** concurrent createItem id-collision + FTS sanitizer gap (MIGRATION.md sec 3.3 scale test)

- **backlog:** implement real transition/claim audit-log (DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001)

- **backlog:** importFromMarkdown upserts on re-import instead of insert-only

- **backlog:** sourcepath-ownership gate for importFromMarkdown (DEBT-BACKLOG-IMPORT-SCOPE-CROSSFILE-001)

- **backlog:** re-import backfills ownership + resurrects superseded ids


### ❤️  Thank You

- pseudosky

## Unreleased
