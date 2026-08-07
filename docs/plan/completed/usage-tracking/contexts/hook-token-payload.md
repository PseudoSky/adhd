# State: hook-token-payload

**Phase:** foundation  
**Kind:** work  
**Depends on:** provider-token-signal

## Goal

Extend `PostModelResponsePayload` in `agent-mcp-types` to carry `tokenUsage?` and update the orchestrator to pass it from `providerResponse.usage`.

## Semantic distillation

`PostModelResponsePayload` is defined at `packages/ai/agent-mcp-types/src/hooks.ts:5`. After `provider-token-signal`, `providerResponse.usage` exists on `ProviderChatResponse`. The orchestrator emits `post:model_response` at `packages/ai/agent-mcp/src/engine/orchestrator.ts:151`:

```typescript
await hooks.emit("post:model_response", {
  executionContext,
  stopReason: providerResponse.stopReason,
  toolCallCount: assistantMessage.toolCalls?.length ?? 0,
});
```

This becomes:

```typescript
await hooks.emit("post:model_response", {
  executionContext,
  stopReason: providerResponse.stopReason,
  toolCallCount: assistantMessage.toolCalls?.length ?? 0,
  tokenUsage: providerResponse.usage,
});
```

The field is optional (`tokenUsage?`) — `undefined` when claudecli ran or the provider returned no usage data. See `[ref:hook-payload-optional]`.

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/providers/types.ts"]
mutates:    ["packages/ai/agent-mcp-types/src/hooks.ts",
             "packages/ai/agent-mcp-types/src/domain.ts",
             "packages/ai/agent-mcp/src/engine/orchestrator.ts",
             "packages/ai/agent-mcp/src/tools/task.ts"]
```

## Contract promise

**Modified:**
- `ExecutionContext` (in `domain.ts`) gains `rootTaskId?: string` — derived at task-creation time, not looked up at terminal event. See `[inv:root-task-resolution]`.
- `PostModelResponsePayload` gains `tokenUsage?: TokenUsage`
- `TaskStartPayload` gains `rootTaskId?: string` — forwarded from `executionContext.rootTaskId`
- `orchestrator.ts:151` emit gains `tokenUsage: providerResponse.usage`
- `orchestrator.ts:~57` task:start emit gains `rootTaskId: executionContext.rootTaskId`
- `orchestrator.ts:~357 / ~375` — change `void hooks.emit("task:failed"...)` and `void hooks.emit("task:cancelled"...)` to `await hooks.emit(...)` so the terminal UPDATE commits before the finally block runs
- `tools/task.ts` — `taskTool` and `runEphemeralTask` derive `rootTaskId` at creation: `const rootTaskId = callerContext ? (callerContext.rootTaskId ?? callerContext.taskId) : null;`

**Added:** nothing  
**Deleted:** nothing

## Acceptance criteria

```bash
# [hook-token-payload.1] PostModelResponsePayload has tokenUsage field in compiled types
cd /Users/nix/dev/node/adhd
npx nx build agent-mcp-types --skip-nx-cache 2>/dev/null
grep -n 'tokenUsage' dist/packages/ai/agent-mcp-types/index.d.ts | grep -q 'TokenUsage'

# [hook-token-payload.2] Orchestrator emit call includes tokenUsage
grep -n 'tokenUsage' packages/ai/agent-mcp/src/engine/orchestrator.ts | grep -q 'providerResponse.usage'

# [hook-token-payload.3] TypeScript compiles without errors
npx nx build agent-mcp --skip-nx-cache 2>&1 | grep -v '^$' | tail -3 | grep -iv 'error'

# [hook-token-payload.4] All tests still pass
npx nx test agent-mcp 2>&1 | tail -5 | grep -q 'pass\|PASS'

# [hook-token-payload.5] ExecutionContext has rootTaskId field
grep -n 'rootTaskId' packages/ai/agent-mcp-types/src/domain.ts | grep -q '.'

# [hook-token-payload.6] TaskStartPayload carries rootTaskId
grep -n 'rootTaskId' packages/ai/agent-mcp-types/src/hooks.ts | grep -q '.'

# [hook-token-payload.7] task:start emit includes rootTaskId from executionContext
grep -n 'rootTaskId' packages/ai/agent-mcp/src/engine/orchestrator.ts | grep -q 'executionContext'

# [hook-token-payload.8] task:failed and task:cancelled use await (not void) for hook emit
grep -n 'void hooks.emit' packages/ai/agent-mcp/src/engine/orchestrator.ts | grep -qv 'task:failed\|task:cancelled'

# [hook-token-payload.9] taskTool and runEphemeralTask derive rootTaskId at creation
grep -n 'rootTaskId' packages/ai/agent-mcp/src/tools/task.ts | grep -q 'callerContext'
```

## Commit points

**R1 (plan write):** Plan file edits committed before continuing.

**R2 (work product):** After guard exits 0:
```
feat(agent-mcp-types): add tokenUsage to PostModelResponsePayload; orchestrator passes it through
```

## Notes

`TokenUsage` is defined in `packages/ai/agent-mcp-types/src/domain.ts` (placed there by the `provider-token-signal` state). `hooks.ts` already imports types from `./domain.js`, so adding `TokenUsage` to the import is a one-line change. No package boundary issues.

The import line to add in `hooks.ts`:
```typescript
import type { ExecutionContext, Message, ToolDefinition, Session, AgentDefinition, TokenUsage } from "./domain.js";
```
