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
