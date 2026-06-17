# Plan: Budget Enforcement — Core Primitive + `@adhd/agent-mcp-budget`

> **Status: SHIPPED** — `@adhd/agent-mcp-types@1.1.0`, `@adhd/agent-mcp@1.1.3`,
> `@adhd/agent-mcp-budget@0.0.2` (2026-06-17). See
> [CHANGELOG.md](./CHANGELOG.md) and [BACKLOG.md](./BACKLOG.md) (FEAT-005, FEAT-006).

Two deliverables in dependency order: the enforcement primitive must land in core
before the plugin can use it.

---

## Deliverable 1 — Enforcement primitive (core changes)

### 1.1 `@adhd/agent-mcp-types` additions

File: `packages/ai/agent-mcp-types/src/hooks.ts`

Add after the existing `HookEventMap` block:

```ts
/** Marker interface the orchestrator duck-types to distinguish budget violations
 *  from generic provider errors. Plugins throw this from enforcement handlers;
 *  never use it in observational handlers (those are try/caught). */
export interface IEnforcementError {
  readonly isEnforcementError: true;
  readonly code: string;   // e.g. "BUDGET_EXCEEDED"
  readonly message: string;
}

/** Only these events support enforcement (no-try/catch, blocking, throws propagate). */
export type EnforcementEvent = "pre:model_request";

export type EnforcementHandler<E extends EnforcementEvent> =
  (payload: HookEventMap[E]) => void | Promise<void>;
```

Add `registerEnforcement` to `IHookRegistry`:

```ts
export interface IHookRegistry {
  register<E extends HookEvent>(event: E, handler: HookHandler<E>): void;
  emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): Promise<void>;
  /** Register an enforcement handler. Unlike register/emit, throws propagate. */
  registerEnforcement<E extends EnforcementEvent>(
    event: E,
    handler: EnforcementHandler<E>,
  ): void;
}
```

Also add `"BUDGET_EXCEEDED"` to the `AgentMcpErrorCode` union in `errors.ts`
(or wherever error codes are defined in types).

### 1.2 `@adhd/agent-mcp` — `hooks.ts`

Implement `registerEnforcement` on `HookRegistry`. Enforcement handlers run
**after** all observational handlers (from `emit`) and have **no try/catch** —
exceptions propagate to the caller.

```ts
import type { ..., EnforcementEvent, EnforcementHandler, IEnforcementError } from "@adhd/agent-mcp-types";

export class HookRegistry implements IHookRegistry {
  private readonly handlers            = new Map<HookEvent, HookHandler<HookEvent>[]>();
  private readonly enforcementHandlers = new Map<EnforcementEvent, EnforcementHandler<EnforcementEvent>[]>();

  // existing register / emit unchanged ...

  registerEnforcement<E extends EnforcementEvent>(event: E, handler: EnforcementHandler<E>): void {
    const list = this.enforcementHandlers.get(event) ?? [];
    list.push(handler as EnforcementHandler<EnforcementEvent>);
    this.enforcementHandlers.set(event, list);
  }

  /** Runs enforcement handlers serially. Throws propagate — no try/catch. */
  async enforce<E extends EnforcementEvent>(event: E, payload: HookEventMap[E]): Promise<void> {
    const list = this.enforcementHandlers.get(event);
    if (!list?.length) return;
    for (const handler of list) {
      await (handler as EnforcementHandler<E>)(payload);
    }
  }
}
```

### 1.3 `@adhd/agent-mcp` — `orchestrator.ts`

In the model-call block, after `emit("pre:model_request", ...)`:

```ts
// Observational hooks (errors swallowed)
await hooks.emit("pre:model_request", preMrPayload);

// Enforcement hooks (throws propagate — budget plugin uses this)
try {
  await hooks.enforce("pre:model_request", preMrPayload);
} catch (err: unknown) {
  if (isEnforcementError(err)) {
    throw new McpError(ErrorCode.InternalError, err.message, { code: "BUDGET_EXCEEDED" });
  }
  throw err; // unexpected — re-throw
}
```

Helper (can live in `hooks.ts` or `orchestrator.ts`):

```ts
function isEnforcementError(err: unknown): err is IEnforcementError {
  return typeof err === "object" && err !== null && (err as IEnforcementError).isEnforcementError === true;
}
```

The orchestrator's existing `task:failed` path handles the `McpError` correctly —
the task ends with an error string that includes `"BUDGET_EXCEEDED"`.

### 1.4 Tests (in `agent-mcp`)

File: `src/__tests__/enforcement.test.ts`

- `registerEnforcement` handler throws → `enforce()` rejects, `emit()` is unaffected
- `registerEnforcement` handler passes → `enforce()` resolves
- Orchestrator integration: install a budget plugin that immediately throws
  `IEnforcementError`; run a task; assert task status is `"failed"` and error
  string contains `"BUDGET_EXCEEDED"`
- Teeth check: comment out the `enforce()` call → task completes instead of failing

---

## Deliverable 2 — `@adhd/agent-mcp-budget` plugin

### 2.1 Scaffold

