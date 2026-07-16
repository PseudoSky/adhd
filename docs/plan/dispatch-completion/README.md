# Dispatch Completion

Take the `@adhd/dispatch-*` subsystem from "generative dispatch works, edges rough, deferred track unbuilt" to "feature-complete + hardened over an executable, shippable core." Two headline defects — tool-call execution (BUG-DISPATCH-EXEC-001) and package-name/publish conformance (BUG-DISPATCH-PUBLISH-001) — are fixed **directly** as landed preconditions (Phase 0 confirms them) and are out of this plan's scope. This plan owns the residual: 3 new packages (`dispatch-serializer-sqlite`, `dispatch-plugin-io`, `dispatch-plugin-gitnexus`), the ~18 open `DEBT-DISPATCH-*` items (see `BACKLOG.md`), a held/data-gated `optimizer-algorithms` phase, test hardening, orphan-delete of `dispatch-base-types`, and release-ready — without rebuilding one line of the shipped, tested packages and without touching agent-mcp.

## Consumer

A dispatch lead ("Priya") who authors `dag.json` plans and drives them through the `@adhd/dispatch-*` CLI + orchestrator. See `demo/DEMO.md` for the acceptance walkthrough; every DoD clause below maps to a binary assertion there.

## Value delta

Before: a `DispatchUnit` has no `execution_mode`; a complete milestone still reads `eligible`; a mid-cycle runner failure throws and leaves no trace; snapshots can corrupt on JSON round-trip; there is no SQLite backend, no file/blast-radius enrichment, no npx binary, and the DEBT-DISPATCH cluster is open. After: each edge is closed with a teeth-bearing test, the deferred capabilities ship, the orphan package is gone, and all 10 dispatch projects build+test green and are release-ready.

## Source artifacts

`SCOPE.md` (objective, pinned-vs-resolve), `USE_CASES.md`, `demo/DEMO.md` (DoD source, validator-passing), `TOOLS.md` (build-vs-reuse), `RECONCILIATION.md` (ship-vs-outstanding ledger), `PLAN_STATE_MACHINE_PROPOSAL.md` (topology), `APPROVAL.md` (committed sign-off), `BACKLOG.md` (plan-owned DEBT-DISPATCH items — source of truth).

## Definition of Done

- `[dod.1]` **All 10 dispatch projects build+test green: nx run-many -t test,build across dispatch-base-spec,-core-client,-serializer-json,-serializer-sqlite,-core-optimizer,-orchestrator,-plugin-io,-plugin-gitnexus,-tools,-cli exits 0. (structural)** — All 10 dispatch projects build+test green: nx run-many -t test,build across dispatch-base-spec,-core-client,-serializer-json,-serializer-sqlite,-core-optimizer,-orchestrator,-plugin-io,-plugin-gitnexus,-tools,-cli exits 0..

- `[dod.2]` **Every DispatchUnit from optimize() carries a non-null execution_mode discriminant. (behavioral)** — Every DispatchUnit from optimize() carries a non-null execution_mode discriminant..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-core-optimizer`
  - observable: `each unit.execution_mode is one of generative|tool-call|guard-only`
  - negative-control: `revert the assembleUnit derivation -> test red`

- `[dod.3]` **A complete milestone reports eligible:false from the spec snapshot definition. (behavioral)** — A complete milestone reports eligible:false from the spec snapshot definition..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-base-spec`
  - observable: `snapshot.milestones[x].eligible === false when x is complete`
  - negative-control: `revert the own-completion promotion -> test red`

- `[dod.4]` **A mid-cycle runner failure is recorded as a failed dispatch_log entry, not thrown. (behavioral)** — A mid-cycle runner failure is recorded as a failed dispatch_log entry, not thrown..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-orchestrator`
  - observable: `a runner that rejects mid-fire yields a status:failed log entry and orchestrateCycle does not throw`
  - negative-control: `remove the per-unit try/catch -> uncaught rejection, test red`

- `[dod.5]` **Causal replan rewires downstream depends_on onto an injected correction and the resumed run reaches terminal. (behavioral)** — Causal replan rewires downstream depends_on onto an injected correction and the resumed run reaches terminal..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-orchestrator`
  - observable: `after a correction completes, downstream depends_on points at it and the cycle terminates all-complete not no-eligible-work`
  - negative-control: `revert the rewire -> resume ends no-eligible-work, test red`

- `[dod.6]` **The SQLite serializer reload equals the JSON serializer reload of the same dag (adapter parity). (behavioral)** — The SQLite serializer reload equals the JSON serializer reload of the same dag (adapter parity)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-serializer-sqlite`
  - observable: `write-then-read via sqlite adapter equals write-then-read via json serializer on normalized form`
  - negative-control: `corrupt the sqlite read mapping -> parity assertion red`

- `[dod.7]` **IO and gitnexus enrichment plugins inject real signal; the optimizer stays pure with null deps. (behavioral)** — IO and gitnexus enrichment plugins inject real signal; the optimizer stays pure with null deps..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-plugin-io dispatch-plugin-gitnexus`
  - observable: `pairwise_overlap non-zero for file-sharing milestones with IO plugin; blast_radius non-null with gitnexus plugin; optimize() still valid with null deps`
  - negative-control: `null-inject the plugin -> overlap zero (baseline), and optimizer purity test stays green`

