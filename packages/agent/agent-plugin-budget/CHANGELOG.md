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
