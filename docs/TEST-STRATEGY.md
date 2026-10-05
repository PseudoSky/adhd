# Test Strategy

This is the single committed source of truth for how quality is verified in this
repository. It is content-based: the sections below are the contract. Where a rule
already lives elsewhere, this document **cites it by path** rather than restating it.

- **Schema version:** 1
- **Owner:** the repository maintainer (git `pseudosky`).
- **Scope:** the whole Nx monorepo (`entrypoint/*`, `packages/*`, `tools/*`).
- **Normative project rules** (read these first; this document does not override them):
  - [`AGENTS.md`](../AGENTS.md) — §7 "Testing Protocol" (default-running tests, the
    one legitimate env gate, proof standard §7 bullets 1–6).
  - [`entrypoint/agent-mcp/AGENTS.md`](../entrypoint/agent-mcp/AGENTS.md) — protocol/tool contract.

## Risk map

Failure modes ranked by impact × likelihood, and the level that covers each. "Impact"
is consequence for a consumer of the shipped artifact; "Level" names the test level
(unit / integration / e2e) that must cover it.

| # | Failure mode | Impact | Likelihood | Level that covers it |
|---|---|---|---|---|
| R1 | A change passes `nx test <leaf>` but breaks a downstream consumer (Nx affected miss). | High | High | `npx nx affected -t test` (AGENTS.md §5) |
| R2 | Dist entry loads in tests (resolves to `src`) but throws when a consumer `require()`s the real bundle. | High | Medium | `verify-dist-load` (AGENTS.md §5) |
| R3 | A provider/runtime path is only exercised with a scripted stub, so a real model/CLI path is broken in production. | High | Medium | e2e with a real provider (this document, "Environments") |
| R4 | A dispatch-driven feature (session threading, HITL, budget cap, default MCP servers, policy) is unit-green but unreachable once the real MCP boundary is crossed. | High | Medium | integration/e2e across the real MCP seam |
| R5 | Dependency drift (`package.json` vs imports) silently ships a broken dependency set. | Medium | Medium | `sync-deps-check` via `nx lint` (AGENTS.md §5) |
| R6 | A test writes outside `tmp/` or leaks a DB/artifact into the tree. | Medium | Low | lint + teardown-in-`finally` rule (AGENTS.md §10) |
| R7 | Flake from fixed sleeps / shared state / wall-clock, so a real failure hides behind a retry. | Medium | Medium | determinism rules below; no silent retries (AGENTS.md §7) |

## Test pyramid

Proportion and placement. A new test belongs at the **lowest level that proves the
behaviour**:

1. **Unit (most numerous)** — pure logic in `packages/*/src/**/*.spec.ts`, Vitest/Node
   (`layer:test-logic`). No I/O, no subprocess, no model.
2. **Integration (middle)** — real stores/engine wired against a temp SQLite DB and an
   in-memory MCP transport:
   - `entrypoint/agent-mcp/src/__tests__/integration/harness.ts` (`buildHarness`) is the
     canonical fixture; it runs the real drizzle migrations, real stores, real queue, real
     `PolicyEngine`, and the same `dispatchFn` wiring as production.
   - `entrypoint/dispatch-cli/src/test/helpers/agent-mcp-registry.ts` spawns the **built**
     agent-mcp over real stdio JSON-RPC.