- `[dod.8]` **validateDagJson rejects an unknown dispatch_log[].provider and accepts claudecli/teammate (DEBT-019); calibrate rejects a bad model tier before constructing the runner (DEBT-024). (structural)** — validateDagJson rejects an unknown dispatch_log[].provider and accepts claudecli/teammate (DEBT-019); calibrate rejects a bad model tier before constructing the runner (DEBT-024)..

- `[dod.9]` **A DagSnapshot round-trips JSON.stringify/parse with no Infinity->null corruption in context_window_per_tier (DEBT-014). (structural)** — A DagSnapshot round-trips JSON.stringify/parse with no Infinity->null corruption in context_window_per_tier (DEBT-014)..

- `[dod.10]` **optimizer-algorithms is data-gated: HELD with a recorded baseline when <15%/<3 cycles, else the cascade beats greedy on >=1 golden fixture (REQ-012). (structural)** — optimizer-algorithms is data-gated: HELD with a recorded baseline when <15%/<3 cycles, else the cascade beats greedy on >=1 golden fixture (REQ-012)..

- `[dod.11]` **dispatch-tools authors a valid dag through DagClient and rejects a cycle-forming edit. (behavioral)** — dispatch-tools authors a valid dag through DagClient and rejects a cycle-forming edit..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-tools`
  - observable: `a tool-authored 3-milestone dag passes validateDagJson with no orphans/cycles; a cycle-forming milestone_add is rejected and the dag is unchanged`
  - negative-control: `remove the referential-integrity guard -> cycle accepted, test red`

- `[dod.12]` **dispatch is npx-invocable (bin field + built bin/); snapshot/status/run report a missing dag file consistently with the path (DEBT-022/025); dispatch-base-types is deleted. (structural)** — dispatch is npx-invocable (bin field + built bin/); snapshot/status/run report a missing dag file consistently with the path (DEBT-022/025); dispatch-base-types is deleted..

- `[dod.13]` **Every carried DEBT-DISPATCH item in this plan's BACKLOG.md is either fixed-with-a-teeth-bearing test or closed with a dated live-source verdict; no silent carry. (structural)** — Every carried DEBT-DISPATCH item in this plan's BACKLOG.md is either fixed-with-a-teeth-bearing test or closed with a dated live-source verdict; no silent carry..

- `[dod.1]` **All 10 dispatch projects build+test green: nx run-many -t test,build across dispatch-base-spec,-core-client,-serializer-json,-serializer-sqlite,-core-optimizer,-orchestrator,-plugin-io,-plugin-gitnexus,-tools,-cli exits 0. (structural)** — All 10 dispatch projects build+test green: nx run-many -t test,build across dispatch-base-spec,-core-client,-serializer-json,-serializer-sqlite,-core-optimizer,-orchestrator,-plugin-io,-plugin-gitnexus,-tools,-cli exits 0..

- `[dod.2]` **Every DispatchUnit from optimize() carries a non-null execution_mode discriminant. (behavioral)** — Every DispatchUnit from optimize() carries a non-null execution_mode discriminant..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-core-optimizer`
  - observable: `each unit.execution_mode is one of generative|tool-call|guard-only`
  - negative-control: `revert the assembleUnit derivation in dispatch-core-optimizer -> test red`
  - delivered-by: `optimizer-client, spec-foundations`

- `[dod.3]` **A complete milestone reports eligible:false from the spec snapshot definition. (behavioral)** — A complete milestone reports eligible:false from the spec snapshot definition..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-base-spec`
  - observable: `snapshot.milestones[x].eligible === false when x is complete`
  - negative-control: `revert the own-completion promotion in dispatch-base-spec -> test red`
  - delivered-by: `spec-foundations`

- `[dod.4]` **A mid-cycle runner failure is recorded as a failed dispatch_log entry, not thrown. (behavioral)** — A mid-cycle runner failure is recorded as a failed dispatch_log entry, not thrown..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-orchestrator`
  - observable: `a runner that rejects mid-fire yields a status:failed log entry and orchestrateCycle does not throw`
  - negative-control: `remove the per-unit try/catch in dispatch-orchestrator -> uncaught rejection, test red`
  - delivered-by: `orchestrator-harden`

- `[dod.5]` **Causal replan rewires downstream depends_on onto an injected correction and the resumed run reaches terminal. (behavioral)** — Causal replan rewires downstream depends_on onto an injected correction and the resumed run reaches terminal..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `nx test dispatch-orchestrator`
  - observable: `after a correction completes, downstream depends_on points at it and the cycle terminates all-complete not no-eligible-work`
  - negative-control: `revert the rewire in dispatch-orchestrator -> resume ends no-eligible-work, test red`
  - delivered-by: `causal-replan`
