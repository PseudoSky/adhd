# Plan: `@adhd/agent-mcp-timing` Plugin

Observational-only timing plugin. Accumulates per-interval timing in memory
during task execution and writes a single batch to its own `timing.db` SQLite
file at task terminal. Zero writes to the operational DB (`agents.db`).

---

## Deliverable — `@adhd/agent-mcp-timing` plugin

### 1. Scaffold

```bash
./generate-lib.sh lib agent-mcp-timing logic node
```

Verify `packages/ai/agent-mcp-timing/project.json` tags: `["layer:logic", "platform:node"]`

Update `packages/ai/agent-mcp-timing/package.json`:
```json
{
  "name": "@adhd/agent-mcp-timing",
  "peerDependencies": { "@adhd/agent-mcp-types": "*" },
  "dependencies": { "zod": "*", "better-sqlite3": "*", "uuid": "*" }
}
```

**No dependency on `@adhd/agent-mcp`**. Does not use `ctx.db` (the operational
DB handle) — opens its own `timing.db` connection.

### 2. Config schema

```ts
export const configSchema = z.object({
  /** Path to timing SQLite file. Relative paths resolve from process.cwd().
   *  Set to ":memory:" for ephemeral/test use. */
  dbPath: z.string().default("./data/timing.db"),

  /** Delete rows older than N days at startup and periodically.
   *  0 = no purge (default). */
  maxAgeDays: z.number().int().min(0).default(0),

  /** Also purge every N task completions (in addition to startup).
   *  0 = startup-only. Default: 100 (prevents unbounded growth in long-lived servers). */
  purgeEveryN: z.number().int().min(0).default(100),

  /** Capture per-tool timing (pre:tool_call → post:tool_call intervals).
   *  Default false — adds a row per tool call; enable for detailed profiling. */
  perToolTiming: z.boolean().default(false),

  /** Write a summary row to task_usage (total_model_ms, total_tool_ms) at terminal.
   *  Requires ctx.db access to task_usage. Default false. */
  writeUsageSummary: z.boolean().default(false),
});
```

### 3. Schema (owned by the plugin, in `timing.db`)

The plugin manages its own DB file and schema. No Drizzle — plain SQL DDL run
in the factory constructor.

#### `task_timing` table

```sql
CREATE TABLE IF NOT EXISTS task_timing (
  id            TEXT    NOT NULL PRIMARY KEY,  -- uuid
  task_id       TEXT    NOT NULL,
  interval_type TEXT    NOT NULL,              -- see interval types below
  seq           INTEGER NOT NULL,              -- ordering within task
  turn_index    INTEGER NOT NULL,              -- 0-based model call index
  duration_ms   INTEGER NOT NULL,
  tool_name     TEXT,                          -- set for tool_* intervals
  created_at    TEXT    NOT NULL               -- ISO-8601 UTC
);
CREATE INDEX IF NOT EXISTS idx_task_timing_task_id ON task_timing(task_id);
```

#### `_schema_version` table

```sql
CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL);
INSERT INTO _schema_version (version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM _schema_version);
```

Future schema changes: check `SELECT version FROM _schema_version`, apply
`ALTER TABLE` statements incrementally, update version. Never drop and recreate.

#### Interval types

| `interval_type` | Description |
|---|---|
| `setup` | `task:start` → first `pre:model_request` |
| `model_call` | `pre:model_request` → `post:model_response` (one row per model call) |
| `tool_batch` | Wall-clock from first `pre:tool_call` in batch → last `post:tool_call` |
| `tool_call` | `pre:tool_call` → `post:tool_call` for one tool (only if `perToolTiming: true`) |
| `inject` | Last `post:tool_call` → next `pre:model_request` (context inject + loop overhead) |
| `terminal` | Final `post:model_response` → `task:completed/failed/cancelled` |

### 4. In-memory accumulator

One `TimingAccumulator` per task, keyed by `taskId`. Created in `task:start`,
flushed and deleted at terminal.

