# TOOLS — dispatch-completion (capability catalog + build-vs-reuse)

**Status:** PROPOSED — awaiting sign-off with DEMO.md (GATE 2). `valid-as-of: 2026-07-15` (re-validate any interface contract older than one build cycle).

## 1. Capability list (verb-noun, no implementation assumption)

| # | Capability |
|---|---|
| C1 | validate a dag.json structure |
| C2 | derive a snapshot (eligibility, waves, overlap, ki) from a dag |
| C3 | pack eligible milestones into token-optimal DispatchUnits |
| C4 | persist/load a dag via a storage adapter |
| C5 | run one orchestration cycle (snapshot→optimize→fire→poll→record) |
| C6 | dispatch to a real agent over agent-mcp |
| C7 | author a dag through MCP tools (no raw file writes) |
| C8 | enrich a snapshot with real file sizes / shared bytes |
| C9 | enrich a snapshot with blast-radius / AST facts |
| C10 | ~~query per-turn model token usage~~ — REMOVED (former DEBT-006, handed to the agent-* stream; out of scope) |
| C11 | calibrate per-tier base cost B (formalize `ICalibrationStore`; cold-start seed) |
| C12 | expose the whole stack as an npx CLI |
| C13 | select an optimal packing algorithm by DAG structure/N |
| C14 | ~~execute a tool-call op~~ — **OUT (BUG-DISPATCH-EXEC-001, fixed directly)**; a landed precondition |
| C15 | ~~publishable package names~~ — **OUT (BUG-DISPATCH-PUBLISH-001, fixed directly)**; a landed precondition |

## 2. Existing inventory (precise identifiers + live evidence)

| Cap | Provider (live, tested) |
|---|---|
| C1 | `@adhd/dispatch-spec`: `validateDagJson`/`assertValidDagJson`, `VALID_OPS_BY_KIND` — 25 tests |
| C2 | `@adhd/dispatch-optimizer`: `snapshot`, `topoSortMilestones` — 30 tests |
| C3 | `@adhd/dispatch-optimizer`: `optimize` (greedy), `computeTokensNaive` — greedy only |
| C4 | `@adhd/dispatch-client`: `DagClient`/`IDagSerializer`; `@adhd/dispatch-serializer-json`: `createJsonFileSerializer`, `normalizeDag` — 32+18 tests |
| C5 | `@adhd/dispatch-orchestrator`: `orchestrateCycle`/`orchestrate`/`pollUntilTerminal`, `DEFAULT_B_PER_TIER`, `POLL_TERMINAL_STATUSES` — 38 tests |
| C6 | `@adhd/dispatch-orchestrator`: `AgentMcpRunner` (+ `MockAgentRunner` double) |
| C11 | `@adhd/dispatch-cli`: `calibrate`/`calibrateCore`; orchestrator `ICalibrationPlaceholder` (minimal) |
| C12 | `entrypoint/dispatch-cli`: hand-written `bin/cli.ts` (7 commands) — 30 tests. NO `bin` field; generated router broken 5/7. |
| C10 | n/a — removed from this plan's scope |
| C7,C8,C9,C13 | **NONE** — not built |
| C14 | delivered by BUG-DISPATCH-EXEC-001 (precondition; not this plan) |
| C15 | delivered by BUG-DISPATCH-PUBLISH-001 (precondition; not this plan) |

## 3. Gap analysis

- **Landed preconditions (fixed directly, NOT this plan):** C14 (tool-call execution — BUG-DISPATCH-EXEC-001), C15 (publish integrity — BUG-DISPATCH-PUBLISH-001).
- **No provider:** C7 (dag-authoring MCP tools — may be delivered by EXEC-001; Phase 0 confirms), C8 (IO enrichment), C9 (gitnexus enrichment), C13 (algorithm cascade).
- **Partial:** C3 (greedy only, cascade data-gated), C11 (`ICalibrationPlaceholder` only — formalize `ICalibrationStore` + cold-start seed), C12 (works via tsx, not npx-invocable; DEBT-022/024/025).
- **Covered but debt-laden:** C1/C2/C5 carry the spec/optimizer/orchestrator DEBT items (execution_mode, eligible, Infinity, error boundary, guard routing, replan).

## 4. Build-vs-reuse verdict per gap (ladder: reuse→extend→buy→build→prototype→hedge)

