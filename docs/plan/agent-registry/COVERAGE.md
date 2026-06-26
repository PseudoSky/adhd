# Agent Registry — Coverage Tracker ("cover everything")

> **Operating directive (user, 2026-06-24):** *"this plan won't end until we cover everything."*
> The 7 plans' DoDs are deliberately-scoped **foundation slices**. This file is the master
> ledger of every gap between the scoped build and the **GOAL** — the initiative's *true*
> definition of done. Nothing here is a permanent escape hatch; each item is owed work.
> A gap is CLOSED only when its observable is proven (consumer-level, with teeth), not when
> it's merely backlogged.

## Status legend
`PLAN` = closes inside a remaining plan · `NEW` = needs a dedicated closure pass (net-new) ·
`DONE` = covered & proven.

## A. Closes via the remaining plans (now 4: plans 6, 7, 8, 9)

| gap | source | closure path | status |
|---|---|---|---|
| ProviderAdapter not wired into agent-mcp | provider NB-1 | **agent-mcp-refactor** (plan 6) consumes the adapter | PLAN |
| Foundations never exercised together (consumer outcome) | (whole point) | **agent-compiler** `compile-fixtures-e2e` (plan 5, wave 9) compiles real agents end-to-end | PLAN (compile-path only; runtime via plan 6) |
| Existing agents not in the registry | (goal) | **agent-registry-migration** (plan 7) | PLAN |
| No agent-facing authoring/discovery over MCP (single-authorship, onboarding, discovery) | GOAL §Maintainability; SPEC | **agent-mcp-authoring** (plan 8) — `agent_define`/`component_define`/`component_search` + enrichment + name↔slug seam | PLAN |
| Demo tests author's-perspective (deep src imports), not zero-context user | DEMO.md; demo audit | **agent-mcp-authoring** (plan 8) `composition-journey-e2e` — maintained zero-internal-import test over the public MCP surface | PLAN |
| No live-model e2e for the authoring lane | CLAUDE.md std #5 | **agent-mcp-authoring** (plan 8) `live-model-e2e` (`AGENT_MCP_LIVE`-gated) | PLAN |
| Worktree/merge/publish/cleanup + agent-mcp back-out guarantee at release | closeout | **agent-registry-release** (plan 9) — `CLOSEOUT.md`, gated merge/publish | PLAN |

## B. Needs a dedicated closure pass (NOT in the current 7 plans)

| gap | source | what "covered" means | status |
|---|---|---|---|
| **Only 1 of 8 enforcement mechanisms enforces** | policy NB-1 | extend `EnforcementEvent` in `@adhd/agent-mcp-types` + wire agent-mcp HookRegistry for `runtime/settings/dispatcher/ci/...`; turn observational-only policies into enforced ones | NEW |
| Rate policy = single `maxModelCalls` | policy NB-2 | add maxTokens / maxToolCalls / etc. limit types | NEW |
| Single-level policy inheritance | policy NB-3 | hierarchical taxonomy walk in `resolveForAgent` (needs taxonomy parent link) | NEW |
| **No live-model e2e tests** | policy NB-4, provider NB-2 | `AGENT_MCP_LIVE`-gated tests driving enforcement + adapter through a real model | NEW |
| Lint debt across packages | policy NB-5, provider NB-3, + unused-zod dep-check on registry/tool-registry | sweep `no-non-null-assertion` (≈24 policy + 2 provider + others) + remove unused deps; get `nx lint` green on all agent-* packages | NEW |
| Audit trail (`COMPOSED_PROMPT`) + A/B testing (`EXPERIMENT`) | GOAL §Audit Trail / §A/B | likely a future plan; GOAL marks these as design-pass illustrations | NEW (goal-future) |

## C. Process / skill gaps (logged as reflections)

| gap | reflection uid | owner |
|---|---|---|
| `dod_confirmed` enforced inconsistently (authoring-stamp vs fresh) | `01KVVHENAC…` | plan-state-machine |
| DoD relayed as audit-green instead of consumer-framed + assessed | `01KVVHEXJV…` | plan-orchestrator |
| DoD not traceable to GOAL (meets-DoD ≠ achieves-goal) | `01KVVHF2EE…` | plan-state-machine |
| Planner derives DoD from "auditable" not from intent | `01KVVHF8DJ…` | workflow-planner |
| How humanized/GOAL-traceable DoD changed orchestration (gate tiering+framing caught consumer-guarantee regression; split-harness/tier/telemetry gaps) | `01KVZPK4JT…` | plan-orchestrator |

## Definition of "everything covered"
1. All **9** plans `done` + DoD-confirmed (5/9 built now; plans 6–9 authored, unbuilt — see `CLOSEOUT.md` §3).
2. Section A items proven by their plans' e2e/integration states (now incl. plan 8's
   `composition-journey-e2e` zero-internal-import gate + `live-model-e2e`).
3. Section B items each built + proven at the consumer level (with teeth / live where applicable).
4. `nx lint` green across all `packages/ai/agent-*`.
5. The consumer journey from `USAGE.md` (install → compose → apply policy → compile to platform)
   works end-to-end with a real agent — and the **SPEC §7 task-packet→agent composition journey**
   runs over the **public MCP surface** (plan 8), not deep store calls.
6. The initiative is **landed**: `agent-registry-execution` merged to `main` (or an explicit
   no-merge decision recorded), 6 packages published, artifacts dispositioned, and the agent-mcp
   back-out guarantee verified as a gate (plan 9).

> The full GOAL achieves/defers map (clause-by-clause, with the honest "agent-mcp runtime imports
> zero registry packages today" finding) lives in `CLOSEOUT.md` §4.
