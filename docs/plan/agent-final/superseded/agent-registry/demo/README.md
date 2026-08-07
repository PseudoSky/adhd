# Agent Registry Usability Demo

**Date:** 2026-06-25
**Input:** `/Users/nix/dev/ai/claude-agents/categories/00-active/agents/qa-expert.md`
**DB:** `demo/tmp/registry.db`
**Platform:** `claude_code` (yaml_frontmatter header format)

## Step Results

### Step 1: Parse qa-expert.md
- Agent slug: `qa-expert`
- Tools: 15 entries: `Read, Grep, Glob, Bash, ListMcpResourcesTool, ReadMcpResourceTool, WaitForMcpServers, AskUserQuestion, WebSearch, Monitor, LSP, mcp__memory-server__*, SendMessage, TaskGet, TaskList`
- Model hint: `sonnet`
- Body sections decomposed: 3

### Step 2: Migrations
All 4 plan migration sets applied in dependency order:
`agent-provider` → `agent-registry` → `agent-tool-registry` → `agent-policy`

### Step 3: Tool Bindings
Seeded platform `claude_code` (yaml_frontmatter) and 15 tool-platform bindings.
Identity bindings: canonical lowercase slug → original alias (e.g. `read` → `Read`).

### Step 4: Provider/Model
Seeded model `sonnet` with platform binding to `claude_code` (identity passthrough).

### Step 5: Component Store
Created 3 PROMPT_COMPONENT rows (one per body section) via ComponentStore.create().

### Step 6: Agent + Composition + Tool Grants
- Agent `qa-expert` inserted (status: active, modelHint: sonnet)
- 3 components attached via CompositionStore.attach() at positions 1-3
- 15 tool grants via AgentToolStore.grant()

### Step 7: Policy
Attached policy template `no-credentials`: "Prevent credential leakage in files, task output, and handoff text"

### Step 8: Text Round-Trip (Compiled Output)

First 20 lines of compiled artifact:
```
---
name: qa-expert
description: Use this agent when you need comprehensive quality assurance strategy, test planning across the entire development cycle, or quality metrics analysis to improve overall software quality.
tools: Read, Grep, Glob, Bash, ListMcpResourcesTool, ReadMcpResourceTool, WaitForMcpServers, AskUserQuestion, WebSearch, Monitor, LSP, mcp__memory-server__*, SendMessage, TaskGet, TaskList
model: sonnet
---

You are a senior QA expert with expertise in comprehensive quality assurance strategies, test methodologies, and quality metrics. Your focus spans test planning, execution, automation, and quality advocacy with emphasis on preventing defects, ensuring user satisfaction, and maintaining high quality standards throughout the development lifecycle.

When invoked:

1. Query context manager for quality requirements and application details
2. Review existing test coverage, defect patterns, and quality metrics
3. Analyze testing gaps, risks, and improvement opportunities
4. Implement comprehensive quality assurance strategies

QA excellence checklist:

- Test strategy comprehensive defined
- Test coverage > 90% achieved
```

### Step 9: Assertions + Normalized Diff

All assertions PASSED:
- Output starts with `---`
- tools: line matches original frontmatter tools exactly
- model: resolves to `sonnet`
- All body section headings present in compiled output
- Description present in frontmatter

Normalized diff summary:
```
Original body lines  : 290
Compiled body lines  : 294
Lines only in original (0) — these are minor differences:

Lines only in compiled (2) — includes policy block if any:
  > ## Policies
  > - Prevent credential leakage in files, task output, and handoff text


Non-policy extra lines in compiled: 0
CONCLUSION: Only minor syntactic differences (section join separators, policy block appended).
```

### Step 10: Cache Proof

- composed_prompts rows after first compile (MISS): **1** (row id: 1)
- composed_prompts rows after second compile (HIT): **1** (unchanged)
- Second compile returned same row id **1** — cache HIT confirmed.

### Step 11: Execution (Real Model)

