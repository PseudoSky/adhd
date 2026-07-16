# State: usage-plugin-stop

## Goal

Update `UsagePlugin` to track `stop_reason` (most-severe-wins across model calls, stored in the Accumulator) and `max_tokens` (captured once at task:start from provider config, stored in the initial INSERT row).

## Semantic distillation

The existing UPSERT strategy (see [inv:incremental-write]) writes token counts incrementally. `stop_reason` follows the same UPSERT approach but uses a severity comparison rather than arithmetic addition. `max_tokens` is a constant per task — included in the INSERT values but NOT in the `onConflictDoUpdate` SET (it never changes after the first write). Both columns are nullable — claudecli tasks will write NULL for both.

## File ownership

**mutates:**
- `packages/ai/agent-mcp/src/plugins/usage-plugin.ts`

**read_only:**
- `packages/ai/agent-mcp/src/db/schema.ts` (taskUsageTable now has stopReason + maxTokens columns)
- `packages/ai/agent-mcp-types/src/hooks.ts` (PostModelResponsePayload.tokenUsage carries the new fields)

## Contract

**Modified: `packages/ai/agent-mcp/src/plugins/usage-plugin.ts`**

1. Add severity map and helper at module level (see [inv:stop-reason-severity]):

```typescript
const SEVERITY: Record<string, number> = { length: 3, tool_calls: 2, stop: 1, unknown: 0 };
function mostSevere(a: string | null | undefined, b: string | null | undefined): string {
  const sa = SEVERITY[a ?? ""] ?? 0;
  const sb = SEVERITY[b ?? ""] ?? 0;
  return sa >= sb ? (a ?? "unknown") : (b ?? "unknown");
}
```

2. `Accumulator` gains two new fields:

```typescript
interface Accumulator {
  startedAt: number;
  rootTaskId: string | null;
  agentName: string;
  providerType: string;
  model: string;
  mostSevereStopReason: string;   // ← add; starts as "unknown"
  maxTokens: number | null;       // ← add; set once at task:start
}
```

3. `onTaskStart`: populate new Accumulator fields:

```typescript
const provider = executionContext.agentDefinition.provider;
this.accumulators.set(executionContext.taskId, {
  // ... existing fields ...
  mostSevereStopReason: "unknown",
  maxTokens: ("maxTokens" in provider && typeof provider.maxTokens === "number")
    ? provider.maxTokens
    : null,
});
```

4. `onModelResponse`: update `mostSevereStopReason` in memory, then include both in UPSERT:

```typescript
const incoming = tokenUsage?.stopReason ?? "unknown";
if (acc) {
  acc.mostSevereStopReason = mostSevere(acc.mostSevereStopReason, incoming);
}

this.db
  .insert(taskUsageTable)
  .values({
    // ... existing fields ...
    stopReason: acc?.mostSevereStopReason ?? incoming,
    maxTokens: acc?.maxTokens ?? null,
  })
  .onConflictDoUpdate({
    target: taskUsageTable.taskId,
    set: {
      inputTokens: sql`${taskUsageTable.inputTokens} + ${inputTokens}`,
      outputTokens: sql`${taskUsageTable.outputTokens} + ${outputTokens}`,
      toolCallCount: sql`${taskUsageTable.toolCallCount} + ${toolCalls}`,
      modelCalls: sql`${taskUsageTable.modelCalls} + 1`,
      stopReason: acc?.mostSevereStopReason ?? incoming,
      // maxTokens deliberately OMITTED from SET — it is a constant per task
    },
  })
  .run();
```

## Acceptance criteria

[usage-plugin-stop.1] `stopReason` or `stop_reason` is referenced in `usage-plugin.ts`

[usage-plugin-stop.2] `maxTokens` or `max_tokens` is referenced in `usage-plugin.ts`

[usage-plugin-stop.3] A severity map or most-severe logic (`SEVERITY`, `severity`, `mostSevere`, or `most_severe`) is present in `usage-plugin.ts`

## Commit points

**R2 (post-guard):**
```
feat(agent-mcp): UsagePlugin tracks stop_reason (most-severe-wins) and max_tokens per task
```

## Notes

- See [inv:plugin-no-throw]: all handlers are try/catch wrapped. Add the new logic inside the existing try blocks.
- `maxTokens` must NOT be in `onConflictDoUpdate` SET — if it were, each subsequent model response would overwrite it with the same value, which is harmless but semantically wrong.
- For claudecli tasks: `tokenUsage` is `undefined`, so `incoming` becomes `"unknown"` and `maxTokens` was set to `null` at task-start. Both DB columns will contain NULL — this is correct per [inv:claudecli-undefined].
- The severity update: `mostSevere("unknown", "length")` → `"length"`. Once a `"length"` response fires, no subsequent `"stop"` or `"tool_calls"` can demote it.
