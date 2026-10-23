# Interactive dispatcher CLI: plan

Status: proposed (2026-10-21). Owner: product. Architecture review: architect. Backlog parent: `3a790b0e-9177-4b2e-8fb7-b068d9f49c1b` (PLAN, P1, 33 `part_of` children).

The backlog graph is the source of truth for scope, acceptance criteria and status. Each item's body holds its complete acceptance criteria of record; citations carry evidence and priority rationale. Editing an item's body mints a successor uid that keeps the item's edges and citations; the old uid answers with a `conflict` naming the successor (`entrypoint/backlog/skill/REFERENCE.md:468-490`). Short uids below are the current ones. This document explains the order, the design constraints and the reasons.

## 1. Objective

The owner's direction:

> drive agent-mcp through an interactive CLI starting from 0 messages and building up plans

Today `dispatch-cli` is a set of one-shot commands. Every DAG command requires `--dag-path` to an existing `dag.json` (`entrypoint/dispatch-cli/bin/cli.ts:60-146`), and the program parses argv once and exits (`bin/cli.ts:178`). Nothing creates a DAG, adds a milestone, routes work to an agent, or holds a conversation, and `DagClient` has no authoring methods (`packages/dispatch/dispatch-core-client/src/lib/client.ts:11-162`).

The finished outcome:

1. `dispatch-cli session` starts with zero messages on an empty plan, against the user's production stores, and prints which stores and endpoints it is using. `--sandbox` isolates them.
2. The user builds a plan turn by turn: create a DAG, add milestones, let an LLM pick the best-fit agent for each, validate, and show the eligible set. A plan already groomed in the backlog can be materialized as a DAG instead.
3. The user dry-runs the plan, then live-runs it with `--live --yes`; typed turn, cost and wall-clock caps follow in S2.
4. HITL questions are answered without leaving the session.

## 2. Inventory of dispatcher plans, specs and docs

Statuses were checked against code on 2026-10-21. Shipped means the code exists and is exercised. Partial means part of it shipped. Stale means the doc contradicts the code. Dead means it was never executed or is empty.

| Artifact | Status | Evidence |
|---|---|---|
| `entrypoint/dispatch-cli` (bin/cli.ts, src/api.ts, src/lib/core.ts) | **shipped (one-shot)** | 8 commands (`bin/cli.ts:60-176`). `run` is one cycle (`src/api.ts:173-180`, `core.ts:656-699`). |
| apigen-generated dispatch-cli | **partial** | Comments say 5 of 7 commands crash with the apigen-logical `$ref` bug (`bin/cli.ts:9-28`, `src/api.ts:144-158`). Root items: 97ce4e5b (fixed) and 1bb4b5d5 (review). The session uses `bin/cli.ts`, so it does not depend on this. |
| `packages/dispatch/*` | **shipped** | `DagJson` has 14 required fields (`dispatch-base-spec/src/lib/types.ts:592-625`). `AgentMcpRunner.callTool` (`dispatch-orchestrator/src/lib/agent-runner.ts:488`). Missing `domain:`/`pkg-kind:` tags (f20afd65). |
| Run-exclusivity lock + unique temp name (0b80a7b5, d794287f) | **shipped, in review** | `withDagLock` is fail-fast and not reentrant (`core.ts:701-736`). pid+random temp name (`dispatch-serializer-json/src/index.ts:28-45`). |
| Live-run turn/cost guard | **test-only** | Exists only in the e2e harness, driven by `DISPATCH_E2E_*` env, and meters cost by opening agents.db with better-sqlite3 (`src/test/integration/live-guard-core.ts:17,60-73`). No cap in `runCycleCore`. |
| fs.* allow/deny policy (`FsOpPolicyFn`) | **shipped** | `dispatch-orchestrator/src/lib/orchestrator.ts:505-545,732-760`. Guard commands run as ungated shell exec (`orchestrator.ts:1560`); the ask branch remains (f4ceea85). |
| `entrypoint/dispatch-cli/README.md` | **stale** | Dead path `docs/plan/dispatch-production/dag.json`. `--version` prints 0.0.1 (`bin/cli.ts:48`) against package 0.1.11. Tracked as 2ea81c4f. |
| `docs/plan/dispatch-completion/` | **dead** | `state.json` has 24/24 states pending. `final-review.md` is a stub. |
| `docs/plan/dispatch-completion/superseded/dispatch-production/` | **historical** | Still cited as the shape contract by `src/api.ts:19`. |
| `docs/plan/backlog-interface-v2-dispatch/` | **dead** | Empty directory (d565dbad). |
| `docs/product/dispatcher-platform/GAP-MATRIX.md` | **stale** | Says ROADMAP supersedes it. Rows 18 (no REPL) and 19 (no authoring) are carried into this plan. |
| `docs/product/dispatcher-platform/ROADMAP.md` | **partial** | §3.2/§3.3 dispatched-agent tools, HITL-from-dispatch and the lock are done. §3.4, I2 and §8 decision 2 are answered here. |
| `STRUCTURE.md`, `GOAL.md` (dispatcher-platform) | **framing, current** | No code claims. |
| `docs/dispatcher/DISPATCHER-RECONCILIATION.md`, `FEATURE_COMPARISON_SOX.md` | **reference** | Doc-only comparison. |
| `docs/architecture/agent-dispatch-systems.md` | **reference** | Dated 2026-07-16; predates the lock fix. |
| `docs/plan/agent-final/GOAL.md` | **governing** | Ratified rulings. This plan conforms. |
| `entrypoint/agent-mcp/parity/README.md:20`, `parity/drive.mjs:303-308` | **stale** | False claim about `ADHD_AGENT_ANTHROPIC_BASE_URL`. Tracked as 6e8d960b. |

