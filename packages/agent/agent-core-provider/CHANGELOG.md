## Unreleased

### 🚀 Features

- **`estimateCost(model, usage, {asOf?, source?})`** returns `{costUsd, status, basis, pricingRef, resolvedId}`; `estimateCostUsd` is now a thin wrapper returning only `costUsd`. A model with no rate returns `costUsd: null` and `status: "unpriced_model"`, never 0. Resolution order: exact `RATE_CARD` key (`vendor-direct`), then OpenRouter (`source.priceAt(id, asOf)` first, bundled snapshot as fallback; an alias hit is `owner-assumption`, a plain id `openrouter-estimate`), then normalised `RATE_CARD` keys and family aliases (`vendor-direct`). A `kind: "router"` record is final: unpriced. With no `opts` the numeric result is unchanged. (1f1c8598 37f6c511) ([5f314528](https://github.com/PseudoSky/adhd/commit/5f314528))
- **Bundled OpenRouter snapshot** (`pricing.json`, 467 models, fetched 2026-10-08) is now projected to a generated `pricing-snapshot.ts` by `nx run agent-core-provider:gen-pricing-snapshot`; the default-running `pricing-snapshot-drift` test fails if the two diverge. New exports: `parseBundledSnapshot`, `PRICING_SNAPSHOT_META`. (37f6c511) ([5f314528](https://github.com/PseudoSky/adhd/commit/5f314528))
- **Feed parser and contracts:** `parseOpenRouterFeed`, `perMillion` (the single per-token to per-million conversion), and the types `IParsedFeed`, `IParsedModel`, `CostBasis`, `CostStatus`, `ICostEstimate`, `IPriceRecord`, `IPriceSource`, `IUsageTokens`. `pricing.overrides` (time-of-day pricing) is kept verbatim in `overridesJson` and never applied. (37f6c511 1f1c8598) ([5f314528](https://github.com/PseudoSky/adhd/commit/5f314528))

### ⚠️ Changed export shape

- **`PROVIDER_MODEL_ALIASES` values are now objects**, not strings: `{ target, basis: "owner-assumption", setAt, setBy, ticket }`. Before: `PROVIDER_MODEL_ALIASES["deepseek-flash"] === "deepseek/deepseek-v4.1-flash"`; now: `PROVIDER_MODEL_ALIASES["deepseek-flash"].target === "deepseek/deepseek-v4.1-flash"`. The new type is exported as `IProviderModelAlias`. (37f6c511) ([5f314528](https://github.com/PseudoSky/adhd/commit/5f314528))

### Known limits

- The `deepseek-flash` to `deepseek/deepseek-v4.1-flash` alias is an owner assumption, not evidence; DeepSeek-direct billing is estimated from OpenRouter rates.
- The bundled snapshot is a point-in-time copy; fresher prices come from the price history that `@adhd/agent-mcp` maintains.

### Release note (owner)

Semver: the alias value-shape change is a breaking change to a public export, so strictly it is a major (2.2.5 to 3.0.0). But the string-valued `PROVIDER_MODEL_ALIASES` was introduced by commit 4f1e4427 (2026-10-08), after the 2.2.5 release commit 133a6090 (2026-10-07), and `published-state.json` still records 2.2.5; no published release ever carried the string shape. Against npm the change is therefore additive, and the repo convention (feat commits map to minor; `BREAKING CHANGE` maps to major) supports a minor bump (2.2.5 to 2.3.0). Recommendation: minor. If a release containing 4f1e4427 has been published since, bump major instead. Not bumped here.

## 2.2.5 (2026-10-07)

### 🚀 Features

- **agent-core-provider:** provider-failure classifier, heuristics, retry-after, cooldown (5e72d493 PF-1 AC1-AC8) ([4c5a3b6a](https://github.com/PseudoSky/adhd/commit/4c5a3b6a))

### ❤️ Thank You

- pseudosky

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