# PLAN-STATE-MACHINE PROPOSAL — dispatch-completion

**Status:** PROPOSED shell — NOT the executable plan. `dag.json`/`state.json`/`contexts/`/`scripts/` are authored via the `plan-state-machine` skill **only after** GATE 2 sign-off. This document is the design presented for that sign-off.

## Cross-cutting invariants → `contexts/_shared.md` (cited by every work state, never restated)

- **`[inv:worktree-required]`** — monorepo detected (`nx.json`). Every executor works in a git worktree under `.worktrees/` (`<actor>/<slug>` convention), never the main checkout. When a worktree needs `node_modules`, **symlink** it: `ln -s <main-repo-root>/node_modules node_modules` — never reinstall (the dep tree is byte-identical until a `package.json` changes).
- **`[inv:nx-cache]`** — never `--skip-nx-cache`; prove hits by running twice.
- **`[inv:aliases]`** — import `@adhd/dispatch-spec`/`-client`/`-optimizer`; package names carry `-base-`/`-core-` infixes (`tsconfig.base.json`).
- **`[inv:purity]`** — shared packages never import node/logic/UI; optimizer stays pure (injected deps).
- **`[inv:live-gate]`** — paid-LLM paths gated `DISPATCH_E2E_LIVE=1`, documented (owner: plan-builder) in README + CLAUDE.md + test header; all else default-runs with `MockAgentRunner`.
- **`[inv:teeth]`** — every behavioral DoD clause proven by an audit check that drives the real entrypoint AND goes red when the fix is reverted (negative control). Grep/"symbol present" is insufficient for behavioral clauses.
- **`[inv:resolve-at-dispatch]`** — line numbers + current file contents are RESOLVE (grep at dispatch), not pinned; only acceptance signal + invariants + interface contracts are pinned.

## Phase / state graph (work + audit states)

Each phase = 1+ work state + an audit state (gate). Audit states run deterministic env-pinned guards. `⊳` = depends_on.

DoD clauses map to `demo/DEMO.md` REQ-/CAP- IDs and beats (the §8 coverage matrix), not to prose. Each behavioral clause is proven by an audit check that drives the named beat.

| Phase | State (work) | Owns / file reservations | DoD (DEMO REQ · beat) | Tier |
|---|---|---|---|---|
| **P0** | `triage` (audit-only) | `BACKLOG.md`, `RECONCILIATION.md`, emits outstanding-list | D0.1–D0.3 | mid |
| **P1** | `spec-foundations` ⊳ triage | `packages/dispatch/dispatch-base-spec/src/**` | REQ-003 (3.1), REQ-004 (2.2), REQ-005 (4.2), REQ-013 (1.2) | mid (pin snippets) |
| | `spec-audit` | guard: `nx test,build dispatch-base-spec` + teeth checks | gates P1 | — |
| **P2** | `optimizer-propagate` ⊳ spec-audit | `dispatch-core-optimizer/src/**` | REQ-003 (3.1); BL-103/105 internal | mid |
| | `client-eligible` ⊳ spec-audit | `dispatch-core-client/src/**` | REQ-005 (4.2) | weak |
| | `prompt-split` ⊳ optimizer-propagate | optimizer + orchestrator prompt-compiler seam | DEBT-012 (internal) | strong |
| | `opt-audit` | guard: `nx test,build dispatch-core-optimizer,dispatch-core-client` | gates P2 | — |
| **P3** | `orchestrator-harden` ⊳ opt-audit | `dispatch-orchestrator/src/lib/orchestrator.ts`, `agent-runner.ts` | REQ-006 (4.3), REQ-014 (5.4); DEBT-017/018 | mid |
| | `causal-replan` ⊳ orchestrator-harden | orchestrator replan/injection | REQ-011 (§4 climax, DEBT-020) | strong |
| | `orch-audit` | guard: `nx test,build dispatch-orchestrator` + teeth | gates P3 | — |
| **P4** | `plugin-io` ⊳ orch-audit | NEW `packages/dispatch/dispatch-plugin-io/**` | REQ-010 (3.2) | strong |
| | `plugin-gitnexus` ⊳ orch-audit | NEW `packages/dispatch/dispatch-plugin-gitnexus/**` (wraps GitNexus MCP) | REQ-010 (3.2) | strong |
| | `plugin-audit` | guard: `nx test,build` both plugins | gates P4 | — |
| **P5** | `serializer-sqlite` ⊳ orch-audit | NEW `packages/dispatch/dispatch-serializer-sqlite/**` | D5.1 (sqlite parity) | strong |
| | `bl107-backcompat` ⊳ orch-audit | `dispatch-serializer-json/src/**` (confirm `normalizeDag` owns legacy load) | — | mid |
| | `storage-audit` | guard: sqlite↔json parity test + legacy-load validate | gates P5 | — |
| **P6** | `dispatch-tools` ⊳ opt-audit (client) **[Phase-0-gated: may be delivered by EXEC-001]** | `packages/dispatch/dispatch-tools/**` (authoring surface only; execution wiring is EXEC-001) | REQ-007 (5.3) | strong |
| | `tools-audit` | guard: author-then-validate + cycle-reject | gates P6 | — |
| **P7** | `cli-complete` ⊳ orch-audit | `entrypoint/dispatch-cli/**` (bin field, esbuild target, lazy factory, missing-file guard); DELETE `dispatch-base-types` | REQ-009 (6.2, 5.2), REQ-015 (5.1) | mid |
| | `cli-audit` | guard: `npx` spawn smoke + consistency | gates P7 | — |
| **P8** | `optimizer-algorithms` ⊳ orch-audit **[HELD: data-gate]** | `dispatch-core-optimizer/src/lib/algorithms/**` + DEBT-011 final cleanup | REQ-012 (6.3) | strong |
| | `algo-audit` | guard: gate-check (≥3 cycles/>15%) → golden comparison OR record HELD | gates P8 conditionally | — |
| **P9** | `tests-golden` ⊳ P2–P7 audits | golden fixtures across packages | REQ-001 (6.3) | mid |
| | `stepwise-ab` ⊳ orch-audit | orchestrator A/B experiment harness | CAP-013 experiment | strong |
| | `nx-inputs-dispatch` ⊳ (all package states) | dispatch-package `project.json` inputs/implicitDeps only | (dispatch instance of NX-001) | mid |
| | `test-audit` | guard: `nx run-many -t test,build -p <10 projects>` ×2 cache-proven | REQ-001, REQ-012 (6.3) | — |
| **P10** | `release-ready` ⊳ test-audit, algo-audit | version bumps `0.0.1→0.1.0`, BACKLOG reconciliation, portfolio links; `npm pack --dry-run` re-confirm (PUBLISH-001 already conformed names) | REQ-001 (O1 rollup) | mid |
| | `terminal` | terminal state | — | — |

