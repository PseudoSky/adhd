# SCOPE — dispatch-completion

**Plan:** `dispatch-completion` · **Kind:** completion + hardening of a shipped subsystem
**Merged from:** dispatch-optimizer (PoC, superseded) + dispatch-production (deferred track) + dispatch-backlog-fill (debt specs). See `RECONCILIATION.md`.
**Executor tier:** mixed — spec/type changes and debt fixes are bounded (weak/mid tier, more pinning); new packages (plugins, tools-mcp, sqlite) and causal replan are strong-tier.

**Objective (one paragraph).** The `@adhd/dispatch-*` subsystem turns a `dag.json` plan into token-optimal parallel agent dispatch: `snapshot()` derives eligibility/waves/cost, `optimize()` packs eligible milestones into the cheapest `DispatchUnit[]`, and the orchestrator dispatches work to a real agent, guards it, and records the result. That planning/optimizing/serializing/CLI spine genuinely works today (all six packages build EXIT=0; dispatch-cli's 30 tests pass; the built CLI runs). Two load-bearing defects — tool-call execution being a `skipped` stub (`orchestrator.ts:668`) and the packages being unshippable under a name/import mismatch — are being fixed **directly** against `packages/dispatch/*` (BUG-DISPATCH-EXEC-001, BUG-DISPATCH-PUBLISH-001) and are **out of this plan's scope**; dispatch-completion builds on them as landed preconditions (Phase 0 confirms). **What dispatch-completion owns is the work that remains to take the subsystem from "core works" to "complete + hardened":** close the correctness edges (complete≠eligible, recorded-not-thrown failure, `execution_mode` discriminant, Infinity-safe round-trip, causal replan), light up the deferred feature track (file/blast-radius enrichment plugins, a SQLite storage adapter, the remaining MCP dag-authoring tools, an npx-invocable CLI, a data-gated algorithm cascade held until real cycles justify it), delete the orphaned `@adhd/dispatch-base-types`, and clear the remaining `DEBT-DISPATCH-*` cluster — without rebuilding one line of the shipped, tested code, and without touching agent-mcp.

---

## 1. Outcomes (observable end-state)

The `@adhd/dispatch-*` subsystem moves from *"generative dispatch proven, core edges rough, deferred track unbuilt"* to *"feature-complete + hardened over an executable, shippable core"*, provable by the outcomes below.

**Preconditions (delivered DIRECTLY, NOT this plan's scope):** the two headline defects are being fixed against `packages/dispatch/*` by separate code-fix executors — **BUG-DISPATCH-EXEC-001** (wire real tool-call execution; replaces the `skipped` stub at `orchestrator.ts:668` and builds the `@adhd/dispatch-tools` primitives it calls) and **BUG-DISPATCH-PUBLISH-001** (conform package-name↔import↔alias to the repo `<domain>-<tier>-<name>` standard; drop the duplicate short aliases; `npm pack`/install gate). This plan **builds on them as landed** and does not re-plan or re-verify them; Phase 0 triage confirms they landed before remaining work begins.

- **O1** — `nx run-many -t test,build -p dispatch-base-spec,dispatch-core-client,dispatch-core-optimizer,dispatch-orchestrator,dispatch-serializer-json,dispatch-serializer-sqlite,dispatch-plugin-io,dispatch-plugin-gitnexus,dispatch-tools,dispatch-cli` exits `0` (all green, all built).
- **O2** — every remaining DEBT-DISPATCH item in §D.2 of `RECONCILIATION.md` is either fixed-with-a-teeth-bearing test or explicitly closed with a live-source verdict in BACKLOG.md (no silent carry).
- **O3** — a `DispatchUnit` carries a non-null `execution_mode` discriminant; a `DagSnapshot` round-trips through `JSON.stringify`/`parse` with no `Infinity→null` corruption; a complete milestone reports `eligible:false` from the spec definition.
- **O4** — the orchestrator survives a runner/persist failure mid-cycle with a recorded `failed` `dispatch_log` entry (no uncaught throw, no silent forensic gap).
- **O5** — the `DispatchLogEntry.provider` enum is extended to the real providers and enforced by validation; `calibrate` rejects a bad model tier before constructing the paid runner. *(Per-turn `task_events` — former DEBT-006 — handed to the agent-\* stream; no agent-mcp touch.)*
- **O6** — `@adhd/dispatch-tools` exposes MCP tools that author a valid `dag.json` through `DagClient` (no raw-file writes); `@adhd/dispatch-serializer-sqlite` persists+reloads a dag identically to the JSON serializer (adapter parity). *(If EXEC-001 already delivered the full dispatch-tools surface, Phase 0 narrows this to the sqlite adapter + any authoring gap.)*
- **O7** — `dispatch` is npx-invocable (`bin` field + built `bin/`), and `dispatch run/calibrate/status` behave consistently on a missing dag file; the orphaned `dispatch-base-types` is deleted (if PUBLISH-001 didn't).
- **O8** — enrichment: `dispatch-plugin-io` (`fileSizes`/`readFiles`) and `dispatch-plugin-gitnexus` (blast-radius) inject real signal into the snapshot; optimizer stays pure with null deps.
- **O9 (data-gated)** — IF the greedy-vs-naive shortfall gate fires (>15% over ≥3 real cycles), the algorithm cascade ships and beats greedy on the golden fixtures; ELSE the phase is recorded held with the measured baseline.

## 2. Scope boundaries (explicit OUT-of-scope — the door is closed)

- **OUT (delivered directly)** — **BUG-DISPATCH-EXEC-001** (wiring real tool-call execution + the `@adhd/dispatch-tools` execution primitives) and **BUG-DISPATCH-PUBLISH-001** (package-name↔import↔alias conformance to the repo standard + `npm pack`/install gate). These are being fixed against `packages/dispatch/*` by separate code-fix executors; this plan treats them as landed preconditions (Phase 0 confirms) and plans no states for them.
- **OUT** — rebuilding, re-porting, or re-testing any package in §B of `RECONCILIATION.md` (all shipped + tested). Touch a shipped file only to apply a named DEBT fix.
- **OUT** — the general workspace-wide `DEBT-WORKSPACE-NX-INPUTS-001` sweep and `DEBT-WORKSPACE-VITE-PATHS-001`. Only the **dispatch-package instances** of the nx-inputs fix are in scope.
- **OUT** — fixing the apigen `$ref`-in-run-mode generator bug that breaks the *generated* CLI. Canonical CLI is the hand-written `bin/cli.ts`; the generated path stays referenced-and-deferred to `packages/apigen/BACKLOG.md`.
- **OUT** — **any** change to agent-mcp, the `agent-*` plan corpus/feature roadmap, or the `adhd-environment` plan. Former DEBT-006 (per-turn `task_events`) is handed to the agent-* work-stream; this plan touches no file under `entrypoint/agent-mcp` or `packages/agent/**`. Its removal also eliminates the only cross-plan file-reservation collision surface.
- **OUT** — replacing the execution layer with LangGraph (PoC README open question). The dispatch layer (snapshot/optimize/orchestrate over `agent-mcp`) is the shipped substrate; this plan completes it, it does not re-platform.
- **OUT** — publishing to npm. Version-bump + build + test to **release-ready** state; the actual `nx release publish` is a human-gated follow-on.

## 3. Constraints / assumptions

- **Nx monorepo.** Every executor works in a git worktree under `.worktrees/` (never the main checkout); symlink `node_modules` from the main checkout, never reinstall. Layer/platform tags are load-bearing: `dispatch-spec`=shared/shared (zero-dep), plugins/sqlite/tools/cli=node, optimizer/client=shared. A shared package must never import a node/logic/UI package (dependency purity).
- **nx cache is authoritative** — never `--skip-nx-cache`. Prove cache hits by running twice.
- **Repo package-naming standard is `<domain>-<tier>-<name>`** — verified repo-wide: `agent-base-types`, `agent-core-provider`, `apigen-base-schema`, `apigen-core-client`, `data-core-structures`, and `dispatch-base-spec`/`dispatch-core-client`/`dispatch-core-optimizer`. **The structured names ARE the standard**; role-only names without a tier word (`dispatch-orchestrator`, `dispatch-serializer-json`, `dispatch-cli`, cf. `agent-mcp`, `apigen-cli`, `environment-builder`) are also standard.
- **Import-name↔package-name conformance is a LANDED PRECONDITION (BUG-DISPATCH-PUBLISH-001), not this plan's work.** It conforms the 63 short-name imports to the standard names (`@adhd/dispatch-base-spec`/`-core-client`/`-core-optimizer`) and drops the duplicate `tsconfig.base.json` aliases. This plan assumes it has landed (Phase 0 verifies) and writes all new imports using the standard names.
- **New packages MUST follow the standard:** `dispatch-serializer-sqlite`, `dispatch-plugin-io`, `dispatch-plugin-gitnexus` conform (cf. `dispatch-serializer-json`, `apigen-plugin-*`). The dag-authoring tools package name is subject to the tier convention — propose `dispatch-core-tools` (data-tier wrapper over `DagClient`); confirm at authoring against the closest sibling (`agent-store-tools`).
- **Typecheck target exists** on the 5 shipped dispatch packages (`tsc --noEmit` via `tsconfig.lib.json`); new packages must add it (DEBT-WORKSPACE-TYPECHECK-001 pattern, already FIXED for the 5).
- **SOLUTIONS.md paths are stale** — its debt specs reference pre-rename `packages/shared/dispatch-*`; real locations are `packages/dispatch/dispatch-*` (+ `entrypoint/dispatch-cli`). Phase 0 emits the corrected target paths.
- **Live-LLM is the single gated exception** — the `run --no-dry-run` / `calibrate` / real-e2e S4 paths call a paid model; gated behind `DISPATCH_E2E_LIVE=1`, documented (owner: plan-builder) in README + CLAUDE.md + test header. Everything else runs by default with `MockAgentRunner` exercising the same code paths.

## 4. Prior decisions

- **P1 `non-negotiable`** — Serialization adapter pattern: `IDagSerializer` + factories; the client never knows where the dag lives. SQLite serializer must satisfy the identical `IDagSerializer` contract as JSON (adapter parity is the acceptance).
- **P2 `non-negotiable`** — `DagClient` is the single CRUD authority; `dispatch-tools` MCP tools wrap it, never write `dag.json` raw. Agents never read `dag.json` into context.
- **P3 `non-negotiable`** — Optimizer is pure computation with injected `IOptimizerDeps`; no I/O, graceful degradation when data sources are null. Plugins enrich post-hoc via injection.
- **P4 `non-negotiable`** — This plan touches **no** agent-mcp file. Every reserved path is under `packages/dispatch/**` or `entrypoint/dispatch-cli/**`, so there is zero cross-plan file-reservation overlap with the concurrent agent-* work-stream.
- **P5 `advisory`** — DEBT specs in `dispatch-backlog-fill/SOLUTIONS.md` are the reference implementations, but every one must be **re-verified against live source in Phase 0** before coding (six items already drifted to fixed — §C). Advisory, because a spec written against stale paths/state must not perpetuate a wrong assumption.
- **P6 `advisory`** — Spec-level fixes (DEBT-013 eligible, DEBT-018 ICalibrationStore, DEBT-019 provider enum, BL-102 ExecutionMode) land **before** their consumers so each downstream package inherits the guard rather than re-implementing it. Ordering is advisory but strongly preferred (reduces churn).
- **P7 `non-negotiable`** — `optimizer-algorithms` is data-gated: it ships **only** on ≥3 real cycles showing >15% greedy shortfall vs. recorded naive baseline. No speculative algorithm build.

## 5. Task breakdown (bounded units → proposed phases)

See `PLAN_STATE_MACHINE_PROPOSAL.md` for the full phase/state graph. Bounded units:

0. **Reconcile-triage** (audit-only): reverify every DEBT item + deferred milestone vs live source; archive fixed; confirm `dispatch-base-types` delete; emit authoritative outstanding list.
1. **Spec foundations** (dispatch-base-spec): ExecutionMode, type_spec nesting, D-07 eligible own-completion, ICalibrationStore, provider enum+validation, Infinity guard.
2. **Optimizer + client propagation**: wire execution_mode, snapshot_version, mcp_servers catalog, systemPrompt/prompt split, client eligibility, round-trip test.
3. **Orchestrator hardening**: error boundary, op-level guard routing, UTF-8 cap, calibration store impl, causal replan, delete cli poll dupes' upstream export.
4. **Enrichment plugins**: `dispatch-plugin-io`, `dispatch-plugin-gitnexus`.
5. **Storage adapter**: `dispatch-serializer-sqlite` (adapter parity with JSON); BL-107 back-compat confirm.
6. **MCP authoring tools**: complete `dispatch-tools`' dag-authoring surface (`dag.milestone_add`/`pending_clear` over `DagClient`). *Phase 0 narrows this: if EXEC-001 already shipped the full dispatch-tools package, this unit shrinks to any authoring-API gap or drops entirely.*
7. **CLI completion**: bin field + esbuild, lazy runner factory, missing-file guard, `dispatch-base-types` delete (if PUBLISH-001 didn't).
8. **Optimizer algorithms** (DATA-GATED / may hold): Bitmask DP / Tree DP / SA / HLFET + DEBT-011 final cleanup.
9. **Test hardening**: golden fixtures, algorithm suite, stepwise-dispatch A/B, dispatch-instance nx-inputs fix, real-e2e extension.
10. **Terminal**: version-bump + release-ready + BACKLOG reconciliation + portfolio links.

## 6. Verification criteria (each a concrete probe)

- **V0 (precondition check, Phase 0)** → confirm BUG-DISPATCH-EXEC-001 and BUG-DISPATCH-PUBLISH-001 have landed: a tool-call op runs to `complete` (not `skipped`), and `require('@adhd/dispatch-base-spec')` resolves with no duplicate short aliases. If not yet landed, Phase 0 halts and reports (this plan depends on them).
- **V1** → `nx run-many -t test,build -p <all 10 dispatch projects>` exit 0.
- **V2** → grep-proof: `ExecutionMode` exported from dispatch-spec; a unit-test asserts `assembleUnit()` sets `guard-only`/`tool-call`/`generative` correctly (test goes red if the derivation is reverted).
- **V3** → a JSON round-trip test on a snapshot built with a tier absent from deps fails before the fix, passes after (DEBT-014 teeth).
- **V4** → an orchestrator test injects a runner that throws mid-`fire()`; asserts a `failed` `dispatch_log` entry with an error note and no thrown exception (DEBT-015 teeth).
- **V5** → `validateDagJson` rejects an unknown `dispatch_log[].provider` and accepts the real `claudecli`/`teammate` values (DEBT-019 teeth); `calibrate` with a bad tier throws before the runner factory is called (DEBT-024).
- **V6** → author a 3-milestone dag via `dispatch-tools` MCP calls, then `validateDagJson` passes and the SQLite serializer reload equals the JSON serializer reload byte-for-byte on the normalized form (P1/P2 parity).
- **V7** → `npx @adhd/dispatch-cli status <plan>` runs from a clean install (bin resolves); `dispatch snapshot`/`status`/`run` on a missing dag file all return the same shaped error incl. the path (DEBT-025).
- **V8** → algorithm suite: on the golden fixtures, IF gate fired, cascade `optimize()` total tokens ≤ greedy total (strict on ≥1 fixture); ELSE a recorded `HELD` marker with the measured shortfall <15%.

---

## Pinned-vs-Resolve partition (efficient-context contract for executors)

| PIN in the work-order (verbatim) | LET the executor RESOLVE at dispatch time |
|---|---|
| The falsifiable acceptance signal per state (the V-probe above) | Current exact line numbers in `orchestrator.ts`/`types.ts` (they drift — resolve by grep at dispatch) |
| Architectural invariants: adapter pattern (P1), DagClient-sole-authority (P2), optimizer-purity (P3), no-agent-mcp-touch (P4) | The current file contents & signatures of the shipped packages (1-second read) |
| Import-alias↔package-name map; layer/platform tags per package | Which symbols a given edit ripples to (gitnexus impact at dispatch) |
| The DEBT item's *intent + teeth test*, NOT SOLUTIONS.md's stale code verbatim | The exact port of a SOLUTIONS.md snippet onto live paths/state (Phase 0 emits the corrected target) |
| Data gate for Phase 8 (>15% / ≥3 cycles) and the live-LLM env gate | Whether the gate is currently met (orchestrator reads `dispatch_log` at dispatch) |
| Worktree + `node_modules` symlink invariant (`_shared.md`) | Intermediate build/test outputs |

**Tier note:** debt fixes with a SOLUTIONS.md reference → pin the corrected snippet + teeth test (weak-tier safe). New packages (plugins/tools/sqlite) and causal replan → pin the interface contract + acceptance, let a strong executor own the how. Never pin a stale line number or a stale `packages/shared/` path.
