# Dispatch Backlog Fill — Solution Specs

**Date:** 2026-07-04
**Scope:** 8 actionable backlog items (DEBT-DISPATCH-005, 006, 012, 013, 018, 020, 022, DEBT-WORKSPACE-NX-INPUTS-001) + 1 CLOSE/CONFIRMED (DEBT-DISPATCH-011)

---

## Table of Contents

1. [DEBT-DISPATCH-005 (BL-102..107): Dispatch compiler stubs](#1-debt-dispatch-005-bl-102107)
2. [DEBT-DISPATCH-006: Per-turn token usage via task_events MCP tool](#2-debt-dispatch-006)
3. [DEBT-DISPATCH-012: systemPrompt/prompt split](#3-debt-dispatch-012)
4. [DEBT-DISPATCH-013: D-07 eligible semantics promote own-completion](#4-debt-dispatch-013)
5. [DEBT-DISPATCH-018: Formalize ICalibrationStore](#5-debt-dispatch-018)
6. [DEBT-DISPATCH-020: Causal-aware replan](#6-debt-dispatch-020)
7. [DEBT-DISPATCH-022: dispatch-cli bin field + esbuild step](#7-debt-dispatch-022)
8. [DEBT-WORKSPACE-NX-INPUTS-001: Test boundary sweep](#8-debt-workspace-nx-inputs-001)
9. [DEBT-DISPATCH-011: Orphaned stubs (CLOSE/CONFIRMED)](#9-debt-dispatch-011-closedconfirmed)

---

## 1. DEBT-DISPATCH-005 (BL-102..107)

### 1.1 BL-102: Guard-only milestones need `execution_mode` signal on DispatchUnit

**Files:**
- `packages/shared/dispatch-spec/src/lib/types.ts`
- `packages/shared/dispatch-core-optimizer/src/lib/optimize.ts`

**Problem:** `DispatchUnit` has no typed discriminant for guard-only milestones. The orchestrator must guess: a unit with `model: null, provider: null, agent_name: "", prompt: null` could be a guard-only milestone (correct) or a broken provider config (accident). Currently there is no way to distinguish them at the type level.

**Interface change — `types.ts`:**

```typescript
// BEFORE:
export type SentinelRole = 'prewarm' | 'payload' | 'solo';

export interface DispatchUnit {
  // ... existing fields
  sentinel_role: SentinelRole | null;
  // ...
}

// AFTER:
export type SentinelRole = 'prewarm' | 'payload' | 'solo';
export type ExecutionMode = 'generative' | 'tool-call' | 'guard-only';

export interface DispatchUnit {
  // ... existing fields
  execution_mode: ExecutionMode;  // NEW — always set, non-null
  sentinel_role: SentinelRole | null;
  // ...
}
```

**Behavioral changes — `optimize.ts`:**

In `assembleUnit()` (line 378), derive `execution_mode`:
- All ops are `type: "tool-call"` and there are no generative ops → `'tool-call'`
- Zero operations total (no ops at all, or only the synthesized guard op) → `'guard-only'`
- Any `type: "generative"` op → `'generative'`

```typescript
// In assembleUnit(), add after computing operationIds:
const hasGenerative = packedSlugs.some(slug => {
  const ops = ctx.opsByMilestone.get(slug) ?? [];
  return ops.some(op => op.type === 'generative');
});
const totalOpsCount = packedSlugs.reduce((acc, slug) =>
  acc + (ctx.opsByMilestone.get(slug)?.length ?? 0), 0);

const execution_mode: ExecutionMode =
  totalOpsCount === 0 ? 'guard-only' :
  hasGenerative ? 'generative' :
  'tool-call';
```

**Test cases:**
1. Single milestone with 0 ops → `execution_mode: 'guard-only'`
2. Single milestone with all `tool-call` ops → `execution_mode: 'tool-call'`
3. Single milestone with at least one `generative` op → `execution_mode: 'generative'`
4. Packed batch where at least one milestone has a generative op → `execution_mode: 'generative'`
5. Existing DispatchUnit fixtures updated to include the new field

**Edge cases:**
- Milestone with `type: 'automated'` ops: falls into `'tool-call'` (correct — no model call)
- Mix of `tool-call` and `automated` ops with no `generative`: still `'tool-call'`

**Dependencies:** `@adhd/dispatch-spec` must export `ExecutionMode` before optimizer can reference it.

### 1.2 BL-103: `snapshot_version` increment on write

**Files:**
- `packages/shared/dispatch-core-optimizer/src/lib/snapshot.ts`

**Problem:** `snapshot_version` is always set to `1` (line 980). There is no increment mechanism, so consumers cannot detect stale snapshots.

**Interface change — none.** The field already exists on `DagSnapshot.snapshot_version: number`. The fix is purely behavioral.

**Behavioral change:**

Add a `snapshotVersion?: number` optional parameter to `snapshot()`. When provided, increment by 1. When absent, start at 1. The caller (`orchestrator.ts` or `DagClient`) records the last written version and passes it back.

```typescript
// snapshot.ts — signature change:
export function snapshot(
  dag: DagJson,
  deps: IOptimizerDeps,
  options?: { previousSnapshotVersion?: number }
): DagSnapshot {
  // ...
  const snapshot_version = options?.previousSnapshotVersion
    ? options.previousSnapshotVersion + 1
    : 1;
  // use instead of hardcoded 1
}
```

**Independent segment:** The signature change is backward-compatible — `options` is optional. All existing callers continue to work unchanged (always start at version 1).

**Test cases:**
1. No `options` → `snapshot_version === 1`
2. `previousSnapshotVersion: 3` → `snapshot_version === 4`
3. `previousSnapshotVersion: 0` → `snapshot_version === 1`

### 1.3 BL-104: OperationDag `type_spec` for nested sub-shapes

**Files:**
- `packages/shared/dispatch-spec/src/lib/types.ts`
- `packages/shared/dispatch-core-optimizer/src/lib/optimize.ts` (`compilePrompt`)

**Problem:** `compilePrompt()` inlines operation specs into the prompt, but when an op targets a field whose type is a complex interface (e.g., `Shape`, `DispatchLogEntry`), there is no description of that interface's own sub-fields. The agent generates a simple flat structure instead of the rich polymorphic object.

**Interface change — `types.ts`:**

Add an optional `type_spec` field to `OperationDag` and its snapshot variant:

```typescript
// BEFORE:
export interface OperationDag {
  // ... existing fields
  shape: Shape | null;
}

// AFTER:
export interface TypeSpecEntry {
  field: string;
  type: string;        // "number" | "string" | "Shape" | "DispatchLogEntry" | ...
  sub_fields?: TypeSpecEntry[];  // recursive for nested interfaces
  description?: string;
}

export interface OperationDag {
  // ... existing fields
  shape: Shape | null;
  type_spec: TypeSpecEntry[] | null;  // NEW — describes complex target type internals
}
```

**Behavioral change — `compilePrompt()`:**

In `compilePrompt()` (line 141), after rendering the op's action and file/symbol, if `type_spec` is non-null, append an indented block:

```
  Type spec:
    - field: "kind" → ShapeKind
      sub_fields:
        - field: "kind" → "code-config"
          ops: ShapeOpDag[] — ordered list of structural changes
        - field: "kind" → "doc"
          description: string — what this doc is about
          objective: string — what must be achieved
          required_sections: string[]
```

**Test cases:**
1. Op with `type_spec: null` → no change in prompt output
2. Op with flat `type_spec` (fields are primitives) → inline listing
3. Op with nested `type_spec` (sub_fields populated) → recursive indented listing
4. Multiple ops in one unit, each with different `type_spec` → both rendered
5. Round-trip: dag.json with `type_spec` serialized → deserialized → same shape

**Edge cases:**
- Deeply nested interfaces (3+ levels): indent with 2-space increments per level
- `type_spec` arrays: render each entry separately
- Empty array: same as null

### 1.4 BL-105: `mcp_servers` null → real catalog

**Files:**
- `packages/shared/dispatch-spec/src/lib/types.ts` (MilestoneDag)
- `packages/shared/dispatch-core-optimizer/src/lib/optimize.ts`
- `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts`

**Problem:** `DispatchUnit.mcp_servers` is always null; `AgentMcpRunner.ensureAgent()` hardcodes `mcpServers: {}` as a workaround. Real dispatch needs proper MCP server catalogs per milestone.

**Interface change — `types.ts`:**

Add `mcp_servers` to `MilestoneDag`:

```typescript
// BEFORE:
export interface MilestoneDag {
  // ... existing fields
  guard: string | null;
}

// AFTER — add one field:
export interface MilestoneDag {
  // ... existing fields
  guard: string | null;
  mcp_servers: Record<string, Record<string, unknown>> | null;  // NEW
}
```

Add global defaults to `DagJson`:

```typescript
// Add to DagJson:
export interface DagJson {
  // ... existing fields
  optimization: OptimizationConfig;
  mcp_server_defaults: Record<string, Record<string, unknown>> | null;  // NEW
  providers: Record<string, ProviderConfig>;
  // ...
}
```

**Behavioral changes:**

1. In `assembleUnit()` (`optimize.ts`), resolve `mcp_servers` per unit by unioning each packed milestone's `mcp_servers` (milestone-level overrides global defaults). Requires threading `dag` into optimize's reach.

2. In `AgentMcpRunner.ensureAgent()` (`agent-runner.ts`), use `unit.mcp_servers` instead of `{}`.

**Test cases:**
1. No `mcp_servers` on milestone, no `mcp_server_defaults` on dag → `mcp_servers: null` (backward compat)
2. `mcp_server_defaults` only → all milestones inherit
3. Per-milestone `mcp_servers` overrides → specific servers used
4. Milestone has `mcp_servers` plus dag defaults → merged union

**Cross-package deps:** Requires orchestrated release: dispatch-spec → optimizer → orchestrator → agent-runner.

### 1.5 BL-106: `b_per_tier` cold-start fallback

**Files:**
- `packages/shared/dispatch-core-optimizer/src/lib/snapshot.ts`

**Status:** Already partially solved by `resolveBPerTier()` (line 139-153) which falls back to `deps.bPerTier` for null entries. The missing piece is ensuring the *orchestrator* passes its `DEFAULT_B_PER_TIER` as `deps.bPerTier`.

**Behavioral change — guarantee at the call site:**

In `orchestrateCycle()` (`orchestrator.ts` line 887-892), verify that `bPerTier` is always truthy before constructing `IOptimizerDeps`. This is already the case through `resolveDeps()` (line 331: `deps.bPerTier ?? DEFAULT_B_PER_TIER`).

**Test case (documentation-only):** Prove that a new plan with `b_per_tier: { Haiku: null, Sonnet: null, Opus: null }` in dag.json produces non-null `tokens_estimated` in the snapshot when DEFAULT_B_PER_TIER is supplied.

### 1.6 BL-107: Backward-compat patches in run.ts → readDag()

**Files:**
- `entrypoint/dispatch-cli/src/lib/core.ts` (if readDag lives there) or a shared IO module

**Problem:** Backward-compat patches for pred-schema dags (missing `type` field, missing `providers`, missing `effort_max_tokens`, missing optimization fields) are applied in run.ts's `readDag()` stand-in. These should live in the canonical `readDag()` so all consumers benefit.

**Behavioral change:**

Create a `patchDag(dag: DagJson): DagJson` function that:
1. Defaults missing `type` on operations to `'generative'` (already in `normalizeOperations()` but that runs inside `snapshot()` — needs to also run at IO time)
2. Defaults missing `providers` to `{}`
3. Defaults missing `effort_max_tokens` to `{}`
4. Defaults missing `optimization.b_per_tier` to `{}`
5. Defaults missing `optimization.context_window_per_tier` to `{}`
6. Defaults missing `optimization.sentinel_fanout` to `{ enabled: false, write_multiplier: 1, read_multiplier: 0, hit_probability: 0 }`

Wire into `readDag()` in the IO layer.

**Test cases:**
1. Minimal dag with no optional fields at all → all get defaults
2. Complete modern dag → no modifications
3. Partial dag (half fields present) → missing fields filled, present fields unchanged
4. Backward compat: an adhd-build-era dag (no `type`, no `providers`) → runs without error

---

## 2. DEBT-DISPATCH-006

### Per-turn token usage via `task_events` MCP tool

**Files:**
- `packages/agent/agent-engine-orchestrator/src/tools/usage.ts` (usageQuery)
- `packages/agent/agent-engine-orchestrator/src/validation/usage.ts` (schemas)
- `entrypoint/agent-mcp/src/server.ts` (tool registration)
- `packages/agent/agent-store-runtime/src/db/schema.ts` (taskEventsTable)

**Problem:** The `task_events` table has per-turn `MODEL_RESPONSE` events (each with token counts), but no MCP tool exposes them. `usage_query` returns aggregate `task_usage` rows only. Dispatch calibration (SCOPE §C4) needs per-turn access.

**Schema (already exists):**

```
task_events:
  id: string (PK)
  task_id: string (FK → tasks.id, cascade delete)
  type: enum(MODEL_REQUEST, MODEL_RESPONSE, TOOL_CALL, TOOL_RESULT, TASK_COMPLETED, TASK_FAILED, TASK_CANCELLED)
  payload: text (JSON blob)
  created_at: string (ISO-8601)
```

A `MODEL_RESPONSE` event's `payload` typically has shape `{ inputTokens, outputTokens, model, stopReason, latencyMs }`.

**New validation schema — add to `packages/agent/agent-engine-orchestrator/src/validation/usage.ts`:**

```typescript
// NEW — input schema for task_events query
export const taskEventsInputSchema = z.object({
  task_id: z.string().uuid().optional(),
  type: taskEventTypeSchema.optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.number().int().positive().max(500).default(100),
  include_payload: z.boolean().default(false),
});

export type TaskEventsInput = z.infer<typeof taskEventsInputSchema>;

// NEW — output row
export const taskEventsRowSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.string(),
  payload: z.unknown().nullable(),
  createdAt: z.string(),
});
export type TaskEventsRow = z.infer<typeof taskEventsRowSchema>;
```

**New function — `queryTaskEvents()` in `packages/agent/agent-engine-orchestrator/src/tools/usage.ts`:**

```typescript
import { taskEventsTable } from '@adhd/agent-store-runtime';
import { and, desc, eq, gte, lte } from 'drizzle-orm';

export function queryTaskEvents(
  db: Database,
  input: TaskEventsInput
): TaskEventsRow[] {
  const filters: SQL[] = [];
  if (input.task_id) filters.push(eq(taskEventsTable.taskId, input.task_id));
  if (input.type) filters.push(eq(taskEventsTable.type, input.type));
  if (input.since) filters.push(gte(taskEventsTable.createdAt, input.since));
  if (input.until) filters.push(lte(taskEventsTable.createdAt, input.until));

  const rows = db
    .select({
      id: taskEventsTable.id,
      taskId: taskEventsTable.taskId,
      type: taskEventsTable.type,
      payload: input.include_payload ? taskEventsTable.payload : sql`NULL`,
      createdAt: taskEventsTable.createdAt,
    })
    .from(taskEventsTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(taskEventsTable.createdAt))
    .limit(input.limit)
    .all();

  return rows.map(r => ({
    ...r,
    payload: r.payload ? JSON.parse(r.payload as string) : null,
  }));
}
```

**Tool registration in `entrypoint/agent-mcp/src/server.ts`:**

Add to both `inProcessDescriptors` and the `ListToolsRequestSchema` handler:

```typescript
{
  name: 'task_events',
  description:
    'Query per-turn task events from the task_events table. ' +
    'Filters: task_id, type (e.g. MODEL_RESPONSE), since/until (ISO-8601). ' +
    'Set include_payload:true to return the event payload JSON. ' +
    'Returns events ordered by created_at desc, up to limit entries.',
  inputSchema: toMcpInputSchema(taskEventsInputSchema),
},
```

Add to the `CallToolRequestSchema` handler:

```typescript
case 'task_events':
  return toMcpContent(
    queryTaskEvents(deps.db, taskEventsInputSchema.parse(args ?? {}))
  );
```

**Test cases:**
1. No filters → returns most recent 100 events
2. Filter by `task_id` → only events for that task
3. Filter by `type: 'MODEL_RESPONSE'` → only model response events
4. `include_payload: false` → payload column is null
5. `include_payload: true` → payload is parsed JSON object
6. `since`/`until` filters: respects time window
7. Empty result: returns `[]`

**Edge cases:**
- Task with no events: empty array
- Payload that isn't valid JSON: returned as null (won't happen with current producers)
- Very large payloads (tool results with big file contents): truncated at read time only by SQLite, but 500-row limit prevents OOM

**Cross-package deps:** Agent-engine-orchestrator (usage.ts) ← imports schema from agent-store-runtime. Server.ts wires the new tool. Both packages need coordinated release.

---

## 3. DEBT-DISPATCH-012

### systemPrompt/prompt split

**Files:**
- `packages/shared/dispatch-core-optimizer/src/lib/optimize.ts` (compilePrompt)
- `packages/shared/dispatch-spec/src/lib/types.ts` (DispatchUnit)
- `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts` (ensureAgent, fire)

**Problem:** `DispatchUnit` carries a single `prompt` field. The full compiled prompt is baked into both `agent_create`'s `systemPrompt` (via `ensureAgent`) AND resent as the per-task user-turn prompt (via `fire`). This doubles token cost — ~800 tokens of preamble (role, guard rules, file context) are paid twice per dispatch.

**Interface change — `types.ts`:**

```typescript
// BEFORE:
export interface DispatchUnit {
  // ...
  prompt: string | null;
  // ...
}

// AFTER:
export interface DispatchUnit {
  // ...
  system_prompt: string | null;  // NEW — ~800 tokens, role + guard rules + file context
  task_prompt: string | null;    // NEW — ~5200 tokens, milestone descriptions + ops + shapes
  /** @deprecated Use system_prompt/task_prompt instead. Still populated for backward compat. */
  prompt: string | null;
  // ...
}
```

**Behavioral change — `compilePrompt()` split:**

Split `compilePrompt()` into two named exports:

```typescript
/**
 * Compile the system prompt: role statement, guard command rules, file context listing.
 * ~800 tokens. Deterministic from dag fields.
 * Returns null for tool-call / guard-only units (no model call needed).
 */
export function compileSystemPrompt(
  packedSlugs: string[],
  milestones: DagSnapshot['milestones'],
  opsSnapshot: OperationSnapshot[]
): string | null {
  // Guard prefix: role definition + invariant enforcement rules
  // File context: union of context_files with size annotations
  // Guard command format specification
  // Returns null if all tool-call
}

/**
 * Compile the task prompt: milestone descriptions, rationale, operations, shape specs.
 * ~5200 tokens. Deterministic from dag fields.
 * Returns null for tool-call / guard-only units.
 */
export function compileTaskPrompt(
  packedSlugs: string[],
  milestones: DagSnapshot['milestones'],
  opsSnapshot: OperationSnapshot[]
): string | null {
  // The body of current compilePrompt (milestone descriptions + operations + shapes)
  // minus the preamble/role/context parts
}
```

**Behavioral change — `assembleUnit()`:**

```typescript
// In assembleUnit(), replace the single compilePrompt call:
const system_prompt = compileSystemPrompt(packedSlugs, ctx.snapshot.milestones, ...);
const task_prompt = compileTaskPrompt(packedSlugs, ctx.snapshot.milestones, ...);

// Backward compat:
const prompt = system_prompt !== null && task_prompt !== null
  ? `${system_prompt}\n\n${task_prompt}`
  : (system_prompt ?? task_prompt);

return {
  // ...
  system_prompt,
  task_prompt,
  prompt,  // populated for backward compat
  // ...
};
```

**Behavioral change — `AgentMcpRunner.ensureAgent()`:**

```typescript
async ensureAgent(unit: DispatchUnit): Promise<void> {
  // Use unit.system_prompt (not full prompt) as the agent's static system prompt
  await this.callTool('agent_create', {
    name: unit.agent_name,
    provider: { type: 'claudecli' },
    systemPrompt: unit.system_prompt ?? unit.prompt ?? undefined,  // fallback to prompt
    mcpServers: unit.mcp_servers ?? {},
  });
}
```

**Behavioral change — `AgentMcpRunner.fire()`:**

```typescript
async fire(unit: DispatchUnit): Promise<{ taskId: string }> {
  const promptText = unit.task_prompt ?? unit.prompt;  // task_prompt is the per-turn body
  if (promptText == null) {
    throw new Error(`DispatchUnit '${unit.id}' has no prompt`);
  }
  const result = await this.callTool<{ task_id: string }>('task', {
    agent_name: unit.agent_name,
    prompt: promptText,
  });
  return { taskId: result.task_id };
}
```

**Token savings estimate:**

| Turn | Before (full prompt) | After (system_prompt cached) | Savings |
|------|---------------------|------------------------------|---------|
| 1    | 6000 tokens         | 5200 (task) + 0 (system cached) | 800     |
| 2    | 6000 tokens         | 5200 (task) + 0 (system cached) | 800     |
| 3    | 6000 tokens         | 5200 + 0                      | 800     |
| 4    | 6000 tokens         | 5200 + 0                      | 800     |
| **Total** | **24000**      | **20800**                     | **3200 (13%)** |

After Sentinel-Fanout: system prompt is also read-cached across payload units, compounding savings.

**Test cases:**
1. Guard-only unit: both `system_prompt` and `task_prompt` are null
2. Single milestone, all generative ops: `system_prompt` has role+context, `task_prompt` has ops
3. Tool-call-only unit: both null
4. Backward compat: a consumer reading `prompt` gets the same joined text as before
5. `ensureAgent` called with new fields: uses `system_prompt`
6. `fire` called with new fields: uses `task_prompt`

**Edge cases:**
- `system_prompt` is null but `task_prompt` has content (tool-call with no role): `fire` sends task_prompt, ensureAgent uses task_prompt as system prompt
- `task_prompt` is null but `system_prompt` has content (shouldn't happen in practice): fire falls back to system_prompt
- Both null: fire throws as today

---

## 4. DEBT-DISPATCH-013

### D-07 eligible semantics promote own-completion

**Files:**
- `packages/shared/dispatch-spec/src/lib/types.ts` (MilestoneSnapshot — comment)
- `packages/shared/dispatch-core-optimizer/src/lib/snapshot.ts` (deriveMilestoneStatus, snapshot's D-07 block)
- `packages/dispatch/dispatch-core-client/src/lib/client.ts` (getEligibleMilestones)
- `docs/plan/dispatch-optimizer/SCOPE.md` (D-07)

**Problem:** D-07 defines `eligible` purely from `pending == null` AND all deps complete AND no dep failed. This means a completed milestone stays `eligible: true` forever. `optimize()` independently guards with `status === 'pending'`, but the spec-level definition should promote own-completion into the eligible formula so all consumers inherit the guard.

**Interface change — none.** The `eligible` field already exists on `MilestoneSnapshot`. This is a behavioral + documentation change.

**Behavioral change — `snapshot.ts` D-07 block (line 814-822):**

```typescript
// BEFORE:
const allDepsComplete =
  dagM.depends_on.length === 0 ||
  depStatuses.every((s) => s === 'complete');
const noDepFailed = depStatuses.every((s) => s !== 'failed');
const eligible = dagM.pending === null && allDepsComplete && noDepFailed;

// AFTER:
const allDepsComplete =
  dagM.depends_on.length === 0 ||
  depStatuses.every((s) => s === 'complete');
const noDepFailed = depStatuses.every((s) => s !== 'failed');
const ownPending = dagM.pending === null;
const notAlreadyComplete = status !== 'complete' && status !== 'skipped' && status !== 'failed';
const eligible = ownPending && notAlreadyComplete && allDepsComplete && noDepFailed;
```

**Behavioral change — `client.ts` `getEligibleMilestones()` (line 91-108):**

Can stay as-is (already includes the `isMilestoneComplete()` check which is the client-side equivalent). But add a comment referencing the new spec-level definition.

```typescript
// Add doc comment referencing D-07 (updated):
/**
 * Returns milestone slugs that are eligible for dispatch.
 *
 * Eligibility (D-07, updated): pending == null AND own status is not
 * terminal (complete/skipped/failed) AND all deps complete AND no dep failed.
 * The own-completion guard prevents re-dispatching finished work
 * (BUG-DISPATCH-008).
 */
```

**SCOPE.md D-07 update:**

```
| D-07 | `eligible` requires `pending == null` AND own status NOT terminal
|      | (complete/skipped/failed) AND all deps complete AND no dep failed |
```

**Test cases:**
1. Milestone with `status: 'complete'` → `eligible: false` (was `true`)
2. Milestone with `status: 'failed'` → `eligible: false`
3. Milestone with `status: 'skipped'` → `eligible: false`
4. Milestone with `status: 'pending'`, `pending: null`, deps complete → `eligible: true`
5. Milestone with `pending: "some question"`, deps complete → `eligible: false` (unchanged)
6. Milestone with deps not complete → `eligible: false` (unchanged)

**Edge cases:**
- `status: 'pending-surfaced'` is NOT terminal → `eligible` depends on `pending` field (handled naturally by `notAlreadyComplete` check)
- Zero-operation milestone with no guard → status is `'pending'` (from `deriveMilestoneStatus`), eligible true if deps met

---

## 5. DEBT-DISPATCH-018

### Formalize ICalibrationStore

**Files:**
- `packages/shared/dispatch-spec/src/lib/types.ts` (new interface)
- `packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts` (ICalibrationPlaceholder → ICalibrationStore)

**Problem:** `ICalibrationPlaceholder` (lines 135-137) is a deliberately minimal stand-in. A real `ICalibrationStore` interface should exist in `@adhd/dispatch-spec` for the calibration milestone to depend on.

**Interface — add to `packages/shared/dispatch-spec/src/lib/types.ts`:**

```typescript
/**
 * Calibration store for per-tier baseline token cost ("B").
 *
 * Calibration measures the fixed overhead per dispatch for each model tier
 * by dispatching a null task (no ops) and recording the actual token consumption.
 * Results are persisted so the optimizer can use calibrated B values instead
 * of cold-start estimates on subsequent runs.
 *
 * Cold-start defaults (used when no calibration data exists):
 *   Haiku: 8000, Sonnet: 15000, Opus: 27000
 */
export interface ICalibrationStore {
  /** Read all calibration entries. */
  readAll(): Promise<CalibrationEntry[]> | CalibrationEntry[];
  /** Read a single tier's calibration entry, or null if uncalibrated. */
  read(tier: ModelTier): Promise<CalibrationEntry | null> | CalibrationEntry | null;
  /** Write a calibration entry for a tier. Replaces any existing entry for the same tier. */
  write(tier: ModelTier, entry: CalibrationEntry): Promise<void> | void;
}

export interface CalibrationEntry {
  tier: ModelTier;
  b_tokens: number;           // Measured base overhead in tokens
  measured_at: string;        // ISO-8601
  sample_count: number;       // Number of null-task dispatches averaged
  std_dev: number | null;     // Standard deviation across samples, null if sample_count < 2
}

/**
 * Convenience: read all entries as a Record<tier, b_tokens> for direct
 * consumption by IOptimizerDeps.bPerTier.
 */
export function calibrationEntriesToRecord(
  entries: CalibrationEntry[]
): Partial<Record<ModelTier, number>> {
  const record: Partial<Record<ModelTier, number>> = {};
  for (const entry of entries) {
    record[entry.tier] = entry.b_tokens;
  }
  return record;
}
```

**Replacement in `orchestrator.ts`:**

```typescript
// BEFORE (lines 124-137):
export interface ICalibrationPlaceholder {
  read(): Promise<Record<string, number>> | Record<string, number>;
}

// AFTER — import from @adhd/dispatch-spec:
import type { ICalibrationStore } from '@adhd/dispatch-spec';

// In OrchestratorDeps:
export interface OrchestratorDeps {
  // ...
  /** OPTIONAL. Calibration store for per-tier B values. When present, queried at
   *  cycle start to populate IOptimizerDeps.bPerTier. Absent: cold-start defaults. */
  calibration?: ICalibrationStore;
  // ...
}
```

**Update `resolveDeps()` logic (around line 325):** If `calibration` is present, call `calibration.readAll()` and merge into `bPerTier` before passing to `IOptimizerDeps` — calibrated values take priority over cold-start defaults.

```typescript
async function resolveCalibrationB(
  calibration: ICalibrationStore | undefined,
  bPerTier: Record<string, number>
): Promise<Record<string, number>> {
  if (!calibration) return bPerTier;
  const entries = await calibration.readAll();
  for (const entry of entries) {
    bPerTier[entry.tier] = entry.b_tokens;  // calibrated wins
  }
  return bPerTier;
}
```

**Test cases:**
1. No calibration store → `bPerTier` is cold-start defaults only
2. Calibration store with Haiku=7500, Sonnet=14200 → those values override defaults
3. Partial calibration (only Haiku) → Haiku uses calibrated, Sonnet/Opus use defaults
4. Calibration with `readAll()` returns empty → all defaults
5. `calibrationEntriesToRecord()`: array of 2 entries → correct Record shape

**Cross-package deps:** dispatch-spec exports `ICalibrationStore` + `CalibrationEntry`; orchestrator imports and uses them. No dependency cycle.

---

## 6. DEBT-DISPATCH-020

### Causal-aware replan

**Files:**
- `packages/shared/dispatch-spec/src/lib/types.ts` (DispatchKind, new ReplanNote)
- `packages/dispatch/dispatch-orchestrator/src/lib/orchestrator.ts` (injectCorrectionMilestone, injectFailureCorrection)

**Problem:** `injectCorrectionMilestone()` copies the failed milestone's `depends_on` verbatim (line 537). Downstream milestones that depended on the failed slug never see the correction. There is no causal tracing: the correction cannot target a truly at-fault upstream milestone.

**Interface change — add `ReplanNote` and extend `DispatchKind`:**

```typescript
// In types.ts — new type:
export type DispatchKind = 'planning' | 'execution' | 'replan';  // added 'replan'

export interface ReplanNote {
  /** The dispatch_log entry id that triggered replanning. */
  triggered_by_dispatch: string;
  /** The slug of the milestone that failed its guard. */
  failed_milestone: string;
  /** Slugs of milestones whose depends_on were rewired to the correction. */
  rewired_downstream: string[];
  /** The slug of the correction milestone injected. */
  correction_slug: string;
  /** ISO timestamp of when replan was injected. */
  injected_at: string;
}
```

**Add to `MilestoneDag`:** Optionally record failure reason:

```typescript
export interface MilestoneDag {
  // ... existing fields
  pending: string | null;
  /** NEW — set to a non-null value when this milestone is pending because
   *  a replan is required (e.g., an upstream guard failure). The correction
   *  milestone should resolve this. */
  pending_reason?: 'replan-required' | null;
  // ...
}
```

**Behavioral change — `orchestrator.ts` `injectCorrectionMilestone()`:**

Add a second, richer overload for causal replan:

```typescript
/**
 * Causal-aware correction injection.
 *
 * Unlike the generic injection (which copies depends_on verbatim), this
 * version:
 * 1. Wires the correction milestone's depends_on to the failed milestone's
 *    OWN deps (not the failed milestone itself).
 * 2. Marks the failed milestone as `pending: "replan-required"`.
 * 3. Returns a ReplanNote describing what was rewired.
 * 4. Does NOT auto-rewire downstream — that is the plan-builder's job
 *    (out of orchestrator scope), but the ReplanNote provides the data.
 *
 * Returns null when failedSlug has agent: null (guard-only milestone).
 */
function injectCausalCorrectionMilestone(
  dag: DagJson,
  failedSlug: string,
  dispatchEntryId: string,
  guardOutput: string,
  extraReadOnly: string[]
): { slug: string; milestone: MilestoneDag; operation: OperationDag; note: ReplanNote } | null {
  const original = dag.milestones[failedSlug];
  if (!original || original.agent == null) return null;

  const slug = nextCorrectionSlug(dag, failedSlug);

  // Build correction depends_on from failed milestone's OWN deps
  // (so correction runs AFTER the same upstream deps as the failed work)
  const correctionDependsOn = [...original.depends_on];

  // Find downstream milestones that depend on the failed slug
  const rewiredDownstream: string[] = [];
  for (const [mslug, m] of Object.entries(dag.milestones)) {
    if (m.depends_on.includes(failedSlug)) {
      rewiredDownstream.push(mslug);
    }
  }

  // Mark the failed milestone as replan-required
  dag.milestones[failedSlug] = {
    ...original,
    pending: 'replan-required',  // Mark as pending with reason
  };

  // Build milestone (same as before but with causal depends_on)
  const milestone: MilestoneDag = {
    // ... same fields as injectCorrectionMilestone ...
    depends_on: correctionDependsOn,
    // ...
  };

  const note: ReplanNote = {
    triggered_by_dispatch: dispatchEntryId,
    failed_milestone: failedSlug,
    rewired_downstream,
    correction_slug: slug,
    injected_at: new Date().toISOString(),
  };

  return { slug, milestone, operation, note };
}
```

**Mark failed milestone as `pending: "replan-required"`:**

In `injectFailureCorrection()` (line 585), after a correction is injected, set:

```typescript
// Mark the failed milestone so snapshot() can reflect the replan state:
dag.milestones[slug] = {
  ...dag.milestones[slug],
  pending: 'replan-required',
};
```

This causes `deriveMilestoneStatus()` to return `'pending-surfaced'` for the failed milestone (since deps are complete and `pending` is non-null), and `eligible` becomes `false` (since `pending !== null`).

**Behavioral change — `snapshot.ts`:**

In `deriveMilestoneStatus()` (line 299), handle `pending: "replan-required"`:

```typescript
// In deriveMilestoneStatus, after the 'pending-surfaced' check:
if (dag.pending === 'replan-required') {
  return 'pending-surfaced';  // Consumer sees: "someone needs to resolve this"
}
```

**Behavioral change — plan-builder (out of scope for this BL, but spec describes):**

When a new cycle processes the ReplanNote, the plan-builder should:
1. Find `rewired_downstream` slugs still with `pending === null`
2. Rewire their `depends_on` to include the correction slug instead of (or in addition to) the failed slug
3. Clear `pending` on the correction milestone (if set by prior injection) to make it eligible

**Test cases:**
1. Single downstream depends on failed slug → `rewiredDownstream` contains its slug
2. No downstream depends on failed slug → `rewiredDownstream` is empty
3. Chain: A → B → C; B fails → correction depends on A (not B), C still depends on B
4. Failed milestone's `pending` becomes `"replan-required"` after injection
5. Guard-only milestone failure: returns null, no injection
6. `deriveMilestoneStatus` with `pending: "replan-required"` → `'pending-surfaced'`

**Edge cases:**
- Diamond dependency: both A and B depend on X; X fails → both stay wired to X (unchanged; plan-builder decides which to rewire)
- Failed milestone already has `pending: "replan-required"` → no double-wrap (idempotent)
- Correction milestone for a correction (recursive): allowed — slug counter increments

---

## 7. DEBT-DISPATCH-022

### dispatch-cli bin field + esbuild build step

**Files:**
- `entrypoint/dispatch-cli/package.json`
- `entrypoint/dispatch-cli/project.json`
- `entrypoint/dispatch-cli/bin/cli.ts`

**Problem:** `bin/cli.ts` is hand-written TypeScript with a shebang (`#!/usr/bin/env node`). The vite build doesn't compile `bin/` files. `package.json` has no `bin` field. The CLI is only invocable via `npx tsx bin/cli.ts`.

**Changes:**

### `package.json` — add bin field:

```json
{
  "name": "@adhd/dispatch-cli",
  "version": "0.0.1",
  "bin": {
    "dispatch-cli": "./bin/cli.js"
  },
  // ... existing fields
}
```

### `project.json` — add esbuild `build-bin` target:

```json
{
  "targets": {
    "build": {
      "executor": "@nx/vite:build",
      // ... existing vite build for library
    },
    "build-bin": {
      "executor": "nx:run-commands",
      "cache": true,
      "inputs": ["{projectRoot}/bin/**/*"],
      "dependsOn": ["build"],
      "options": {
        "command": "esbuild entrypoint/dispatch-cli/bin/cli.ts --bundle --platform=node --target=node20 --outfile=entrypoint/dispatch-cli/bin/cli.js --external:@adhd/* --external:commander --banner:js=\"#!/usr/bin/env node\""
      },
      "outputs": ["{projectRoot}/bin/cli.js"]
    },
    // ... existing targets
  }
}
```

Or alternatively, a simpler two-step script-based approach:

```json
{
  "targets": {
    "build-bin": {
      "executor": "nx:run-commands",
      "cache": false,
      "dependsOn": ["build"],
      "options": {
        "command": "mkdir -p dist/entrypoint/dispatch-cli/bin && cp entrypoint/dispatch-cli/bin/cli.ts dist/entrypoint/dispatch-cli/bin/cli.mjs"
      },
      "outputs": ["dist/entrypoint/dispatch-cli/bin/cli.mjs"]
    }
  }
}
```

**Better approach — use @nx/js:tsc for bin compilation:**

```json
{
  "targets": {
    "compile-bin": {
      "executor": "@nx/js:tsc",
      "options": {
        "main": "entrypoint/dispatch-cli/bin/cli.ts",
        "outputPath": "dist/entrypoint/dispatch-cli/bin",
        "tsConfig": "entrypoint/dispatch-cli/tsconfig.lib.json",
        "additionalBuildOptions": {
          "declaration": false,
          "declarationMap": false
        }
      },
      "outputs": ["dist/entrypoint/dispatch-cli/bin"]
    }
  }
}
```

Then update the `bin` field in `package.json` post-build or output to `entrypoint/dispatch-cli/bin/cli.js`:

```json
{
  "bin": {
    "dispatch-cli": "./bin/cli.js"
  }
}
```

If using the dist path, the Nx release publish would need the package root at `dist/entrypoint/dispatch-cli` and the bin dist output at `dist/entrypoint/dispatch-cli/bin/cli.js`.

**Simplest practical fix — two-line `package.json` change + `tsconfig.json` for bin:**

```json
// package.json bin field — points at source (npx will resolve via tsx or similar):
"bin": {
  "dispatch-cli": "./bin/cli.mjs"
}
```

But this requires the runtime to support TS. The **correct** approach is to compile to JS:

`entrypoint/dispatch-cli/tsconfig.bin.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "bin",
    "declaration": false,
    "declarationMap": false,
    "module": "es2022",
    "moduleResolution": "bundler"
  },
  "files": ["bin/cli.ts"]
}
```

And add a `build-bin` to project.json that references this:

```json
"build-bin": {
  "executor": "nx:run-commands",
  "cache": true,
  "inputs": ["{projectRoot}/bin/**/*"],
  "dependsOn": ["build"],
  "options": {
    "command": "tsc -p entrypoint/dispatch-cli/tsconfig.bin.json"
  },
  "outputs": ["{projectRoot}/bin/cli.js"]
}
```

**Shebang preservation:**

Ensure the compiled JS output starts with `#!/usr/bin/env node`. The TypeScript compiler preserves shebang lines from source files, and the source already has one (line 1 of `bin/cli.ts`). Verify after build.

**Independent segments:**
1. `package.json` bin field (1 line) — independent, safe
2. `tsconfig.bin.json` (new file) — independent, safe
3. `project.json` build-bin target — independent, safe
4. Dist publish wiring — depends on 1+2+3

**Test case:**
After build, `node bin/cli.js --help` produces correct output (same as `npx tsx bin/cli.ts --help`).

---

## 8. DEBT-WORKSPACE-NX-INPUTS-001

### Test boundary sweep

**Files:** 17+ offenders across the workspace (see BACKLOG.md for the full list). Each has a distinct fix pattern:

| Pattern | Count | Root cause | Fix approach |
|---------|-------|------------|--------------|
| A: Sibling `drizzle/` dir reads | 4+ | `packages/ai/agent-mcp/src/__tests__/` imports `../../node_modules/drizzle-kit/` or resolves sibling drizzle dirs with no graph edge | Add `implicitDependencies` for each read package; or inline the schema into the test |
| B: `REPO_ROOT` path escape | 3+ | Tests access repo-root config files (`tsconfig.base.json`, `.eslintrc`) via `../../../` | Move fixture to `projectRoot`; or declare as explicit `{workspaceRoot}` input in project.json |
| C: Stale `dist/` path | 2+ | `plugin-loader.test.ts` reads `dist/packages/ai/agent-mcp-budget/` — path to a deleted/renamed package | Repoint to `dist/packages/agent/agent-plugin-budget`; add `implicitDependencies: ["agent-plugin-budget"]` |
| D: Own `dist/` read | 2+ | `serve.spec.ts` reads its own dist from `../../../dist/` — no `dependsOn: ["build"]` on the test target | Add `dependsOn: ["build"]` to the test target in project.json |
| E: Virtual tree (benign) | 7 | Apigen Nx + agent-generator-plugin generator specs — only resolve in-memory virtual trees | No code fix needed; document as benign |
| F: Orphaned pre-rename `dist/` dirs | 7 | `dist/packages/ai/` contains orphaned directories from packages renamed in workspace-cleanup | Delete each orphan individually |

**Per-pattern fix recipe:**

**Pattern A — Sibling drizzle dirs:**
```json
// In project.json, add implicitDependencies:
{
  "targets": {
    "test": {
      "executor": "@nx/vite:test",
      "options": {
        // ...
      },
      "implicitDependencies": [
        "agent-core-provider",
        "agent-store-prompts",
        "agent-store-tools",
        "agent-core-policy"
      ]
    }
  }
}
```

**Pattern B — REPO_ROOT:**
```json
// In project.json test target inputs:
{
  "targets": {
    "test": {
      "inputs": [
        "default",
        "^production",
        { "fileset": "{workspaceRoot}/tsconfig.base.json", "runtime": true }
      ]
    }
  }
}
```

Then update the test code to read the fixture from a package-owned path, or leave the path as-is knowing nx now tracks it.

**Pattern C — Stale dist path:**
```typescript
// In plugin-loader.test.ts, change:
// FROM: load('dist/packages/ai/agent-mcp-budget/index.js')
// TO:   load(require.resolve('@adhd/agent-plugin-budget'))
```
Then `project.json`:
```json
"implicitDependencies": ["agent-plugin-budget"]
```

This creates the graph edge so `^production` hashes the real plugin.

**Pattern D — Own dist read:**
```json
{
  "targets": {
    "test": {
      "dependsOn": ["build"],
      // ... existing options
    }
  }
}
```

**Pattern F — Orphaned dist dirs:**
```bash
rm -rf dist/packages/ai/agent-compiler
rm -rf dist/packages/ai/agent-mcp-budget
rm -rf dist/packages/ai/agent-mcp-types
rm -rf dist/packages/ai/agent-policy
rm -rf dist/packages/ai/agent-provider
rm -rf dist/packages/ai/agent-registry
rm -rf dist/packages/ai/agent-tool-registry
```

**Workspace-level fix — populate `sharedGlobals` in `nx.json`:**

```json
{
  "targetDefaults": {
    "test": {
      "inputs": [
        "default",
        "^production",
        { "env": "NODE_ENV" }
      ]
    }
  },
  "sharedGlobals": [
    { "fileset": "{workspaceRoot}/tsconfig.base.json", "runtime": true },
    { "fileset": "{workspaceRoot}/.eslintrc.base.json", "runtime": true }
  ]
}
```

This makes nx cache-aware of root configs that affect ALL targets.

**Enforcement — CI grep:**

Add to CI config:
```yaml
- name: Check test boundary violations
  run: |
    if rg -q '\.\.\/\.\.\/\.\.\/' packages/*/src/**/__tests__/; then
      echo "ERROR: Tests must not escape their project root via '../../../'"
      echo "Use implicitDependencies + declared inputs instead."
      exit 1
    fi
```

**Independent segments:** Each offender is independent. The work can be parallelized across:
1. agent-mcp package (patterns A, C) — 1 task
2. agent-engine-compiler package (pattern B) — 1 task
3. apigen packages (patterns B, D) — 1 task
4. Orphaned dist deletion — 1 task
5. nx.json sharedGlobals + CI grep — 1 task

**Test verification:** After each fix, `npx nx test <project>` must pass. After all fixes, run `npx nx print-affected --base HEAD~1 --head HEAD` to verify the graph correctly shows affectedness from root config changes.

---

## 9. DEBT-DISPATCH-011 (CLOSED/CONFIRMED)

### Orphaned stubs

**Status: CONFIRMED — already deleted.**

The following files from commit 1e63f8d were identified as orphaned stubs:

- `packages/dispatch/dispatch-core-optimizer/src/lib/optimize/bitmask-dp.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/optimize/hlfet.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/optimize/sentinel.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/optimize/simulated-annealing.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/optimize/tree-dp.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/snapshot/clone.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/snapshot/eligibility.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/snapshot/overlap.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/snapshot/size-estimate.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/snapshot/topology.ts`
- `packages/dispatch/dispatch-core-optimizer/src/lib/compiler.ts` (2087-line PoC duplicate)

All files were unreachable from the build (index.ts imports `snapshot.js`/`optimize.js`). Deletion was verified by `nx build dispatch-core-optimizer` passing with zero changed modules.

**No code changes needed.** Remove from BACKLOG.md.

---

## Summary of independent segments

| Segment | BL items | Packages touched | Token estimate |
|---------|----------|-----------------|----------------|
| dispatch-spec types | BL-102, 104, 105, 018 | `dispatch-spec` | 200 |
| optimizer compilePrompt | BL-102, 104, 105, 012 | `dispatch-core-optimizer` | 250 |
| orchestrator calibration | BL-105, 018, 020 | `dispatch-orchestrator` | 200 |
| orchestrator replan | BL-020 | `dispatch-orchestrator` | 180 |
| agent-runner dispatch | BL-102, 105, 012 | `dispatch-orchestrator` + `agent-mcp` | 120 |
| snapshot eligibility | BL-103, 013, 020 | `dispatch-core-optimizer` | 80 |
| client eligibility | BL-013 | `dispatch-core-client` | 20 |
| task_events tool | BL-006 | `agent-engine-orchestrator` + `agent-mcp` | 180 |
| dispatch-cli bin | BL-022 | `dispatch-cli` | 30 |
| NX inputs sweep | BL-NX-001 | 17 files across workspace | 300 |
| BL-011 closure | BL-011 | BACKLOG.md only | 10 |

**Total:** ~11 segments, ~1570 tokens of implementation work.
