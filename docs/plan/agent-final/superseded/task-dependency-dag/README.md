# Task Dependency DAG — Implementation Plan

> **Goal:** Add `depends_on: string[]` to task creation so tasks wait for upstream tasks
> to complete before dispatching. Fan-in supported. Upstream results injected as `inputs`
> on the downstream task. Covers #23 (task dependency DAG) and #14 (task chaining).
>
> **Spec:** `packages/ai/agent-mcp/ROADMAP.md` (#23, #14)
> **Executor:** `sox-active:typescript-pro`
> **Author:** planner
> **Created:** 2026-06-12

---

## What this directory is

A **resumable state machine** decomposed into work states, audit hold points, and a terminal `done`.

```text
docs/plan/task-dependency-dag/
├── README.md
├── dag.json
├── state.json
├── references.json
├── state-machine.md
├── final-review.md
└── contexts/
    ├── _shared.md
    ├── dag-schema.md
    ├── dag-types.md
    ├── dag-engine.md
    ├── audit-foundation.md
    ├── code-review.md
    ├── audit-final.md
    └── docs-and-publish.md
```

---

## How the executor uses this plan

1. Read `state.json` + `dag.json`. Find `current_state`.
2. Read that state's context file + `contexts/_shared.md`.
3. Do the work within declared file reservations.
4. Run the guard until it exits 0.
5. Update `state.json`, commit (R1), stop at state boundary.

**Never skip a guard. Never leave a plan write uncommitted.**

---

## Definition of Done

- `[dod.1]` **waiting status** — A task created with `depends_on: ["id-a"]` starts in `waiting` status and does not execute until `id-a` completes.
- `[dod.2]` **auto-dispatch on completion** — When an upstream task completes, all downstream tasks whose every `depends_on` entry is now `completed` are automatically dispatched to the queue.
- `[dod.3]` **fan-in** — A task with `depends_on: ["id-a", "id-b"]` only dispatches after BOTH `id-a` AND `id-b` complete.
- `[dod.4]` **fail-fast default** — `on_upstream_failure: "fail"` (default): if any upstream task fails or is cancelled, the dependent task transitions to `failed` without executing.
- `[dod.5]` **skip variant** — `on_upstream_failure: "skip"`: dependent task dispatches regardless of whether upstreams completed, failed, or were cancelled.
- `[dod.6]` **inputs injection** — Upstream task `result` strings are available to the downstream orchestrator run as an `inputs` map (taskId → result string) accessible via `executionContext.inputs`.
- `[dod.7]` **cycle detection** — Creating a task that would form a dependency cycle throws `VALIDATION_ERROR`.
- `[dod.8]` **tests green** — All existing tests pass. New tests cover: single-dep chain, fan-in, fail/skip propagation, inputs injection, cycle detection.
- `[dod.9]` **Reviewed** — code-reviewer subagent issues PASS; human sentinel `.code-review-complete` created.

---

## Execution model

- **Parallel execution:** no — linear chain (schema → types → engine).
- **Implementer agent:**
  - [x] `sox-active:typescript-pro` — all work states
- **Review:** yes — code-reviewer subagent + human sentinel at `code-review`.
- **Automatic dispatch:** no — Dispatch line only.

---

## Design invariants

- `[inv:waiting-no-queue]` — Tasks in `waiting` status are never enqueued. Only `pending` tasks are enqueued.
- `[inv:dispatch-on-completion]` — The completion handler (in `tools/task.ts` or a new `DagEngine`) scans for dependents whose full `depends_on` set is now resolved, and dispatches them.
- `[inv:inputs-immutable]` — `inputs` is populated at dispatch time from upstream results. It is not updated after the downstream task starts.
- `[inv:cycle-check-on-create]` — Cycle detection runs synchronously at task-creation time before the row is inserted. Creating a cycle throws immediately without inserting.

---

## Status at a glance

```bash
python3 -c "
import json
dag = json.load(open('docs/plan/task-dependency-dag/dag.json'))
st  = json.load(open('docs/plan/task-dependency-dag/state.json'))
print('current:', st['current_state'])
for slug, node in dag['nodes'].items():
    status = st['states'].get(slug, {}).get('status', '?')
    print(f'  [{node[\"phase\"]}] {slug}: {status}')
"
```
