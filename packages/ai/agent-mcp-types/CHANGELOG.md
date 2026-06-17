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