## Notes on structure

- **Ripple ordering (P6 advisory):** spec → optimizer/client → orchestrator → (plugins ∥ sqlite ∥ tools ∥ cli) → algorithms(held) → tests → release. Consumers inherit spec guards rather than re-implementing.
- **The `ICalibrationStore` work (DEBT-018 + BL-106)** lands in P3 (`orchestrator-harden`) — it is a spec interface + orchestrator impl + cold-start seed, with no external feed (former per-turn dependency removed with DEBT-006).
- **Data-gate (P8):** `algo-audit` reads `dispatch_log` for the greedy-vs-naive shortfall. Unmet → writes a `HELD` marker; `terminal` does not require P8 (locked decision U5). Met → the cascade must beat greedy on ≥1 golden fixture.
- **Zero cross-plan collision surface.** Every state reserves only `packages/dispatch/**` or `entrypoint/dispatch-cli/**` — no agent-mcp file is touched (DEBT-006 handed off). No cross-stream coordination needed in the registry `mutate_set`.
- **`gap-check.js`** must run clean before hand-off: no cycles (FAIL), resolve write-conflicts/unresolved-needs (WARN).

## Preconditions (fixed directly — NOT states in this plan)
- **BUG-DISPATCH-EXEC-001** (tool-call execution wired + `@adhd/dispatch-tools` primitives) and **BUG-DISPATCH-PUBLISH-001** (import↔name conformance + dup-alias removal) land via separate code-fix executors. `P0 triage` gates on them (V0): if either hasn't landed, halt and report — this plan depends on them.
- **`orphan-delete` (P7)** — remove `@adhd/dispatch-base-types` (0 consumers) if PUBLISH-001 didn't.

## Estimated shape
~11–13 work states + ~8 audit states across 10 phases (P0 triage → spec → optimizer/client → orchestrator → plugins ∥ sqlite ∥ tools ∥ cli → algorithms(held) → tests → release). ~3 new packages (`dispatch-serializer-sqlite`, `dispatch-plugin-io`, `dispatch-plugin-gitnexus`; `dispatch-tools` authoring only if not shipped by EXEC-001), ~15 debt-fix edits to shipped packages, zero agent-mcp changes, zero headline-defect work (handled directly). Context packs budgeted 1.5–3k tokens/executor, honoring the SCOPE pinned-vs-resolve partition.