**Path used:** claude CLI (direct)
**Exit code:** 0
**Model-independent invariants:** EXIT 0: PASS | JSON shape {"agent":"qa-expert","status":...}: PASS | In-character QA response (domain terms): PASS
**Overall:** PASSED

User task given to model:
> Draft a concise test strategy (3-5 bullet points) for a small TypeScript library.
> At the end, emit your progress tracking JSON in EXACTLY this format:
> {"agent":"qa-expert","status":"testing","progress":{"test_files_reviewed":"<n>","test_commands_run":"<n>","defects_found":"<n>","coverage_measured":"<value>"}}

Response excerpt (first 40 lines):
```
This is a documentation/strategy request — no codebase to test against, no test suite to run. I'll be honest about that in the grounding fields rather than fabricating numbers.

## Test Strategy: Small TypeScript Library

- **Unit tests as the foundation (Vitest).** Cover every exported function against the public API surface — happy paths, boundary values, and error cases (invalid input, empty/null, type-edge cases). Aim for ≥90% line/branch coverage measured via `vitest --coverage` (v8/istanbul), with assertions that have teeth: each test must fail if the behavior regresses.

- **Type-level testing.** For a TS library, the types *are* part of the contract. Use `tsd` or `expectTypeOf` (Vitest) to assert generic inference, conditional types, and that misuse fails to compile. A passing runtime test means nothing if the published `.d.ts` lies.

- **Package-consumption / smoke test.** Build the dist and import it the way a real consumer does — verify both ESM and CJS entrypoints resolve, the `exports` map is correct, and the published `.d.ts` is reachable. This catches build/packaging defects that unit tests run against source never see.

- **CI gate on every push (GitHub Actions).** Run lint → typecheck → test+coverage → build across the supported Node matrix. Fail the build on coverage drop or any test failure; key the gate on the runner's exit code, never on grepping stdout for "passed."

- **Property-based tests for pure logic (optional, high ROI).** For parsers, transforms, or math-style utilities, add `fast-check` to fuzz invariants across generated inputs — finds boundary defects example-based tests miss.

Note on grounding: this is a strategy draft for a hypothetical library, so there is no actual code reviewed, no test suite executed, and no coverage measured. The JSON below reflects that real state — zeros, not fabricated metrics.

{"agent":"qa-expert","status":"testing","progress":{"test_files_reviewed":"0","test_commands_run":"0","defects_found":"0","coverage_measured":"not measured"}}

```

## Boundary Check

`packages/ai/agent-mcp` and `packages/ai/agent-mcp-types` were NOT modified.
All demo code lives in `docs/plan/agent-registry/demo/`.

## Usability Notes / Backlog Items

1. **Plan API awkwardness**: `AgentToolStore.grant()` throws `GRANT_ALREADY_EXISTS` with no
   upsert path — callers must pre-check or catch. An `upsertGrant()` method would be more
   ergonomic for idempotent seeding scripts.

2. **Wildcard MCP tools**: The frontmatter `mcp__memory-server__*` wildcard has no first-class
   registry representation. The demo uses a passthrough `mcp__memory-server__wildcard` canonical
   name. A proper wildcard expansion mechanism in the tool-registry would be a cleaner long-term
   design.

3. **Model seeding duplication**: `seedProvider()` seeds models from a fixed catalog; if the
   agent's model_hint (`sonnet`) is not in that catalog, callers must seed it manually. A
   `seedModelIfAbsent()` helper would improve DX.

4. **No agent-compiler drizzle migrations**: The compiler has an empty drizzle folder. The
   composed_prompts table lives in agent-registry. This is correct per the shared-SQLite topology
   but is non-obvious — the CLI's migration loop references a COMPILER_MIGRATIONS folder that
   resolves to an empty set. Worth documenting explicitly in the CLI's header comment.

## Step 11b: Execution via agent-mcp runtime

