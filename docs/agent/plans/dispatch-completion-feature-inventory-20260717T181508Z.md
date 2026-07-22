# Dispatch Completion — Complete Raw Feature Inventory

**Extracted:** 2026-07-17T18:15:08Z  
**Source directory:** `docs/plan/agent-final/superseded/dispatch-completion/`  
**Purpose:** Features, data models, architectural decisions, and runtime agent execution concepts described by the dispatch-completion plan and its 3 superseded ancestors — *dispatch-optimizer* (PoC), *dispatch-production* (extraction plan), *dispatch-backlog-fill* (debt specs).  

> **What this is NOT.** This is NOT a re-statement of what already ships in `packages/dispatch/*`. It captures only what the plan describes as NEW, ADDITIONAL, or UNBUILT — the "delta" between today's shipped code and the plan's end state. If a feature was already shipped (e.g., `validateDagJson`, `snapshot()`, `orchestrateCycle` greedy packer), it is not re-listed here unless the plan describes a debt fix, extension, or behavioral change to it.

---

## Table of Contents

1. [New Interfaces, Types & Data Models](#1-new-interfaces-types--data-models)
2. [New Packages (3 Planned + 1 Extended)](#2-new-packages-3-planned--1-extended)
3. [Spec-Level Fixes & Extensions (dispatch-base-spec)](#3-spec-level-fixes--extensions-dispatch-base-spec)
4. [Optimizer & Client Changes (dispatch-core-optimizer, dispatch-core-client)](#4-optimizer--client-changes)
5. [Orchestrator Hardening & Causal Replan (dispatch-orchestrator)](#5-orchestrator-hardening--causal-replan)
6. [Enrichment Plugin Architecture](#6-enrichment-plugin-architecture)
7. [Storage — SQLite Serializer Adapter](#7-storage--sqlite-serializer-adapter)
8. [MCP Dag-Authoring Tools (dispatch-tools)](#8-mcp-dag-authoring-tools-dispatch-tools)
9. [CLI Completion & Distribution](#9-cli-completion--distribution)
10. [Algorithm Cascade (Data-Gated)](#10-algorithm-cascade-data-gated)
11. [Stepwise Dispatch A/B Experiment](#11-stepwise-dispatch-ab-experiment)
12. [Runtime Agent Execution Concepts](#12-runtime-agent-execution-concepts)
13. [Live E2E Testing Against Real Model](#13-live-e2e-testing-against-real-model)
14. [Audit, Gate & State-Machine Infrastructure](#14-audit-gate--state-machine-infrastructure)
15. [Precondition Defects (BUG-DISPATCH-EXEC-001, BUG-DISPATCH-PUBLISH-001)](#15-precondition-defects)
16. [Architectural Decisions & Invariants](#16-architectural-decisions--invariants)
17. [DEBT-DISPATCH-006 — Handed Off (not in plan scope)](#17-debt-dispatch-006--handed-off)
18. [Sample Plan dag.json Structure (schema_version 4)](#18-sample-plan-dag-json-structure)

---

## 1. New Interfaces, Types & Data Models

### 1.1 ExecutionMode
- **Source:** `contexts/spec-foundations.md`, `USE_CASES.md` #4–#10, `TOOLS.md §5`, `SOLUTIONS.md §1.1`
- **Type:** `'generative' | 'tool-call' | 'guard-only'`
- **New field on `DispatchUnit`:** `execution_mode: ExecutionMode` — non-null, always set
- **Derivation rule in `assembleUnit()`:** All ops `tool-call` → `'tool-call'`; zero ops total → `'guard-only'`; any generative op → `'generative'`. Mix of `tool-call` and `automated` with no generative → `'tool-call'`.
- **Status:** UNBUILT — DEBT-DISPATCH-005 BL-102

### 1.2 ICalibrationStore (replaces ICalibrationPlaceholder)
- **Source:** `contexts/spec-foundations.md`, `SOLUTIONS.md §5`, `TOOLS.md §5`
- **New interface in `@adhd/dispatch-spec`:**
  ```typescript
  interface ICalibrationStore {
    readAll(): Promise<CalibrationEntry[]> | CalibrationEntry[];
    read(tier: ModelTier): Promise<CalibrationEntry | null> | CalibrationEntry | null;
    write(tier: ModelTier, entry: CalibrationEntry): Promise<void> | void;
  }
  ```
- **`CalibrationEntry`:** `{ tier, b_tokens (number), measured_at (string), sample_count (number), std_dev (number | null) }`
- **Convenience fn:** `calibrationEntriesToRecord(entries) → Partial<Record<ModelTier, number>>`
- **Cold-start defaults:** Haiku:8000, Sonnet:15000, Opus:27000
- **Status:** UNBUILT — DEBT-DISPATCH-018

### 1.3 DispatchLogEntry.provider — Extended Enum
- **Source:** `USE_CASES.md` #7, `contexts/spec-foundations.md`, `RECONCILIATION.md` D.2
- **Adds:** `'claudecli'` and `'teammate'` to the provider union
- **Enforcement:** `validateDagJson` rejects unknown provider values
- **Status:** UNBUILT — DEBT-DISPATCH-019

### 1.4 TypeSpecEntry (Nested sub-shapes for compilePrompt)
- **Source:** `SOLUTIONS.md §1.3`
- **New type:**
  ```typescript
  interface TypeSpecEntry {
    field: string;
    type: string;
    sub_fields?: TypeSpecEntry[];
    description?: string;
  }
  ```
- **New optional field on `OperationDag`:** `type_spec: TypeSpecEntry[] | null`
- **compilePrompt behavior:** when `type_spec` is non-null, append recursive indented block to prompt
- **Status:** UNBUILT — DEBT-DISPATCH-005 BL-104

### 1.5 ReplanNote
- **Source:** `SOLUTIONS.md §6`
- **New type:**
  ```typescript
  interface ReplanNote {
    triggered_by_dispatch: string;
    failed_milestone: string;
    rewired_downstream: string[];
    correction_slug: string;
    injected_at: string;
  }
  ```
- **Also adds `pending_reason: 'replan-required' | null` to `MilestoneDag`**
- **Also adds `'replan'` to `DispatchKind` union** (was `'planning' | 'execution'`)
- **Status:** UNBUILT — DEBT-DISPATCH-020

### 1.6 system_prompt / task_prompt Split on DispatchUnit
- **Source:** `SOLUTIONS.md §3`, `USE_CASES.md` #13
- **New fields on `DispatchUnit`:**
  - `system_prompt: string | null` — role + guard rules + file context (~800 tokens)
  - `task_prompt: string | null` — milestone descriptions + ops + shapes (~5200 tokens)
- **Deprecated:** `prompt: string | null` — still populated for backward compat
- **Status:** UNBUILT — DEBT-DISPATCH-012

### 1.7 MilestoneDag.mcp_servers + DagJson.mcp_server_defaults
- **Source:** `SOLUTIONS.md §1.4`
- **New field on `MilestoneDag`:** `mcp_servers: Record<string, Record<string, unknown>> | null`
- **New field on `DagJson`:** `mcp_server_defaults: Record<string, Record<string, unknown>> | null`
- **Resolution in `assembleUnit()`:** milestone-level overrides global defaults, merged union
- **Status:** UNBUILT — DEBT-DISPATCH-005 BL-105

### 1.8 PatchDag Function (Backward Compat)
- **Source:** `SOLUTIONS.md §1.6`
- **New function:** `patchDag(dag: DagJson): DagJson` that applies 6 default patches:
  - Defaults missing `type` on ops to `'generative'`
  - Defaults missing `providers` to `{}`
  - Defaults missing `effort_max_tokens` to `{}`
  - Defaults missing `optimization.b_per_tier` to `{}`
  - Defaults missing `optimization.context_window_per_tier` to `{}`
  - Defaults missing `optimization.sentinel_fanout` to `{ enabled: false, ... }`
- **Wired into `readDag()`** in IO layer (not in run.ts)
- **Status:** UNBUILT — DEBT-DISPATCH-005 BL-107

---

## 2. New Packages (3 Planned + 1 Extended)

### 2.1 @adhd/dispatch-plugin-io (NEW)
- **Source:** `RECONCILIATION.md D.1`, `contexts/plugin-io.md`, `dag.json` (node:plugin-io phase)
- **Type:** Node platform, plugin tier
- **Exports:**
  - `createIOPlugin(rootDir) → { fileSizes, readFiles, siBytesAsTokens }`
  - `siBytesAsTokens(bytes, filePath?) → number` — chars_per_token lookup
- **Purpose:** Provides real file sizes and file reads via `fs.stat`/`fs.readFileSync`, injected into `IOptimizerDeps` to make `pairwise_overlap` reflect real shared source bytes
- **Degradation:** When plugin absent, `optimize()` still returns valid units (optimizer purity)
- **Status:** NOT SCAFFOLDED — planned for dispatch-completion

### 2.2 @adhd/dispatch-plugin-gitnexus (NEW)
- **Source:** `RECONCILIATION.md D.1`, `contexts/plugin-gitnexus.md`, `dag.json` (node:plugin-gitnexus)
- **Type:** Node platform, plugin tier
- **Exports:** `enrichWithGitnexus(snapshot: DagSnapshot, repoRoot: string): DagSnapshot`
- **Purpose:** Blast-radius/AST enrichment pass between `snapshot()` and `optimize()` via existing GitNexus MCP (`gitnexus_impact`/`gitnexus_context`)
- **Populates:** `blast_radius`, `from`/`breaking`/`severity`, `conflict` on ops
- **Key constraint:** Reuse existing GitNexus MCP — do NOT reimplement AST analysis
- **Status:** NOT SCAFFOLDED — planned for dispatch-completion

### 2.3 @adhd/dispatch-serializer-sqlite (NEW)
- **Source:** `RECONCILIATION.md D.1`, `contexts/serializer-sqlite.md`, `dag.json` (node:storage)
- **Type:** Node platform
- **Exports:** `createSqliteSerializer(db: BetterSQLite3Database): IDagSerializer`
- **Purpose:** Implements same `IDagSerializer` contract as JSON serializer; stores dag.json as JSON blob in single-row table; transactional appendDispatchLog
- **Acceptance:** Adapter parity — reload from SQLite equals reload from JSON on normalized form
- **Status:** NOT SCAFFOLDED — planned for dispatch-completion

### 2.4 @adhd/dispatch-tools (EXTENDS existing package)
- **Source:** `RECONCILIATION.md D.1`, `contexts/dispatch-tools.md`, `dag.json` (node:tools)
- **What's new:** MCP dag-authoring tools wrapping `DagClient`:
  - `dag.milestone_add`/`get`/`list`/`update`/`delete`
  - `dag.operation_add`/`get`/`list`/`update`/`delete`
  - `dag.pending_get`/`set`/`clear`
  - `dag.field_get`/`set`
  - `dag.dispatch_log_append`/`get`/`list`
  - `dag.snapshot` (read-only summary)
  - `dag.validate` (structural)
- **Safety invariants:** No `full_dag()` exposed to agents; validates after every mutation; atomic writes via serializer; every mutation appends `dispatch_log` note
- **Cycle detection:** Cycle-forming `milestone_add` is rejected (referential-integrity guard)
- **Phase-0-gated:** May be fully delivered by BUG-DISPATCH-EXEC-001; if so, remaining work narrows or drops

---

## 3. Spec-Level Fixes & Extensions (dispatch-base-spec)

### 3.1 Own-Completion in D-07 `eligible` Definition (DEBT-DISPATCH-013)
- **Source:** `USE_CASES.md` #5, `SOLUTIONS.md §4`
- **Change:** `eligible` formula adds `notAlreadyComplete`: status must not be `'complete'`, `'skipped'`, or `'failed'`
- **Before:** `eligible = pending === null && allDepsComplete && noDepFailed`
- **After:** `eligible = pending === null && notAlreadyComplete && allDepsComplete && noDepFailed`
- **Rationale:** A completed milestone stays `eligible: true` forever under current D-07; this makes all consumers inherit the guard
- **Also affects:** `DagClient.getEligibleMilestones()` — update doc comment to reference new spec definition
- **Status:** UNBUILT

### 3.2 Infinity Guard on Snapshot Round-Trip (DEBT-DISPATCH-014)
- **Source:** `SCOPE.md V3`, `USE_CASES.md` #6
- **Problem:** `Infinity` in per-tier B/context-window becomes `null` after `JSON.parse(JSON.stringify(snapshot))`
- **Fix:** Reject or clamp absent/finite tiers at `snapshot()` entry; round-trip test asserts all fields stay finite
- **Status:** UNBUILT

---

## 4. Optimizer & Client Changes

### 4.1 snapshot_version Increment on Write (DEBT-DISPATCH-005 BL-103)
- **Source:** `SOLUTIONS.md §1.2`
- **Change:** `snapshot()` gains optional `options?: { previousSnapshotVersion?: number }` parameter
- When provided → increment by 1; when absent → start at 1
- No interface change — `DagSnapshot.snapshot_version: number` already exists
- **Status:** UNBUILT

### 4.2 execution_mode Wire in optimize() (DEBT-DISPATCH-005 BL-102)
- **Source:** `SOLUTIONS.md §1.1`
- **Change:** `assembleUnit()` derives `execution_mode` from packed ops
- Tokens newly handled: Mix of `tool-call` and `automated` with no `generative` → `'tool-call'`
- **Status:** UNBUILT

### 4.3 compilePrompt Type Spec Inlining (DEBT-DISPATCH-005 BL-104)
- **Source:** `SOLUTIONS.md §1.3`
- **Change:** After rendering op's action and file/symbol, if `type_spec` is non-null, append indented recursive listing of nested sub-shapes
- **Status:** UNBUILT

### 4.4 mcp_servers Resolution from Catalog (DEBT-DISPATCH-005 BL-105)
- **Source:** `SOLUTIONS.md §1.4`
- **Change:** `assembleUnit()` unions per-milestone `mcp_servers` over global `mcp_server_defaults`
- `AgentMcpRunner.ensureAgent()` uses `unit.mcp_servers` instead of `mcpServers: {}` bypass
- **Status:** UNBUILT

### 4.5 systemPrompt/prompt Split in compilePrompt (DEBT-DISPATCH-012)
- **Source:** `SOLUTIONS.md §3`
- **Change:** Split `compilePrompt()` into `compileSystemPrompt()` and `compileTaskPrompt()`
- `compileSystemPrompt()`: role statement, guard command rules, file context (~800 tokens); returns null for tool-call/guard-only units
- `compileTaskPrompt()`: milestone descriptions + operations + shapes (~5200 tokens); returns null for tool-call/guard-only units
- `assembleUnit()` calls both, populates `system_prompt` and `task_prompt`; backward compat `prompt` = joined
- **Status:** UNBUILT

### 4.6 Client Eligibility Inheritance (DEBT-DISPATCH-013 client side)
- **Source:** `SOLUTIONS.md §4`
- **Change:** `DagClient.getEligibleMilestones()` references the updated D-07 own-completion definition. Already includes `isMilestoneComplete()` check — add comment linking to spec.
- **Status:** UNBUILT (documentation only)

---

## 5. Orchestrator Hardening & Causal Replan

### 5.1 Per-Unit Error Boundary (DEBT-DISPATCH-015)
- **Source:** `USE_CASES.md` #14, `contexts/orchestrator-harden.md`
- **Change:** `orchestrateCycle` wraps each unit dispatch in try/catch; a runner that rejects mid-cycle produces a `dispatch_log` entry with `status:'failed'` + error note; `orchestrateCycle` returns normally (no uncaught throw)
- **Teeth:** Remove the try/catch → uncaught rejection makes test go red
- **Status:** UNBUILT

### 5.2 Op-Level Guard Routing (DEBT-DISPATCH-016)
- **Source:** `USE_CASES.md` #15, `DEMO.md` 5.4
- **Current problem:** Orchestrator never reads `op.guard`/`op.type`/`op.action` — an op with `type:'automated'` and `action:'guard'` is silently skipped
- **Change:** Route op-level `type:'automated'`/`action:'guard'` through `GuardExecFn` so the guard command actually executes
- **Status:** UNBUILT

### 5.3 UTF-8 Boundary capOutput (DEBT-DISPATCH-017)
- **Source:** `USE_CASES.md` #16
- **Problem:** `capOutput` may truncate mid-multi-byte character, producing replacement glyph
- **Change:** Cut on a character boundary, not byte boundary — truncated output is valid UTF-8
- **Status:** UNBUILT

### 5.4 Replace ICalibrationPlaceholder (DEBT-DISPATCH-018 impl)
- **Source:** `USE_CASES.md` #8, `SOLUTIONS.md §5`
- **Change:** Remove `ICalibrationPlaceholder` from orchestrator; import `ICalibrationStore` from spec; add `resolveCalibrationB()` that merges calibration data into `bPerTier`
- Calibrated values take priority over cold-start defaults
- **Status:** UNBUILT

### 5.5 Seed b_per_tier Cold-Start (DEBT-DISPATCH-005 BL-106)
- **Source:** `SOLUTIONS.md §1.5`
- **Change:** Guarantee `bPerTier` is always truthy before constructing `IOptimizerDeps` (already done via `resolveDeps()` but formalize)
- **Status:** PARTIALLY LANDED — verify/finish

### 5.6 Causal-Aware Replan (DEBT-DISPATCH-020)
- **Source:** `USE_CASES.md` #17, `SOLUTIONS.md §6`, `DEMO.md` §4 climax
- **Problem:** `injectCorrectionMilestone()` copies failed milestone's `depends_on` verbatim; downstream milestones never see correction
- **Change:**
  1. `injectCausalCorrectionMilestone()` wires correction depends_on from failed milestone's OWN deps (not the failed slug itself)
  2. Marks failed milestone as `pending: 'replan-required'`
  3. Returns `ReplanNote` with `rewired_downstream` array
  4. Downstream `depends_on` rewired to correction
  5. `deriveMilestoneStatus()` recognizes `pending: 'replan-required'` → returns `'pending-surfaced'`
- **Teeth:** Revert rewire → resume ends `no-eligible-work`, test goes red
- **Status:** UNBUILT

---

## 6. Enrichment Plugin Architecture

### 6.1 IO Plugin (@adhd/dispatch-plugin-io)
- **Source:** `TOOLS.md §4`, `contexts/plugin-io.md`, `dag.json` plugin-io milestone
- **Described above in §2.1.** Architecture pattern: plugin supplies `fileSizes`/`readFiles` to `IOptimizerDeps` injection seam.

### 6.2 Gitnexus Plugin (@adhd/dispatch-plugin-gitnexus)
- **Source:** `TOOLS.md §4`, `contexts/plugin-gitnexus.md`
- **Described above in §2.2.** Architecture pattern: enrichment pass runs post-snapshot, pre-optimize in the orchestrator pipeline. Wraps existing GitNexus MCP — never reimplements AST.

### 6.3 Plugin Degradation Guarantee
- **Source:** `SCOPE.md P3`
- Both plugins degrade gracefully: with null injection, `optimize()` still produces valid `DispatchUnit[]`. The optimizer is pure computation — pluggable enrichment.

---

## 7. Storage — SQLite Serializer Adapter

- **Source:** `contexts/serializer-sqlite.md`, `dag.json` serializer-sqlite milestone
- **Package:** `@adhd/dispatch-serializer-sqlite` (new)
- **Created above in §2.3.**
- **Key acceptance (P1):** Adapter parity — reload from SQLite equals reload from JSON on normalized form
- **Closes:** DEBT-DISPATCH-005 BL-107 (back-compat load confirmed in `normalizeDag`, not `run.ts`)

---

## 8. MCP Dag-Authoring Tools (dispatch-tools)

- **Source:** `TOOLS.md §5`, `contexts/dispatch-tools.md`, `dag.json` tools-mcp milestone
- **Described above in §2.4.**
- **Architecture invariant (P2):** `DagClient` is the single CRUD authority; tools wrap `DagClient`, never write `dag.json` raw. Agents never read `dag.json` into context.
- **Flag shape:** `dag.milestone_add` with `--slug`, `--depends-on`, `--and-make` (from DEMO.md 5.3 shape)

---

## 9. CLI Completion & Distribution

### 9.1 bin Field + esbuild build-bin Target (DEBT-DISPATCH-022)
- **Source:** `SOLUTIONS.md §7`, `contexts/cli-complete.md`
- **Changes:**
  - Add `"bin": { "dispatch-cli": "./bin/cli.js" }` to `entrypoint/dispatch-cli/package.json`
  - Add `build-bin` target in `project.json` using `@nx/js:tsc` or esbuild to compile `bin/cli.ts` to JS
  - Shebang `#!/usr/bin/env node` preserved by TypeScript compiler
- **Status:** UNBUILT

### 9.2 Delete CLI Poll-Internal Duplicates (DEBT-DISPATCH-023)
- **Source:** `RECONCILIATION.md C`, `contexts/cli-complete.md`
- **Problem:** `dispatch-cli/lib/core.ts` has local copies of `POLL_TERMINAL_STATUSES` and `pollUntilTerminal`
- **Fix:** Delete copies, consume exported versions from `@adhd/dispatch-orchestrator`
- **Status:** UNBUILT

### 9.3 Lazy Runner Factory in calibrateCore (DEBT-DISPATCH-024)
- **Source:** `USE_CASES.md` #29, `SCOPE.md V5`
- **Change:** Thread a lazy runner factory into `calibrateCore`; tier is validated before the factory is called. A bad tier never constructs an `AgentMcpRunner`.
- **Status:** UNBUILT

### 9.4 Shared Missing-Dag-File Guard (DEBT-DISPATCH-025)
- **Source:** `USE_CASES.md` #28, `DEMO.md` 5.2
- **Problem:** Only `validateCore` guards gracefully against missing dag file; `snapshot`/`status`/`run` surface generic pathless error
- **Change:** Extract shared guard into a helper all `*Core` fns call; consistent error shape across all four commands includes the missing path
- **Status:** UNBUILT

### 9.5 Delete Orphan dispatch-base-types (dod.12)
- **Source:** `RECONCILIATION.md D.3`, `contexts/cli-complete.md`
- **Action:** Delete `packages/dispatch/dispatch-base-types/` — confirmed orphaned (0 importers)
- **Status:** CONFIRMED ORPHANED, pending deletion

### 9.6 Keep Hand-Written CLI Canonical
- **Source:** `SCOPE.md §2` (OUT)
- **Decision:** The apigen-generated CLI crashes on 5/7 commands (`$ref` in run-mode bug). The hand-written `bin/cli.ts` is canonical. The generated-CLI fix is deferred to `packages/apigen/BACKLOG.md`.

---

## 10. Algorithm Cascade (Data-Gated)

### 10.1 Four Packing Algorithms
- **Source:** `SCOPE.md O9`, `dag.json` optimizer-algorithms milestone, `contexts/optimizer-algorithms.md`
- **Algorithms (from PoC):**
  - **Bitmask DP:** exact `O(3^N)` subset DP — fires at N ≤ 20
  - **Tree DP:** exact `O(N²W)` bottom-up — fires for forest/SP DAGs
  - **Simulated Annealing:** SA with cooling schedule — fires for general DAG N ≤ 50
  - **HLFET:** critical-path priority list `O(N log N)` — fires for N > 50
- **Structure detection:** `isForest()`, `isSeriesParallel()` (Valdes-Tarjan-Lawler SP reduction)
- **Status:** DATA-GATED — not built

### 10.2 Data Gate (P7)
- **Unblock condition:** ≥3 real dispatch cycles show >15% greedy shortfall vs recorded naive baseline
- **If unmet:** Write `HELD` marker with measured baseline; plan reaches terminal without algorithm cascade
- **No speculative algorithm build** — this is locked (P7 non-negotiable)

---

## 11. Stepwise Dispatch A/B Experiment

- **Source:** `dag.json` stepwise-dispatch milestone, `PRODUCTION_README.md`
- **Concept:** Op-granular dispatch — one operation per ephemeral task instead of packing into a single conversation
- **Key mechanism:** Agent ends each completion report with a fenced-JSON `ForwardContext` block (`{ completed_op, artifacts, exports, decisions, warnings }`, ≤2000 chars)
- Runner persists `ForwardContext` to `dispatch_log`, injects into next step's prompt as "PRIOR STEP CONTEXT"
- **A/B experiment:** Run spec-types sandbox in both packed and stepwise modes against same agent; record sent/paid tokens; assert artifact equivalence; write raw usage to `tmp/dispatch/stepwise-ab/`
- **Success criterion:** Stepwise total sent tokens strictly below packed baseline AND forward context demonstrably threaded
- **Negative result:** Record as packing input, not a default
- **Contract:**
  - `DispatchUnit` gains `execution_mode: 'packed' | 'stepwise'` (default `'packed'`)
  - Stepwise runner truncates oversize `ForwardContext` + records warn note
  - Per-step tokens recorded from aggregate usage as usual
- **Status:** NOT BUILT — strong-tier work

---

## 12. Runtime Agent Execution Concepts

### 12.1 AgentMcpRunner (IDispatchAgentRunner)
- **Source:** `dag.json` agent-runner milestone, `RECONCILIATION.md B`
- **Interface:**
  ```typescript
  interface IDispatchAgentRunner {
    fire(unit: DispatchUnit): Promise<{ taskId: string }>;
    poll(taskId: string): Promise<TaskResult>;
    cancel(taskId: string): Promise<void>;
    ensureAgent(unit: DispatchUnit): Promise<void>;
  }
  ```
- **Real implementation (`AgentMcpRunner`):** Calls agent-mcp MCP tools as a host:
  - `ensureAgent` = `agent_read` → `agent_create` on `AGENT_NOT_FOUND` with `{ name: unit.agent_name, provider: 'claudecli', systemPrompt, mcpServers: {} }`
  - `fire` = `task` tool in ephemeral mode `{ agent_name, prompt }`
  - `poll` = `result` tool `{ task_id }`
- **Token recording constraint:** agent-mcp exposes only aggregate usage (`TaskUsageReport.direct` — `inputTokens`, `outputTokens`, `modelCalls`, `toolCallCount`, `latencyMs`). The runner synthesizes a SINGLE `turns[]` entry. Per-turn breakdown is NOT available on MCP surface — MUST NOT be assumed.
- **MockAgentRunner:** Implements same interface for test scenarios; writes compiled prompt to `tmp/test-e2e/debug/` for human inspection

### 12.2 Orchestrator Pipeline
- **Source:** `dag.json` orchestrator-core, `PRODUCTION_README.md`
- **Fixed pipeline (each step with DI):**
  1. Load dag via `IDagSerializer`
  2. `snapshot(dag, deps)` → `DagSnapshot`
  3. Enrich (optional plugins: IO, gitnexus)
  4. `optimize(snapshot, deps)` → `DispatchUnit[]`
  5. For each unit: `runner.ensureAgent` → `runner.fire` → poll with bounded deadline
  6. Run milestone guard (shell exec, record guard_result + guard_output)
  7. Append `dispatch_log` entry (turns synthesized from aggregate usage)
  8. Persist dag
  9. Replan injection (guard failure → correction milestone)
  10. Multi-cycle via `orchestrate()` AsyncIterable
- **OrchestratorDeps interface:** `{ client, optimizer: {snapshot, optimize}, runner, plugins?: {io?, gitnexus?}, calibration?: ICalibrationStore }` — all plugins/calibration optional, undefined-safe

### 12.3 Tool-Call Execution (BUG-DISPATCH-EXEC-001)
- **Source:** `RECONCILIATION.md B`, `SCOPE.md §Preconditions`
- **Problem:** `dispatch-orchestrator/src/lib/orchestrator.ts:659-671` marks any tool-call op as `skipped` with `("is not wired into the minimal loop")`
- **Fix (DIRECT, not plan scope):** Wire real tool-call execution + build `@adhd/dispatch-tools` execution primitives
- **Status:** IN PROGRESS — separate executor; plan depends on it as landed precondition

### 12.4 Resumption from dispatch_log
- **Source:** `dag.json` orchestrator-core, `contexts/tests-real-e2e.md` Scenario 8
- Orchestrator reads `dispatch_log` to skip completed milestones on restart/crash recovery
- `orchestrate()` (AsyncIterable) cycles until terminal; resumption does not redispatch completed work

---

## 13. Live E2E Testing Against Real Model

### 13.1 Structural Test (default-running, unflagged)
- **Source:** `contexts/live-e2e.md`, `criteria.json` live-e2e.1
- Spawns real `agent-mcp` subprocess, performs MCP stdio `initialize` + `tools/list` handshake
- No paid model call
- FAILS LOUDLY if `agent-mcp` artifact/`python3` prereq is missing
- **Status:** IN PROGRESS (separate executor)

### 13.2 Paid Live Test (env-gated)
- **Source:** `contexts/live-e2e.md`, `criteria.json` live-e2e.2, `human-blockers.json`
- **Gate:** `AGENT_MCP_LIVE=1` + `DEEPSEEK_API_KEY` provisioned (the one legitimate live-test exception — a paid third-party model)
- Drives `dispatch run --no-dry-run` through real `AgentMcpRunner` → `npx -y @adhd/agent-mcp` → deepseek-chat
- Asserts: persisted `dispatch_log` has completed result with tokens > 0; new deepseek task in agent-mcp usage
- Self-skips with VISIBLE warning when `AGENT_MCP_LIVE` unset
- **Human blocker:** `deepseek-api-key` — must be exported before execution
- **Status:** IN PROGRESS — finalizing `entrypoint/dispatch-cli/src/test/integration/real-e2e.ts`

### 13.3 8-Scenario E2E Suite
- **Source:** `dag.json` tests-real-e2e milestone, `contexts/tests-real-e2e.md`
- Eight sequential scenarios from the `dispatch-production` plan:
  1. Cold start: empty dir → `dispatch init` creates skeleton
  2. Author plan via DagClient: 3 milestones, 5 ops, validate
  3. Snapshot + optimize: 1 DispatchUnit, prompt non-null, tokens_est > 0
  4. **LIVE GATED:** Real dispatch via agent-mcp Haiku
  5. Second cycle: next milestone eligible
  6. Guard failure → correction injection
  7. Correction resolves → retry succeeds
  8. CLI resume mid-cycle + calibration

---

## 14. Audit, Gate & State-Machine Infrastructure

### 14.1 audit_dispatch-completion.py
- **Source:** `scripts/audit_dispatch-completion.py`
- Python3 audit driver that runs all definition-of-done checks
- `--phase dod` runs 14 behavioral/structural checks (dod.1–dod.14)
- `--phase <other>` delegates to `run-audit.js` with phase-specific criteria
- Each behavioral check drives `nx test <project>` and gates on exit code (never stdout scraping)

### 14.2 run-audit.js (vendored declarative criteria runner)
- **Source:** `scripts/run-audit.js`
- Reads `criteria.json`, runs criteria per `kind`:
  - `absent`/`present`: grep for pattern in paths
  - `exists`: file existence check
  - `command`: shell command, expect exit0 or marker
  - `negative-control`: positive → mutate → assert positive now FAILS → restore
  - `custom`: node script
- Fail-closed: zero criteria selected → non-zero exit
- Marker channel isolation: child output captured but NEVER parsed for PASS/FAIL markers

### 14.3 criteria.json
- **Source:** `scripts/criteria.json`
- 25 criteria across all 11 phases, each with `id`, `phase`, `kind`, `expect`
- Covers triage V0 preconditions, spec exports, optimizer+client build, orchestrator, plugins existence, sqlite, tools, cli, algorithms, tests, release build, live-e2e
- Example criteria: `triage.1` = grep for "is not wired into" absent from orchestrator.ts; `spec-foundations.2` = `ExecutionMode` present in types.ts

### 14.4 skill-version.json
- **Source:** `scripts/skill-version.json`
- Records the `plan-state-machine` skill version that authored this plan: `workflow@0.8.29+836ff34f0a74`

### 14.5 State Machine Architecture (dag.json + state.json)
- **Source:** `PLAN_STATE_MACHINE_PROPOSAL.md`, `dag.json`, `state.json`
- **24 nodes** (17 work states + 7 audit states) across 11 phases
- **Work states:** triage → spec-foundations → optimizer-client → orchestrator-harden → causal-replan → plugin-io → plugin-gitnexus → serializer-sqlite → dispatch-tools → cli-complete → optimizer-algorithms → tests-hardening → live-e2e → release-ready
- **Audit states:** spec-audit, opt-audit, orch-audit, plugin-audit, storage-audit, tools-audit, cli-audit, algo-audit, test-audit, audit-final
- Each state has: `phase`, `kind` (work/audit), `depends_on`, `guard` (shell command), `context`, file `reservations`
- **Transition log + amendment log** in state.json
- **DoD provenance:** 14 clauses (dod.1–dod.14) confirmed at `2026-07-16T03:18:28.933Z`
- **Shared context file:** `contexts/_shared.md` — glossary, cross-cutting invariants cited by all states

### 14.6 Cross-Cutting Invariants (contexts/_shared.md)
- `[inv:worktree-required]` — work in `.worktrees/`, symlink `node_modules`
- `[inv:nx-cache]` — never `--skip-nx-cache`
- `[inv:layer-purity]` — shared packages never import node/logic/UI; optimizer stays pure
- `[inv:adapter-pattern]` — `IDagSerializer` + factory; SQLite parity acceptance
- `[inv:no-agent-mcp]` — plan touches no agent-mcp file
- `[inv:teeth]` — behavioral tests must FAIL when fix reverted; drive real component; no timing; gate on exit code not grep
- `[inv:live-gate]` — only paid-LLM tests gated behind `DISPATCH_E2E_LIVE=1`
- `[inv:resolve-at-dispatch]` — pin acceptance signal + invariants; resolve line numbers at dispatch
- `[inv:ephemeral-tmp]` — scratch artifacts under `tmp/<package>/...`

---

## 15. Precondition Defects (fixed directly, not plan scope)

### 15.1 BUG-DISPATCH-EXEC-001 — Tool-Call Execution Stub
- **Source:** `RECONCILIATION.md B`, `SCOPE.md §Preconditions`
- **Location:** `dispatch-orchestrator/src/lib/orchestrator.ts:659-671`
- **Symptom:** Any tool-call op is marked `skipped` with "is not wired into the minimal loop"
- **Fix (DIRECT):** Wire real tool-call execution + build `@adhd/dispatch-tools` primitives
- **Verification (Phase 0 V0):** The warn string is gone from orchestrator.ts

### 15.2 BUG-DISPATCH-PUBLISH-001 — Name/Alias Conformance
- **Source:** `RECONCILIATION.md B`, `SCOPE.md §Preconditions`
- **Problem:** 63 source imports use short names (`@adhd/dispatch-spec`/`-client`/`-optimizer`) that resolve only via duplicate tsconfig aliases; packages publish under standard names (`-base-spec`/`-core-client`/`-core-optimizer`)
- **Fix (DIRECT):** Conform all imports to standard names; drop duplicate tsconfig aliases; verify `npm pack`/install
- **Verification (Phase 0 V0):** Duplicate `@adhd/dispatch-spec` alias removed from `tsconfig.base.json`

---

## 16. Architectural Decisions & Invariants

### 16.1 Non-Negotiable Decisions
- **P1:** Serialization adapter pattern — `IDagSerializer` + factories; SQLite serializer must satisfy identical contract as JSON (adapter parity)
- **P2:** `DagClient` is the single CRUD authority; `dispatch-tools` MCP tools wrap it, never write `dag.json` raw; agents never read dag.json into context
- **P3:** Optimizer is pure computation with injected `IOptimizerDeps`; no I/O, graceful degradation when data sources are null
- **P4:** This plan touches NO agent-mcp file. All reserved paths under `packages/dispatch/**` or `entrypoint/dispatch-cli/**`
- **P7 (non-negotiable):** `optimizer-algorithms` is data-gated — ships only on ≥3 real cycles showing >15% greedy shortfall

### 16.2 Advisory Decisions
- **P5:** DEBT specs in `dispatch-backlog-fill/SOLUTIONS.md` are reference implementations — must be re-verified against live source before coding (6 items already drifted to fixed)
- **P6:** Spec-level fixes land BEFORE consumers so each downstream inherits the guard

### 16.3 Repo Standards
- **Import names:** Always use standard `@adhd/dispatch-base-spec`/`-core-client`/`-core-optimizer` (not short aliases)
- **Package naming:** `<domain>-<tier>-<name>` — verified repo-wide. Role-only names (-orchestrator, -serializer-json, -cli) also standard
- **Layer/platform tags:** dispatch-spec = shared/shared; optimizer/client = shared; plugins/sqlite/tools/cli = node

---

## 17. DEBT-DISPATCH-006 — Handed Off (out of scope)

- **Source:** `RECONCILIATION.md D.2`, `SOLUTIONS.md §2`, `APPROVAL.md`
- **What it was:** Per-turn token usage via `task_events` MCP tool — query `task_events` table (already exists in agent-store-runtime) via new `queryTaskEvents()` function
- **Schema reference:** `task_events` table: `id`, `task_id`, `type` (MODEL_REQUEST, MODEL_RESPONSE, TOOL_CALL, TOOL_RESULT, etc.), `payload` (JSON), `created_at`
- **New tool shape:** `task_events` — filters: `task_id`, `type`, `since`/`until`, `limit` (max 500), `include_payload`
- **Status:** HANDED OFF to agent-* work-stream; this plan does not touch agent-mcp

---

## 18. Sample Plan dag.json Structure (schema_version 4)

- **Source:** `demo/fixtures/sample-plan.dag.json`
- The canonical 3-milestone chain (scaffold → implement → verify) used for ALL demo beats
- **Provider section:** Single `Sonnet` provider with `type:'claudecli'`, `model_id:'claude-sonnet-test'`, `retry_config: { retries: 0, ... }`
- **Optimization section:** Empty `b_per_tier` and `context_window_per_tier` (falls back to cold-start defaults)
- **Operations array:** three `type:'generative'`, `action:'create'` ops with `status:'pending'`
- Empty `dispatch_log: []`
- **Immutable in demo:** Every mutating beat copies the fixture to `/tmp/dispatch-demo/` first; committed fixture never changes

---

## Summary: What's NEW vs. What Already SHIPS

| Category | Count of items | Status |
|---|---|---|
| New interfaces/types (`ExecutionMode`, `ICalibrationStore`, `ReplanNote`, `TypeSpecEntry`) | 4 | UNBUILT |
| New packages to scaffold | 3 | NOT SCAFFOLDED |
| Extensions to existing packages (spec, optimizer, orchestrator, cli) | ~15 items | UNBUILT |
| Orchestrator hardening items | 5 | UNBUILT |
| Causal replan | 1 | UNBUILT |
| Enrichment plugins (IO + gitnexus) | 2 | UNBUILT |
| Algorithm cascade (data-gated) | 1 | UNBUILT |
| Stepwise dispatch A/B experiment | 1 | NOT BUILT |
| Live E2E test scenarios | 8 scenarios | IN PROGRESS |
| Audit infrastructure | 3 scripts | AUTHORED |
| Precondition fixes (direct, not plan) | 2 | IN PROGRESS |
| Deferred/OUT of scope (DEBT-006, apigen CLI, publishing) | 3 | HANDED OFF |
