## 2.2.1 (2026-07-27)


### 🩹 Fixes

- **agent-engine-compiler:** resolve sibling `@adhd/*/drizzle` migration folders via real module resolution (`createRequire` + walk-up) instead of a 3-hop `../../../` that assumed a nonexistent monolithic dist — migrations were silently skipped (→ `no such table: registry_agents`) under the per-project dist layout and pnpm's isolated store (BUG-014). A missing migration set is now a hard error, not a silent warn-and-continue.


## 2.1.10 (2026-07-26)

Re-publish fixing 2.1.9's own defects: an unsatisfiable `@adhd/agent-store-tools: ^2.1.9` dependency range (captured during a transient phantom-version-bump window on agent-store-tools that was later reverted — the real max published is 2.1.8) and a missing `README.md` in the published tarball (BUG-BUILD-ASSETS-CACHE-STALE-AFTER-CLEAN-001) — no code changes to this package itself.

## 2.1.9 (2026-07-26)

Re-publish fixing an empty (1-file) tarball at 2.1.8, caused by BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001 in the shared `@adhd/nx-build:publish`/`:version` executors (see tools/nx-plugins/build/executors/publish/impl.js and .../version/impl.js) — no code changes to this package itself.

## 2.1.8 (2026-07-26)

This was a version bump only for agent-engine-compiler to align it with other projects, there were no code changes.

## 2.1.7 (2026-07-25)

This was a version bump only for agent-engine-compiler to align it with other projects, there were no code changes.

## 2.1.6 (2026-07-25)

This was a version bump only for agent-engine-compiler to align it with other projects, there were no code changes.

## 2.1.5 (2026-07-24)

This was a version bump only for agent-engine-compiler to align it with other projects, there were no code changes.

## 2.1.4 (2026-07-24)

This was a version bump only for agent-engine-compiler to align it with other projects, there were no code changes.

## 2.1.3 (2026-07-23)


### 🚀 Features

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### ❤️  Thank You

- pseudosky