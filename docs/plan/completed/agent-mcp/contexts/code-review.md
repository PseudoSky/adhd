# State: code-review

## Goal

Human hold point between implementation and `audit-final`. The executor pauses here; the human reviewer inspects the diff, confirms correctness, and creates a sentinel file to unblock the plan.

## Semantic distillation

This is a `kind: review` state. No source code is written. The executor's job is to:
1. Ensure all prior states are complete and their guards pass.
2. Summarise what was changed (see checklist below).
3. Pause and wait for the human reviewer.

The guard is: `test -f docs/plan/0.0.6/.code-review-complete`

The reviewer creates this file when satisfied. The executor must NOT create the file on behalf of the reviewer.

## For the reviewer: what to check

Run these commands to see the full diff:

```bash
# Full diff of all implementation changes
git diff main...HEAD -- packages/ai/

# Abbreviated summary
git diff --stat main...HEAD -- packages/ai/

# Audit foundation (all implementation checks)
python3 docs/plan/0.0.6/scripts/audit_006.py --phase foundation
```

Review checklist:

### Gap #6 — stop_reason / max_tokens
- [ ] `TokenUsage` in `agent-mcp-types` has `stopReason?`, `maxTokens?`, `cacheReadTokens?`, `cacheCreationTokens?`
- [ ] Anthropic provider maps `stop_reason` to normalised enum; captures `cache_read_input_tokens`
- [ ] OpenAI provider maps `finish_reason` to normalised enum
- [ ] `task_usage` schema has all four new nullable columns
- [ ] Drizzle migration generated and correct
- [ ] `UsagePlugin` UPSERT writes `stopReason` (severity-wins) and `maxTokens` (no-update on conflict)
- [ ] `usageSummarySchema` has `stopReason?`; `summarise()` folds with severity-wins

### Correctness fixes
- [ ] `index.ts` reads `AGENT_MCP_MAX_DEPTH`, `AGENT_MCP_MAX_TOOL_LOOPS`, `AGENT_MCP_DEFAULT_MAX_TOKENS`
- [ ] `MAX_TOOL_LOOPS` default is `"50"` (was `"10"`)
- [ ] Anthropic `max_tokens` uses `AGENT_MCP_DEFAULT_MAX_TOKENS` fallback (was hard-coded `4096`)
- [ ] Cache token columns in schema and forwarded from Anthropic provider

### Error codes
- [ ] `PROVIDER_TIMEOUT`, `PROVIDER_AUTH_ERROR`, `PROVIDER_RATE_LIMITED` in both enum files
- [ ] Orchestrator catch block: timeout → `PROVIDER_TIMEOUT`; auth → `PROVIDER_AUTH_ERROR`; 429 → `PROVIDER_RATE_LIMITED`
- [ ] `CONTEXT_WINDOW_EXCEEDED` detection present and before generic `PROVIDER_ERROR` fallback

### claudecli auth fix
- [ ] `buildSubprocessEnv` catch block logs warn + captures `keychainError` string
- [ ] Empty `finalResult` in `claudecli.chat()` throws `PROVIDER_AUTH_ERROR` with recovery message
- [ ] `AnthropicProvider` OAuth path: keychain failure degrades to env vars; throws `PROVIDER_AUTH_ERROR` if both absent
- [ ] Recovery message text includes `` `claude setup-token` `` and `authTokenEnv`

### Gap #7 — sliding window
- [ ] `windowMessages()` pure function in `session-store.ts`; preserves system messages
- [ ] Orchestrator reads `AGENT_MCP_CONTEXT_LIMIT`; calls `windowMessages` before each provider call

### Robustness
- [ ] Empty tool-call guard present in orchestrator loop
- [ ] Cancellation detection uses `signal.aborted` (no `error.message.includes("cancelled")` with `PROVIDER_ERROR`)

### Tests
- [ ] `npx nx test agent-mcp` passes
- [ ] No test expects the old hard-coded `4096` max_tokens value

## After reviewing

Create the sentinel file to unblock the plan:
```bash
touch docs/plan/0.0.6/.code-review-complete
```

If you find issues, do NOT create the sentinel file. Fix the source files, re-run `python3 docs/plan/0.0.6/scripts/audit_006.py --phase foundation`, and then create the file when satisfied.

## File ownership

**mutates:** (nothing — this is a hold point state)

**read_only:** all source files in `packages/ai/`

## Acceptance criteria

[code-review.1] `docs/plan/0.0.6/.code-review-complete` exists (created by human reviewer)

## Commit points

No commit required for this state. The reviewer may commit any last-minute fixes they make during review.

## Notes

- This state's guard is `test -f docs/plan/0.0.6/.code-review-complete`. The file is created by the human reviewer, never by the executor.
- The `.code-review-complete` sentinel is gitignored by convention — it should not be committed. It is a local workflow signal only.
- After the sentinel is created, the executor advances to `audit-final` which re-runs all checks plus the full test suite.
