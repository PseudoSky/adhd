## 2.2.10 (2026-10-11)

### 🚀 Features

- **agent-engine-orchestrator:** persist budget:unpriced_model and provider:builtin_bypass as typed task events (20772a0b AC1 AC2 AC3 AC4) ([a6b1150b](https://github.com/PseudoSky/adhd/commit/a6b1150b))

### ❤️ Thank You

- pseudosky

## 2.2.9 (2026-10-11)

### 🚀 Features

- **agent-engine-orchestrator:** first-turn context, failed-run usage and usage_query projections (debd934d afa37093 8333f755) ([0ea88328](https://github.com/PseudoSky/adhd/commit/0ea88328))

### 🩹 Fixes

- **agent-mcp:** roster lookup sorts and limits in SQL; index task_events(task_id,type) via migration 0016; migrate race tests use drizzle's public logger (ad988fda AC1 AC2 AC3 AC5) ([c8f75cf9](https://github.com/PseudoSky/adhd/commit/c8f75cf9))

### ❤️ Thank You

- pseudosky

## 2.2.8 (2026-10-10)

### 🩹 Fixes

- **agent-engine-orchestrator:** bridged claudecli calls get events, coercion and a per-call timeout; fail redispatch on a missing cwd; skip home file in store-path warning (9ed453c1 BLIND F4 F6 F8 F9) ([7adb975e](https://github.com/PseudoSky/adhd/commit/7adb975e))

### ❤️ Thank You

- pseudosky

## 2.2.7 (2026-10-09)

This was a version bump only for agent-store-runtime to align it with other projects, there were no code changes.

## 2.2.6 (2026-10-09)

### 🩹 Fixes

- **agent-store-runtime:** guard finishPull on running, warn on zero-boundary price moves, forced-claim floor (37f6c511, 9ae6927d) ([a017f3b3](https://github.com/PseudoSky/adhd/commit/a017f3b3))

### ❤️ Thank You

- pseudosky

## Unreleased

### 🚀 Features

- **`task_usage` model resolution columns** (migration `0013_task_usage_model_resolution`, additive, nullable): `requested_model`, `cli_reported_cost_usd`, `model_breakdown_json`. Legacy rows read NULL. (79aebb26)

### 🐛 Bug Fixes

- **`tasks.cwd` is persisted.** `TaskStore.create({ cwd })` stores the dispatching cwd and `read`/`list` return it (`Task.cwd`, `null` for legacy rows) so a restart or DAG redispatch spawns the provider in the same cwd (9ed453c1 CWD; migration `0014_task_cwd` in agent-mcp).

- **Cache-write 1h tier.** `PriceHistoryStore.priceAt`/`latest`/`history` records expose `cacheWrite1hPerM`, read from the verbatim `raw_json` `input_cache_write_1h` (no schema change; null when unpublished). A feed update that changes only the 1h tier now appends a new row instead of being deduped as unchanged. (b726a987)

### 🚀 Features

- **Append-only price history.** New tables `model_price_history` (BEFORE UPDATE/DELETE triggers abort; a correction is a new row, newest `observed_at` wins; unique on `(model_id, observed_at, source)`) and `price_pull_ledger` (one row per pull attempt: `running` | `ok` | `failed` | `rejected_shrink` | `rejected_invalid`). Schema in `src/db/schema.ts`, migration `0012_price_history_and_cost_provenance.sql` (shipped in `entrypoint/agent-mcp/drizzle`). (1f1c8598 37f6c511) ([bc340a5b](https://github.com/PseudoSky/adhd/commit/bc340a5b))
- **`PriceHistoryStore`** with `priceAt(modelId, instantIso)` (as-of lookup: greatest `observed_at <= instant`; a turn that predates the first observation gets the earliest row flagged `beforeFirstObservation`), `latest`, `history(model, from?, to?)`, `seedBundled`, `claimPull`, `applyObservation`, `finishPull`, `lastLedger` (with `priceAgeHours`, not reset by a later failure). Multi-statement writes run in `BEGIN IMMEDIATE`, so several processes sharing one DB file serialise on the write lock. (37f6c511 1f1c8598) ([987b093f](https://github.com/PseudoSky/adhd/commit/987b093f))
- **Anomaly rules** exported as `ANOMALY_HOLD_FACTOR` (20), `ANOMALY_WARN_FACTOR` (10) and `ANOMALY_MAX_INPUT_PER_M` (1000): a 20x move or an input above $1000/M is held unless the model id is in `accept`; a 10x move is applied with a `warn` anomaly. A differing price at an already-used instant is skipped with a `same_instant` anomaly. (37f6c511) ([987b093f](https://github.com/PseudoSky/adhd/commit/987b093f))
- **`createPriceSource(db)`**, an as-of price source structurally assignable to core-provider's `IPriceSource`. (37f6c511) ([987b093f](https://github.com/PseudoSky/adhd/commit/987b093f))
- **`task_usage` provenance columns** (nullable; legacy rows stay NULL = provenance unknown): `response_model`, `cost_basis`, `pricing_ref`, `cost_status`, `priced_cost_usd`, `unpriced_tokens`. (1f1c8598) ([bc340a5b](https://github.com/PseudoSky/adhd/commit/bc340a5b))

### Known limits

- A held anomaly needs a manual accept; nothing in this package applies one automatically.
- Prices are as observed by the pulling server, not as effective at the vendor.

### Release note (owner)

Additive (new tables, nullable columns, new exports): minor bump recommended (2.2.5 to 2.3.0). Not bumped here.

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