## 0.1.2 (2026-09-24)


### 🩹 Fixes

- **nx-build:** run-scoped release manifest token + apigen-cli readiness flake + codegen test output


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.1.1 (2026-08-07)


### 🩹 Fixes

- **workspace-codegen-nx:** wire vite-paths helper into scaffold; fix broken externalizeRealDeps path + stale dist layout

- **workspace-base-vite-paths:** commit test fix + lockfile delta from code review

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.0.4 (2026-07-24)

This was a version bump only for workspace-codegen-nx to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **workspace:** create workspace-codegen-nx generator + scaffold workspace-base-tools with getPackageInfo

- **workspace:** add sub-generators per type (base/core/engine/store/plugin/generator/query/types/entrypoint) + fix entrypoint/types schemas

- **workspace:** add .adhd/workspace.json config + config validation in generator

- **workspace:** move workspace config schema into generator package

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **workspace-codegen-nx:** enforce externalizeRealDeps() on newly-scaffolded node/shared packages


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **quality:** salvage completed work from session-limited agents


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **workspace:** create workspace-codegen-nx generator + scaffold workspace-base-tools with getPackageInfo

- **workspace:** add sub-generators per type (base/core/engine/store/plugin/generator/query/types/entrypoint) + fix entrypoint/types schemas

- **workspace:** add .adhd/workspace.json config + config validation in generator

- **workspace:** move workspace config schema into generator package

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **workspace-codegen-nx:** enforce externalizeRealDeps() on newly-scaffolded node/shared packages


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **quality:** salvage completed work from session-limited agents


### ❤️  Thank You

- pseudosky