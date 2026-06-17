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
