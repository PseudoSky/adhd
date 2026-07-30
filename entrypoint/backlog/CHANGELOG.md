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
