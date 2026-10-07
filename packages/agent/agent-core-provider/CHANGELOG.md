## 2.2.4 (2026-10-07)

### 🚀 Features

- **nx-build:** release/CI/toolchain integrity gates (a4d346ae df9de4da 8c0c314e 255394d0 b83f167d 420a7051 e92e2b92 7b7d5e38 ddceb069) ([35bbcbf0](https://github.com/PseudoSky/adhd/commit/35bbcbf0))
- **agent-core-provider:** merge provider representations into one registry + shared PartialBinding (d3f1f787 D-G(1)) ([eabd654c](https://github.com/PseudoSky/adhd/commit/eabd654c))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([b2022986](https://github.com/PseudoSky/adhd/commit/b2022986))

### 🩹 Fixes

- **agent-store:** complete store-layer atomicity epic — 3 residual sites + JSDoc ([66531986](https://github.com/PseudoSky/adhd/commit/66531986))
- **agent-store:** atomically arbitrate provider/binding/category/link uniqueness ([01313773](https://github.com/PseudoSky/adhd/commit/01313773))
- **agent-store:** arbitrate transitions/uniqueness atomically with typed errors ([747115f0](https://github.com/PseudoSky/adhd/commit/747115f0))
- **vite:** restore import.meta.url in CJS output under vite 8 ([9690844d](https://github.com/PseudoSky/adhd/commit/9690844d))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([4ccdb53e](https://github.com/PseudoSky/adhd/commit/4ccdb53e))

### ❤️ Thank You

- pseudosky

## 2.2.1 (2026-09-24)


### 🩹 Fixes

- **agent-core-provider:** normalize model keys in estimateCostUsd (agent-mcp-005)

- **eslintrc:** exclude vite.config.ts from dependency-checks source scan + module-boundary lint

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes)

- **workspace:** correct nx project names in package.json build scripts

- **nx:** drop self-referential scripts.build wrappers to restore build cache


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 2.1.9 (2026-07-26)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.8 (2026-07-25)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.7 (2026-07-25)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.6 (2026-07-24)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.5 (2026-07-24)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.4 (2026-07-23)


### 🚀 Features

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### 🩹 Fixes

- **agent-mcp:** create + migrate registry DB on fresh machines instead of crashing SQLITE_CANTOPEN


### ❤️  Thank You

- pseudosky

## 2.1.3 (2026-07-23)


### 🚀 Features

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### 🩹 Fixes

- **agent-mcp:** create + migrate registry DB on fresh machines instead of crashing SQLITE_CANTOPEN


### ❤️  Thank You

- pseudosky