## 3. Design constraints

### 3.1 Two locks, delta writes (91f591cf, ade520c9)

**Run exclusivity.** `acquireDispatchLock` keeps the rule that a DAG has at most one live dispatch (d794287f). Each run takes it exactly once, at its outermost entry. The session's `run` calls a lock-free cycle entry inside that span, because `withDagLock` is not reentrant (`core.ts:701-736`).

**Write coordination.** Every dag.json write goes through `IDagSerializer.update(mutator)`:

1. Acquire the write lock, a file distinct from `dispatchLockPath` (`core.ts:733-736`), with a bounded wait. A dead holder's lock is reclaimed with the same pid-liveness check `process-guard.ts` uses.
2. Re-read the file.
3. Apply the mutator, which is synchronous and pure, never awaits I/O and never calls `update()` (a nested call is rejected).
4. Validate, write a temp file, rename it into place, release.

Lock order is always run lock, then write lock.

**Delta writes in the orchestrator.** `orchestrateCycle` loads the DAG once (`orchestrator.ts:1832`) and saves the whole document (`:1794`, `:1883`, `:1960`); `DagClient` writes from a cached `_dag` (`client.ts:29-89`). Both lose concurrent edits (ade520c9). Each run write becomes a delta mutator on the re-read document: set operation status, push the `dispatch_log` entry, clear `pending`, stamp `session_id`. `saveDag` survives only as create-if-absent. An edit that touches a milestone pending or dispatched in a live run is refused with `PlanConflictError`; every other edit lands.

**Concurrent sessions.** Two sessions may edit the same DAG at once, and both edits survive. Every store in this ecosystem is parallel-process enabled (AGENTS.md hard rule, ADR-0012). The proof uses two real processes released by a stdout latch, with a negative control that drops the re-read.

**Snapshots.** `writeSnapshot`/`saveSnapshot` have no production caller (11dae275, in 42bd4d93) and are outside `update()`; they are a derived cache, exempt from coordination.

**Hand edits (9be8e522).** A revision check inside the critical section catches writers that bypass `update()`.

### 3.2 Layering (be1e6ef3, 91f591cf)

- **`dispatch-core-client`** (`layer:data`, `platform:shared`, `project.json:15-17`) gets only pure code: `createEmptyDag`, `applyDagEdit(dag, edit)` with typed errors, and the `update(mutator)` port. Cycle checks reuse `detectCycle` from `dispatch-base-spec`.
- **`dispatch-serializer-json`** (`platform:node`) implements the critical section.
- **`dispatch-orchestrator`** moves its run writes to delta mutators.
- **`dispatch-cli`** composes them.
- **No new package before S3.**

### 3.3 Stores: production by default, sandbox on request (3b715df2)

The session and every existing command work on the production stores by default (owner ruling, 2026-10-21). On start the session prints every resolved store path, the backlog namespace and every MCP endpoint, labelled `production` or `sandbox`; `agents import`, `calibrate` and `run --no-dry-run` print the same to stderr before their first write.

