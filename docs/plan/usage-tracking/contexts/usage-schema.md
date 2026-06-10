# State: usage-schema

**Phase:** plugin  
**Kind:** work  
**Depends on:** audit-foundation

## Goal

Add the `task_usage` table to the Drizzle schema and generate the migration file.

## Semantic distillation

`packages/ai/agent-mcp/src/db/schema.ts` defines tables as `sqliteTable(...)` calls imported from `drizzle-orm/sqlite-core`. The new `taskUsageTable` follows the same pattern as `tasksTable`.

Column rationale:
- `task_id` — primary key; maps to the `tasks.id` from the running task (or the ephemeral UUID for `agent_name` mode tasks)
- `root_task_id` — nullable; null = this task is the root of its delegation tree. Non-null = `task_id` of the topmost ancestor. Resolved at terminal event by walking `tasks.parentTaskId`. See `[inv:root-task-resolution]`.
- `agent_name` — denormalized for query convenience; not a foreign key (ephemeral tasks have no `agents` row if the agent is deleted mid-flight)
- `provider_type` — `"openai"` | `"anthropic"` | `"lmstudio"` | `"claudecli"` (string, not enum — extensible)
- `model` — the model string from the provider config
- `input_tokens` / `output_tokens` — accumulated totals across all `post:model_response` events for the task
- `tool_call_count` — accumulated from `toolCallCount` field in `post:model_response` payload
- `model_calls` — count of how many times `post:model_response` fired for this task
- `latency_ms` — wall-clock ms from task start to terminal event; 0 until terminal event fires. See `[inv:incremental-write]`.
- `is_complete` — integer boolean; 0 = row written mid-task or process crashed before terminal; 1 = terminal event reached
- `created_at` — ISO-8601 string; set on first UPSERT (first `post:model_response`)

See `[def:task_usage table]`, `[inv:incremental-write]`, `[inv:root-task-resolution]`.

**Index:** Add a secondary index on `root_task_id` so subtree aggregation queries (`WHERE task_id = ? OR root_task_id = ?`) can use the index on the `root_task_id` side instead of scanning the full table. Add `.index()` to the Drizzle schema column or define a separate index export — see how `tasksTable` handles its indexes for the reference pattern.

No foreign key constraint on `task_id` → `tasks.id`. Ephemeral tasks and cleanup scenarios make the FK unreliable. The plugin tracks usage independently.

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/db/schema.ts",
             "packages/ai/agent-mcp/drizzle/"]
```

## Contract promise

**Added:**
- `taskUsageTable` exported from `schema.ts`
- New drizzle migration SQL file under `packages/ai/agent-mcp/drizzle/` (filename has timestamp prefix, e.g. `0005_task_usage.sql`)
- Updated `drizzle/meta/_journal.json` with the new migration entry

**Modified:** `schema.ts` — one new `sqliteTable` definition appended

**Deleted:** nothing

## Acceptance criteria

```bash
# [usage-schema.1] taskUsageTable defined in schema.ts
cd /Users/nix/dev/node/adhd
grep -n 'taskUsageTable' packages/ai/agent-mcp/src/db/schema.ts | grep -q 'sqliteTable'

# [usage-schema.2] Migration file exists in drizzle/ directory
ls packages/ai/agent-mcp/drizzle/*.sql | xargs grep -l 'task_usage' | grep -q '.'

# [usage-schema.3] Journal updated
grep -n 'task_usage\|taskUsage' packages/ai/agent-mcp/drizzle/meta/_journal.json | grep -q '.'

# [usage-schema.4] TypeScript build passes with new schema
npx nx build agent-mcp --skip-nx-cache 2>&1 | tail -3 | grep -iv 'error'

# [usage-schema.5] All tests still pass
npx nx test agent-mcp 2>&1 | tail -5 | grep -q 'pass\|PASS'

# [usage-schema.6] Migration includes index on root_task_id
ls packages/ai/agent-mcp/drizzle/*.sql | xargs grep -l 'task_usage' | xargs grep -q 'idx_task_usage_root_task_id\|INDEX.*root_task_id'
```

## Commit points

**R1 (plan write):** Plan file edits committed.

**R2 (work product):** After guard exits 0:
```
feat(agent-mcp): add task_usage table schema + drizzle migration
```
Include schema.ts + the generated drizzle files in the same commit.

## Notes

Run the migration generator from inside the package directory:
```bash
cd packages/ai/agent-mcp && npm run db:generate
```
Or find the exact command in `packages/ai/agent-mcp/package.json` scripts — look for `"db:generate"` or `"generate"`. If no such script exists, the command is:
```bash
cd packages/ai/agent-mcp && npx drizzle-kit generate
```

Do NOT run `db:migrate` or `db:push` — migration runs on startup via `runMigrations()` in `index.ts`. The generator only produces the SQL file; the runtime applies it.

See `[ref:drizzle-migration]`.
