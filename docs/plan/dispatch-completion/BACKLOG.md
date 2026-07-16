# BACKLOG — dispatch-completion (plan-owned DEBT-DISPATCH ledger)

**This file is the source of truth** for the `DEBT-DISPATCH-*` items this plan carries. The root `/BACKLOG.md` is de-duplicated to remove these plan-owned items. Each row is fixed-with-a-teeth-bearing-test or closed with a dated live-source verdict before terminal (`[dod.13]`); the final audit (`audit_dispatch-completion.py --phase dod`, check dod.13) fails while any row still reads `status: OPEN`.

> Preconditions handled DIRECTLY, NOT in this ledger: **BUG-DISPATCH-EXEC-001** (tool-call execution) and **BUG-DISPATCH-PUBLISH-001** (name/alias conformance). Phase 0 `triage` confirms they landed (V0).
> Already-fixed before this plan (archived in root BACKLOG, not carried): DEBT-DISPATCH-009, -010, -021, -011, -023(export half), BUG-DISPATCH-003. Handed off: DEBT-DISPATCH-006 (agent-mcp per-turn `task_events`).

| ID | Summary | Owning state | status |
|---|---|---|---|
| DEBT-DISPATCH-005 (BL-102) | `ExecutionMode` discriminant on `DispatchUnit`; derive in `assembleUnit()` | spec-foundations, optimizer-client | status: OPEN |
| DEBT-DISPATCH-005 (BL-103) | `snapshot_version` increments on write | optimizer-client | status: OPEN |
| DEBT-DISPATCH-005 (BL-104) | `compilePrompt()` inlines nested `type_spec` sub-shapes | optimizer-client | status: OPEN |
| DEBT-DISPATCH-005 (BL-105) | `mcp_servers` null → real catalog lookup | optimizer-client | status: OPEN |
| DEBT-DISPATCH-005 (BL-106) | `b_per_tier` cold-start seeding | orchestrator-harden | status: OPEN |
| DEBT-DISPATCH-005 (BL-107) | back-compat load moves to `normalizeDag`/serializer (not `run.ts`) | serializer-sqlite | status: OPEN |
| DEBT-DISPATCH-012 | `systemPrompt`/`prompt` split (double-token cost) | optimizer-client | status: OPEN |
| DEBT-DISPATCH-013 | D-07 `eligible` promotes own-completion into the spec definition | spec-foundations | status: OPEN |
| DEBT-DISPATCH-014 | reject/clamp `Infinity` per-tier B/context-window (JSON round-trip) | optimizer-client | status: OPEN |
| DEBT-DISPATCH-015 | per-unit error boundary in `orchestrateCycle` (record `failed`, don't throw) | orchestrator-harden | status: OPEN |
| DEBT-DISPATCH-016 | route op-level `type:automated`/`action:guard` through the guard seam | orchestrator-harden | status: OPEN |
| DEBT-DISPATCH-017 | `capOutput` cut on a character boundary (UTF-8) | orchestrator-harden | status: OPEN |
| DEBT-DISPATCH-018 | formalize `ICalibrationStore` in spec; replace `ICalibrationPlaceholder` | spec-foundations, orchestrator-harden | status: OPEN |
| DEBT-DISPATCH-019 | extend `DispatchLogEntry.provider` enum + enforce in `validate.ts` | spec-foundations | status: OPEN |
| DEBT-DISPATCH-020 | causally-aware replan; rewire downstream `depends_on` after correction | causal-replan | status: OPEN |
| DEBT-DISPATCH-022 | `dispatch-cli` `bin` field + esbuild `build-bin` target | cli-complete | status: OPEN |
| DEBT-DISPATCH-023 | delete `dispatch-cli` poll-internal duplicates (consume exported ones) | cli-complete | status: OPEN |
| DEBT-DISPATCH-024 | lazy runner factory into `calibrateCore` (tier validated before construct) | cli-complete | status: OPEN |
| DEBT-DISPATCH-025 | shared missing-dag-file guard across `*Core` fns | cli-complete | status: OPEN |
| DEBT-WORKSPACE-NX-INPUTS-001 (dispatch instances) | dispatch-package `project.json` inputs/implicitDeps only (workspace-wide sweep is out of scope) | tests-hardening | status: OPEN |

## Discovered during execution

_New bugs/deferrals discovered while executing this plan are appended here at discovery time (per disclosure policy), with their own `status: OPEN` row, and also to the repo root BACKLOG.md if they are not plan-owned._