The flag `--sandbox [dir]` isolates three surfaces:

- **Agent stores.** Explicit env to the child: `ADHD_AGENT_DATABASE_PATH` and `ADHD_AGENT_REGISTRY_DB_PATH` under the sandbox dir. Explicit env beats every `.env` layer (`agent-mcp/src/utils/load-env.ts:118-138`).
- **Backlog.** The backlog MCP server given to dispatched agents (`core.ts:251-266`) gets `--namespace sandbox`.
- **Memory.** The operator's memory server (`http://localhost:3099/sse`) is omitted unless `--memory <url>` is given.

The sandbox is flag-only. An exported environment variable that switches every later command between production and sandbox is a mode toggle (ADR-0001 D3), and a user could believe they are on one set of stores while writing to the other. Whether harnesses get an env mirror anyway is an open owner decision (§11).

HOME is never relocated in product mode: provider secrets live in `~/.adhd/.env`, claudecli's OAuth in `~/.claude`, npx's cache in `~/.npm`. Every acceptance e2e runs with `--sandbox`, because a fake HOME does not isolate the memory endpoint. That is why 3b715df2 stays P0 and blocks the session.

**Network is separate from stores.** agent-mcp pulls prices from a hard-coded OpenRouter URL 5 s after start on a fresh store (`pricing/pull.ts:9`, `scheduler.ts:24,112-118`). 17eee8c6 makes the feed URL typed config; tests point it at a loopback fake that serves deterministic prices. The sandbox does not touch it.

### 3.4 Caps in product code (e04a69e8)

The guard moves from the e2e harness into `dispatch-orchestrator`:

- **Metering through the runner port.** `IDispatchAgentRunner` (`dispatch-orchestrator/src/lib/agent-runner.ts:129-151`) gains `usage(taskId)`, returning tokens and `est_cost_usd` (null when unpriced). The guard depends only on that method. `AgentMcpRunner` implements it with agent-mcp's `usage_query` MCP tool (`agent-mcp/src/server.ts:832,1033`) over the client the session already holds: no DB path, no better-sqlite3, no schema coupling.
- **Typed caps** (`--max-turns`, `--max-cost-usd`, `--max-wall-ms`), never env toggles (ADR-0001 D3). A NULL `est_cost_usd` aborts the run.
- **Testable without paying.** The fake Anthropic SSE server (b6b1f7d8) reports scripted usage, and with the price feed pointed at the loopback fake (17eee8c6) a seeded model gets a deterministic non-NULL cost.

**Sequencing.** S1 ships live `ask` and `run` before the caps (owner ruling, 2026-10-21). The caps block the multi-cycle loop (ac0c1364), where unattended spend accumulates.

### 3.5 A long-lived process (6afff610, cd33eab3, 432c9933)

**Definitions.** *Live* means a real agent-mcp child; whether a call costs money depends on the provider endpoint, not on the flag. *Dry* (the default) uses the mock runner.

**Runner lifecycle.**
- One runner per session, passed to `runCycleCore` as `runnerOverride`; exactly one agent-mcp child per session, counted by pid.
- The runner is closed on exit and on SIGINT. `runCycleCore` today never closes the runner it builds (432c9933).
- The run debug dir is rooted under the session dir; today it is resolved from `process.cwd()` at import (`core.ts:626`, 3adf552b).
- Reconnect (cd33eab3) builds a fresh runner with the same env and stores.

**Runner port.** The session holds its runner as `IDispatchAgentRunner`; only the runner factory names `AgentMcpRunner`. An in-process runner (§3.8) is then a drop-in, and the version pin and child count below are properties of the stdio implementation.

**Version pin.** The agent-mcp version is stamped into dispatch-cli at build time, never `@latest` (`core.ts:425-426`). A major mismatch with `serverInfo.version` is refused unless `--agent-mcp` is given explicitly.

**HITL in S1.** Session-created agents run without the shell native tool until f4ceea85 lands. A suspended task is printed with its exact resume command; answering in-session arrives in b629c8c6.

**Command handlers** are pure (parse, handler, result, render). Readline lives only in the I/O shell, so a9904f8e and 70e61986 reuse the same handlers.

### 3.6 Routing by LLM selection (af826533)

