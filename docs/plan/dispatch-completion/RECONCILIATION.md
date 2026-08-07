# Dispatch Subsystem — Reconciliation Ledger (merge of 3 stale plans)

**Authored:** 2026-07-15 · plan-builder (mode: build / reconcile-and-merge)
**Merges:** `docs/plan/dispatch-optimizer` (PoC), `docs/plan/dispatch-production` (extraction plan), `docs/plan/dispatch-backlog-fill` (SOLUTIONS.md debt specs)
**Merged into:** `docs/plan/dispatch-completion`
**Status of the three sources:** single-file legacy plans, **no `state.json`** → excluded from the live corpus. This ledger is the authoritative reconciliation of plan-intent vs. shipped code, verified against live source on 2026-07-15.

> All three source dirs are retained for provenance. This plan supersedes their *executable* intent; it does not delete them.

---

## A. What the three plans intended

| Source plan | Role | Disposition |
|---|---|---|
| `dispatch-optimizer` | PoC: defined the `dag.json`/snapshot schema, the cost model (B / Sᵢ / Kᵢ / Sentinel-Fanout), the 4-algorithm selection, 17 design decisions (D-01..D-17). Ships `src/compiler.ts` (2,038-line reference). | **SUPERSEDED.** Its types/algorithms/schema were ported into the shipped `@adhd/dispatch-*` packages. The reference `compiler.ts` and stub scaffolding are cleanup targets (DEBT-011). Kept as design provenance (DECISIONS.md, SCOPE.md, PROPOSED_DAG_STRUCTURE.md). |
| `dispatch-production` | Extraction plan: 20 milestones taking the PoC to a production package ecosystem. Fast-path (spec→client→optimizer→runner→orchestrator→e2e) + deferred track (plugins, tools-mcp, sqlite, algorithms, tests, backlog-fill). | **PARTIALLY EXECUTED.** Fast path DONE (8 milestones dispatched + logged). Deferred track (9 milestones) NEVER RAN → carried forward. |
| `dispatch-backlog-fill` | SOLUTIONS.md: detailed implementation specs for 8 backlog items (DEBT-005/006/012/013/018/020/022 + NX-INPUTS) + 1 closure (011). | **NOT EXECUTED** but specs are valid (with stale `packages/shared/` paths → now `packages/dispatch/`). Folded in as the debt-closure phases. |

---

## B. What SHIPPED (delivered + tested — DO NOT REBUILD)

Verified 2026-07-15 by package inventory (exports + `it()` counts) and the `dispatch-production` `dispatch_log`.

| Package (npm name → import alias) | Delivers | Tests | Source of truth |
|---|---|---|---|
| `@adhd/dispatch-base-spec` → `@adhd/dispatch-spec` | Full type contract (~65 types), `validateDagJson`/`assertValidDagJson`, `validateSnapshot`, `migrateDag`, op-legality table (`VALID_OPS_BY_KIND`, `isValidOpForKind`), JSON schema assets | 25 (`validate.spec` 24 + `plan.spec` 1) | milestones `spec-types`, `spec-validate` DONE |
| `@adhd/dispatch-core-client` → `@adhd/dispatch-client` | `DagClient`/`createDagClient`, `IDagClient`/`IDagSerializer` seams, `getEligibleMilestones` | 32 | `client-core`, `client-fixes` DONE |
| `@adhd/dispatch-serializer-json` | `createJsonFileSerializer` (atomic file I/O), `normalizeDag` (legacy object→array migration) | 18 | `serializer-json` DONE |
| `@adhd/dispatch-core-optimizer` → `@adhd/dispatch-optimizer` | `snapshot`, `topoSortMilestones`, `optimize` (greedy packer), `computeTokensNaive`, size-tokens | 30 | `optimizer-core` DONE (greedy only; algorithm cascade NOT built) |
| `@adhd/dispatch-orchestrator` | `orchestrateCycle`/`orchestrate`, `pollUntilTerminal`, real `AgentMcpRunner` + `MockAgentRunner`, `POLL_TERMINAL_STATUSES`, `DEFAULT_B_PER_TIER`, `ICalibrationPlaceholder` | 38 | `orchestrator-core`, `agent-runner` DONE |
| `@adhd/dispatch-cli` (`entrypoint/dispatch-cli`) | 7 commands (validate/snapshot/optimize/eligible/status/run/calibrate) via hand-written `bin/cli.ts`; DI core seams; dry-run (Mock) vs `--no-dry-run` (paid) | 30 (core 18 + smoke 12) | `cli`, `tests-real-e2e` DONE |

