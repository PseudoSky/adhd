# Parallel Tool Execution — Implementation Plan

> **Goal:** Replace the sequential tool-call for-loop in `orchestrator.ts` with
> `Promise.all`, so multiple tool calls returned in a single model response execute
> concurrently instead of one-at-a-time.
>
> **Spec:** `packages/ai/agent-mcp/ROADMAP.md` (#28)
> **Executor:** `sox-active:typescript-pro`
> **Author:** planner
> **Created:** 2026-06-12

---

## What this directory is

A **resumable state machine**. The implementation is decomposed into work states plus audit
hold points and a terminal `done`. Each state is a self-contained work order keyed by an
immutable **slug**.

```text
docs/plan/parallel-tool-execution/
├── README.md
├── dag.json          ← STRUCTURE: nodes (slug → phase, depends_on, guard, artifacts, context)
├── state.json        ← RUNTIME: current_state, per-slug status+timestamps, transition/amendment logs
├── state-machine.md  ← human render of dag.json
├── references.json   ← reference pattern catalog
└── contexts/
    ├── _shared.md
    ├── parallel-dispatch.md
    ├── audit-foundation.md
    ├── code-review.md
    ├── audit-final.md
    └── docs-and-publish.md
```

---

## How the executor uses this plan

1. Read `state.json` and `dag.json`. Find `current_state`.
2. Read that state's context file plus `contexts/_shared.md` for referenced definitions.
3. Do the work. Respect reservations — do not mutate files outside `mutates`.
4. Run the guard. The state may not advance until the guard exits 0.
5. Update runtime: set status `done`, record timestamps, append transition log, set `current_state`.
6. **Commit (R1).** Every write to a plan file is immediately committed.
7. **Stop at a state boundary.** One state per session.

**Never skip a guard. Never leave a plan write uncommitted.**

### If reality diverges

- **No topology change** → executor-class amendment: fix in place, sync `dag.json`/`state.json`/`state-machine.md`/context, append `amendment_log`, commit.
- **Topology change** → stop, record, escalate to planner.

---

## Definition of Done

Agreed non-interactively from user answers Q1–Q2 + architect research.

- `[dod.1]` **Parallel dispatch** — Multiple tool calls returned in a single model response execute concurrently via `Promise.all`. Wall-clock time for N independent tool calls ≈ time for the slowest single call, not sum of all.
- `[dod.2]` **Error containment** — One tool call failing surfaces as `isError: true` in that slot's `tool_result` message; the remaining tool calls in the batch complete normally. Only policy violations (MAX_DEPTH_EXCEEDED, MAX_TOOL_LOOPS_EXCEEDED, DELEGATION_NOT_ALLOWED) abort the entire batch.
- `[dod.3]` **Call-ID keying** — Each `tool_result` message is keyed by `toolCallId: toolCall.id` (the ID returned by the provider), not by array index.
- `[dod.4]` **Policy check preserved** — `policy.check()` fires for each tool before its individual dispatch. If ANY tool in the batch triggers a policy violation, the entire batch is aborted (consistent with the sequential behaviour).
- `[dod.5]` **toolCallCount correct** — `executionContext.toolCallCount` is incremented by the number of tools dispatched in the batch before the next loop iteration. The policy check on the following iteration sees the correct count.
- `[dod.6]` **Message order preserved** — All tool results from the batch are appended as separate `tool_result` messages (one per call) before the next model request.
- `[dod.7]` **Tests green** — All existing tests pass. New tests cover: (a) concurrent dispatch when N > 1 tools present, (b) one-fails-rest-continue, (c) call-ID-based result keying.
- `[dod.8]` **Reviewed** — code-reviewer subagent issues PASS verdict; human sentinel `.code-review-complete` created.

---

## Execution model

- **Parallel execution:** no — linear dependency chain (single changed file).
- **Implementer agent:**
  - [x] `sox-active:typescript-pro` — all work states
- **Review:** yes — code-reviewer subagent spawned at `code-review` state; human sentinel required.
- **Automatic dispatch:** no — Dispatch line only (Step 8).

---

## Design invariants

- `[inv:policy-before-dispatch]` — policy.check() fires before each tool is dispatched; never after.
- `[inv:tool-error-throw]` — all ToolErrors thrown inside the orchestrator loop are caught and surface as `isError: true` result messages, except fatal codes which re-throw. See `[ref:tool-error-throw]`.
- `[inv:no-sequential-tool-loop]` — after this plan, `for (const toolCall of toolCalls)` no longer exists in `orchestrator.ts`.

---

## Status at a glance

```bash
python3 -c "
import json
dag = json.load(open('docs/plan/parallel-tool-execution/dag.json'))
st  = json.load(open('docs/plan/parallel-tool-execution/state.json'))
print('current:', st['current_state'])
for slug, node in dag['nodes'].items():
    status = st['states'].get(slug, {}).get('status', '?')
    print(f'  [{node[\"phase\"]}] {slug}: {status}')
"
```