**Date:** 2026-06-25
**Path used:** `packages/ai/agent-mcp/src/providers/factory.ts` → `createProvider()`
**Provider class actually invoked:** `ClaudeCliProvider` (from `packages/ai/agent-mcp/src/providers/claudecli.ts`)
**Factory import line:** `packages/ai/agent-mcp/src/providers/factory.ts:14` (`export function createProvider(...)`)
**Claude CLI path:** `/Users/nix/.local/bin/claude`
**Model:** sonnet (via `--model sonnet` flag, resolved by the CLI)
**Elapsed:** 14066ms
**Stop reason:** `completed`

### What was called

```typescript
// Relative import from demo/ — createProvider is NOT in @adhd/agent-mcp index.ts
// and "@adhd/agent-mcp/src/providers/factory" is not a valid tsconfig sub-path alias.
import { createProvider } from '../../../../packages/ai/agent-mcp/src/providers/factory';

const provider = createProvider(
    { type: 'claudecli', claudePath: '/Users/nix/.local/bin/claude', model: 'sonnet', timeoutMs: 120_000 },
    {} // no mcpServers
);

const response = await provider.chat({
    messages: [
        { role: 'system', content: '<compiled qa-expert system prompt body>' },
        { role: 'user',   content: '<QA strategy task with JSON format mandate>' },
    ],
    tools:  [],
    signal: AbortSignal.timeout(120_000),
});
```

ClaudeCliProvider drives the subprocess via:
  `claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json --verbose --disallowedTools <all-builtins> --system-prompt <body> --model sonnet`

Writing the user message as a stream-json line to stdin, then streaming NDJSON events
from stdout until a `{"type":"result"}` event completes the exchange.

### Response transcript (first 30 lines)

```
## Test Strategy: Small TypeScript Library

- **Unit-first with Vitest.** Each exported function gets isolated unit tests covering happy paths, boundary values, and error branches. Target ≥ 90% statement coverage measured via `vitest --coverage` (v8 provider) — reported from actual tool output, never estimated.

- **Type-safety as a test surface.** Use `tsd` or `expect-type` assertions to compile-time-verify generic overloads, discriminated unions, and return types. Type errors are bugs; catch them in CI before runtime.

- **Integration smoke tests over the public API.** Wire the real library (no mocks of internal modules) in at least one integration test per major feature area — import from the compiled `dist/` to catch bundling regressions, not just source.

- **Property-based testing for data-transformation logic.** Use `fast-check` for any pure transforms (serializers, parsers, calculators). Randomized inputs surface edge cases equivalence partitioning misses, especially around unicode, large numbers, and empty collections.

- **CI gate: zero-tolerance on failures, coverage threshold enforced.** `nx test <lib> --coverage` runs on every PR; the pipeline fails if coverage drops below the configured threshold or any test is red. No merges on amber.

---

```json
{"agent":"qa-expert","status":"testing","progress":{"test_files_reviewed":"0","test_commands_run":"0","defects_found":"0","coverage_measured":"not measured"}}
```

> **Note:** No files were examined or test commands executed during this response — the strategy above is prescriptive (a plan to implement), not a report of observed results. All counts are honestly zero. Run `npx nx test <project-name> --coverage` against your actual library to populate real values.
```

### Invariants passed

```
(a) stopReason completed/tool_calls: PASS (got 'completed')
(b) In-character QA response (found term 'test'): PASS
(c) Mandated {"agent":"qa-expert","status":...} JSON shape: PASS
(d) Non-empty substantive response (1750 chars): PASS
```

### API-surface findings (backlog candidates)

1. **`createProvider` not exported from package index.** `packages/ai/agent-mcp/src/index.ts`
   exports only `HookRegistry`. To construct a provider from outside the package, callers
   must deep-import `@adhd/agent-mcp/src/providers/factory`. Re-exporting
   `createProvider` and the `LLMProvider` / `ProviderChatRequest` types from the package
   index would make the provider subsystem reachable as a first-class public API.