```ts
interface TimingAccumulator {
  taskId:          string;
  taskStartMs:     number;      // from task:start
  turnIndex:       number;      // incremented on each pre:model_request
  seq:             number;      // row ordering counter

  modelCallStartMs?: number;    // set in pre:model_request, cleared in post:model_response
  lastModelEndMs?:   number;    // for computing inject_ms

  // Tool batch tracking (parallel tool calls share a batch)
  batchStartMs?:   number;      // set when first pre:tool_call fires in a batch
  batchDepth:      number;      // incremented pre:tool_call, decremented post:tool_call
  batchEndMs?:     number;      // updated to Date.now() on each post:tool_call

  // Per-tool tracking (only if perToolTiming)
  toolCallStarts:  Map<string, number>;  // callId → startMs

  rows:            TimingRow[];  // accumulated, flushed at terminal
}
```

Batch depth tracking is necessary because `pre:tool_call` fires serially but
`post:tool_call` fires concurrently from inside `Promise.all`. The batch ends
when `batchDepth` returns to 0 after the last `post:tool_call`.

### 5. Hook handlers

```
task:start           → init accumulator, record taskStartMs
pre:model_request    → compute inject_ms (if lastModelEndMs set), record setup_ms
                       (first turn only), set modelCallStartMs, increment turnIndex
post:model_response  → compute model_call duration, push row, set lastModelEndMs
pre:tool_call        → if batchDepth === 0: record batchStartMs; increment batchDepth
                       if perToolTiming: record toolCallStarts[callId]
post:tool_call       → decrement batchDepth; update batchEndMs
                       if batchDepth === 0: push tool_batch row
                       if perToolTiming: push tool_call row for callId
task:completed       → push terminal row, flush to DB, cleanup, maybe purge
task:failed          → same as task:completed
task:cancelled       → same as task:completed
```

All handler bodies wrapped in `try/catch` — timing is purely observational,
never fatal.

### 6. Terminal flush

On any terminal hook, write all accumulated rows in a single transaction:

```ts
const insert = timingDb.prepare(`
  INSERT INTO task_timing (id, task_id, interval_type, seq, turn_index, duration_ms, tool_name, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = timingDb.transaction((rows: TimingRow[]) => {
  for (const r of rows) insert.run(r.id, r.taskId, r.intervalType, r.seq, r.turnIndex, r.durationMs, r.toolName ?? null, r.createdAt);
});

insertAll(acc.rows);
```

One transaction = one WAL write = minimal contention with the operational DB.

### 7. TTL purge

Run on startup (if `maxAgeDays > 0`):
```ts
const cutoff = new Date(Date.now() - cfg.maxAgeDays * 86_400_000).toISOString();
timingDb.prepare("DELETE FROM task_timing WHERE created_at < ?").run(cutoff);
```

Run periodically (if `purgeEveryN > 0`) inside the `task:completed` terminal
handler, gated on a completion counter:
```ts
if (cfg.purgeEveryN > 0 && ++this.completionCount % cfg.purgeEveryN === 0) {
  this.runPurge();
}
```

This ensures TTL is enforced even on long-lived servers that don't restart.

### 8. Plugin class structure

```ts
class TimingPlugin implements Plugin {
  readonly name = "agent-mcp-timing";
  private readonly accumulators = new Map<string, TimingAccumulator>();
  private completionCount = 0;

  constructor(
    private readonly timingDb: BetterSQLite3Database,
    private readonly cfg: TimingPluginConfig,
  ) {}

  install(hooks: IHookRegistry): void {
    hooks.register("task:start",          (p) => this.onTaskStart(p));
    hooks.register("pre:model_request",   (p) => this.onPreModelRequest(p));
    hooks.register("post:model_response", (p) => this.onPostModelResponse(p));
    hooks.register("pre:tool_call",       (p) => this.onPreToolCall(p));
    hooks.register("post:tool_call",      (p) => this.onPostToolCall(p));
    hooks.register("task:completed",      (p) => this.onTerminal(p.executionContext.taskId));
    hooks.register("task:failed",         (p) => this.onTerminal(p.executionContext.taskId));
    hooks.register("task:cancelled",      (p) => this.onTerminal(p.executionContext.taskId));
  }
}
```

### 9. Factory

```ts
import Database from "better-sqlite3";
import path from "path";

const createPlugin: PluginFactory = ({ config }: PluginContext): Plugin => {
  const cfg = config as TimingPluginConfig;
  const dbPath = path.resolve(cfg.dbPath);
  const timingDb = new Database(dbPath);
  timingDb.pragma("journal_mode = WAL");
  timingDb.pragma("synchronous = NORMAL");
  timingDb.pragma("foreign_keys = OFF");

  // Schema bootstrap (idempotent)
  timingDb.exec(`
    CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL);
    INSERT INTO _schema_version (version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM _schema_version);
    CREATE TABLE IF NOT EXISTS task_timing (
      id            TEXT    NOT NULL PRIMARY KEY,
      task_id       TEXT    NOT NULL,
      interval_type TEXT    NOT NULL,
      seq           INTEGER NOT NULL,
      turn_index    INTEGER NOT NULL,
      duration_ms   INTEGER NOT NULL,
      tool_name     TEXT,
      created_at    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_timing_task_id ON task_timing(task_id);
  `);

  // Startup purge
  if (cfg.maxAgeDays > 0) {
    const cutoff = new Date(Date.now() - cfg.maxAgeDays * 86_400_000).toISOString();
    timingDb.prepare("DELETE FROM task_timing WHERE created_at < ?").run(cutoff);
  }

  return new TimingPlugin(timingDb, cfg);
};

export default createPlugin;
export { createPlugin };
```

### 10. Tests

File: `src/__tests__/timing-plugin.test.ts`

All tests use `dbPath: ":memory:"` to avoid filesystem I/O.

- **Basic timing:** task with 2 model calls and 2 tools (1 serial batch per turn)
  → assert `setup`, 2× `model_call`, 2× `tool_batch`, 1× `inject`, 1× `terminal`
  rows written; `setup.duration_ms >= 0`; `inject.duration_ms >= 0`
- **perToolTiming: false (default):** no `tool_call` rows, only `tool_batch`
- **perToolTiming: true:** `tool_call` rows present for each callId
- **Parallel tool batch:** simulate 3 concurrent tools in one batch → 1 `tool_batch`
  row with `duration_ms` ≥ max individual duration
- **turn_index:** model_call rows have correct `turn_index` (0, 1, 2...)
- **seq ordering:** rows are ordered by `seq` within a task
- **TTL purge on startup:** insert rows with old `created_at`, construct plugin
  with `maxAgeDays = 7`, assert old rows deleted; recent rows kept
- **Periodic purge:** `purgeEveryN = 3`; emit 3 terminal events; assert purge
  ran (mock `Date.now` to produce stale rows that should be removed)
- **Accumulator cleanup:** after terminal, accumulator map is empty (no leak)
- **Error safety:** handler that would normally throw (force an error) → emit
  still resolves; no rows written for that task (handler caught internally)
- **`:memory:` path:** factory accepts `":memory:"` without path.resolve mangling
  (special-case or test that it works)

### 11. Integration checklist

- [ ] `npx nx build agent-mcp-timing` — build passes
- [ ] `npx nx test agent-mcp-timing` — 0 failures
- [ ] Add to `agent-mcp.config.json`:
  ```json
  {
    "module": "/abs/path/to/dist/packages/ai/agent-mcp-timing/src/index.js",
    "config": { "dbPath": "/abs/path/to/data/timing.db", "maxAgeDays": 30, "purgeEveryN": 100 }
  }
  ```
- [ ] Reload MCP (`/mcp`), confirm `External plugin installed` in logs
- [ ] Run a task; query `timing.db`:
  ```bash
  sqlite3 /path/to/timing.db "SELECT interval_type, duration_ms FROM task_timing ORDER BY seq;"
  ```
  Confirm expected interval rows appear
- [ ] CHANGELOG entry in `agent-mcp-timing` package
