## 0.2.1 (2026-09-24)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **build:** route ESM packages' test target through dist-manifest + fail loud on type divergence (BUG-020)

- **nx:** drop self-referential scripts.build wrappers to restore build cache


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.1.11 (2026-07-24)

This was a version bump only for decompile-cli to align it with other projects, there were no code changes.

## 0.1.10 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- complete all build fixes — move dispatch-cli to entrypoint, fix tsconfig paths

- **quality:** salvage completed work from session-limited agents


### ❤️  Thank You

- pseudosky

## 0.1.9 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- complete all build fixes — move dispatch-cli to entrypoint, fix tsconfig paths

- **quality:** salvage completed work from session-limited agents


### ❤️  Thank You

- pseudosky