Lane and tool grant are a hard filter: the candidates are the registry agents whose grant satisfies the milestone's lane. A selector agent (a named registry agent, default `dispatch-router`, overridable with `--router`) receives the milestone's text and each candidate's name, description and lane fit, and returns `{agent, rationale}`. The pick is accepted only if it is in the filtered set. Zero candidates means no model call and an unassigned milestone; one candidate is assigned without a call.

- **No implicit creation.** `route --auto` never creates the selector; if it is missing, it fails and prints the `router init` command. `router init` is an explicit command that creates `dispatch-router` with a versioned system prompt shipped in dispatch-cli, after printing the store banner. A shipped, versioned prompt keeps selection reproducible and testable, and the one registry write stays explicit, consistent with the runner's no-auto-create rule (f1dbd0f2).
- **Dry and live.** The selector is a model call, so it needs `--live --yes`. Without them, `route --auto` runs the deterministic filter, prints each milestone's first candidate as `unscored`, and assigns nothing.
- **Persistence.** The pick, rationale and prompt version go into a `routing` field on the milestone, written through `update()`. `dispatch_log` stays an execution record.

Everything is tested against the fake model server with `--sandbox`; there is no paid gate.

### 3.7 A DAG from a backlog plan (b7c4bf6e)

`dispatch-cli from-backlog <parent>` turns a backlog plan into a DAG: each open `part_of` child becomes a milestone carrying its body and citations verbatim and its uid, and each `blocks` edge between children becomes a dependency. Resolved children are recorded as done. dispatch-cli already depends on `@adhd/backlog`, today only to locate the backlog MCP server entry (`core.ts:183-233`).

Write-back happens on live runs only; a dry run makes no backlog write. It uses the namespace resolved by 3b715df2 (production unless `--sandbox`), shown in the banner. dispatch-orchestrator exposes an `onMilestoneTerminal` callback and imports nothing from the backlog; dispatch-cli wires the callback to the backlog CLI. The callback runs after `update()` commits, outside the write lock and never inside the mutator; it never rolls back the DAG write, re-transitioning an item already in the target state is a no-op, and a failed transition is listed in the run summary.

### 3.8 The in-process engine runner (7da11874, decision open)

The owner directed that the dispatcher use the agent engine instead of spawning agent-mcp, and prefers that path. No package is named agent-engine-client; this plan reads the direction as `@adhd/agent-engine-orchestrator`'s in-process API, which exports `Orchestrator`, `DagEngine`, `McpClientRegistry`, `InProcessMcpClient`, the agent CRUD tools and `usageQuery` (`src/index.ts:16,67,103-104,113,130`).

What the code shows:

- dispatch-orchestrator does not depend on the engine at runtime. The engine, agent-store-runtime and better-sqlite3 are devDependencies (`package.json:4-15`); the one real import is a test (`real-turn-telemetry.spec.ts:49`).
- The engine and agent-store-runtime list better-sqlite3 and drizzle as runtime dependencies, so an in-process runner makes better-sqlite3 a runtime dependency of the dispatch path and decides the ADR-0001 D4 question (3b847644) before the owner rules.
- The engine is `type: module` with `default`-only exports, and its runtime dependencies `p-queue` ^8, `p-retry` ^6 and `uuid` 14 are ESM-only. Re-emitting the agent packages as CJS (a99fe8dd, ADR-0003) is not enough: a CJS dispatch-cli bin would need `require(esm)` and therefore an `engines` floor of Node >=20.19/22.12, or replacement dependencies.
- The composition root lives in agent-mcp's entrypoint: `openRegistryDb` (`index.ts:134`), `createPricingService` (`:313`), `new Orchestrator()` (`:324`) and `DagEngine` over a better-sqlite3 handle (`:340`). `config.ts:58` runs `loadEnvHierarchy()` at import, which mutates process.env. Extracting it is a new package and needs human approval (ce7ffc4e).

**Architect recommendation (round 5).** Start S1 now on the stdio child and do not wait. 7da11874 stays open, blocked by 3b847644, a99fe8dd and ce7ffc4e. Because the session and the guard are written against `IDispatchAgentRunner` with metering as a port method, an `InProcessAgentRunner` drops in later without rework; reconnect (cd33eab3) and the runner-close bug (432c9933) are then restated against it. Whether S1 starts now or waits is the owner's decision (§11).

### 3.9 Testing obligations