2. **`ClaudeCliProvider` is a standalone class** — it can be driven directly via
   `provider.chat()` without the orchestrator, stores, or DB. This makes it a good
   candidate for lightweight integration tests that don't need the full harness.
   The only coupling to the rest of the package is the `Message` / `ProviderChatRequest`
   type shapes (which require uuid `id` + `sessionId` fields) and the internal imports
   (`generateId`, `nowIso`, `resolveToolCallName`, `logger`). A thin facade or
   re-export in the index would let external consumers drive it without deep imports.

3. **`--disallowedTools` flag list is hardcoded** in `claudecli.ts` as `CLAUDE_CODE_BUILTIN_TOOLS`.
   Any new built-in tool added to Claude Code won't be blocked until this list is updated.
   A runtime query (`claude --list-tools`) or a sentinel allowlist approach would be more robust.

## Step 11c: Create + run via agent-mcp Orchestrator

**Date:** 2026-06-25
**Script:** `docs/plan/agent-registry/demo/create-and-run-via-mcp.ts`

### Honest framing

There is NO registry→agent-mcp integration (agent-mcp has zero registry refs; Plan 6 is unbuilt).
This script manually bridges: the registry COMPILES the prompt, and we hand that blob to
agent-mcp's native `agentCreate()`. This proves agent-mcp can create+run an agent built from
registry output — it does NOT prove an automated integration (that is Plan 6's job).

### What was called

```typescript
// 1. Get the compiled system prompt from the registry
const compiled = compileAgent({ agentSlug: 'qa-expert', platform: 'claude_code', context: {}, db });
const systemPromptBody = compiled.content.replace(/^---\n[\s\S]*?\n---\n+/, '');

// 2. Stand up agent-mcp harness on a TEMP DB
const liveProvider = createProvider({ type: 'claudecli', claudePath: '/Users/nix/.local/bin/claude', model: 'sonnet', timeoutMs: 120_000 }, {});
const harness = await buildHarness({ defaultProvider: liveProvider, skipOrphanScan: true });

// 3. CREATE the agent in agent-mcp's own store
const agentDef = agentCreate(
    { name: 'qa-expert', provider: { type: 'claudecli', ... }, systemPrompt: systemPromptBody, mcpServers: {}, permissions: {} },
    { agentStore: harness.agentStore, sessionStore: harness.sessionStore }
);

// 4. Open a session via the Orchestrator path
const { session_id } = await agentTool({ name: 'qa-expert' }, { agentStore, sessionStore, policy });

// 5. RUN through the Orchestrator
const taskResult = await taskTool({ session_id, prompt: '<QA strategy task>', background: false }, harness.taskDeps);

// 6. Confirm persistence
const persisted = resultTool({ task_id: taskResult.task_id }, { taskStore, db });
```

### Task lifecycle

| Field       | Value |
|-------------|-------|
| agent name  | `qa-expert` |
| session_id  | `b3fffa04-cb78-43b7-b1af-0d2448f5a8bd` |
| task_id     | `7f6f4f16-6ae5-40d0-a57d-df5284573070` |
| task status | `completed` |
| elapsed     | 15171ms |
| events      | 3 total (MODEL_REQUEST ×1, MODEL_RESPONSE ×1, TASK_COMPLETED ×1) |

### Result excerpt (first 30 lines)

```
## Test Strategy: Small TypeScript Library

- **Unit-first with Vitest** — Cover all exported public functions with pure unit tests (equivalence partitioning + boundary value analysis). Target ≥ 90% branch coverage measured via `vitest --coverage` with `@vitest/coverage-v8`; fail the CI gate if it drops below threshold.

- **Type-safety as a test dimension** — Use `tsd` or `expect-type` assertions to validate generic types, overload signatures, and edge-case inference at compile time. Type errors are bugs; they get the same defect tracking as runtime failures.

- **Integration smoke layer** — One lightweight integration test per major entry point that wires real dependencies (no mocks of the code under test), imports the compiled output from `dist/`, and asserts consumer-visible outcomes. This catches tree-shaking breaks, ESM/CJS dual-bundle issues, and `exports` map misconfigurations that unit tests miss.

- **Property-based edge cases** — Use `fast-check` for any parsing, transformation, or math-heavy logic. Generate hundreds of random inputs automatically; specify invariants (`roundtrip(encode(x)) === x`) instead of enumerating cases manually.

- **CI-gated quality gates** — Run `npx nx test <lib> --coverage` + `npx nx lint <lib>` on every PR via the Nx affected pipeline. Block merge on: any failing test, coverage regression, or lint error. No manual overrides.

---

```json
{"agent":"qa-expert","status":"testing","progress":{"test_files_reviewed":"0","test_commands_run":"0","defects_found":"0","coverage_measured":"not measured"}}
```

> **Note:** No files were read and no commands were executed for this planning response — the progress counters reflect that truthfully. Actual measurements will populate once the strategy is implemented and `npx nx test` / `vitest --coverage` are run against the target library.
```

### Invariants passed

```
[inv:1] agentRead returns compiled systemPrompt (6941 chars): PASS
[inv:2] task status 'completed' via Orchestrator: PASS
[inv:3] TASK_COMPLETED event in task_events: PASS (event id a1ed8f3a)
[inv:4] MODEL_REQUEST (1) + MODEL_RESPONSE (1) events: PASS
[inv:5] QA in-character response (found term 'test'): PASS
[inv:6] Mandated {"agent":"qa-expert","status":...} JSON shape: PASS
[inv:7] session-backed task row (sessionId=b3fffa04...): PASS
```

### Symbols imported (file:line)

| Symbol | Source |
|--------|--------|
| `buildHarness` | `packages/ai/agent-mcp/src/__tests__/integration/harness.ts:102` |
| `drainQueue` | `packages/ai/agent-mcp/src/__tests__/integration/harness.ts:305` |
| `agentCreate` | `packages/ai/agent-mcp/src/tools/agent-crud.ts:16` |
| `agentRead` | `packages/ai/agent-mcp/src/tools/agent-crud.ts:21` |
| `agentTool` | `packages/ai/agent-mcp/src/tools/session.ts:29` |
| `taskTool` | `packages/ai/agent-mcp/src/tools/task.ts:181` |
| `resultTool` | `packages/ai/agent-mcp/src/tools/task.ts:534` |
| `createProvider` | `packages/ai/agent-mcp/src/providers/factory.ts:14` |
| `taskEventsTable` | `packages/ai/agent-mcp/src/db/schema.ts:99` |
| `tasksTable` | `packages/ai/agent-mcp/src/db/schema.ts:65` |

### API-surface findings (backlog candidates)

1. **`buildHarness` not in package public API.** Importable only via deep path
   `packages/ai/agent-mcp/src/__tests__/integration/harness.ts`. For external consumers
   wanting to write integration tests without copy-pasting the harness, exposing a
   `@adhd/agent-mcp/test-utils` sub-path export would be ergonomic.

2. **`agentCreate`, `agentTool`, `taskTool`, `resultTool` not in package index.**
   All tool functions must be deep-imported from source paths. A `tools` sub-path
   export or re-export from `index.ts` would make the create-and-run path accessible
   without relying on internal file paths.

3. **`createProvider` not in package index** (already noted in Step 11b).
   Repeated here because it is also needed for the full Orchestrator path — callers
   must know the concrete provider to inject it via `defaultProvider`.

4. **`defaultProvider` injection in harness is harness-only.** The production
   `Orchestrator.run()` accepts a `provider` override (so per-task injection works),
   but the `buildHarness` `defaultProvider` wraps the orchestrator at construction
   time. Both work; the harness pattern (wrapping) is the most ergonomic for tests
   that want every task on one provider without patching per-call.
