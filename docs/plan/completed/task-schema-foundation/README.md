# Task Schema Foundation — Implementation Plan

> **Goal:** Add all DB columns and status enum values required by the 0.2.0 (task-dependency-dag)
> and 0.3.0 (hitl-interrupts) feature plans into a single upstream release. This decouples
> schema/type evolution from feature logic, enabling 0.2.0 and 0.3.0 to run in parallel once
> this plan lands.
>
> **Spec:** `packages/ai/agent-mcp/ROADMAP.md` (#23, #14, #20)
> **Executor:** `sox-active:typescript-pro`
> **Author:** planner
> **Created:** 2026-06-13

---

## What this directory is

A **resumable state machine** decomposed into work states, audit hold points, and a terminal `done`.

```text
docs/plan/task-schema-foundation/
├── README.md
├── dag.json
├── state.json
├── references.json
├── state-machine.md
├── final-review.md
└── contexts/
    ├── _shared.md
    ├── schema-columns.md
    ├── task-types.md
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

- `[dod.1]` **Schema migration** — A single migration (0004_*) adds all four columns: `depends_on`, `on_upstream_failure`, `inputs`, `resume_token`. No split migrations.
- `[dod.2]` **Status enum** — Both `"waiting"` and `"awaiting_input"` present in the status enum (`schema.ts` AND `taskStatusSchema` in `validation/task.ts`).
- `[dod.3]` **TaskStore updated** — `TaskStore.create()` accepts `dependsOn`, `onUpstreamFailure`, `inputs`; sets `"waiting"` status when `dependsOn.length > 0`. `TaskStore.updateStatus()` accepts optional `resumeToken`. `read()` and `list()` return all new fields.
- `[dod.4]` **agent-mcp-types** — `TaskStatus` union exported from `@adhd/agent-mcp-types` includes `"waiting"` and `"awaiting_input"`.
- `[dod.5]` **Build green** — `npx nx build agent-mcp` exits 0 with no TypeScript errors after all changes.
- `[dod.6]` **Published** — `agent-mcp` at `0.1.5`, `agent-mcp-types` bumped and published.

---

## Downstream plans enabled

This plan is a **hard prerequisite** for:

| Plan | Dependency |
|---|---|
| `task-dependency-dag` (0.2.0) | `depends_on`/`on_upstream_failure`/`inputs` columns + `"waiting"` status + TaskStore.create deps support |
| `hitl-interrupts` (0.3.0) | `resume_token` column + `"awaiting_input"` status + TaskStore.updateStatus resumeToken |

Both downstream plans declare `assumed_baseline: ["task-schema-foundation"]` in `plan-index.json`.
Once this plan publishes, 0.2.0 and 0.3.0 **may dispatch in parallel** (they touch distinct files
after this plan has handled the shared schema surface).

---

## Parallel dispatch model post-foundation

```
task-schema-foundation (this plan)
         ↓
parallel-tool-execution ║ task-dependency-dag   ← run in parallel (no file overlap)
         ↓ merge
hitl-interrupts  (needs both: orchestrator.ts from 0.1.0 + dag-engine from 0.2.0)
         ↓
task-streaming-sse
```

---

## Execution model

- **Parallel execution:** no — linear chain (schema-columns → task-types → audit → review → publish).
- **Implementer agent:**
  - [x] `sox-active:typescript-pro` — all work states
- **Review:** yes — code-reviewer subagent + human sentinel at `code-review`.
- **Automatic dispatch:** no — Dispatch line only.

---

## Design invariants

- `[inv:single-migration]` — All four columns land in ONE migration file. Two separate migrations would create a window where `awaiting_input` exists but `depends_on` does not, which is an invalid schema state.
- `[inv:types-before-validation]` — `agent-mcp-types` is updated BEFORE `validation/task.ts`. The validator re-exports `TaskStatus` from the types package; updating the types package first prevents the TS error at the validation layer.
- `[inv:task-store-accepts-all-fields]` — After this plan, `TaskStore.create()` can accept any combination of the new fields. Downstream plans (0.2.0, 0.3.0) rely on this without needing to modify `task-store.ts` themselves.

---

## Status at a glance

```bash
python3 -c "
import json
dag = json.load(open('docs/plan/task-schema-foundation/dag.json'))
st  = json.load(open('docs/plan/task-schema-foundation/state.json'))
print('current:', st['current_state'])
for slug, node in dag['nodes'].items():
    status = st['states'].get(slug, {}).get('status', '?')
    print(f'  [{node[\"phase\"]}] {slug}: {status}')
"
```
