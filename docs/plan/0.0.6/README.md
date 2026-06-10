# Plan: agent-mcp 0.0.6

Implements confirmed gaps and correctness fixes sourced from `packages/ai/agent-mcp/GAPS.md` and a deep code review of 0.0.5 sources:

- **Gap #6** — `max_tokens` and `stop_reason` tracking in `task_usage`
- **Gap #7** — Context window full detection (`CONTEXT_WINDOW_EXCEEDED`) and sliding-window truncation
- **Correctness fixes** — env-var names wrong in `index.ts`; `MAX_TOOL_LOOPS` default mismatch; cache tokens not forwarded; provider error codes not granular enough; claudecli auth error swallowed; empty tool-call guard missing; cancellation detection uses string-matching

## Definition of Done

**Gap #6 — stop_reason / max_tokens**

[dod.1] `TokenUsage` exports `stopReason?: string` and `maxTokens?: number`; both appear in compiled `domain.d.ts`

[dod.2] Providers populate effective `maxTokens`: Anthropic uses `provider.maxTokens ?? AGENT_MCP_DEFAULT_MAX_TOKENS` (env var, default 8192); OpenAI/LMStudio uses config value or `null`

[dod.3] `task_usage` gains `stop_reason TEXT` + `max_tokens INTEGER` nullable; new drizzle migration

[dod.4] `UsagePlugin` writes `stop_reason` (severity-wins in accumulator) + `maxTokens` on initial INSERT

[dod.5] `UsageSummary` gains `stopReason?`; `summarise()` folds via severity-wins

**Gap #7 — context window**

[dod.6] `CONTEXT_WINDOW_EXCEEDED` in `AgentMcpErrorCode`; orchestrator throws it on context overflow

[dod.7] `windowMessages` pure function called from orchestrator (NOT in SessionStore); system messages always preserved; `AGENT_MCP_CONTEXT_LIMIT` read in `index.ts` and injected

**Correctness fixes**

[dod.8] `index.ts` reads `AGENT_MCP_MAX_DEPTH` and `AGENT_MCP_MAX_TOOL_LOOPS` (currently reads bare `MAX_DEPTH`/`MAX_TOOL_LOOPS` — bug); `MAX_TOOL_LOOPS` default reconciled to 50 in code and docs; `AGENT_MCP_DEFAULT_MAX_TOKENS` added as env var

[dod.9] Anthropic provider captures `cache_read_input_tokens` + `cache_creation_input_tokens`; `TokenUsage` gains `cacheReadTokens?`/`cacheCreationTokens?`; `task_usage` gains two nullable integer columns

**Error code completeness**

[dod.10] `PROVIDER_TIMEOUT` error code; orchestrator throws it on timeout (currently `PROVIDER_ERROR`)

[dod.11] `PROVIDER_AUTH_ERROR` error code; covers: Anthropic 401, OpenAI 401, claudecli keychain ACL denial

[dod.12] `PROVIDER_RATE_LIMITED` error code; thrown after retries exhausted on 429

**claudecli / OAuth diagnosis fix**

[dod.13] `claudecli` `buildSubprocessEnv` catch block logs keychain error at warn level and records it; if `chat()` fails, `ToolError` message includes keychain failure reason

[dod.14] `CLAUDE.md` documents that `useClaudeOauth:true` and `claudecli` keychain path require Claude Code process trust context; Anthropic provider gracefully degrades: if keychain read fails, falls back to `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` env vars before throwing `PROVIDER_AUTH_ERROR`

**Robustness**

[dod.15] Empty tool-call guard: `stopReason === "tool_calls"` with zero tool call blocks breaks the orchestrator loop (prevents infinite spin)

[dod.16] Cancellation detection uses error code comparison, not `error.message` string-matching

**Convergence**

[dod.17] `npx nx test agent-mcp` exits 0

[dod.18] Both packages bumped to `0.0.6` and published; `npm info @adhd/agent-mcp version` returns `0.0.6`

[dod.19] All new env vars (`AGENT_MCP_CONTEXT_LIMIT`, `AGENT_MCP_DEFAULT_MAX_TOKENS`) + error codes (`CONTEXT_WINDOW_EXCEEDED`, `PROVIDER_TIMEOUT`, `PROVIDER_AUTH_ERROR`, `PROVIDER_RATE_LIMITED`) documented in `CLAUDE.md` + `README.md`

[dod.20] When OAuth keychain extraction fails, `PROVIDER_AUTH_ERROR` message includes recovery instruction: "Set `ANTHROPIC_AUTH_TOKEN` (run `claude setup-token` to obtain an OAuth access token) or use `authTokenEnv` in the provider config"; `CLAUDE.md` documents the manual injection workflow

## Execution model

- **Parallel execution:** No — linear sequential. `orchestrator.ts` is mutated by multiple states and must be sequenced.
- **Implementer:** sox-active:typescript-pro
- **Review:** Human code-review hold point (`code-review` state) between implementation and `audit-final`.
- **Automatic dispatch:** Yes — the planner orchestrates execution.

## Topology

```
stop-reason-types
      │
      ▼
provider-stop-reason
      │
      ▼
schema-migration
      │
      ▼
usage-plugin-stop
      │
      ▼
usage-report-stop
      │
      ▼
env-var-fixes
      │
      ▼
cache-tokens
      │
      ▼
provider-error-codes
      │
      ▼
context-error-code
      │
      ▼
sliding-window
      │
      ▼
claudecli-auth-fix
      │
      ▼
robustness-fixes
      │
      ▼
audit-foundation
      │
      ▼
code-review  ← human hold point
      │
      ▼
audit-final
      │
      ▼
docs-and-publish
      │
      ▼
    DONE
```

## Rollback / abort

If any state guard fails after `audit-foundation`:
1. `git diff` to identify the partial state.
2. Fix the failing criterion (amend in place; no graph change needed for additive fixes).
3. Re-run the guard.

Drizzle migrations are applied only on server restart — they do not run automatically during the plan. If aborting after `schema-migration`, no DB change is permanent until the server restarts.

## Status command

```bash
node docs/plan/0.0.6/scripts/gap-check.js docs/plan/0.0.6
python3 -c "import json; s=json.load(open('docs/plan/0.0.6/state.json')); print(s['current_state'])"
```
