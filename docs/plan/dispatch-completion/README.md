# Dispatch Completion

Take the `@adhd/dispatch-*` subsystem from "generative dispatch works, edges rough, deferred track unbuilt" to "feature-complete + hardened over an executable, shippable core." Two headline defects — tool-call execution (BUG-DISPATCH-EXEC-001) and package-name/publish conformance (BUG-DISPATCH-PUBLISH-001) — are fixed **directly** as landed preconditions (Phase 0 confirms them) and are out of this plan's scope. This plan owns the residual: 3 new packages (`dispatch-serializer-sqlite`, `dispatch-plugin-io`, `dispatch-plugin-gitnexus`), the ~18 open `DEBT-DISPATCH-*` items (see `BACKLOG.md`), a held/data-gated `optimizer-algorithms` phase, test hardening, orphan-delete of `dispatch-base-types`, and release-ready — without rebuilding one line of the shipped, tested packages and without touching agent-mcp.

## Consumer

A dispatch lead ("Priya") who authors `dag.json` plans and drives them through the `@adhd/dispatch-*` CLI + orchestrator. See `demo/DEMO.md` for the acceptance walkthrough; every DoD clause below maps to a binary assertion there.

## Value delta

Before: a `DispatchUnit` has no `execution_mode`; a complete milestone still reads `eligible`; a mid-cycle runner failure throws and leaves no trace; snapshots can corrupt on JSON round-trip; there is no SQLite backend, no file/blast-radius enrichment, no npx binary, and the DEBT-DISPATCH cluster is open. After: each edge is closed with a teeth-bearing test, the deferred capabilities ship, the orphan package is gone, and all 10 dispatch projects build+test green and are release-ready.

## Definition of Done

_Authored below via `plan-scaffold.js add-dod`._

## Source artifacts

`SCOPE.md` (objective, pinned-vs-resolve), `USE_CASES.md`, `demo/DEMO.md` (DoD source, validator-passing), `TOOLS.md` (build-vs-reuse), `RECONCILIATION.md` (ship-vs-outstanding ledger), `PLAN_STATE_MACHINE_PROPOSAL.md` (topology), `APPROVAL.md` (committed sign-off), `BACKLOG.md` (plan-owned DEBT-DISPATCH items — source of truth).

- `[dod.1]` **All 10 dispatch projects build+test green: nx run-many -t test,build across dispatch-base-spec,-core-client,-serializer-json,-serializer-sqlite,-core-optimizer,-orchestrator,-plugin-io,-plugin-gitnexus,-tools,-cli exits 0. (structural)** — All 10 dispatch projects build+test green: nx run-many -t test,build across dispatch-base-spec,-core-client,-serializer-json,-serializer-sqlite,-core-optimizer,-orchestrator,-plugin-io,-plugin-gitnexus,-tools,-cli exits 0..

- `[dod.2]` **Every DispatchUnit from optimize() carries a non-null execution_mode discriminant. (behavioral)** — Every DispatchUnit from optimize() carries a non-null execution_mode discriminant..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-core-optimizer`
  - observable: `each unit.execution_mode is one of generative|tool-call|guard-only`
  - negative-control: `revert the assembleUnit derivation -> test red`
