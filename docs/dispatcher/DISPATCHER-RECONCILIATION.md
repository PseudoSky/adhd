# The Three Dispatchers — Reconciliation

> **Status:** reconciliation of three independently-evolved "dispatch" concepts in
> the `@adhd` ecosystem. **Doc-only; no code change.** Resolves `cb2cec85`
> (`Reconcile three independent dispatcher concepts: dispatch-cli, backlog, and agent-mcp`).
>
> This document does **not** propose a merge. The three systems serve different
> purposes and are intentionally separate. Its job is to make the boundaries,
> overlaps, and integration points explicit, so the next developer knows *which*
> dispatcher to extend and *how* they relate.

## 0. TL;DR

| # | System | One-line role | Dispatch primitive | "Task" unit |
|---|--------|---------------|--------------------|-------------|
| 1 | **dispatch-cli** (`entrypoint/dispatch-cli` + `packages/dispatch/*`) | Plan-level DAG scheduler: validate → snapshot → optimize → run → calibrate a `dag.json` | `DagClient` / `OrchestratorCycle` | a milestone's `DispatchUnit` |
| 2 | **backlog** (`entrypoint/backlog`) | Graph-based multi-agent issue tracker: CRUD, lifecycle, claims, dependencies | `GraphBacklogStore` + item lifecycle transitions | a backlog **item** |
| 3 | **agent-mcp** (`entrypoint/agent-mcp`) | Runtime that actually runs an AI agent loop: providers, tools, sessions, HITL | `Orchestrator` + `BackgroundQueue` | a **task** (one prompt to one session) |

**Today they chain right-to-left at exactly one seam:** dispatch-cli spawns
agent-mcp as a subprocess (`AgentMcpRunner`) to execute a milestone's work.
Backlog is *not* in that chain — it is a parallel, independent dispatch model.
The shared trait is only the *word* "dispatch": all three schedule units of work,
none of them share a type, interface, or protocol.

## 1. What each dispatcher actually is

### 1.1 dispatch-cli — plan-level DAG orchestration

Purpose: take a plan's `dag.json` and move milestones through a dependency graph.

- **Commands** (7, all non-interactive): `validate`, `snapshot`, `optimize`,
  `eligible`, `status`, `run`, `calibrate` — registered in
  `entrypoint/dispatch-cli/bin/cli.ts` (`.command('validate')`…`.command('calibrate')`,
  lines 60–156; `run` at 120–144).
- **Contract surface:** `entrypoint/dispatch-cli/src/api.ts` — plain async
  functions (`validate`/`snapshot`/`optimize`/`eligible`/`status`/`run`/`calibrate`,
  lines 56–193) that delegate to `src/lib/core.ts`. This is the same file an
  apigen CLI *would* project, but the generated projection is broken for 5 of 7
  commands and the hand-written Commander fallback (`bin/cli.ts`) is the shipped
  path (see `api.ts` lines 134–148).
- **Abstractions** (`packages/dispatch/`): `DagClient` (CRUD over `dag.json`),
  `DagSnapshot` (cost estimation), `DispatchUnit` (packed work), `OrchestratorCycle`
  (snapshot → optimize → dispatch → persist).
- **Runners:** `MockAgentRunner` (default; free, deterministic) or `AgentMcpRunner`
  (paid; spawns `npx -y @adhd/agent-mcp`) — selected by `run`'s `dryRun` flag
  (`bin/cli.ts` lines 121–144).
- **State:** `dispatch_log` entries appended to the `dag.json` as work completes.

### 1.2 backlog — graph-based issue lifecycle

Purpose: track units of work as graph nodes/edges, safely under many concurrent
writers, with a claim/transition lifecycle and dependency traversal.

- **Store:** `GraphBacklogStore` (`entrypoint/backlog/src/store/graph-backlog-store.ts`)
  over SQLite + SOX nodes/edges, with an audit log of events.
- **Operation surface:** the apigen extraction file `entrypoint/backlog/src/api.ts`,
  mounted to three transports from **one** definition: CLI, MCP (stdio), and HTTP
  (Fastify). `entrypoint/backlog/src/server.ts` header (lines 2–3): *"apigen MOUNT
  wiring (DESIGN.md §7): extract() → composeSchemas() → plugin.run(). NO apigen
  generate, no nx codegen executor…"*. The MCP mount is wired at `server.ts:906`
  (`options: { transport: 'stdio', usePlugins: [tracingPlugin, batchPlugin] }`).
- **Dispatch pattern:** an item's *lifecycle transitions* (`claim`/`renew`/`release`,
  status changes) plus dependency-graph traversal. "Dispatching" in backlog means
  **moving an item through its states**, not running a model.
