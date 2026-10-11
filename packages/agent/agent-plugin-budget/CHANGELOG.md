## 0.2.9 (2026-10-11)

### 🚀 Features

- **agent-engine-orchestrator:** persist budget:unpriced_model and provider:builtin_bypass as typed task events (20772a0b AC1 AC2 AC3 AC4) ([a6b1150b](https://github.com/PseudoSky/adhd/commit/a6b1150b))
- **agent-engine-orchestrator:** un-weld agent from provider; resolveSelection chain + session-held binding + fail-closed NO_PROVIDER_SELECTED (5ad2cf37 D-G(2)) ([b5f3f6d8](https://github.com/PseudoSky/adhd/commit/b5f3f6d8))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([b2022986](https://github.com/PseudoSky/adhd/commit/b2022986))
- **agent-plugin-budget:** add errors/consecutiveErrors caps + reject tool-scoped context (Packet C, plan §8.9) ([c5fbef89](https://github.com/PseudoSky/adhd/commit/c5fbef89))
- **agent-plugin-budget:** rename tokens cap to context with peak semantics + contextWindowFraction (Packet B, BUG-AGENTMCP-009) ([0ec6c3f2](https://github.com/PseudoSky/adhd/commit/0ec6c3f2))
- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2) ([b777b50b](https://github.com/PseudoSky/adhd/commit/b777b50b))
- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes ([91621210](https://github.com/PseudoSky/adhd/commit/91621210))

### 🩹 Fixes

- **agent-plugin-budget:** document the auto-pricing default change and the store-runtime dependency decision, pin the rate-less cost cap (pp-d1 blind-review #2 #3) ([#2](https://github.com/PseudoSky/adhd/issues/2), [#3](https://github.com/PseudoSky/adhd/issues/3))
- **agent-plugin-budget:** price the cost cap on usage_query's source and requested model, one basis per scope (cf7e0e5c review-M1 M2 M3 L4 L5 L6) ([a390e6bb](https://github.com/PseudoSky/adhd/commit/a390e6bb))
- **agent-plugin-budget:** price the cost cap on the shared rate card and honour provider/agent rate overrides (cf7e0e5c AC1-AC9, cbe0b6ce, ab65aa54) ([c8864b1b](https://github.com/PseudoSky/adhd/commit/c8864b1b))
- **agent-plugin-budget:** reserve toolCalls counter atomically at pre:tool_call, document spend-cap overshoot window (699da472) ([ad887715](https://github.com/PseudoSky/adhd/commit/ad887715))
- **agent-plugin-budget:** await createPlugin in BUDGET-B1 spec helper (9ed453c1 BUDGET-B1) ([031eac86](https://github.com/PseudoSky/adhd/commit/031eac86))
- **agent-plugin-budget:** warn mode never alters a call; opt-in soft-block; windowed input/output caps sum their own direction (9ed453c1 BUDGET-B1) ([88c840ca](https://github.com/PseudoSky/adhd/commit/88c840ca))
- **agent-plugin-budget:** policy denials are not errors (df7c3af9 AC1-AC3) ([293dce21](https://github.com/PseudoSky/adhd/commit/293dce21))
- **agent-plugin-budget:** enforce global-scope caps via the drizzle handle + scoped cost ([6a2da60d](https://github.com/PseudoSky/adhd/commit/6a2da60d))
- **agent-mcp:** pin wildcard externals to real ranges ([9869db26](https://github.com/PseudoSky/adhd/commit/9869db26))
- **vite:** restore import.meta.url in CJS output under vite 8 ([9690844d](https://github.com/PseudoSky/adhd/commit/9690844d))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([4ccdb53e](https://github.com/PseudoSky/adhd/commit/4ccdb53e))
- **agent-plugin-budget:** reject windowed caps at task scope (F2 fold-in — silent no-op class, plan §8.9-precedent) ([57b1a7e1](https://github.com/PseudoSky/adhd/commit/57b1a7e1))
- **agent-plugin-budget:** emit budget:block on tool path; add typecheck targets (Packet A review F1/F5) ([16c2252d](https://github.com/PseudoSky/adhd/commit/16c2252d))
- **agent-plugin-budget:** honor cap.mode on the model path with budget:warning/budget:block events (Packet A) ([6017091c](https://github.com/PseudoSky/adhd/commit/6017091c))
- **agent-plugin-budget:** cache-weighted cost enforcement (BUG-AGENTMCP-008) ([75929999](https://github.com/PseudoSky/adhd/commit/75929999))
- **apigen-cli:** restore 2768 files mass-deleted by 6b36a38a (BUG-APIGEN-052) ([8202f672](https://github.com/PseudoSky/adhd/commit/8202f672))
- **agent:** BUG-AGENTBASE-TSC-001 — drop composite:true from agent-plugin-{budget,sanitize} ([f88ec3e4](https://github.com/PseudoSky/adhd/commit/f88ec3e4))
- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001) ([7616be8f](https://github.com/PseudoSky/adhd/commit/7616be8f))
- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001) ([6541313c](https://github.com/PseudoSky/adhd/commit/6541313c))
- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries ([80016bf6](https://github.com/PseudoSky/adhd/commit/80016bf6))

### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001) ([5dad2e52](https://github.com/PseudoSky/adhd/commit/5dad2e52))

### ❤️ Thank You

- pseudosky

## 0.2.8 (2026-10-11)

This was a version bump only for agent-plugin-budget to align it with other projects, there were no code changes.

## Unreleased

### ⚠️ Behaviour changes

- **`pricing` defaults to `auto`: a rate-less `cost` cap now enforces.** A `cost` cap with no `costPer*Token` rates used to accrue $0 and never fire; it is now priced from the rate card. Set `pricing: "flat"` to restore the old behaviour. (pp-d1 blind-review #3)

### Bug Fixes

- **agent-plugin-budget:** `pre:tool_call` no longer loses updates on the per-tool `toolCalls` counter. The counter was read before the cap loop and written back as `snapshot + 1` after awaits in the warn / soft-block / block branches, so two simultaneous calls undercounted and could both pass a full cap. The call is now reserved in one synchronous step and the reservation is released if the call is refused. (699da472 AC1, AC2)

### Documentation

- README: records the `@adhd/agent-store-runtime` dependency decision (no cycle, lint-clean, tracing precedent). (pp-d1 blind-review #2)
- README Concurrency: the `toolCallConcurrency - 1` spend-overshoot bound is scoped to the native tool-loop path; the `claudecli` bridge path is described honestly (governed per call, but not bounded by `toolCallConcurrency`), and the `toolCalls` reservation's over-refusal of a concurrent call (conservative, never over-allows) is documented. (b3999dfa AC1)
- README: new Concurrency section documenting the spend-cap overshoot window under concurrent tool calls (bounded by `toolCallConcurrency - 1`, default 8). (699da472 AC3)

## 0.2.7 (2026-10-09)

### ⚠️ Behaviour changes

- **`warning` mode never alters a call.** On the tool path a tripped `warning`-mode cap used to throw an IToolWarning that skipped the tool; it now only emits `budget:warning` and the tool executes (matching the model path). Existing configs with `mode: "warning"` now warn only. (9ed453c1 BUDGET-B1)
- **Windowed `inputTokens` / `outputTokens` caps count their own direction only.** The window query summed `input_tokens + output_tokens` for both, so a windowed `inputTokens` cap counted output tokens of history (the `current value is 4201334` against a 500000 cap). `inputTokens` now sums input only, `outputTokens` output only. (9ed453c1 BUDGET-B1)

### 🚀 Features

- **agent-plugin-budget:** opt-in `soft-block` mode reproduces the previous tool-path IToolWarning behaviour exactly; `warn` is accepted as an alias of `warning`. `block` still throws BUDGET_EXCEEDED on both paths. (9ed453c1 BUDGET-B1)
- **agent-plugin-budget:** one `budget:warning` per (budget, task) in warn mode, with message `[budget <id> WARN] <current> / <limit> <unit> (<pct>%, window <w>, scope <s>). Warning only; execution continues.` (9ed453c1 BUDGET-B1)

### 📖 Documentation

- README: documents the modes table and migration note, and drops the removed `tokens` cap field / `maxTotalTokens` key from every example.

## 0.2.6 (2026-10-09)

### 🩹 Fixes

- **agent-plugin-budget:** policy denials are not errors (df7c3af9 AC1-AC3) ([293dce21](https://github.com/PseudoSky/adhd/commit/293dce21))

### ❤️ Thank You

- pseudosky

## 0.2.5 (2026-10-07)

### 🚀 Features

- **agent-engine-orchestrator:** un-weld agent from provider; resolveSelection chain + session-held binding + fail-closed NO_PROVIDER_SELECTED (5ad2cf37 D-G(2)) ([b5f3f6d8](https://github.com/PseudoSky/adhd/commit/b5f3f6d8))

### ❤️ Thank You

- pseudosky

## 0.2.4 (2026-10-06)

### 🩹 Fixes

- **agent-plugin-budget:** enforce global-scope caps via the drizzle handle + scoped cost ([6a2da60d](https://github.com/PseudoSky/adhd/commit/6a2da60d))
- **agent-mcp:** pin wildcard externals to real ranges ([9869db26](https://github.com/PseudoSky/adhd/commit/9869db26))

### ❤️ Thank You

- pseudosky

## 0.2.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.2.1 (2026-09-24)

This was a version bump only for agent-plugin-budget to align it with other projects, there were no code changes.

## 0.2.0 (2026-08-11)


### 🚀 Features

- **agent-plugin-budget:** rename tokens cap to context with peak semantics + contextWindowFraction (Packet B, BUG-AGENTMCP-009)

- **agent-plugin-budget:** add errors/consecutiveErrors caps + reject tool-scoped context (Packet C, plan §8.9)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent-plugin-budget:** cache-weighted cost enforcement (BUG-AGENTMCP-008)

- **agent-plugin-budget:** honor cap.mode on the model path with budget:warning/budget:block events (Packet A)

- **agent-plugin-budget:** emit budget:block on tool path; add typecheck targets (Packet A review F1/F5)

- **agent-plugin-budget:** reject windowed caps at task scope (F2 fold-in — silent no-op class, plan §8.9-precedent)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.0.7 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.0.6 (2026-07-24)

This was a version bump only for agent-plugin-budget to align it with other projects, there were no code changes.

## 0.0.5 (2026-07-24)

This was a version bump only for agent-plugin-budget to align it with other projects, there were no code changes.

## 0.0.4 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **agent:** BUG-AGENTBASE-TSC-001 — drop composite:true from agent-plugin-{budget,sanitize}


### ❤️  Thank You

- pseudosky

## 0.0.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **agent:** BUG-AGENTBASE-TSC-001 — drop composite:true from agent-plugin-{budget,sanitize}


### ❤️  Thank You

- pseudosky

# Changelog

All notable changes to `@adhd/agent-mcp-budget`. Format based on
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

---

## [0.0.2] — 2026-06-17

### Changed

- **Package relocated from `packages/node-tools/` to `packages/ai/`** via
  `nx g @nx/workspace:move`. Import path `@adhd/agent-mcp-budget` and all
  runtime behaviour are unchanged. The move aligns this package with the rest of
  the `@adhd/agent-mcp-*` plugin family under `packages/ai/`.
- **Import of `HookRegistry` changed from `@adhd/agent-mcp` to `@adhd/agent-mcp-types`**
  in tests. The class was relocated to `agent-mcp-types` to eliminate a circular
  Nx build dependency (`agent-mcp:build → agent-mcp-budget:build → agent-mcp:build`).
  No change to production code — plugins depend on `@adhd/agent-mcp-types` as a peer.

### Fixed

- **`vite.config.ts` now sets `emptyOutDir: true`.** Without this, Vite does not clear
  `dist/` between builds — the old `dist/package.json` (containing the previous version
  number) would survive a version bump and the wrong version would be published.

---

## [0.0.1] — 2026-06-16

### Added

- Initial release. Budget enforcement plugin for `@adhd/agent-mcp`.
- Registers a `pre:model_request` **enforcement** handler via
  `IHookRegistry.registerEnforcement()` — throws `IEnforcementError` when any
  configured limit is breached, aborting the LLM call before it is made.
- Registers a `post:model_response` **observational** handler that accumulates
  model call count, token totals, and elapsed time.
- Configurable limits (all optional; omit to leave unbounded):
  - `maxModelCalls` — maximum number of LLM calls per task
  - `maxTotalTokens` — combined input + output token cap
  - `maxInputTokens` — input token cap
  - `maxOutputTokens` — output token cap
  - `maxWallClockMs` — wall-clock duration cap (from task start)
  - `maxModelMs` — cumulative model latency cap
  - `maxCostUSD` — cost cap (requires `inputPricePerMToken` + `outputPricePerMToken`
    in config)
- Exports `configSchema` (Zod `z.object(...)`) — the server validates the plugin's
  `config` block in `agent-mcp.config.json` against this schema before calling the
  factory. Validation failure skips the plugin and logs a structured error; the server
  continues without it.
- Exports `createPlugin` as both default and named export (factory signature:
  `(ctx: PluginContext) => Plugin`).
- Activated by adding the plugin to `agent-mcp.config.json`:
  ```json
  {
    "plugins": [
      {
        "module": "/abs/path/to/dist/packages/ai/agent-mcp-budget/index.js",
        "config": { "maxModelCalls": 5, "maxTotalTokens": 50000 }
      }
    ]
  }
  ```