- **Per-AC records.** Every AC names its lane (unit, or e2e under ADR-0009 with isolated cwd, fake HOME and `--sandbox`), and its red-run method.
- **No sleeps.** Waits are on events: child `exit`, ready markers, latches, responses.
- **Paid parent AC2.** A real-provider run, only behind the AGENTS.md §7 gate, with the approval and a named owner recorded in dispatch-cli's README, AGENTS.md and the test header, and a declared lane (a836f923).
- **Change class.** Rigor is derived by test-routing at pickup from each item's Testing record.

## 4. Build vs integrate: the REPL

**Verdict: build on `node:readline/promises` and the existing `commander`, pinned exact at `14.0.3`** (`entrypoint/dispatch-cli/package.json:14`). No dependency is needed.

**Research.** Memory uids `01M5FSFSVQTPXS4BRXJW8PQA7C` (approved) and `01M5FSFV375FQ67TJGBFVJEQRZ` (pattern).

**Pattern:** one `Command` tree with `exitOverride()`; `for await (const line of rl)` over the input, never `rl.question` in a loop; `parseAsync(tokens, {from:'user'})` once per line. The one-shot argv entry and the session share command definitions, and piped stdin drives the e2e tests.

**commander@15.** `npm view commander@15` reports `"type": "module"` with an exports map that has no `require` condition, and `latest` is `15.0.0`. The exact pin stays. The bin compiles to CJS and declares no `engines` floor, so relying on `require(esm)` would add an unstated floor.

**ESM surface.** dispatch-cli already emits ESM against ADR-0003 (`package.json:23` `"module"`, `vite.config.ts:53` `formats: ['es','cjs']`), tracked on a99fe8dd. The session adds no ESM surface.

| Not chosen | Reason |
|---|---|
| `@inquirer/prompts`, `@clack/prompts`, `ink` | Prompt and TUI libraries; ROADMAP I2 rules out a TUI; ESM graphs would need an engines floor |
| `enquirer`, `prompts` | Single-question prompts, not command loops |
| `vorpal` | Unmaintained |
| `node:repl` | A JavaScript evaluator, not a command shell |
| `interactive-commander` | A thin, low-adoption wrapper over the same pattern |

## 5. Slice order

Slices are ordered by consequence to the objective, thinnest first. Every slice fits an existing package except 70e61986, which needs human approval.

### Owner ruling 3b847644 (ADR-0001 D4)

dag.json is written at runtime by several processes, so it is a store, and ADR-0001 D4 requires an explicit scope ruling for dispatch persistence. The ruling does not gate S1: 91f591cf's write lock and delta mutators use no better-sqlite3 and no new store, so they hold either way. If the ruling is "in scope", run state later moves to `@adhd/sox-store-adapter` behind the same `update(mutator)` port. The ruling does gate the engine path (7da11874) and the revision guard (9be8e522).

### S0: safe ground (P0)

| uid | Item | Package |
|---|---|---|
| `3b715df2-9346-4b7a-bee1-6f89d84d9a14` | Opt-in `--sandbox` stores and the store banner (§3.3) | entrypoint/dispatch-cli |
| `5ee17367-2b87-4475-ae12-a9798afb2d7a` | `validate` throws on non-DagJson input: serializer `normalizeDag` runs `Object.values` before validation | dispatch-serializer-json, dispatch-base-spec |

### S1: zero messages to a validated, live-runnable plan (P0)

| Order | uid | Item | Package |
|---|---|---|---|
| 1 | `be1e6ef3-5f66-4f00-ab6c-e9daa4c28593` | Pure authoring API and `update(mutator)` port (§3.2) | dispatch-core-client |
| 2 | `91f591cf-a1bc-4a14-bae9-0db800c4c1c1` | Coordinated delta writes (§3.1); fixes ade520c9 | dispatch-serializer-json, dispatch-core-client, dispatch-orchestrator |
| 2 | `ade520c9-a96f-4a59-bb61-aa48396747e7` | Whole-document stale writes (bug) | dispatch-orchestrator, dispatch-core-client |
| 2 | `432c9933-30e6-43c3-bede-b5649043ade2` | `runCycleCore` never closes its runner (bug) | entrypoint/dispatch-cli |
| 2 | `17eee8c6-4dee-4b71-b1ab-88e6425a9a00` | Typed price-feed URL; tests point it at a loopback fake | entrypoint/agent-mcp |
| 2 | `cd33eab3-b3e5-4dc0-a2f6-1b5bf5bbec18` | `AgentMcpRunner` reconnect | dispatch-orchestrator |
| 2 | `b6b1f7d8-2b66-4248-8b1b-c31e4cd2ff73` | Stdio e2e on `ADHD_AGENT_ANTHROPIC_BASE_URL`; the shared fake-model fixture | entrypoint/agent-mcp |
| 3 | `6afff610-949b-472c-990c-ff0a028c4212` | `dispatch-cli session` (§3.5) | entrypoint/dispatch-cli |