- **Status:** shipped; MCP + CLI + HTTP derive from one code-first definition.

### 1.3 agent-mcp — the agent runtime

Purpose: actually run an AI agent loop — provider calls, tool calls, sub-agent
delegation, HITL suspension/resume, budget/policy, usage accounting — for one task.

- **Server:** `entrypoint/agent-mcp/src/server.ts` — `createServer(deps)` (line 309)
  wires 16 MCP tools: `agent_create`/`agent_read`/`agent_update`/`agent_delete`/
  `agent_list`, `agent`, `session_list`/`session_close`/`session_clear`,
  `task`/`task_list`/`task_cancel`/`task_resume`, `result`, `usage_query`, `guide`
  (ListTools at 472–566; CallTool switch at 568–732). A **second**, delegation-only
  wiring exists as `inProcessDescriptors`/`inProcessHandler` (lines 321–470) —
  the same 11 runtime ops, duplicated; this duplication is what the apigen
  multi-surface design (`d78c8b1a`) eliminates.
- **Abstractions:** `Orchestrator` (the task dispatch loop), `BackgroundQueue`,
  `ProviderRouter`, `SessionStore`, `TaskStore`, `HookRegistry`, `PolicyEngine`.
- **Streaming:** `src/streaming/event-bus.ts` (typed `TaskStreamEvent`s) →
  `src/streaming/sse-server.ts` (`GET /tasks/:id/stream`) and an OpenAI-compatible
  facade `src/streaming/chat-gateway.ts` (`/v1/chat/completions`,
  `/v1/models`) — see `docs/agent-mcp/agent-mcp-chat-gateway/SPEC.md`.
- **Boot:** `src/index.ts` `main()` (line 219) constructs stores/queue/orchestrator,
  starts the SSE server (line 307), then the MCP server (`startServer`, line 320).
- **Status:** shipped, published — a real external compatibility surface (MCP host
  configs; MCP tool names + payload shapes).

## 2. Where they overlap

All three schedule work and persist its outcome, so the overlaps are real but
shallow:

1. **A "task" for each** — `DispatchUnit` (dispatch-cli), backlog `item`, agent-mcp
   `task` (`tasks` table + `task_usage`). Different granularity, different schema.
2. **A lifecycle** — dispatch-cli milestone status, backlog item status, agent-mcp
   task status (`pending`/`running`/`awaiting_input`/`completed`/`failed`/`cancelled`).
   Three vocabularies, no shared enum.
3. **A runner/spawn step** — dispatch-cli's `AgentMcpRunner.fire()` calls agent-mcp's
   MCP `task` tool (`packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts`
   lines 400–411); backlog's `claim`/`release` is a *human/multi-agent* work claim,
   not a process spawn.
4. **Usage/accounting** — dispatch-cli queries `usage_query` (agent-runner.ts
   `queryTurns`, lines 427–444); agent-mcp owns `task_usage`; backlog has none.
5. **Dependency structure** — dispatch-cli's `dag.json` graph and backlog's item
   graph are *both* DAGs. They are structurally similar and semantically unrelated:
   one schedules milestones, the other tracks issues.

## 3. Where they are *intentionally* different

| Axis | dispatch-cli | backlog | agent-mcp |
|------|--------------|---------|-----------|
| Unit | milestone (DAG node) | issue item | task (prompt→session) |
| Trigger | plan file + CLI run | human/agent lifecycle verbs | MCP tool call |
| Concurrency model | one scheduling cycle, persisted to `dag.json` | many concurrent writers, claim/lease | one process per host connection; internal queue |
| Persistence | `dag.json` + `dispatch_log` | SQLite graph (nodes/edges/audit) | SQLite (agents/sessions/tasks/usage) |
| Streaming | none (poll to terminal) | none | SSE + OpenAI gateway |
| Cost model | estimates + calibration; mock default | none | real, per-call usage accounting |
| Transport | CLI only | CLI + MCP + HTTP | MCP + HTTP/SSE |

These are **not** accidents of drift. dispatch-cli is a *plan executor*; backlog is
a *coordination ledger*; agent-mcp is an *execution runtime*. Collapsing them would
force one model to be wrong about the other two's concerns (e.g. giving backlog a
provider loop, or giving the runtime a claim/lease ledger).

## 4. How they interact today

```
                 ┌────────────────────────────────────────────┐
   dag.json ───▶ │ dispatch-cli run (--no-dry-run)             │
                 │   OrchestratorCycle: snapshot→optimize→     │
                 │   dispatch→persist                         │
                 └───────────────────┬────────────────────────┘
                                     │ AgentMcpRunner.fire()
                                     │  (MCP tool: task)
                                     ▼
                 ┌────────────────────────────────────────────┐
                 │ agent-mcp (subprocess, npx @adhd/agent-mcp)│
                 │   Orchestrator → provider → tools → HITL   │
                 │   task_usage persists; result/usage_query  │
                 └────────────────────────────────────────────┘

   backlog ─ ─ ─ ─ ─ ─ ─ ─ ─  (independent; no link today)  ─ ─ ─ ─ ─ ▶
```