3. **End-to-end (few, highest-value)** — real DAG + real orchestrator + real MCP boundary,
   and (only where a real provider is required) a real model. Entry points:
   - `entrypoint/dispatch-cli/src/test/integration/real-e2e.ts` (self-executing script).
   - `entrypoint/dispatch-cli/src/test/integration/live-dispatch-five-acs.e2e.test.ts`
     (this change's live proof; see "Environments").
   - `entrypoint/agent-mcp/src/__tests__/integration/live-*.e2e.test.ts`.

A test that can be written one level lower must be. E2E is reserved for the journeys a
consumer actually takes through the real boundary.

## Test-case design

Techniques in use (per AGENTS.md §7's proof standard):

- **Equivalence partitioning** — one case per class of equivalent input. Example:
  `agent_verify_mcp`'s tri-state `verified`/`skipped`/`error` has one case each.
- **Boundary values** — min, min−1, max, max+1, empty, oversize. Example: budget caps
  (`maxModelCalls: 0`, `1`, and an unbounded run), recursion depth (`maxDepth`, `maxDepth−1`),
  empty vs. non-empty `mcpServers` maps.
- **Negative cases** — malformed/missing/adversarial input must fail per contract, not crash.
  Example: HITL with a stale `resumeToken` must reject with `VALIDATION_ERROR`
  (`hitl-suspend-resume.e2e.test.ts`); an unknown `--allow-fs` action must reject before
  touching a runner.
- **Decision tables / state transitions** — enumerate combinations and state changes.
  Example: task status transitions (`pending → running → awaiting_input → completed`).
- **Negative controls with teeth** — a behavioural test must go red if the fix is
  reverted. Proven by a deliberately-wrong variant (source edit + rerun, or a second
  fixture branch), never by assertion alone. This change's controls are listed in
  `live-dispatch-five-acs.e2e.test.ts`'s header.

A case is reproducible: it names its input, its action, its expected result, and anyone
can run it.

## Test data & fixtures

- **Fixtures & data:** created per test from factories, isolated from production data.
  - `ScriptedProvider` (`entrypoint/agent-mcp/src/__tests__/integration/scripted-provider.ts`)
    is the only permitted LLM stub for default-running tests.
  - `MockAgentRunner` (public export of `@adhd/dispatch-orchestrator`) stands in for the
    task-runner boundary in default-running dispatch tests.
  - External MCP boundaries that cannot run in-process are stood in for by a local stdio
   /server fixture, never by reaching inside the system under test.
- **Seeding:** deterministic; no `Date.now()`/`Math.random()` in an assertion. Where time
  or ids are needed they are injected (`clock`, `idFactory`, `sleep`).
- **Isolation:** every test gets a fresh temp SQLite DB (`ADHD_AGENT_DATABASE_PATH`) and a
  fresh scratch dir; the child's `cwd` is a scratch dir so no repo `.env` can redirect the
  store.
- **Cleanup:** every test removes what it created in a `finally` block; scratch lives under
  `tmp/<package>/…` (AGENTS.md §10) and is removed deterministically. A failing run still
  cleans up.

## Environments

Where each level runs, and how a failure is reproduced locally.

| Level | Environment | Reproduction |
|---|---|---|
| unit | Node + Vitest | `npx nx test <project>` |
| integration | Node + Vitest + temp SQLite + in-memory MCP transport | `npx nx test <project>` |
| e2e (no model) | Node + Vitest + built artifacts (stdio child) | `npx nx run agent-mcp:dist-manifest && npx nx test dispatch-cli` |
| e2e (real provider) | a host with the real provider reachable | see "Environments — live e2e" below |

**Live e2e (real provider).** A real model is a paid/external third-party service. Per
AGENTS.md §7 this is the *only* reason a test may be gated behind an env flag, and the gate
must be documented in the open. Each live suite documents its gate, its named owner, and its
run command in **all three** required places: the owning package's `README.md`, its
`AGENTS.md` (or the repo-root `AGENTS.md`), and the test file's own header.

- `entrypoint/agent-mcp` live suites: gate + owner recorded in
  [`entrypoint/agent-mcp/README.md`](../entrypoint/agent-mcp/README.md) "Live tests".
- `entrypoint/dispatch-cli` live suite: gate + owner recorded in
  [`entrypoint/dispatch-cli/README.md`](../entrypoint/dispatch-cli/README.md) and
  [`entrypoint/dispatch-cli/AGENTS.md`](../entrypoint/dispatch-cli/AGENTS.md).

A live gate must **fail loudly** when it is enabled but a required credential/subscription is
absent — never a silent skip.

## Automation architecture

- **One abstraction for one surface.** A screen/surface is represented once; selectors and
  wire shapes are not scattered. `AgentMcpRunner` is the single abstraction over the
  agent-mcp MCP surface; `IDispatchAgentRunner` is the seam the orchestrator depends on.
- **Stable, semantic selectors.** MCP tools are addressed by published tool name and JSON
  schema, never by internal function names.
- **Wait for a condition, never a fixed sleep.** Poll with a bounded deadline
  (`pollUntilTerminal`, `drainQueue`); no `sleep`-then-assert.
- **Independent, atomic tests.** Each test sets up its own state, asserts one thing, and
  tears down; order must not matter and one failure must not cascade.

## Gates

Thresholds that block a merge or release. All are enforced by commands in this repo — a
gate the suite cannot actually enforce is not listed.

| Gate | Threshold | Enforced by |
|---|---|---|
| Tests pass | 0 failures | `npx nx affected -t test` (AGENTS.md §5) |
| Built artifact loads | `require()`/`import()` of the real `dist` entry succeeds | `npx nx run <project>:verify-dist-load` (AGENTS.md §5) |
| Dependency integrity | no drift | `nx lint` → `sync-deps-check` (AGENTS.md §5) |
| Live e2e | runs only when explicitly gated; when enabled, 0 failures and loud failure on missing credentials | the gated suite itself (this document, "Environments — live e2e") |
| Coverage | measured per suite; not a self-certifying threshold — report the tool's number | `vitest --coverage` (v8) |

There is no coverage percentage gate enforced across the whole repo; where a project adds
one it must be a number the suite's own command prints, not a number asserted here.

## Metrics

What is measured, and where. Every number reported is one a tool printed, never estimated.

| Metric | Where |
|---|---|
| Pass/fail counts + exit code | the test runner's own output (`npx nx test …`) |
| Coverage % | `vitest --coverage` (v8), per project |
| Suite duration | the runner's reported duration |
| Flake rate | tracked implicitly by running the suite; a retry is recorded with a tracking item, never silent (AGENTS.md §7) |
| Live-gate spend | the real provider's own usage output, captured in the live run evidence |

## Provenance

- **Schema version 1** (2026-10-05): initial strategy authored alongside the
  `dispatch-2026-10-04-9c4e` live-e2e work. Created because no single committed document
  contained every required section (candidates were partial: `AGENTS.md` §7 carries the
  live-gate rule, each package README carries its own live-gate table, and the integration
  harness carries the fixture rules — none is the whole strategy). Cites those rather than
  restating them. No secrets, no machine-local absolute paths.
