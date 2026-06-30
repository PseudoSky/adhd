# Dispatch Production

Plan to extract the dispatch-optimizer proof-of-concept into a production-grade
library ecosystem.

## Architecture

```
                        Human CLI                  Agent CLI            MCP Server
                            │                          │                    │
                            └──────────────────────────┴────────────────────┘
                                                       │
                                                  DagClient              ← @adhd/dispatch-client
                                                 (CRUD + validation)
                                                       │
                                                 IDagSerializer          ← adapter interface
                                                       │
                                ┌──────────────────┼────────────────────┐
                                │                  │                    │
                        JsonFileSerializer  SqliteSerializer   GitSerializer
                            │
                        (dag.json on disk)
                                                       │
                         ┌─────────────────────────────┤
                         │                             │
                  snapshot() + optimize()          Plugin-IO          Plugin-gitnexus
              @adhd/dispatch-optimizer         (file stat + read)   (blast radius + AST)
                         │
                  Orchestrator                 ← @adhd/dispatch-orchestrator
             (state machine loop: snapshot → enrich → optimize → dispatch → poll → record)
```

## Packages

| Package | Layer | Platform | Depends on |
|---|---|---|---|
| `@adhd/dispatch-spec` | shared | shared | — (zero deps) |
| `@adhd/dispatch-client` | data | shared | spec |
| `@adhd/dispatch-serializer-json` | data | node | client |
| `@adhd/dispatch-serializer-sqlite` | data | shared | client |
| `@adhd/dispatch-optimizer` | logic | shared | spec |
| `@adhd/dispatch-plugin-io` | logic | node | optimizer |
| `@adhd/dispatch-plugin-gitnexus` | logic | node | optimizer |
| `@adhd/dispatch-tools` | data | node | client, serializer-json |
| `@adhd/dispatch-orchestrator` | workflows | node | optimizer, client, plugins |
| `apps/dispatch-cli` | entrypoints | node | orchestrator, tools, serializer-sqlite |

## Key design decisions

1. **Serialization adapter pattern** — `IDagSerializer` interface with factory functions
   (`createJsonFileSerializer`, `createSqliteSerializer`, etc.). The client never knows
   where dag.json lives. Modeled on `HostAdapter` from `@adhd/apigen-gateway`.

2. **DagClient is the single CRUD authority** — no agent, CLI, or orchestrator reads
   dag.json raw. The MCP tools wrap DagClient; the human CLI configures a DagClient;
   the orchestrator calls `client.full_dag()`.

3. **Optimizer is pure computation** — `snapshot()` and `optimize()` take injected
   dependencies (`IOptimizerDeps`). No I/O, no agent-mcp knowledge, no side effects.
   Works with all data sources null (graceful degradation).

4. **Plugins enrich post-hoc** — the IO plugin provides `fileSizes()` and `readFiles()`
   injected into the optimizer. The gitnexus plugin is a separate enrichment pass that
   runs between `snapshot()` and `optimize()` in the orchestrator pipeline.

5. **Agents never read dag.json into context** — all dag manipulation goes through MCP
   tools (`dag.milestone_add`, `dag.pending_clear`, etc.) that enforce structural
   validity, referential integrity, and D-07 eligibility invariants.

## Backlog items addressed

- BL-101 through BL-107 from the dispatch-optimizer LOG.md
- The 7 stubs (attempt_count, tokens_actual, mcp_servers, blast_radius,
  from/breaking/severity, conflict, raised_at_dispatch)
- Cold-start b_per_tier seeding
- Backward-compat normalization moved into serializer
- No tests → full test suite (golden, algorithms, edge cases, integration)

## Phases

1. **Foundation** — spec types + validation (the data contract)
2. **Client** — DagClient + JSON serializer (the CRUD layer)
3. **Optimizer** — snapshot + optimize ported from compiler.ts with DI
4. **Plugins** — IO + gitnexus enrichment
5. **Tools & Orchestrator** — MCP server + state machine loop
6. **CLI** — human entrypoint
7. **Hardening** — golden tests, algorithm tests, backlog fill, real-world e2e

## Milestone graph

