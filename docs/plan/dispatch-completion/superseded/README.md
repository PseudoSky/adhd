# ⚠️ SUPERSEDED — historical source material for `dispatch-completion`

**Nothing in this directory is live. Do not execute, repair, or re-point anything here.**

These three artifacts were merged into the parent plan (`docs/plan/dispatch-completion`)
and are retained **only** as provenance — the source material `SCOPE.md` and
`RECONCILIATION.md` were derived from. `dispatch-completion/SCOPE.md:4` records the merge:

> *Merged from: dispatch-optimizer (PoC, superseded) + dispatch-production (deferred track) + dispatch-backlog-fill (debt specs). See `RECONCILIATION.md`.*

| Dir | What it was | Why it's here |
|---|---|---|
| `dispatch-production/` | A **bespoke** plan schema (`milestones`/`operations`/`dispatch_log`) — **not** a plan-state-machine plan (no `state.json`, no `scripts/`). Reported 20/32 operations `complete`. | Deferred track, fully absorbed. Its schema means `plan-scaffold.js`/`gap-check.js` never could validate it. |
| `dispatch-optimizer/` | The original PoC + planning session (`SCOPE.md`, `MIGRATE.md`, `LOG.md`, `PROPOSED_DAG_STRUCTURE.md`, `src/`, `test-dag.json`). | Proved the approach; the shipped `@adhd/dispatch-*` packages replaced it. |
| `dispatch-backlog-fill/` | A lone `SOLUTIONS.md` of debt specs. | Folded into the DEBT cluster tracked in `RECONCILIATION.md` §D.2. |

## Coverage was verified before supersession (2026-07-16)

All **12 pending `dispatch-production` operations** were mapped op-by-op onto live
`dispatch-completion` states. **Zero uncovered:**

| Superseded op(s) | Lands in |
|---|---|
| `tests-golden.1`, `tests-algorithms.1`, `stepwise-dispatch.1/2/3` | `tests-hardening` (+ `USE_CASES.md` #32; `stepwise-ab` state in `PLAN_STATE_MACHINE_PROPOSAL.md:46`) |
| `optimizer-algorithms.1` (bitmask) | O9 — the data-gated algorithm cascade |
| `backlog-fill.1` (`calibration.ts`) | O5 — `calibrate` rejects a bad model tier |
| `plugin-io.1`, `plugin-gitnexus.1` | O8 — enrichment plugins |
| `tools-mcp.1`, `serializer-sqlite.1` | O6 — dag-authoring tools + sqlite adapter parity |
| `hardening-complete.1` | milestone marker (no work) |

The 20 ops marked `complete` in `dispatch-production/dag.json` are **historical record,
not a live claim** — several cite paths that no longer resolve (see below).

## ⛔ The dead paths in here are NOT defects to fix

`dispatch-production/dag.json` references package names that were renamed by
`88ed95c6 refactor(dispatch): rename dispatch-spec→base, client→core, optimizer→core`
(and `packages/ai/*`, removed by the agent restructure):

    packages/dispatch/dispatch-spec        → dispatch-base-spec
    packages/shared/dispatch-spec          → dispatch-base-spec   (packages/shared/ deleted in 4dc34b64)
    packages/dispatch/dispatch-client      → dispatch-core-client
    packages/dispatch/dispatch-optimizer   → dispatch-core-optimizer
    packages/dispatch/dispatch-cli         → entrypoint/dispatch-cli
    packages/ai/agent-mcp, packages/ai/agent-provider  → (agent restructure; packages/ai is gone)

**Re-pointing them would resurrect a superseded plan into direct file-reservation
conflict with the live `dispatch-completion`.** The rule is **supersede, don't
re-point** — the same trap recorded for the completed `agent-*` plans. Tracked as
BUG-DISPATCH-009 (janitorial).

## Safe to nest here

Plan discovery walks `docs/plan/` recursively (depth ≤ 4) but keys on **`state.json`**
as the plan marker (`corpus-verify.js:findAllStateDirs`, `lib/plan-scan.js`). **None of
these three has a `state.json`**, and none is registered in `plan-index.json` — so they
are invisible to plan scans, `gap-check.js`, and `plan-orchestrator`. They were already
invisible before the move; relocating them here is for **human** clarity and provenance.

**If you need the live plan, go up one level:** [`../README.md`](../README.md).
