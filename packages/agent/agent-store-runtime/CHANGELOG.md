## 2.2.5 (2026-10-07)

### 🚀 Features

- **nx-build:** release/CI/toolchain integrity gates (a4d346ae df9de4da 8c0c314e 255394d0 b83f167d 420a7051 e92e2b92 7b7d5e38 ddceb069) ([35bbcbf0](https://github.com/PseudoSky/adhd/commit/35bbcbf0))
- **agent-engine-orchestrator:** emit permission:decision, hitl:suspend, hitl:resume, session:closed (f376e27a TRACE-2) ([9f2e7dc5](https://github.com/PseudoSky/adhd/commit/9f2e7dc5))
- **agent-mcp:** session_update tool, host default provider tier, registry seeding + provider-selection e2e (5ad2cf37 D-G(2)) ([ef9f72e6](https://github.com/PseudoSky/adhd/commit/ef9f72e6))
- **agent-engine-orchestrator:** un-weld agent from provider; resolveSelection chain + session-held binding + fail-closed NO_PROVIDER_SELECTED (5ad2cf37 D-G(2)) ([b5f3f6d8](https://github.com/PseudoSky/adhd/commit/b5f3f6d8))

### 🩹 Fixes

- **agent-store-runtime:** getSelection fails loudly on an unmigrated sessions table (aafd6561 e) ([423350ea](https://github.com/PseudoSky/adhd/commit/423350ea))

### ❤️ Thank You

- pseudosky

## 2.2.4 (2026-10-06)

### 🚀 Features

- **agent-engine-orchestrator:** bound and filter task_list/result output ([d237241f](https://github.com/PseudoSky/adhd/commit/d237241f))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([b2022986](https://github.com/PseudoSky/adhd/commit/b2022986))

### 🩹 Fixes

- **agent-mcp,agent-store-runtime:** collapse duplicate vite plugins keys; sweep all configs (50b77657) ([f2e8ceba](https://github.com/PseudoSky/adhd/commit/f2e8ceba))
- **agent-store:** arbitrate transitions/uniqueness atomically with typed errors ([747115f0](https://github.com/PseudoSky/adhd/commit/747115f0))
- **vite:** restore import.meta.url in CJS output under vite 8 ([9690844d](https://github.com/PseudoSky/adhd/commit/9690844d))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([4ccdb53e](https://github.com/PseudoSky/adhd/commit/4ccdb53e))

### ❤️ Thank You

- pseudosky

## 2.2.1 (2026-09-24)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes)

- **nx:** drop self-referential scripts.build wrappers to restore build cache


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 2.1.7 (2026-07-25)

This was a version bump only for agent-store-runtime to align it with other projects, there were no code changes.

## 2.1.6 (2026-07-24)

This was a version bump only for agent-store-runtime to align it with other projects, there were no code changes.

## 2.1.5 (2026-07-24)

This was a version bump only for agent-store-runtime to align it with other projects, there were no code changes.

## 2.1.4 (2026-07-23)

This was a version bump only for agent-store-runtime to align it with other projects, there were no code changes.

## 2.1.3 (2026-07-23)

This was a version bump only for agent-store-runtime to align it with other projects, there were no code changes.