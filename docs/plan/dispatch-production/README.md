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

## Re-plan 2026-07-01 — fast path to first real dispatch

A two-agent review (plan-vs-code audit + agent-mcp integration spec) found the plan's
sequencing inverted relative to its value gate. Findings that drove the restructure:

1. **`optimizer-core` was stubs.** The production package built to 0.11 kB —
   `snapshot()` returned `{} as DagSnapshot`, `optimize()` returned `[]`. The real
   2,038-line implementation exists only in `docs/plan/dispatch-optimizer/src/compiler.ts`.
2. **The sole e2e-blocking stub is `mcp_servers: null`** (PoC compiler.ts:1788, BL-105).
   It is bypassed, not solved: the new `agent-runner` milestone supplies `mcpServers: {}`
   at `agent_create` time, which is valid for `claudecli` agents. The other 6 stubs are
   enrichment-only and deferred to `backlog-fill`.
3. **agent-mcp exposes only aggregate token usage** (`TaskUsageReport.direct`:
   `inputTokens`/`outputTokens`/`modelCalls` — `packages/ai/agent-mcp/src/validation/usage.ts`).
   The `dispatch_log[].turns[]` per-turn assumption was unimplementable as written;
   turns are now synthesized as a single aggregate entry.
4. **No duplication with agent-mcp's `DagEngine`** — audited; it resolves `depends_on`
   between agent-mcp task UUIDs and knows nothing of plan milestones. `orchestrator-core`
   remains necessary.
5. **Three real bugs in shipped packages** → new `client-fixes` milestone:
   `getEligibleMilestones()` ignores milestone completion (only correct for wave 0);
   `plan.spec.ts` silently bails on a stale `packages/shared/` path so it never validates
   anything; `dispatch-client` re-exports optimizer surface (layering leak).
6. **Algorithms are now data-gated.** New `optimizer-algorithms` milestone holds the
   4-algorithm cascade with an explicit unblock condition: ≥3 real cycles of
   `tokens_actual` showing greedy leaves >15% savings vs the recorded naive baseline.
   `optimize()` ships as a greedy packer (kind-family partition, ki-ascending fill,
   hard window constraint, naive-baseline emission).
7. **Stale paths fixed throughout** — all op file targets and read_only paths updated
   from removed `packages/shared/` / `packages/node-tools/` to `packages/dispatch/`.

**New critical path (5 work items, 2 already done):**
`spec-types ✅ → spec-validate ✅ → client-fixes → optimizer-core (snapshot port +
greedy) ∥ serializer-json ∥ agent-runner → orchestrator-core → tests-real-e2e`

Everything else (`plugin-io`, `plugin-gitnexus`, `serializer-sqlite`, `tools-mcp`,
`cli`, `tests-golden`, `tests-algorithms`, `optimizer-algorithms`, `backlog-fill`)
is re-sequenced behind `tests-real-e2e` — build the proof first, enrich after.

### Added 2026-07-02 — `stepwise-dispatch` (A/B experiment)

New milestone testing **op-granular dispatch with context reset + agent-emitted
forward context**: instead of one long conversation where every tool result rides
along for all remaining turns (~1 + 0.1×(T−k) cost per token under caching), the
runner dispatches one operation per ephemeral task; the agent ends each completion
report with a bounded fenced-JSON `ForwardContext` block (`{ completed_op,
artifacts, exports, decisions, warnings }`, ≤2,000 chars) which the runner persists
to `dispatch_log` and injects into the next step's prompt. Grounding: the measured
spec-types run re-sent a 20k reference read across ~10 turns that only 1 of 4 ops
needed, and cross-task prefix caching (measured live) makes each step's prefix cost
~0.1×. This is the split-side of the PoC SCOPE §A4 merge-vs-split crossover — the
milestone's A/B experiment (`tests/integration/stepwise-ab.ts`) decides it with
data: packed vs stepwise on the same sandbox work order, per-turn tokens from
`task_events`, artifact-equivalence assertion. A negative result is recorded here
and becomes a packing input to the optimizer instead of a default.