```bash
./generate-lib.sh lib agent-mcp-budget logic node
```

Verify `packages/ai/agent-mcp-budget/project.json` tags: `["layer:logic", "platform:node"]`

Update `packages/ai/agent-mcp-budget/package.json`:
```json
{
  "name": "@adhd/agent-mcp-budget",
  "peerDependencies": { "@adhd/agent-mcp-types": "*" },
  "dependencies": { "zod": "*", "better-sqlite3": "*" }
}
```

`better-sqlite3` is needed for session/agent scope budget queries against the
operational DB (`ctx.db`).

### 2.2 Config schema

```ts
export const configSchema = z.object({
  /** Accumulation scope. "task" is in-memory only.
   *  "session" and "agent" sum across task_usage rows via ctx.db. */
  scope: z.enum(["task", "session", "agent"]).default("task"),

  maxInputTokens:  z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxTotalTokens:  z.number().int().positive().optional(),
  maxModelCalls:   z.number().int().positive().optional(),
  maxWallClockMs:  z.number().int().positive().optional(),

  /** Cost guard (USD). Requires costPerInputToken + costPerOutputToken. */
  maxCostUSD:          z.number().positive().optional(),
  costPerInputToken:   z.number().positive().default(0),
  costPerOutputToken:  z.number().positive().default(0),
});
```

### 2.3 In-memory accumulator (task scope)

Keyed by `executionContext.taskId`. Populated by `task:start` (records
`startedAtMs = Date.now()`) and `post:model_response` (increments token
counters). Cleaned up on any terminal hook.

```ts
interface BudgetAccumulator {
  startedAtMs:   number;
  inputTokens:   number;
  outputTokens:  number;
  modelCalls:    number;
}
```

### 2.4 Enforcement handler

Registered via `hooks.registerEnforcement("pre:model_request", ...)`. Runs
before each model call. Checks all configured limits. If any limit is exceeded,
throws an object satisfying `IEnforcementError`:

```ts
throw {
  isEnforcementError: true as const,
  code: "BUDGET_EXCEEDED",
  message: `Budget exceeded: ${limitName} (limit=${limit}, current=${current})`,
};
```

For **task scope**: reads from the in-memory accumulator.

For **session scope**: queries `SELECT SUM(input_tokens), SUM(output_tokens), ...
FROM task_usage WHERE session_id = ?` using `ctx.db` cast to `BetterSQLite3Database<any>`.

For **agent scope**: queries by `agent_name` across all sessions.

`maxWallClockMs` check: `Date.now() - acc.startedAtMs > config.maxWallClockMs`.

### 2.5 Plugin class structure

```ts
class BudgetPlugin implements Plugin {
  readonly name = "agent-mcp-budget";
  private readonly accumulators = new Map<string, BudgetAccumulator>();

  install(hooks: IHookRegistry): void {
    hooks.register("task:start",          (p) => this.onTaskStart(p));
    hooks.register("post:model_response", (p) => this.onModelResponse(p));
    hooks.register("task:completed",      (p) => this.onTerminal(p.executionContext.taskId));
    hooks.register("task:failed",         (p) => this.onTerminal(p.executionContext.taskId));
    hooks.register("task:cancelled",      (p) => this.onTerminal(p.executionContext.taskId));
    hooks.registerEnforcement("pre:model_request", (p) => this.enforce(p));
  }

  private enforce(payload: PreModelRequestPayload): void {
    // ... check limits, throw IEnforcementError if exceeded
  }
}
```

### 2.6 Tests (in `agent-mcp-budget`)

- Task scope: `maxTotalTokens = 100`; accumulate 101 tokens; next `pre:model_request` throws
- Task scope: accumulate 99 tokens; `pre:model_request` passes
- Task scope: `maxWallClockMs`; stub `Date.now()` to exceed wall clock; throws
- Task scope: `maxModelCalls = 2`; third call throws
- Cost guard: `maxCostUSD = 0.01`; accumulate enough tokens at config rates; throws
- Session scope: two tasks accumulate tokens summing past limit; second task's first model call throws
- Terminal cleanup: accumulator removed after `task:completed`
- Teeth: comment out `registerEnforcement` call → budget-exceeded scenario no longer throws

---

## Integration checklist

After both deliverables pass tests:

- [ ] `npx nx test agent-mcp-types` — 0 failures
- [ ] `npx nx test agent-mcp` — 0 failures (includes enforcement integration test)
- [ ] `npx nx build agent-mcp-budget` — build passes
- [ ] `npx nx test agent-mcp-budget` — 0 failures
- [ ] Add to `agent-mcp.config.json` with `scope: "task"` and a low `maxTotalTokens`
- [ ] Reload MCP (`/mcp`), run a task that would exceed the limit, confirm task
  fails with `BUDGET_EXCEEDED` in the error string
- [ ] CHANGELOG entry in both `agent-mcp` (for enforcement primitive) and
  `agent-mcp-budget` (for the plugin)
- [ ] Update PLUGINS.md: note that `registerEnforcement` is available for
  enforcement-type plugins; update the "Error handling contract" section