### S2: plan to finished run (P1)

| uid | Item |
|---|---|
| `e04a69e8-4656-4312-9d90-ff7d3f6fb98a` | Turn, cost and wall-clock caps (§3.4) |
| `ac0c1364-4476-4f9e-a156-9cd9bcb9b9e9` | `run --until-terminal`: one run-lock span across cycles, capped |
| `af826533-7a22-4f78-a661-eda534f3740f` | LLM agent selection with lane/tool-grant filter (§3.6) |
| `b7c4bf6e-ce03-4c73-914e-041aaab4e1a6` | Materialize a DAG from a backlog plan, with write-back (§3.7) |
| `f4ceea85-7d66-4f2d-b33e-6a65afe24031` | Ask branch of the fs.* policy and gating of guard shell commands |
| `7da11874-2090-4262-9993-08ccddbc9b12` | Decision: in-process engine runner (§3.8); stays open, blocked |

### S3: conversation and follow-through (P2)

| uid | Item |
|---|---|
| `a9904f8e-5d05-41f4-a908-fdb044173197` | Natural-language plan authoring |
| `70e61986-c70f-4209-bacb-e6ce5d4403e8` | Dispatch MCP tool surface. **Needs human approval** (new package) |
| `9bc29fd6-5d1f-4ead-a3dd-094fc54a1b04` | Chat over a live plan session |
| `b629c8c6-e008-490c-8b9b-c4a823c4789d` | In-session `inbox`/`answer`/`events` (HITL) |
| `988e74dd-1fd8-4758-8a7b-19eb281380c4` | `--follow` live progress |
| `c667a213-5c04-4668-83c0-3b70c9d201c2` | SSE chat-gateway `--follow` renderer (in progress) |
| `9be8e522-59e2-460f-9356-05d4f7684871` | Revision guard for writers that bypass `update()` |
| `3adf552b-8408-43dd-8382-84b285fc5d78` | Run debug dir resolved from cwd at import |
| `43126d09-c609-4ff0-b62c-501cf44b065c` | DAG authoring and session guide |
| `2ea81c4f-141e-4cc2-941c-2589a4ee60eb` | README dead path; `--version` reports 0.0.1 |
| `ce7ffc4e-4f7c-4b59-9174-7a476c9894a5` | Composition-root package and engines floor for the engine path. **Needs human approval** (new package) |

### S4: hygiene (P3)

| uid | Item |
|---|---|
| `6bf79ea9-4b3c-4e37-84a5-51f5d8baebf4` | dispatch-cli usability: raw JSON output, eligible vs status disagreement, errors with no next step |
| `6e8d960b-24ed-4296-ad9d-f486af1eb9e6` | Stale parity docs on the base-URL env path |
| `c5b46c88-6286-429f-b328-1650b5a0a8d8` | `@adhd/agent-core-native-tooling` in both deps and devDeps |
| `126c4d02-e05d-4bc9-b054-99d1ea8eb08d` | Superseded banners on the stale corpus (§9) |
| `f20afd65-bbe2-4216-b6f9-aa6e247c0880` | dispatch packages lack `domain:`/`pkg-kind:` tags |

### Shortcut vs durable path

**The shortcut.** A REPL that shells out to the one-shot commands and hand-edits dag.json would demo this week. It would bypass write coordination, lose edits made during a run, and need re-cutting as soon as authoring arrives.

**The durable path, which this plan takes.** The authoring API is pure and lives in a library; persistence goes through one coordinated port with delta writes; caps live in product code. The REPL, backlog materialization and the future MCP surface share all three. The extra cost is three library items in S1.

**The deliberate trade.** S1 ships live runs before caps, at the owner's direction. The window is bounded to single cycles started with `--yes`; the multi-cycle loop waits for the caps.

