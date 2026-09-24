## 0.1.1 (2026-09-24)


### 🩹 Fixes

- **project-graph:** suppress phantom @nx/js:tsc project-reference edges to workspace-base-vite-paths

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.0.4 (2026-07-24)

This was a version bump only for workspace-base-tools to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- **workspace:** create workspace-codegen-nx generator + scaffold workspace-base-tools with getPackageInfo

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- move dispatch-cli to entrypoint, fix build infrastructure

- complete all build fixes — move dispatch-cli to entrypoint, fix tsconfig paths

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **workspace-base-tools:** drop phantom module field — tsc build emits CJS only, index.mjs never existed so verify-dist-load ESM check failed


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- **workspace:** create workspace-codegen-nx generator + scaffold workspace-base-tools with getPackageInfo

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- move dispatch-cli to entrypoint, fix build infrastructure

- complete all build fixes — move dispatch-cli to entrypoint, fix tsconfig paths

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **workspace-base-tools:** drop phantom module field — tsc build emits CJS only, index.mjs never existed so verify-dist-load ESM check failed


### ❤️  Thank You

- pseudosky