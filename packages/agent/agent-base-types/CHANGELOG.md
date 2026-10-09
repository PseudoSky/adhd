## 2.3.9 (2026-10-09)

This was a version bump only for agent-base-types to align it with other projects, there were no code changes.

## 2.3.8 (2026-10-09)

This was a version bump only for agent-base-types to align it with other projects, there were no code changes.

## Unreleased

### 🚀 Features

- **`TokenUsage.modelBreakdown?: ModelUsageEntry[]` and `TokenUsage.cliReportedCostUsd?: number`.** Per-model usage for providers whose single response can resolve an alias or span several models (claudecli `modelUsage`). Optional and additive. (79aebb26)

### 🐛 Bug Fixes

- **Cache-write 1h tier.** `TokenUsage.cacheCreation1hTokens?: number`, the 1-hour-TTL subset of `cacheCreationTokens` (never additive to `inputTokens`). Optional and additive. (b726a987)

### 🚀 Features

- **`PostModelResponsePayload.responseModel?: string`** — the model id the provider says actually served the call (the response's own `model` field). Absent when the provider does not report one; distinct from the configured model, since an alias or router can resolve to a different concrete model. Captured by the `anthropic` and `openai` adapters (the latter covers DeepSeek-direct); the `claudecli` adapter does not report it. (1f1c8598) ([cfc9d936](https://github.com/PseudoSky/adhd/commit/cfc9d936))

### Release note (owner)

Additive optional field: minor bump recommended (2.3.7 to 2.4.0). Not bumped here.

## 2.3.7 (2026-10-07)

### 🚀 Features

- **agent-base-types:** ProviderConfig carries models/billingScope/tripwire and BindingRetryConfig (a388103a) ([97d24b93](https://github.com/PseudoSky/adhd/commit/97d24b93))
- **agent-core-provider:** provider-failure classifier, heuristics, retry-after, cooldown (5e72d493 PF-1 AC1-AC8) ([4c5a3b6a](https://github.com/PseudoSky/adhd/commit/4c5a3b6a))
- **agent-base-types:** provider-failure taxonomy, failure-event family, binding billingScope/tripwire/retryWindowMs (5e72d493 PF-1) ([77c883f2](https://github.com/PseudoSky/adhd/commit/77c883f2))

### ❤️ Thank You

- pseudosky

## 2.3.6 (2026-10-07)

### 🚀 Features

- **agent-core-provider:** provider-failure classifier, heuristics, retry-after, cooldown (5e72d493 PF-1 AC1-AC8) ([4c5a3b6a](https://github.com/PseudoSky/adhd/commit/4c5a3b6a))
- **agent-base-types:** provider-failure taxonomy, failure-event family, binding billingScope/tripwire/retryWindowMs (5e72d493 PF-1) ([77c883f2](https://github.com/PseudoSky/adhd/commit/77c883f2))

### ❤️ Thank You

- pseudosky

## 2.3.5 (2026-10-07)

### 🚀 Features

- **agent-base-types:** add permission:decision, hitl:suspend, hitl:resume, session:closed hook events (da907b90 TRACE-1) ([b0ad7219](https://github.com/PseudoSky/adhd/commit/b0ad7219))
- **agent-engine-orchestrator:** un-weld agent from provider; resolveSelection chain + session-held binding + fail-closed NO_PROVIDER_SELECTED (5ad2cf37 D-G(2)) ([b5f3f6d8](https://github.com/PseudoSky/adhd/commit/b5f3f6d8))
- **agent-core-provider:** merge provider representations into one registry + shared PartialBinding (d3f1f787 D-G(1)) ([eabd654c](https://github.com/PseudoSky/adhd/commit/eabd654c))

### 🩹 Fixes

- **agent-mcp:** assert pinned node fs launch + pinned shell, drop npm registry from srt allowlist, connectTimeoutMs type, docs (c9f0a791) ([b9ab73bc](https://github.com/PseudoSky/adhd/commit/b9ab73bc))

### ❤️ Thank You

- pseudosky

## 2.3.4 (2026-10-06)

### 🚀 Features

- **agent-engine-orchestrator:** enforce the resolved native-tooling permission gate (NAT-TOOL-6) ([0103dc2f](https://github.com/PseudoSky/adhd/commit/0103dc2f))
- **agent-base-types:** nativeTooling typed config + stdio cwd (ADR-0008 NAT-TOOL-1) ([a2840f17](https://github.com/PseudoSky/adhd/commit/a2840f17))
- **agent-engine-orchestrator:** provider-native web_search/web_fetch in the default toolset (1abd2d84) ([e95bc2df](https://github.com/PseudoSky/adhd/commit/e95bc2df))

### 🩹 Fixes

- **agent,environment:** static-review bucket B — declarative session snapshot, drop denyCommands, cache+freeze permission map ([1749a443](https://github.com/PseudoSky/adhd/commit/1749a443))

### ❤️ Thank You

- pseudosky

## 2.3.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 2.3.1 (2026-09-24)

This was a version bump only for agent-base-types to align it with other projects, there were no code changes.

## 2.3.0 (2026-08-11)


### 🚀 Features

- **agent-plugin-budget:** rename tokens cap to context with peak semantics + contextWindowFraction (Packet B, BUG-AGENTMCP-009)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent-plugin-budget:** honor cap.mode on the model path with budget:warning/budget:block events (Packet A)

- **agent-plugin-budget:** emit budget:block on tool path; add typecheck targets (Packet A review F1/F5)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 2.1.6 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 2.1.5 (2026-07-24)

This was a version bump only for agent-base-types to align it with other projects, there were no code changes.

## 2.1.4 (2026-07-24)

This was a version bump only for agent-base-types to align it with other projects, there were no code changes.

## 2.1.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **agent-mcp:** name-only tool advertisement + per-turn raw usage storage

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries

- **agent-mcp:** cache-preserving context mgmt, provider-neutral token accounting, refactor-parity fixes; prep 2.1.0 family release

- **agent-mcp:** 2.1.1 — ship drizzle migrations + pin external deps (2.1.0 was broken)


### ❤️  Thank You

- pseudosky

## 2.1.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **agent-mcp:** name-only tool advertisement + per-turn raw usage storage

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries

- **agent-mcp:** cache-preserving context mgmt, provider-neutral token accounting, refactor-parity fixes; prep 2.1.0 family release

- **agent-mcp:** 2.1.1 — ship drizzle migrations + pin external deps (2.1.0 was broken)


### ❤️  Thank You

- pseudosky

# Changelog

All notable changes to `@adhd/agent-mcp-types`. Format based on
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

---

## [1.1.0] — 2026-06-17

### Added

- **Enforcement hook API.** `IHookRegistry` gains two new methods:
  `registerEnforcement<E extends EnforcementEvent>(event, handler)` and
  `enforce<E extends EnforcementEvent>(event, payload): Promise<void>`. Unlike
  `emit()` which swallows handler errors, `enforce()` propagates throws — a handler
  that throws an `IEnforcementError` rejects the returned promise; the caller
  (the orchestrator) then converts it to a `ToolError("BUDGET_EXCEEDED")`.
  Non-`IEnforcementError` throws continue to be swallowed for defence in depth.
- **New types:**
  - `IEnforcementError` — `{ isEnforcementError: true; code: string; message: string }`.
    Handlers throw this to signal a hard limit breach.
  - `EnforcementEvent` — currently `"pre:model_request"` (will expand as more
    interception points are needed).
  - `EnforcementHandler<E extends EnforcementEvent>` — `(payload: HookEventMap[E]) => void | Promise<void>`.
  - `EnforcementEventMap` — maps each `EnforcementEvent` to its payload type (reuses
    `HookEventMap` entries for now).
- **`BUDGET_EXCEEDED` error code.** Added to the `AgentMcpErrorCode` union — thrown
  by the orchestrator when an enforcement handler rejects via `IEnforcementError`.
- **Concrete `HookRegistry` class** (`src/registry.ts`). Relocated here from
  `@adhd/agent-mcp/src/engine/hooks.ts` so plugins can import the class without
  depending on the server package. Implements both `register()`/`emit()` (swallows
  errors) and `registerEnforcement()`/`enforce()` (propagates `IEnforcementError`).
  Uses `console.warn` instead of pino (package is `platform:shared`; no pino dep).
  Exported from the package root. `@adhd/agent-mcp` re-exports it from
  `engine/hooks.ts` for backwards compatibility.
- **`passWithNoTests: true`** in `vite.config.ts`. The package ships only types and a
  pure-TypeScript class — no test files by design. Without this flag `npx nx test
agent-mcp-types` would exit 1 ("No test files found").

---

## [1.0.0] — 2026-06-15

### Added

- Initial release alongside `@adhd/agent-mcp@1.0.0`.
- `IHookRegistry` interface with `register()` and `emit()` across 11 lifecycle hooks
  (`task:start`, `pre:model_request`, `post:model_response`, `pre:tool_call`,
  `post:tool_call`, `message:appended`, `task:completed`, `task:failed`,
  `task:cancelled`, `session:created`, `agent:mutated`).
- `HookEvent`, `HookEventMap`, `HookHandler`, `Plugin`, `PluginContext`,
  `PluginFactory` types.
- `AgentMcpErrorCode` union (all typed error codes thrown by the server).
- `ExecutionContext`, `TokenUsage`, `ToolCallResult`, `ProviderConfig`,
  `AgentDefinition`, `SessionInfo`, `TaskInfo` types.