| Gap | Verdict | Rationale |
|---|---|---|
| C1/C2/C5 debt fixes | **extend/wrap** shipped packages | ~80%+ there; each fix is a named surgical change with a teeth test. Never rebuild. |
| C3 cascade (C13) | **build-with-hedge, DATA-GATED** | Differentiator (formal cost optimizer, PoC-designed) but on the critical value path only if greedy underperforms. Hedge = ship greedy, build cascade only when live data proves >15% shortfall (P7). |
| C4 SQLite adapter | **build** (thin) against reused `IDagSerializer` contract | Interface exists (P1); adapter is bounded new code with parity acceptance vs JSON serializer. |
| C14 tool-call execution | **OUT** — BUG-DISPATCH-EXEC-001 (fixed directly) | Landed precondition; not planned here. |
| C15 publish integrity | **OUT** — BUG-DISPATCH-PUBLISH-001 (fixed directly) | Landed precondition; not planned here. |
| C7 dag-authoring MCP tools | **build** on reused `DagClient` (unless EXEC-001 shipped it) | DagClient is the CRUD authority (P2); tools are a thin MCP wrapper. Phase 0 confirms whether EXEC-001's dispatch-tools build already covers this; if so, this drops. |
| C8 IO plugin | **build** (thin) | `fs.stat`/read behind the injected `IOptimizerDeps` seam; node platform. Small. |
| C9 gitnexus plugin | **extend/wrap** existing GitNexus MCP | Blast-radius/AST already provided by the repo's `gitnexus_impact`/`gitnexus_context` tools — wrap, don't reimplement AST analysis. |
| C11 calibration store | **build** `ICalibrationStore` in spec + impl | Formalize the interface (DEBT-018), replace `ICalibrationPlaceholder`, seed cold-start B (BL-106). No agent-mcp dependency. |
| C12 npx CLI | **extend** dispatch-cli | Add `bin` field + esbuild `build-bin` (decompile's `@nx/js:tsc` precedent); DEBT-024/025 fixes. |

**No external tooling to acquire.** All work reuses/extends internal `@adhd/dispatch-*` packages or wraps the existing GitNexus MCP surface (for C9). This plan touches no agent-mcp file. Memory recall (2026-07-15) surfaced no prior dispatch findings; no `workflow-researcher` dispatch warranted (internal-only reconciliation, SOLUTIONS.md carries the researched specs).

## 5. Interface contracts (executors consume; do NOT re-derive)

- **`IDagSerializer`** (reuse verbatim for SQLite): `{ readDag(): DagJson|null; writeDag(dag): void; readSnapshot(): DagSnapshot|null; writeSnapshot(s): void }`. Atomic writes; ENOENT→null. Parity acceptance: reload-equals-JSON on normalized form.
- **`IOptimizerDeps`** (plugins inject here): supplies `bPerTier`, `contextWindowPerTier` (all three ModelTier entries required — DEBT-014), plus optional `fileSizes`/`readFiles` (IO plugin) and enrichment hooks. Optimizer stays pure (P3).
- **`ExecutionMode`** (new spec type): `'generative' | 'tool-call' | 'guard-only'`; `DispatchUnit.execution_mode` non-null; derived in `assembleUnit()`.
- **`ICalibrationStore`** (new spec interface, DEBT-018): per-tier B get/put; replaces `ICalibrationPlaceholder`.
- **dispatch-tools MCP tools** (new): `dag.milestone_add`, `dag.pending_clear`, … each wrapping `DagClient`, enforcing referential integrity + D-07 eligibility; structured error on cycle/orphan.

## 6. Dependency graph (drives state ordering)

```
spec (C1, ExecutionMode, ICalibrationStore, provider-enum, eligible, Infinity)
  └─► optimizer (C2/C3: execution_mode wire, snapshot_version, mcp_servers, prompt-split, type_spec)
  └─► client (C4: eligibility inheritance)
        └─► orchestrator (C5/C6/C11: error boundary, guard routing, calibration store, causal replan)
              ├─► plugin-io (C8) ─┐
              ├─► plugin-gitnexus (C9, wraps GitNexus) ─┤► enrich snapshot
              ├─► serializer-sqlite (C4, reuses IDagSerializer)
              ├─► dispatch-tools (C7, reuses DagClient)
              └─► cli (C12: bin/esbuild, lazy factory, missing-file guard)
calibration store (C11: ICalibrationStore in spec + orchestrator impl + cold-start seed)
optimizer-algorithms (C13) — DATA-GATED, off critical path
```

## 7. Validation method (smoke/integration per tool, `valid-as-of: 2026-07-15`)

| Tool | Validation |
|---|---|
| spec/optimizer/client/orchestrator debt fixes | `nx test <project>` with a teeth test per fix (revert → red) |
| serializer-sqlite | cross-serializer equality test vs JSON |
| dispatch-tools | author-then-`validateDagJson`; cycle-rejection test |
| plugin-io / plugin-gitnexus | injection makes overlap/blast_radius non-zero; null-injection stays green |
| calibration store | `ICalibrationStore` replaces placeholder; cold-start seed feeds the optimizer; unit test |
| cli | `npx` spawn smoke (exit codes + payloads); missing-file consistency; bad-tier factory spy |
| algorithm cascade | golden-fixture token comparison (gated) |
| full suite | `nx run-many -t test,build -p <10 projects>` ×2, cache-hit proven |

Re-validate on every build cycle; refresh `valid-as-of` and re-confirm line-number-free contracts against live source at each dispatch (they drift — resolve at dispatch, per SCOPE partition).