```
foundation:         spec-types ──► spec-validate
                                       │
client:                 ┌──────────────┤
                        │              │
                   client-core    optimizer-core
                        │              │
                   ┌────┤         ┌────┴────┐
                   │    │         │         │
          serializer-json |  plugin-io  plugin-gitnexus
                   │    │         │         │
tools+orch:   ┌────┤    │         └────┬────┘
              │    │    │              │
         tools-mcp │ serializer-sqlite │
              │    │    │              │
              │    └────┼──────────────┤
              │         │     orchestrator-core
              │         │              │
cli:          └────┬────┘              │
                   │                   │
                 cli ◄─────────────────┘
                   │
hardening:    tests-golden
                   │
            tests-algorithms
                   │
              backlog-fill
                   │
            tests-real-e2e (8 scenarios)
                   │
          hardening-complete (guard-only terminal)
```

## Real-world E2E test coverage

`tests/integration/real-e2e.ts` — 8 scenarios covering full lifecycle:

| # | Scenario | Asserts |
|---|---|---|
| S1 | Cold start: empty directory → `dispatch init` | dag.json skeleton exists, validate passes, status shows 0/0 |
| S2 | Author plan via DagClient (MCP tools simulation) | 3 milestones, 5 ops, 1 eligible, no orphans, no cycles |
| S3 | Snapshot + optimize on authored plan | 1 DispatchUnit, prompt non-null, tokens_est > 0, snapshot deterministic |
| S4 | Real dispatch via agent-mcp Haiku | LIVE-gated. Agent produces file, guard passes, dispatch_log appended, tokens tracked |
| S5 | Second cycle: next milestone eligible | 2 dispatch_log entries, no replan injection (plan was complete), 3rd milestone now eligible |
| S6 | Guard failure → correction injection | dispatch_log has warn note, correction milestone injected with triggered_by, pending-surfaced surfaced in open_questions |
| S7 | Correction resolves → retry succeeds | Implementation retried + passes, terminal reached, 4+ dispatch_log entries, total tokens > 0 |
| S8 | CLI resume mid-cycle + calibration | Kill/restart does not re-dispatch completed milestones, `dispatch calibrate` writes ~/.adhd/dispatch-calibration.json |

Scenario 4 is gated behind `DISPATCH_E2E_LIVE=1` (paid LLM call). All other scenarios
run by default with a mock agent runner that exercises the exact same code paths.

## Live test gate

Per the live-testing policy (CLAUDE.md §6), scenario 4 qualifies for the single
exception — it calls a real third-party LLM. Gate details:
- Env var: `DISPATCH_E2E_LIVE=1`
- Documented in: this README, CLAUDE.md, `tests/integration/real-e2e.ts` header
- Named owner: `workflow:plan-builder`
- When gated: auto-skip with clear message; all other 7 scenarios run by default

## Source

This plan extracts from `docs/plan/dispatch-optimizer/` — the 3,132-line
proof-of-concept that defined the types, algorithms, schema, and design decisions.

## What's reusable vs. what's instance

This plan builds **infrastructure** that is reusable across all plans:

| Package | Reusability |
|---|---|
| `@adhd/dispatch-spec` | Zero plan knowledge. Any `dag.json` passes its validators. |
| `@adhd/dispatch-client` | `createDagClient({ serializer, validate })` — any plan, any storage |
| `@adhd/dispatch-optimizer` | `snapshot(dag, deps)` — any DagJson, produces DispatchUnit[] |
| `@adhd/dispatch-orchestrator` | `orchestrate(deps)` — loops any plan to terminal |
| `apps/dispatch-cli` | `dispatch run <any-plan-slug>` — runs anything with a dag.json |

This plan's `dag.json` is an **instance** — hardcoded to the adhd monorepo paths
and specific file targets. The reusable plan that produces instances like this
is the **plan-builder workflow** (described in WORKFLOW.md in dispatch-optimizer).
That meta-plan's milestones are `goal-defined → decompose → ground →
resolve-unknowns → define-contracts → wire-dependencies → validate`. Its
operations call `@adhd/dispatch-tools` MCP tools to author instance dag.json
documents. Building and dispatching that meta-plan is the next layer —
bootstrapping the system that plans itself.

See `packages/shared/dispatch-spec/README.md` for the six design tenets that
govern every package in this ecosystem.