## 6. Dependency graph

The `blocks` edges as recorded in the graph:

```
3b715df2 sandbox ──────────┬──► 6afff610 session ──► af826533 routing
5ee17367 validate ─────────┤                      ──► b629c8c6 resume
be1e6ef3 authoring ──► 91f591cf writes ──┤        ──► 9bc29fd6 chat
ade520c9 stale writes ─────┤             │        ──► 43126d09 docs
432c9933 runner close ─────┤             │        ──► a9904f8e NL authoring
cd33eab3 reconnect ────────┤             │        ──► ac0c1364 until-terminal
b6b1f7d8 e2e fixture ──────┘             │
17eee8c6 price feed URL ──► b6b1f7d8, e04a69e8
91f591cf ──► ac0c1364, a9904f8e, 70e61986
be1e6ef3 ──► a9904f8e, 70e61986, b7c4bf6e from-backlog
e04a69e8 caps ──► ac0c1364
3b715df2, 432c9933, cd33eab3 ──► ac0c1364
be1e6ef3 ──► 6afff610 (also directly)
f4ceea85 fs ask gate ──► ac0c1364
3b715df2 ──► b7c4bf6e from-backlog
3b847644 D4 ruling ──► 9be8e522, 7da11874
a99fe8dd ADR-0003 re-emit ──► 7da11874
ce7ffc4e composition root ──► 7da11874
```

3b847644 relates to 91f591cf without blocking it. 7da11874 also relates to cd33eab3, 432c9933, e04a69e8 and 6afff610.

## 7. Related items

These stay in the backlog, linked `relates_to` the parent or a child. None is deleted.

| uid | State | Relation |
|---|---|---|
| `0b80a7b5` | review | Lock and temp-name fix; write coordination builds on it |
| `d794287f` | — | The run-exclusivity rule kept in §3.1 |
| `42bd4d93` | open | Bug-sweep bucket holding 0b80a7b5 and 11dae275 (dead snapshot path) |
| `bec713de`, `705ae01e`, `4e5c4871`, `34d1fd4c` | open | Adjacent dispatcher work; 34d1fd4c (two usage quotas spent) motivates e04a69e8 |
| `43580269`, `9e7e04bb` | fixed | Fail-closed fs.* allowlist |
| `084c9d6e` | open | "Cancel interactive lane" gate; conflicts with the owner's direction |
| `760ca534` | open | Base-URL double-prefix fixed in d6c5caea / 7506cba1; release verification pending |
| `a836f923` | open | `real-e2e.ts` runs in no lane |
| `97ce4e5b`, `1bb4b5d5` | fixed, review | apigen run-mode `$ref` crash behind the generated CLI |
| `a99fe8dd` | open | Module format ungoverned; dispatch-cli's `module` field and ES build |
| `6ffc4f9b` | open | Missing tags on apigen-base-errors (sibling of f20afd65) |
| `d565dbad` | open | Empty placeholder plan directories |

## 8. Gaps found while testing

Each gap was reproduced or read in code on 2026-10-21, and every one is filed.

| Gap | Item |
|---|---|
| Only `--dag-path` to an existing file; no create or author path | be1e6ef3, 6afff610 |
| No REPL, no turn-taking, no agent selection | 6afff610, af826533 |
| No way to turn a backlog plan into a DAG or write outcomes back | b7c4bf6e |
| `validate` throws on non-DagJson input (exit 1, raw TypeError from `normalizeDag`) | 5ee17367 |
| Orchestrator and `DagClient` write whole documents from stale copies | ade520c9, 91f591cf |
| Run lock is fail-fast and not reentrant, so a session cannot hold it and also write | 91f591cf, 6afff610 |
| No turn or cost cap in product code; the harness guard reads agents.db with better-sqlite3 | e04a69e8 |
| No way to keep a session or test off the production stores, and nothing says which stores are used | 3b715df2 |
| agent-mcp pulls prices from a hard-coded OpenRouter URL on every fresh store | 17eee8c6 |
| agent-mcp's composition root is entrypoint-only and mutates process.env at import | ce7ffc4e |
| `runCycleCore` never closes the runner it builds | 432c9933 |
| Run debug dir resolved from `process.cwd()` at import | 3adf552b |
| Runner never reconnects after a dropped child | cd33eab3 |
| `run` is a single cycle | ac0c1364 |
| HITL suspension has no in-session exit | 6afff610 (report), b629c8c6 (answer) |
| `@latest` agent-mcp is unpinned (`core.ts:425-426`) | 6afff610 |
| Guard shell commands run ungated; no ask branch in the fs.* policy | f4ceea85 |
| No stdio e2e on `ADHD_AGENT_ANTHROPIC_BASE_URL` | b6b1f7d8 |
| Parity docs claim the env var never reaches the SDK | 6e8d960b |
| README dead path; `--version` reports 0.0.1 | 2ea81c4f |
| No authoring or session guide | 43126d09 |
| Duplicated native-tooling dependency | c5b46c88 |
| `real-e2e.ts` runs in no lane | a836f923 |
| dispatch-cli emits ESM against ADR-0003 | a99fe8dd |
| dispatch packages lack `domain:`/`pkg-kind:` tags | f20afd65 |
| Stale plan corpus has no superseded banners | 126c4d02 |

