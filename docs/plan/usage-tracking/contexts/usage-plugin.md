# State: usage-plugin

**Phase:** plugin  
**Kind:** work  
**Depends on:** usage-schema, audit-foundation

## Goal

Implement `UsagePlugin` that accumulates token data via `post:model_response` and flushes to `task_usage` on task completion/failure/cancellation. Wire it into `index.ts`.

## Semantic distillation

`UsagePlugin` implements the `Plugin` interface (`[ref:plugin-interface]`). It maintains an in-memory `Map<taskId, Accumulator>` for start timestamps only. All token data is written to the DB incrementally — see `[inv:incremental-write]`.

**Write strategy:**
- `task:start` → record `startedAt = Date.now()` in the in-memory map. No DB write yet (no tokens to record).
- `post:model_response` → UPSERT into `task_usage`: on first call INSERT with `is_complete=0`; on subsequent calls UPDATE accumulators (add to `input_tokens`, `output_tokens`, `tool_call_count`, increment `model_calls`). This ensures data survives a process crash.
- `task:completed` / `task:failed` / `task:cancelled` → read `rootTaskId` from the in-memory accumulator (stored at `task:start` — see `[inv:root-task-resolution]`), compute `latency_ms = Date.now() - startedAt`, UPDATE the existing row to set `latency_ms`, `root_task_id`, `is_complete=1`. Remove entry from in-memory map. No DB walk required.

If `task:start` fires but no `post:model_response` ever fires (task cancelled before first model call), there is no `task_usage` row — that is correct, zero tokens were consumed.

The plugin receives the Drizzle `Database` (better-sqlite3 instance) at construction time — `index.ts` already has `db` in scope.

```typescript
interface Accumulator {
  startedAt: number; // Date.now() at task:start — only field kept in memory
}
```

Source of `agentName`, `providerType`, `model`: available via `executionContext.agentDefinition` on `task:start`. Pass them through the accumulator or re-read from the first `post:model_response` payload's `executionContext`.

See `[def:task_usage table]`, `[shape:UsagePlugin]`, `[inv:plugin-no-throw]`, `[inv:claudecli-undefined]`, `[inv:ephemeral-flushed]`, `[inv:incremental-write]`, `[inv:root-task-resolution]`.

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/src/engine/orchestrator.ts"]
mutates:    ["packages/ai/agent-mcp/src/plugins/usage-plugin.ts",
             "packages/ai/agent-mcp/src/plugins/index.ts",
             "packages/ai/agent-mcp/src/index.ts"]
```

## Contract promise

**Added:**
- `packages/ai/agent-mcp/src/plugins/usage-plugin.ts` — `UsagePlugin` class
- `packages/ai/agent-mcp/src/plugins/index.ts` — `export { UsagePlugin } from "./usage-plugin.js"`

**Modified:**
- `index.ts`: after `const hooks = new HookRegistry()`, add:
  ```typescript
  import { UsagePlugin } from "./plugins/index.js";
  // ...
  const usagePlugin = new UsagePlugin(db);
  await usagePlugin.install(hooks);
  ```

**Deleted:** nothing

## Acceptance criteria

```bash
# [usage-plugin.1] Plugin file exists and exports UsagePlugin
cd /Users/nix/dev/node/adhd
grep -n 'class UsagePlugin' packages/ai/agent-mcp/src/plugins/usage-plugin.ts | grep -q 'UsagePlugin'

# [usage-plugin.2] Plugin implements Plugin interface
grep -n 'implements Plugin' packages/ai/agent-mcp/src/plugins/usage-plugin.ts | grep -q '.'

# [usage-plugin.3] Plugin registered in index.ts
grep -n 'usagePlugin.install\|UsagePlugin' packages/ai/agent-mcp/src/index.ts | grep -q '.'

# [usage-plugin.4] Plugin registers post:model_response and task terminal handlers
grep -n "post:model_response\|task:completed\|task:failed\|task:cancelled" packages/ai/agent-mcp/src/plugins/usage-plugin.ts | wc -l | grep -qE '[4-9]|[1-9][0-9]'

# [usage-plugin.5] Build passes
npx nx build agent-mcp --skip-nx-cache 2>&1 | tail -3 | grep -iv 'error'

# [usage-plugin.6] All tests pass
npx nx test agent-mcp 2>&1 | tail -5 | grep -q 'pass\|PASS'

# [usage-plugin.7] plugins/index.ts barrel exports UsagePlugin
grep -n 'UsagePlugin' packages/ai/agent-mcp/src/plugins/index.ts | grep -q 'export'

# [usage-plugin.8] Plugin performs UPSERT on post:model_response (incremental write)
grep -n 'post:model_response' packages/ai/agent-mcp/src/plugins/usage-plugin.ts | grep -q '.'
grep -n 'insert\|upsert\|onConflict\|INSERT OR REPLACE\|run(' packages/ai/agent-mcp/src/plugins/usage-plugin.ts | grep -q '.'

# [usage-plugin.9] Plugin resolves root_task_id at terminal event
grep -n 'root_task_id\|rootTaskId' packages/ai/agent-mcp/src/plugins/usage-plugin.ts | grep -q '.'

# [usage-plugin.10] is_complete set to 1 at terminal event
grep -n 'is_complete\|isComplete' packages/ai/agent-mcp/src/plugins/usage-plugin.ts | grep -q '.'
```

## Commit points

**R1 (plan write):** Plan file edits committed.

**R2 (work product):** After guard exits 0:
```
feat(agent-mcp): add UsagePlugin — accumulates token usage and flushes to task_usage
```

## Notes

The `db` object in `index.ts` is typed as `any` before being passed to stores (see the `// eslint-disable-next-line` comment). Pass the same `dbAny` to `UsagePlugin` constructor — the Drizzle insert will work fine.

For the INSERT, import `taskUsageTable` from `../db/schema.js` and use drizzle's insert API:
```typescript
import { drizzle } from "drizzle-orm/better-sqlite3";
import { taskUsageTable } from "../db/schema.js";
// ...
const drizzleDb = drizzle(this.db);
drizzleDb.insert(taskUsageTable).values({ ... }).run();
```
Or check how `AgentStore` does inserts — it's the reference pattern for drizzle inserts in this codebase.

The `task:start` hook payload is `TaskStartPayload { executionContext, messages }`. `executionContext.agentDefinition.provider` has `.type` and `.model` (for claudecli, model is optional — default to `"default"`).

`post:model_response` provides `tokenUsage?: TokenUsage` (after `hook-token-payload` state). Guard for undefined: `payload.tokenUsage?.inputTokens ?? 0`.