### Updated 2026-07-02 — `cli` pulled onto the fast path, apigen-generated

The plan already carried both interface sides — `cli` (human) and `tools-mcp`
(LLM). User decisions (2026-07-02) reshape `cli`: the dispatcher CLI is
**generated via apigen** from the base client rather than hand-written, and the
integration harnesses live in that entrypoint package (no repo-root `tests/`
dir). A transient `cli-entrypoint` milestone briefly duplicated `cli` during
this edit and was merged back — `cli` is the single CLI milestone.

`cli` now: deps `orchestrator-core` only (`tools-mcp` + `serializer-sqlite`
dropped — they stay deferred; the human CLI needs only the file serializer
stack) and `tests-real-e2e` depends on it. Location
`packages/dispatch/dispatch-cli` (`layer:entrypoints, platform:node`; precedent
`packages/decompile` — no new repo-root `apps/`). `src/api.ts` exposes
`validate`/`snapshot`/`optimize`/`eligible`/`status`/`run`/`calibrate` wiring the
real stack; `@adhd/apigen-nx:generate` projects it to a Commander CLI
(`type: 'cli'`). Proof standard: a default-running smoke test **spawns the
generated artifact** (exit codes + payloads; never imports generated code).
Harnesses live at `src/test/integration/{real-e2e,stepwise-ab}.ts`.

**Spike-validated live (2026-07-02, `tmp/dispatchcli/`):** `apigen generate
--type cli` from a 2-function surface over the real client worked end-to-end;
`validate` and `eligible` ran against this very dag.json (JSON envelopes,
kebab-case flags, clean exit codes) — and immediately surfaced
**BUG-DISPATCH-008** (eligibility didn't exclude already-complete milestones).
Quirks found: `tsx` needs `--tsconfig tsconfig.base.json` (repo root has no
`tsconfig.json`), and the generator's namespace identifier breaks on hyphenated
source dirs (BUG-APIGEN-CLI-001 in `packages/apigen/BACKLOG.md`).

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
FAST PATH (to first real dispatch):

  spec-types ✅ ──► spec-validate ✅
                        │
        ┌───────────────┼────────────────┐
        │               │                │
   client-core ✅   optimizer-core   agent-runner
        │           (snapshot port      (IDispatchAgentRunner
   client-fixes      + greedy packer)    over agent-mcp tools)
        │               │                │
   serializer-json      │                │
        └───────────────┼────────────────┘
                        │
               orchestrator-core
        (load → snapshot → greedy → fire → poll
         → guard → record aggregate tokens)
                        │
             tests-real-e2e (8 scenarios,
              S4 live-gated; value gate)

DEFERRED TRACK (unblocked by tests-real-e2e):

  plugin-io   plugin-gitnexus   serializer-sqlite   tools-mcp
        └───────┬───────┘              │                │
                │                     cli ◄─────────────┘
     optimizer-algorithms              │
     (data-gated: >15% greedy     tests-golden
      shortfall over ≥3 cycles)        │
                └──────────► tests-algorithms
                                       │
                                 backlog-fill
                                       │
                            hardening-complete (terminal)
```

## Real-world E2E test coverage

`tests/integration/real-e2e.ts` — 8 scenarios covering full lifecycle:

| # | Scenario | Asserts |
|---|---|---|
| S1 | Cold start: empty directory → `dispatch init` | dag.json skeleton exists, validate passes, status shows 0/0 |
| S2 | Author plan via DagClient (MCP tools simulation) | 3 milestones, 5 ops, 1 eligible, no orphans, no cycles |
| S3 | Snapshot + optimize on authored plan | 1 DispatchUnit, prompt non-null, tokens_est > 0, snapshot deterministic |
| S4 | Real dispatch via agent-mcp Haiku | LIVE-gated. Agent produces file, guard passes, dispatch_log appended, tokens recorded from aggregate `TaskUsageReport.direct` (per-turn breakdown is not exposed by agent-mcp — no scenario may assert it) |
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

See `packages/dispatch/dispatch-spec/README.md` for the six design tenets that
govern every package in this ecosystem.