## 9. Docs that should get a superseded banner

Not edited by this plan; tracked in 126c4d02.

- `docs/plan/dispatch-completion/README.md`, plus `SCOPE.md` and `PLAN_STATE_MACHINE_PROPOSAL.md` in that directory
- `docs/product/dispatcher-platform/GAP-MATRIX.md`
- `docs/product/dispatcher-platform/ROADMAP.md`: §3.4, §6 I2 and §8 decision 2
- `docs/product/dispatcher-platform/STRUCTURE.md`: the interactive-surface section
- `docs/plan/backlog-interface-v2-dispatch/`: empty; remove with approval

## 10. Risks

| Risk | Mitigation |
|---|---|
| S1 live runs are uncapped (accepted by the owner) | Dry-run is the default; live needs `--live --yes`; single cycles only until e04a69e8, which blocks the multi-cycle loop ac0c1364 |
| A session writes into production stores | Production is the intended default; the banner names every store before the first write, and `--sandbox` isolates them with a sentinel test |
| A forgotten env variable flips stores silently | The sandbox is flag-only (§3.3) |
| Lost updates under parallel editors or during a run | Delta writes through `update()` (91f591cf), proven with two real processes |
| A dropped or leaked child process | One runner per session, closed on exit and SIGINT (432c9933); reconnect in S1 (cd33eab3) |
| S1 is rebuilt when the engine runner lands | S1 is written against `IDispatchAgentRunner` with metering as a port method (§3.4, §3.5) |
| Routing writes into the production registry unasked | No implicit selector creation; `router init` is explicit and prints the banner (§3.6) |
| Backlog write-back from a dry run, or under the write lock | Write-back is live-only, runs after commit outside the lock, is idempotent and reports failures (§3.7) |
| An ESM dependency enters a CJS-emitting package | No new dependency in S1; commander pinned exact at 14.0.3; the engine's ESM dependencies are part of ce7ffc4e |
| Tests drive a mock and miss the real path | The session e2e drives the built bin over piped stdin against a real agent-mcp with only the model and price feed faked |

## 11. Open decisions for the owner

1. **S1 start (7da11874).** Start S1 now on the stdio agent-mcp child, as the architect recommends, or wait for the in-process engine you prefer. Either way S1 is written against the runner port, so starting now costs no rework.
2. **ADR-0001 D4 scope ruling (3b847644).** Accept, amend or reject the proposed ADR-0017. It gates the engine path, not S1.
3. **Composition-root package (ce7ffc4e).** Approve or reject the new package, and pick the engines approach (a Node >=20.19/22.12 floor, or replacing the ESM-only dependencies). Both are prerequisites for the engine path.
4. **Sandbox env mirror.** Keep `--sandbox` flag-only (architect and product recommendation) or add an env mirror for harnesses.
5. **The new package 70e61986.** Approve or reject the dispatch MCP tool surface. Nothing before S3 depends on it.
6. **The agent-mcp version pin.** The default launch version: the workspace version, or a recorded known-good one. Moot if the engine runner replaces the child.
7. **084c9d6e.** Close the "cancel interactive lane" gate in favour of this plan?
8. **ROADMAP §8 decision 2.** Ratify that the interactive surface is `dispatch-cli session`.
9. **Owner of the paid gate.** Name the owner recorded for parent AC2.
10. **Corpus cleanup.** Approve the banners in §9 and removal of the empty directory.
