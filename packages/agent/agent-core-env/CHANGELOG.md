## 0.1.5 (2026-10-08)

### 🩹 Fixes

- **agent-core-env:** declare `@adhd/sox-store-adapter` `^0.13.3` (Turso 0.8.2) in the published manifest, so installs can no longer resolve adapter 0.13.0 / Turso 0.7.2 and trigger the mixed-engine FTS drop/recreate (4b7fd623) ([6cfe7058](https://github.com/PseudoSky/adhd/commit/6cfe7058))

### ❤️ Thank You

- pseudosky

## 0.1.4 (2026-10-07)

### 🚀 Features

- **nx-build:** release/CI/toolchain integrity gates (a4d346ae df9de4da 8c0c314e 255394d0 b83f167d 420a7051 e92e2b92 7b7d5e38 ddceb069) ([35bbcbf0](https://github.com/PseudoSky/adhd/commit/35bbcbf0))

### ❤️ Thank You

- pseudosky

## 0.1.3 (2026-10-06)

### 🚀 Features

- **agent-core-env:** adapter-backed registry open + BEGIN IMMEDIATE / busy-retry contract (ADR-0001 D4 step 1) ([6f889317](https://github.com/PseudoSky/adhd/commit/6f889317))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([b2022986](https://github.com/PseudoSky/adhd/commit/b2022986))

### 🩹 Fixes

- **agent-core-env,agent-mcp:** BEGIN IMMEDIATE + bounded BUSY retry on AgentStore read-modify-write ([d9fddae5](https://github.com/PseudoSky/adhd/commit/d9fddae5))
- **agent-core-env,agent-mcp:** make the SQLite busy_timeout locking contract explicit ([c492feb8](https://github.com/PseudoSky/adhd/commit/c492feb8))
- **vite:** restore import.meta.url in CJS output under vite 8 ([9690844d](https://github.com/PseudoSky/adhd/commit/9690844d))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([4ccdb53e](https://github.com/PseudoSky/adhd/commit/4ccdb53e))

### ❤️ Thank You

- pseudosky

## 0.1.1 (2026-09-24)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes)

- **nx:** drop self-referential scripts.build wrappers to restore build cache


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.0.8 (2026-07-26)

This was a version bump only for agent-core-env to align it with other projects, there were no code changes.

## 0.0.7 (2026-07-26)

This was a version bump only for agent-core-env to align it with other projects, there were no code changes.

## 0.0.6 (2026-07-25)

This was a version bump only for agent-core-env to align it with other projects, there were no code changes.

## 0.0.5 (2026-07-25)

This was a version bump only for agent-core-env to align it with other projects, there were no code changes.

## 0.0.4 (2026-07-24)

This was a version bump only for agent-core-env to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-24)

This was a version bump only for agent-core-env to align it with other projects, there were no code changes.

## 0.0.2 (2026-07-23)


### 🚀 Features

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### ❤️  Thank You

- pseudosky