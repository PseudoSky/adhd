# Code Review Evidence

Date: 2026-06-09T22:15:00Z
Reviewer: typescript-pro (subagent, code-reviewer role)

## Files Reviewed

- `packages/ai/agent-mcp-types/src/domain.ts`
- `packages/ai/agent-mcp-types/src/hooks.ts`
- `packages/ai/agent-mcp/src/providers/types.ts`
- `packages/ai/agent-mcp/src/providers/openai.ts`
- `packages/ai/agent-mcp/src/providers/anthropic.ts`
- `packages/ai/agent-mcp/src/engine/orchestrator.ts`
- `packages/ai/agent-mcp/src/tools/task.ts`
- `packages/ai/agent-mcp/src/tools/usage.ts`
- `packages/ai/agent-mcp/src/validation/usage.ts`
- `packages/ai/agent-mcp/src/validation/task.ts`
- `packages/ai/agent-mcp/src/validation/index.ts`
- `packages/ai/agent-mcp/src/plugins/usage-plugin.ts`
- `packages/ai/agent-mcp/src/plugins/index.ts`
- `packages/ai/agent-mcp/src/index.ts`
- `packages/ai/agent-mcp/src/server.ts`
- `packages/ai/agent-mcp/src/db/schema.ts`
- `packages/ai/agent-mcp/INSTALL.md`
- `packages/ai/agent-mcp/README.md`

## Findings

| # | File | Finding | Severity | Resolution | Status |
|---|------|---------|----------|------------|--------|
| 1 | `tools/task.ts:70,211` | `rootTaskId ?? undefined` is a no-op: the ternary already produces `string \| undefined` (the else-branch is `undefined`, not `null`), so `?? undefined` never changes the value | cosmetic | No code change — the assigned value is always correct; the expression is harmlessly redundant | accepted as-is |
| 2 | `tools/usage.ts:80-100` | All `input?.` optional-chain guards are redundant in the server call paths (both `usageQuery` call sites pass `taskUsageInputSchema.parse(args ?? {})` which fills defaults and returns a non-undefined object) | cosmetic | The `TaskUsageInput` type is `{...} \| undefined`, so the guards are correct for the function's declared signature and protect any future direct callers. No change needed. | accepted as-is |
| 3 | `validation/usage.ts:26` | `taskUsageInputSchema` is `.optional()`, causing `z.toJSONSchema()` to emit `required: ["limit"]` in the MCP `inputSchema` (because `limit` has `.default(50)`). LLM clients see `limit` as a required field even though the server fills the default. | cosmetic | Zod's JSON Schema emission of defaulted fields as required is standard behaviour. The server parses correctly regardless. No change needed. | accepted as-is |
| 4 | `plugins/usage-plugin.ts:79,109,149-150` | `Accumulator.rootTaskId` is `string \| null` while `TaskStartPayload.rootTaskId?` is `string \| undefined`. The plugin correctly converts `undefined → null` via `payload.rootTaskId ?? null` on insert, matching the nullable DB column. Terminal fallback chain `acc?.rootTaskId ?? payload.executionContext.rootTaskId ?? null` is also correct. | verified correct | No change needed — null/undefined boundary is handled explicitly at each DB write site. | accepted as-is |
| 5 | `engine/orchestrator.ts:358,376` | `[inv:incremental-write]` requires `task:failed` and `task:cancelled` to use `await hooks.emit(...)` not `void`. Both lines use `await`. | verified correct | No change needed. | accepted as-is |
| 6 | `plugins/usage-plugin.ts` | `[inv:plugin-no-throw]` — all five handlers (`onTaskStart`, `onModelResponse`, `onTerminal` × 3) are individually wrapped in `try/catch` that logs via pino and swallows the error. Plugin can never throw into the orchestrator. | verified correct | No change needed. | accepted as-is |
| 7 | `server.ts:461,664` | `usage_query` registered at all 4 required points: `inProcessDescriptors` (line 415), `inProcessHandler` case (line 461), `ListToolsRequestSchema` handler (line 561), `CallToolRequestSchema` case (line 664). Complete. | verified correct | No change needed. | accepted as-is |
| 8 | `tools/task.ts` | Background task path (line 286-288) returns `{ task_id, status: "pending" }` with no `usage` field — correct because the orchestrator has not run yet; usage is intentionally absent for background submissions. | verified correct | No change needed — matches `[shape:TaskUsageReport]` contract: usage absent when zero model calls recorded. | accepted as-is |
| 9 | `providers/openai.ts:133-139` | Token extraction uses destructured `sdkUsage` local; `inputTokens: sdkUsage.prompt_tokens`, `outputTokens: sdkUsage.completion_tokens`. Matches OpenAI SDK field names. Returns `undefined` if `response.usage` is falsy. | verified correct | No change needed. | accepted as-is |
| 10 | `providers/anthropic.ts:314-321` | Token extraction always returns a `usage` object (Anthropic SDK guarantees `response.usage`). `inputTokens: sdkUsage.input_tokens`, `outputTokens: sdkUsage.output_tokens`. Correct. | verified correct | No change needed. | accepted as-is |
| 11 | `db/schema.ts` | `taskUsageTable` has no FK on `task_id → tasks.id` (intentional — ephemeral tasks have no tasks row). `idx_task_usage_root_task_id` index present for O(1) subtree queries. All 12 required columns present with correct types/defaults. | verified correct | No change needed. | accepted as-is |
| 12 | `tools/usage.ts:137-158` | `buildTaskUsageReport` queries subtree first, then filters `directRows` by `row.taskId === taskId` in memory. Returns `undefined` when subtree is empty. `summarise()` uses `?? 0` guards on all numeric fields. | verified correct | No change needed. | accepted as-is |

## Build and Test Verification

```
npx nx build agent-mcp --skip-nx-cache  → exit 0, no errors
npx nx test agent-mcp                   → 49/49 tests pass
```

## Summary

12 findings total: 0 bugs, 3 cosmetic/redundant-code accepted as-is, 9 verified-correct confirmations. No cleanup edits required. Implementation is type-safe, error-handling is complete, all registration points are present, and the null/undefined boundary between TypeScript types and the SQLite NULL column is correctly managed at every write site.

REVIEW_COMPLETE
