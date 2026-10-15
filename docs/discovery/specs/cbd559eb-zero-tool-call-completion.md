# Spec cbd559eb — a zero-tool-call stop must not be indistinguishable from a finished task

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
items: cbd559eb-dc15-4e50-bdf3-e84d0cfcc2f9 (bug, HIGH, project adhd)
dor: needs-decision — check: AC1 says "agents whose prompt demands tools" and no such field exists (D2); everything else is specified. Size: S.

## Observed facts (O = opened; R = item only)
- O: root cause confirmed. `/Users/nix/dev/node/adhd/packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts:2058-2061`: `if (providerResponse.stopReason === 'completed') { finalContent = assistantMessage.content ?? ''; looping = false; continue; }` — no tool-use check. Then `:2595-2599` sets status `completed`, `:2610-2615` appends `TASK_COMPLETED {result}`, `:2621-2624` emits hook `task:completed`. The `tool_calls` + empty-calls branch at `:2595-2608` is the sibling terminal path.
- O: two counters exist and differ by provider. `executionContext.toolCallCount` is incremented only for tool calls the orchestrator itself executes (`:1208`). Provider-internal tool use (claudecli, whose tools run inside the CLI loop) is reported via `providerResponse.reportedToolUses`; per-turn accounting is `reportedToolCallCount = reportedToolUses ?? assistantMessage.toolCalls?.length ?? 0` (`:2012-2013`). A zero test on `executionContext.toolCallCount` alone would false-positive on every claudecli task.
- O: `TaskStatus` (agent-base-types `domain.ts:85-92`) and `TaskEventType` (`domain.ts:94-107`, `validation/task.ts:40-52`) are closed unions mirrored in a DB CHECK enum at `packages/agent/agent-store-runtime/src/db/schema.ts:~136-146`. Adding a new status or event type requires a schema migration across stores.
- R: evidence is researcher task `236d6552` (1 model call, 0 tool calls, `completed`). Not re-opened.
- O: no AgentDefinition field says "this agent must use tools" (`agent-base-types/src/domain.ts` allowedTools l.377 is an allowlist only). "Prompt demands tools" is therefore not computable.
- ADR: adhd 0001 D3/D7 (no schema churn avoidable) and the item's own scope (out: tool-grant starvation, transport failure).

## Design decisions
D1 Surface as a payload warning, not a new status/event: `TASK_COMPLETED.payload` becomes `{ result, toolUseCount, warnings?: Array<'no_tool_use'> }`; the `task:completed` hook payload gains the same optional `warnings`; agent-mcp `task_get`/SSE `done` passes them through (additive field). No migration, no status change, existing consumers unaffected. Rejected: new `TaskStatus 'incomplete'` (DB CHECK migration, every consumer switch, and false-fails legitimate tool-less answers); new event type (CHECK enum); failing the task (unrequested semantic change).
D2 (DECISION) Trigger definition. Recommended: warn when ALL hold — final stop is `completed`, accumulated `toolUseCount === 0` over the whole task, the agent was granted >=1 tool (resolved tool list non-empty), and the task did not end in HITL. A per-agent opt-in `requiresToolUse?: boolean` in AgentDefinition (frontmatter-compatible) escalates the warning to status `failed` with reason `no_tool_use` when true — default false. Alternative: only opt-in flag (never warns by default) — misses the observed case unless agents are annotated.
D3 Counter: accumulate `toolUseCount += reportedToolCallCount` at the point `reportedToolCallCount` is computed (`:2012`) for every model response, so API and claudecli share one authoritative number; do not read `executionContext.toolCallCount`.
D4 Doc: README of agent-engine-orchestrator and agent-mcp tool description for `task_get` mention `warnings`.

## Write-scope (exact)
- /Users/nix/dev/node/adhd/packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts (lines ~2008-2062, ~2605-2625 only)
- /Users/nix/dev/node/adhd/packages/agent/agent-base-types/src/hooks.ts (task:completed payload), domain.ts (only if D2 flag adopted: `AgentDefinition.requiresToolUse`)
- /Users/nix/dev/node/adhd/entrypoint/agent-mcp/src/server.ts (~l.1044 `done` event / task_get result field)
- tests: `packages/agent/agent-engine-orchestrator/src/__tests__/` new `no-tool-use-warning.test.ts`
- CHANGELOGs of the three packages.

## Acceptance criteria
- AC1 A task whose agent has tools granted and whose model stops with zero tool use completes with `warnings:['no_tool_use']` on `TASK_COMPLETED`, the `task:completed` hook, and the agent-mcp task result.
- AC2 A task that made >=1 tool call (API provider) has no warning; a claudecli task with `reportedToolUses>0` has no warning.
- AC3 An agent with no granted tools, or a HITL-suspended-then-resumed task, has no warning.
- AC4 With `requiresToolUse:true` (if D2 flag adopted) the same stop ends `failed` with reason `no_tool_use`.
- AC5 Existing `TASK_COMPLETED` consumers still read `payload.result` unchanged; no migration is generated.

## Test plan (tier S default; cite `cbd559eb AC<n>`)
All S: real orchestrator + real in-memory stores (harness pattern `entrypoint/agent-mcp/src/__tests__/integration/harness.ts`), scripted provider mocks only the provider boundary (testing.md tier S pattern). AC1 negative control: same scripted run with one tool call -> no warning (red if the check ignores the counter). AC2 claudecli variant uses a scripted response with `reportedToolUses`. A live-model check is NOT required (paid third-party; the defect is deterministic from stop reason).

## Risks / serialization
- Shares `orchestrator.ts` with any open R10/usage worktrees; gx impact on `runTask` loop not run (symbol is a 2700-line module) — implementer must run `gx impact` before editing. No other spec in this batch touches this file.
- Open for product: D2 trigger (granted-tools proxy vs opt-in flag) and whether warning should also be logged at `warn` level.

## Product revision
dor (product): ready.
Resolved decisions (from the consumer outcome: a caller reading a task result must be able to tell "answered without tools" from "stopped without doing the work", with zero annotation burden on existing agents):
- D2 resolved = the granted-tools trigger (warn when final stop is `completed`, task-wide `toolUseCount === 0`, resolved tool list non-empty, not ended in HITL). Opt-in-only is rejected: it never fires for the observed researcher case unless every agent is hand-annotated.
- `AgentDefinition.requiresToolUse` and the escalate-to-`failed` path are CUT from this slice (scope cut, deliberate): it adds a domain type field plus a new failure reason with no observed consumer asking for it. AC4 is removed from this slice and deferred to a follow-up backlog item (file via backlog-operator: "agent requiresToolUse opt-in escalating no_tool_use to failed", cites this spec). `domain.ts` is therefore NOT in the write-scope.
- Warning is also logged at `warn` level (one line: task id, agent, provider). Resolved yes.
Final ACs for this slice: AC1, AC2, AC3, AC5 as written, plus AC6 (new): the orchestrator emits one `warn` log line when it attaches `no_tool_use`.
Priority: P1, rank 2 (silent false-success on real agent runs; S size; no cross-spec dependency).
