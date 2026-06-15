# agent-mcp Backlog

Actionable, tracked work items for `@adhd/agent-mcp`: bugs to fix, features to
build, and tech debt to pay down.

**How this relates to the other docs:**
- **[ROADMAP.md](./ROADMAP.md)** — strategic, scored feature planning ("what to build and why, in what order"). High-level.
- **[CHANGELOG.md](./CHANGELOG.md)** — what shipped, per version.
- **CLAUDE.md → Key design decisions** — durable behavioral invariants/caveats of shipped code (the "why does it behave this way" reference for maintainers).
- **BACKLOG.md** (this file) — concrete, prioritized work items ready to pick up. When an item ships, move it to the **Done** section here and add a CHANGELOG entry.

> Note: the former `GAPS.md` was retired — its open items became backlog entries
> (below), its shipped items became CHANGELOG entries, and its intentional
> behavioral caveats moved to CLAUDE.md's Key design decisions.

---

## Conventions

**ID scheme:** `BUG-NNN`, `FEAT-NNN`, `DEBT-NNN` (zero-padded, never reused).

**Each entry uses this structure:**

```
### <ID> — <short title>
- **Status:** backlog | in-progress | blocked | done | wontfix
- **Priority:** P0 (drop everything) | P1 (next) | P2 (soon) | P3 (someday)
- **Area:** <subsystem, e.g. streaming, engine, db, providers, tools>
- **Reported:** <YYYY-MM-DD> (· **Closed:** <YYYY-MM-DD> when done)

**Problem / Description** — what's wrong or what's wanted, and why it matters.

**Impact** — who/what is affected and how badly.

**Proposed fix / Approach** — the intended direction (not binding).

**Acceptance criteria** — how we know it's done (testable).

**References** — files, commits, issues, related ROADMAP/CHANGELOG entries.
```

**Priority legend:** P0 = breaks production / data loss; P1 = significant
user-facing defect or high-value feature; P2 = worthwhile, not urgent; P3 =
nice-to-have / cleanup.

---

## 🐞 Bugs

### BUG-001 — SSE server crashes the whole process on `EADDRINUSE`
- **Status:** backlog
- **Priority:** P1
- **Area:** streaming (`src/streaming/sse-server.ts`, `src/index.ts`)
- **Reported:** 2026-06-15

**Problem / Description**
The server unconditionally starts the SSE HTTP server on a fixed port
(`SSE_PORT`, default `3001`) at startup. If that port is already in use, the
HTTP server emits an `'error'` event (`Error: listen EADDRINUSE ... :3001`) that
is **not handled**, so Node throws it as an unhandled `'error'` event and the
**entire MCP server process exits** — even though the core MCP stdio transport
and the DB are fine. Surfaced by the 1.0.0 post-publish smoke test when a second
agent-mcp instance booted while another already held `3001`.

**Impact**
Any environment where `3001` is occupied (a second agent-mcp instance, another
service, a leftover process) cannot start agent-mcp at all. The failure is
opaque (a raw stack trace, not an actionable error) and takes down a server
whose primary function (stdio MCP) never needed the port.

**Proposed fix / Approach**
- Attach an `'error'` handler to the SSE `http.Server` and fail gracefully:
  log an actionable warning and either (a) continue running with SSE disabled,
  or (b) bind to an ephemeral port (`listen(0)`) and report the chosen port.
- Consider making SSE **opt-in** (only start it when a task actually requests
  `stream: true`, or behind an env flag) rather than always-on at boot.
- Make the port configurable and documented (it already reads `SSE_PORT`).

**Acceptance criteria**
- Starting a second agent-mcp instance (or any process holding `3001`) does
  **not** crash the server; the MCP stdio transport still works.
- A test binds `3001`, boots the server, and asserts the process stays alive
  and serves MCP (SSE disabled-or-rebound, with a logged warning).

**References**
- `src/streaming/sse-server.ts` (`startSseServer`), `src/index.ts` (boot order:
  migrate → MCP stdio → SSE).