**Fast-path value gate is MET for GENERATIVE dispatch:** a generative cycle runs end-to-end (MockAgentRunner default; live `DISPATCH_E2E_LIVE=1` gated). **Two headline gaps were audit-confirmed 2026-07-15 and are now being fixed DIRECTLY (separate code-fix executors, NOT this plan):**
- **BUG-DISPATCH-EXEC-001 — tool-call execution stub.** `dispatch-orchestrator/src/lib/orchestrator.ts:659-671` marks any tool-call op `skipped` ("`@adhd/dispatch-tools` is not wired into the minimal loop"). The direct fix wires real execution + builds the `@adhd/dispatch-tools` primitives.
- **BUG-DISPATCH-PUBLISH-001 — unshippable name mismatch.** 63 source imports of `@adhd/dispatch-spec`/`-client`/`-optimizer` resolve only via *duplicate* `tsconfig.base.json` aliases (154/163/172); packages publish under the standard `@adhd/dispatch-base-spec`/`-core-client`/`-core-optimizer`. The direct fix conforms imports to the standard names + drops the dup aliases.

These land as **preconditions**; `dispatch-completion` builds on them and plans no states for them (Phase 0 triage confirms they landed).

---

## C. Backlog reverify — items ALREADY FIXED since they were logged (ARCHIVE, do not re-do)

Live-source check 2026-07-15. These are the concrete evidence that the backlog *drifted* — the exact reason Phase 0 (triage) exists.

| Item | Was | Now (live) | Verdict |
|---|---|---|---|
| DEBT-DISPATCH-009 | `SentinelRole` lacks `'solo'` | `types.ts:85` = `'prewarm' \| 'payload' \| 'solo'` | **FIXED — archive** |
| DEBT-DISPATCH-010 | `SnapshotOptimization` lacks `tokens_naive` | `types.ts:579` `tokens_naive: number \| null` present; `computeTokensNaive` exported | **FIXED — archive** |
| DEBT-DISPATCH-021 | `dispatch-cli` omits `@modelcontextprotocol/sdk` | `entrypoint/dispatch-cli/package.json:7` declares `@modelcontextprotocol/sdk 1.29.0` | **FIXED — archive** |
| DEBT-DISPATCH-011 | Orphaned stub dirs `optimize/`,`snapshot/` + `compiler.ts` near-dup | Both dirs contain only `index.ts`; `compiler.ts` absent | **LIKELY FIXED — Phase 0 confirms + closes** |
| DEBT-DISPATCH-023 (half) | `pollUntilTerminal`/`POLL_TERMINAL_STATUSES` not exported | Both now exported from `@adhd/dispatch-orchestrator` | **HALF-FIXED** — remaining: delete the duplicates in `dispatch-cli/lib/core.ts` |
| BUG-DISPATCH-003 | client re-exports optimizer surface | Not present on branch (was audit-vs-diagram artifact) | **INVALID — archive** |

---

## D. Outstanding work — CARRIED FORWARD into `dispatch-completion`

### D.1 Deferred feature track (from `dispatch-production`, never ran)

| Milestone | Capability | New package? |
|---|---|---|
| `plugin-io` | IO enrichment: `fileSizes()`/`readFiles()` injected into optimizer | `@adhd/dispatch-plugin-io` (new) |
| `plugin-gitnexus` | blast-radius / AST enrichment pass between snapshot & optimize | `@adhd/dispatch-plugin-gitnexus` (new) |
| `serializer-sqlite` | SQLite `IDagSerializer` adapter | `@adhd/dispatch-serializer-sqlite` (new) |
| `tools-mcp` (authoring surface) | complete `@adhd/dispatch-tools`' dag-authoring tools over `DagClient` (`dag.milestone_add`/`pending_clear`). *If EXEC-001 shipped the full package, Phase 0 shrinks/drops this.* | `@adhd/dispatch-tools` |
| `orphan-delete` | delete the fully-orphaned `@adhd/dispatch-base-types` (0 consumers, audit-confirmed) if PUBLISH-001 didn't | remove `packages/dispatch/dispatch-base-types` |
| ~~tool-call execution wiring~~ | **OUT — BUG-DISPATCH-EXEC-001, fixed directly** | (not this plan) |
| ~~publish/name reconciliation~~ | **OUT — BUG-DISPATCH-PUBLISH-001, fixed directly** | (not this plan) |
| `optimizer-algorithms` | Bitmask DP / Tree DP / SA / HLFET cascade | extends `dispatch-core-optimizer` — **DATA-GATED** |
| `tests-golden` | golden snapshot/optimize fixtures | test-only |
| `tests-algorithms` | algorithm correctness suite | test-only (gated w/ optimizer-algorithms) |
| `stepwise-dispatch` | op-granular dispatch + `ForwardContext` A/B experiment | extends orchestrator (experiment) |
| `hardening-complete` | terminal / release readiness | — |