- **The one real coupling:** dispatch-cli → agent-mcp, via `AgentMcpRunner`
  (`packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts`). `fire()` calls
  the MCP `task` tool and returns a `task_id` (400–411); `poll()` calls the MCP
  `result` tool until terminal (413–421). **agent-mcp does not know it is being
  driven by dispatch-cli** — the dependency is one-directional and invisible to
  the runtime.
- **backlog ↔ the other two: no link.** backlog items do not drive dispatch-cli
  DAGs, and backlog does not invoke agent-mcp. The only relation is conceptual.

## 5. How they *could* interact in future (named, not committed)

These are candidate integrations the ecosystem would benefit from; each is a
separate design decision, not implied by this document:

1. **backlog item → dispatch-cli DAG.** A backlog item could *emit* a small
   `dag.json` (or a single milestone) and hand it to `dispatch-cli run`. This makes
   the issue ledger the front door and the plan executor the engine. Requires a
   stable item→milestone mapping (schema/contract decision).
2. **Shared event/hook model.** agent-mcp's `HookRegistry` + `TaskStreamEvent`
   (`event-bus.ts`) are the natural spine for a cross-system event stream
   (milestone started, item claimed, task token, task done). The enrichment-plugin
   and `dispatch-plugin-*` efforts would consume it. Requires defining the envelope,
   not merging the systems.
3. **dispatch-cli consuming agent-mcp's SSE.** Already in flight: `c667a213`
   (`--follow` renderer) subscribes dispatch-cli's run output to agent-mcp's
   `GET /tasks/:id/stream` instead of polling `AgentMcpRunner.poll()` to terminal.
   This is the first *live* integration — and it stays one-directional.
4. **backlog driving plan lifecycle.** Plan milestones could be mirrored as backlog
   items (or vice versa) so `dispatch-cli`'s `dispatch_log` and backlog's audit
   trail are reconcilable. This is the `FEAT-BACKLOG-002` cross-repo concern.

## 6. Shared vs intentionally-separate abstractions

**Candidates to share** (thin contracts, worth extracting *if* two systems need
them; do not extract speculatively):

- A **task/milestone status enum** (currently three vocabularies).
- An **event envelope** for the hook/stream spine (§5.2).
- A **usage/accounting read contract** (agent-mcp owns it; dispatch-cli already
  reads it via `usage_query`).

**Intentionally separate — do NOT unify:**

- The **store layer**: `dag.json` (plan file), backlog's SOX graph, and agent-mcp's
  agent/session/task DB have different lifecycles, locking, and consumers.
- The **scheduling semantics**: dependency-gated milestone batching vs claim/lease
  item coordination vs provider/tool agent loop.
- The **transport surfaces**: dispatch-cli is CLI-only by design; backlog derives
  CLI+MCP+HTTP from one definition; agent-mcp is MCP+HTTP with streaming.
- **agent-mcp's runtime internals** (Orchestrator, ProviderRouter, queue, HITL):
  these are its reason to exist and must not be reshaped to serve the other two.

## 7. Decision guidance for the next developer

- Extending **plan execution** (DAG, cost, calibration, milestone scheduling) →
  `dispatch-cli` + `packages/dispatch/*`.
- Extending **work tracking** (items, claims, dependencies, lifecycle, audit) →
  `backlog`.
- Extending **agent execution** (providers, tools, sessions, HITL, usage) →
  `agent-mcp`.
- Need cross-system behavior → build a **thin contract** (§6) and integrate at a
  seam (§5), do not merge the systems.

---

*Citations: `entrypoint/dispatch-cli/bin/cli.ts:60-156`; `entrypoint/dispatch-cli/src/api.ts:56-193`; `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts:400-444`; `entrypoint/backlog/src/server.ts:2-3,878,906`; `entrypoint/backlog/src/api.ts`; `entrypoint/backlog/src/store/graph-backlog-store.ts`; `entrypoint/agent-mcp/src/server.ts:309,321-470,472-732`; `entrypoint/agent-mcp/src/index.ts:219,307,320`; `entrypoint/agent-mcp/src/streaming/event-bus.ts`; `entrypoint/agent-mcp/src/streaming/sse-server.ts:34`; `entrypoint/agent-mcp/src/streaming/chat-gateway.ts`; `docs/agent-mcp/agent-mcp-chat-gateway/SPEC.md`.*