- Smoke evidence: `Error: listen EADDRINUSE: address already in use 127.0.0.1:3001`.
- Related: streaming subsystem (see CHANGELOG 1.0.0 → SSE streaming; FEAT-001).

**Follow-up — audit for other unhandled exceptions (tracked as [DEBT-001]).**
This bug is one instance of an unhandled async/event error taking down the
process. We should investigate what **other** unhandled exceptions / unhandled
promise rejections / unhandled `'error'` events exist (SSE writes, provider
network calls, stdio transport, better-sqlite3, the background queue) and add a
consistent top-level safety net. See DEBT-001.

---

## ✨ Features

### FEAT-001 — Per-token (incremental) streaming
- **Status:** backlog
- **Priority:** P2
- **Area:** streaming, providers
- **Reported:** 2026-06-15

**Problem / Description**
Task-level SSE streaming shipped in 1.0.0 (`tool_call`/`tool_result`/
`status_change`/`done`), but `token` events are defined in the
`TaskStreamEvent` union and never emitted. The `LLMProvider` interface returns
a complete `ProviderChatResponse`, not a streaming iterator, so per-token output
isn't surfaced.

**Impact**
No live token-by-token output to consumers; UIs can't render tokens as they
arrive.

**Proposed fix / Approach**
Breaking `LLMProvider` change to support an async-iterator/streaming mode; emit
`token` events through the existing `EventBus`. `claudecli` already streams
internally via `--output-format stream-json` and could forward once the
interface supports it.

**Acceptance criteria**
- Providers can stream tokens; `token` events arrive on `/tasks/:id/stream`
  before `done`; existing non-streaming callers unaffected.

**References** — `src/providers/types.ts`, `src/streaming/*`. (Migrated from GAPS §3; was "deferred to 0.5.0".)

### FEAT-002 — Agent & task metrics plugin (`@adhd/metrics-plugin`)
- **Status:** backlog
- **Priority:** P2
- **Area:** observability (plugin over `task_usage` + `tasks`)
- **Reported:** 2026-06-15

**Problem / Description**
No aggregated visibility: which agent is most expensive, success rate over a
window, slowest tasks, tokens per agent. Only raw `task_usage`/`tasks` rows.

**Impact** Cost attribution, perf tuning, and anomaly detection require manual querying.

**Proposed fix / Approach**
`@adhd/metrics-plugin` exposing `agent_metrics`, `task_metrics` (incl. recursive
subtree cost via `root_task_id`), and `metrics_summary` — all read-only over
`task_usage` + `tasks`. Depends on the shipped token-usage tracking.

**Acceptance criteria** Three MCP tools return correct rollups; no new hooks required.

**References** — ROADMAP Strategic 8.10 (highest-scored MOAT feature). (Migrated from GAPS §5.)

### FEAT-003 — Queue priority levels + per-agent concurrency limit
- **Status:** backlog
- **Priority:** P2
- **Area:** engine (`src/engine/queue.ts`)
- **Reported:** 2026-06-15

**Problem / Description**
The background queue is a `p-queue` wrapper with no priority levels, and there's
no per-agent concurrency cap — only a server-wide `QUEUE_CONCURRENCY`.

**Impact** No way to prioritise urgent tasks; one hot agent can starve others under load.

**Proposed fix / Approach** Add priority levels to the queue; add a per-agent concurrency cap (config on the agent definition or server).

**Acceptance criteria** Higher-priority tasks dispatch first; a per-agent cap is enforced independently of the server-wide limit.

**References** — `src/engine/queue.ts`. (Migrated from GAPS §4 Phase-1 items.)

---

## 🔧 Tech Debt / Improvements

### DEBT-001 — Audit & harden against unhandled exceptions across the server
- **Status:** backlog
- **Priority:** P1
- **Area:** server-wide (streaming, providers, engine/queue, db, transport)
- **Reported:** 2026-06-15