### D.2 Debt cluster (from `dispatch-backlog-fill` + BACKLOG DEBT-DISPATCH-*, live-confirmed still open)

| Item | Fix | Package(s) |
|---|---|---|
| DEBT-005 BL-102 | `ExecutionMode` discriminant + derive in `optimize()` (`execution_mode` **confirmed absent** in live spec) | spec, optimizer |
| DEBT-005 BL-103 | `snapshot_version` increment on write | optimizer |
| DEBT-005 BL-104 | `compilePrompt()` inline nested interface sub-shapes (`type_spec`) | spec, optimizer |
| DEBT-005 BL-105 | `mcp_servers` null → real catalog lookup (bypass works for claudecli; catalog unbuilt) | optimizer, orchestrator |
| DEBT-005 BL-106 | `b_per_tier` cold-start seeding (partly via `DEFAULT_B_PER_TIER` — confirm/finish) | orchestrator |
| DEBT-005 BL-107 | back-compat patches → `readDag()`/serializer (partly via `normalizeDag` — confirm/finish) | serializer |
| ~~DEBT-006~~ | **HANDED OFF — out of scope.** Per-turn `task_events` MCP tool touches agent-mcp; assigned to the agent-* work-stream. Stays a standalone BACKLOG item; this plan does not touch agent-mcp. | (not this plan) |
| DEBT-012 | `systemPrompt`/`prompt` split (double-token cost per dispatch) — prompt-compiler decision | spec, optimizer, orchestrator |
| DEBT-013 | D-07 `eligible` promotes own-completion into the spec definition | spec, client, optimizer |
| DEBT-014 | reject/clamp `Infinity` in per-tier B/context-window (JSON round-trip) | optimizer |
| DEBT-015 | per-unit error boundary in `orchestrateCycle` | orchestrator |
| DEBT-016 | route op-level `type:'automated'`/`action:'guard'` through the guard seam | orchestrator |
| DEBT-017 | `capOutput` cut on char boundary (cosmetic) | orchestrator |
| DEBT-018 | formalize `ICalibrationStore` in spec; replace `ICalibrationPlaceholder` | spec, orchestrator |
| DEBT-019 | extend `DispatchLogEntry.provider` enum (`claudecli`,`teammate`) + enforce in `validate.ts` | spec |
| DEBT-020 | causally-aware replan (rewire downstream `depends_on` after correction) | orchestrator |
| DEBT-022 | `dispatch-cli` `bin` field + esbuild `build-bin` target (npx-invocable) | dispatch-cli |
| DEBT-023 | delete `dispatch-cli` poll-internal duplicates (consume exported ones) | dispatch-cli |
| DEBT-024 | lazy runner factory into `calibrateCore` (tier validated before construct) | dispatch-cli |
| DEBT-025 | shared missing-dag-file guard across `*Core` fns | dispatch-cli |

### D.3 Cross-cutting / decisions to make in the demo gate

- **`dispatch-base-types`** is an unused Nx-generated placeholder stub — **DELETE** (decision to confirm at sign-off).
- **apigen-generated CLI** crashes on 5/7 commands (`$ref cannot be resolved in run-mode` — a transitive apigen/zod bug, tracked in `packages/apigen/BACKLOG.md`). The working shipped path is hand-written `bin/cli.ts`. **Decision:** keep hand-written as canonical; gate the generated-CLI fix behind the upstream apigen bug (out of this plan's scope, referenced).
- **DEBT-WORKSPACE-NX-INPUTS-001** is workspace-wide; only the **dispatch-package instances** are in this plan's scope. The broader sweep stays a separate workspace-enablement item.
- **No cross-plan collision surface.** With DEBT-006 handed off, every reserved path is under `packages/dispatch/**` or `entrypoint/dispatch-cli/**` — zero overlap with the concurrent `agent-*` work-stream.

### D.4 Data / external hold points (may legitimately defer)

1. **`optimizer-algorithms`** — unblock only when ≥3 real dispatch cycles record `tokens_actual` showing the greedy packer leaves **>15%** savings vs. the recorded naive baseline. If the gate is unmet, this phase stays **held/pending** and the plan can still reach terminal without it.
