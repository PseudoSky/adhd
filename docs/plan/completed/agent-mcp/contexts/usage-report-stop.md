# State: usage-report-stop

## Goal

Update `UsageSummary`, `usageSummarySchema`, and `summarise()` to include `stopReason?: string` — the most-severe stop reason across the folded rows. `buildTaskUsageReport` propagates this automatically since it calls `summarise()`.

## Semantic distillation

`summarise()` already folds numeric fields via `reduce`. Adding `stopReason` to the fold uses the same severity-wins logic as [inv:stop-reason-severity] from `_shared.md`. The Zod schema change (`usageSummarySchema`) is additive — `stopReason?: z.string()` is optional, so all existing usages compile unchanged. `validation/task.ts` imports `taskUsageReportSchema` and will pick up the schema change without edits.

## File ownership

**mutates:**
- `packages/ai/agent-mcp/src/validation/usage.ts`
- `packages/ai/agent-mcp/src/tools/usage.ts`

**read_only:**
- `packages/ai/agent-mcp/src/validation/task.ts` (imports taskUsageReportSchema — no edit needed)
- `packages/ai/agent-mcp/src/tools/task.ts` (uses TaskUsageReport — no edit needed, new field is optional)
- `packages/ai/agent-mcp/src/db/schema.ts` (TaskUsageRow now has stopReason column)

## Contract

**Modified: `packages/ai/agent-mcp/src/validation/usage.ts`**

```typescript
export const usageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  stopReason: z.string().optional(),   // ← add
});
```

**Modified: `packages/ai/agent-mcp/src/tools/usage.ts`**

Add severity constant and update `summarise()`:

```typescript
const SEVERITY: Record<string, number> = { length: 3, tool_calls: 2, stop: 1, unknown: 0 };

function summarise(rows: TaskUsageRow[]): UsageSummary {
  return rows.reduce<UsageSummary>(
    (acc, row) => ({
      inputTokens: acc.inputTokens + (row.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (row.outputTokens ?? 0),
      modelCalls: acc.modelCalls + (row.modelCalls ?? 0),
      toolCallCount: acc.toolCallCount + (row.toolCallCount ?? 0),
      latencyMs: acc.latencyMs + (row.latencyMs ?? 0),
      stopReason: mostSevereStr(acc.stopReason, row.stopReason ?? undefined),  // ← add
    }),
    { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCallCount: 0, latencyMs: 0 }
  );
}

function mostSevereStr(a: string | undefined, b: string | undefined): string | undefined {
  if (!a && !b) return undefined;
  const sa = SEVERITY[a ?? ""] ?? 0;
  const sb = SEVERITY[b ?? ""] ?? 0;
  return sa >= sb ? a : b;
}
```

## Acceptance criteria

[usage-report-stop.1] `stopReason` is present in `usageSummarySchema` in `validation/usage.ts`

[usage-report-stop.2] `stopReason` aggregation (most-severe) is present in `summarise()` in `tools/usage.ts`

## Commit points

**R2 (post-guard):**
```
feat(agent-mcp): UsageSummary and TaskUsageReport expose most-severe stopReason
```

## Notes

- `UsageQueryResult.summary` (the flat summary in `usageQuery()`) does NOT need `stopReason` — it is a raw aggregate over a possibly multi-agent result set. Only `UsageSummary` inside `TaskUsageReport` needs it.
- The initial accumulator in `reduce` does not set `stopReason` (undefined). `mostSevereStr(undefined, someValue)` returns `someValue`. `mostSevereStr(undefined, undefined)` returns `undefined`. This is correct — tasks with all-NULL stop_reason rows (claudecli tasks) produce `stopReason: undefined`.
- `TaskUsageRow.stopReason` is `string | null` from Drizzle. Treat `null` as `undefined` in the fold: `row.stopReason ?? undefined`.