**Problem / Description**
BUG-001 showed a single unhandled `'error'` event (SSE `EADDRINUSE`) can crash
the whole process. There are likely other paths where an async error, a
rejected promise, or an emitter `'error'` event is not caught and would take the
server down or silently swallow a failure. We have no top-level safety net
(`process.on('uncaughtException' / 'unhandledRejection')`) and no systematic
review of error handling on long-lived resources.

**Impact**
Latent crash/hang risk in production; failures that should degrade gracefully
instead kill the server or disappear.

**Proposed fix / Approach**
- Inventory every long-lived resource and async boundary and confirm each has
  an error path: SSE `http.Server` + response streams, the background queue
  (`engine/queue.ts`), provider network calls (anthropic/openai/claudecli
  subprocess), stdio MCP transport, better-sqlite3 handles, the event bus.
- Add a top-level `process.on('uncaughtException')` / `'unhandledRejection')`
  handler that logs structured context and exits deliberately (or recovers
  where safe) instead of crashing opaquely.
- Add tests that inject failures at each boundary and assert graceful handling.

**Acceptance criteria**
- A documented list of error boundaries and their handling status.
- No unhandled `'error'`/rejection path on the known long-lived resources.
- Tests covering at least the SSE, queue, and provider error paths.

**References**
- Triggered by BUG-001.
- Likely files: `src/streaming/*`, `src/engine/queue.ts`, `src/providers/*`,
  `src/index.ts`, `src/db/client.ts`.

### DEBT-002 — `claudecli` provider: tool calls invisible to hooks, policy, and events
- **Status:** backlog
- **Priority:** P2
- **Area:** providers (`src/providers/claudecli.ts`), engine
- **Reported:** 2026-06-15

**Problem / Description**
For a `claudecli` agent, the whole tool exchange (tool call → result → next
turn) happens inside the `claude` subprocess. The orchestrator's tool-use loop
never fires, so `pre:tool_call` / `post:tool_call` hooks and
`TOOL_CALL`/`TOOL_RESULT` task events are not emitted, and policy checks
(max tool loops, delegation allowlist) are skipped for those calls. The final
result is still returned correctly.

**Impact**
Hook consumers, the task event log, and delegation-policy enforcement are all
blind to claudecli tool calls.

**Proposed fix / Approach**
Either (a) surface tool calls out of the subprocess via `stream-json` and
re-emit them into the orchestrator's event/policy system, or (b) accept it as a
fundamental subprocess-model limitation and document it clearly (consider
`wontfix` + a prominent caveat).

**Acceptance criteria**
- Tool calls by claudecli agents emit events + are policy-checked, **or** the
  limitation is explicitly documented and the entry closed as `wontfix`.

**References** — `src/providers/claudecli.ts`. (Migrated from GAPS §1.)

### DEBT-003 — Tighten cancellation latency (thread `signal` into `callTool`)
- **Status:** backlog
- **Priority:** P3
- **Area:** engine (`src/engine/orchestrator.ts`, clients)
- **Reported:** 2026-06-15

**Problem / Description**
The task-cancellation `AbortSignal` is not threaded into individual
`client.callTool()` calls, so aborting mid-batch lets all in-flight tool calls
run to completion before the abort is observed on the next loop iteration.
Pre-existing (sequential code didn't abort mid-tool either), but the parallel
(`Promise.all`) dispatch widened the window.

**Impact** Cancellation is slower than necessary; in-flight tool calls aren't interrupted.

**Proposed fix / Approach** Pass the composed `signal` through to `callTool`; have clients honor it.

**Acceptance criteria** A cancel mid-batch aborts in-flight tool calls (or returns promptly) rather than waiting for the whole batch to settle.

**References** — `src/engine/orchestrator.ts`. (Migrated from GAPS §8 item 3.)

---

## ✅ Done

_Move closed `BUG-/FEAT-/DEBT-` entries here with their **Closed** date, or link_
_to the commit/PR. (Empty for now — this file was created in 1.0.0.)_
