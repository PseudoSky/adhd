# agent-mcp Backlog

Actionable, tracked work items for `@adhd/agent-mcp`: bugs to fix, features to
build, and tech debt to pay down.

**How this relates to the other docs:**
- **[ROADMAP.md](./ROADMAP.md)** — strategic, scored feature planning ("what to build and why, in what order"). High-level.
- **[GAPS.md](./GAPS.md)** — known implementation gaps / limitations of *shipped* behavior, with a fix path. Descriptive.
- **BACKLOG.md** (this file) — concrete, prioritized work items ready to pick up. When a backlog item ships, mark it `done` here and, if it closed a gap, update GAPS.md.

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

**References** — files, commits, issues, related GAPS/ROADMAP entries.
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
- Related: GAPS.md §3 (streaming).

**Follow-up — audit for other unhandled exceptions (tracked as [DEBT-001]).**
This bug is one instance of an unhandled async/event error taking down the
process. We should investigate what **other** unhandled exceptions / unhandled
promise rejections / unhandled `'error'` events exist (SSE writes, provider
network calls, stdio transport, better-sqlite3, the background queue) and add a
consistent top-level safety net. See DEBT-001.

---

## ✨ Features

_None tracked yet. Strategic feature candidates live in [ROADMAP.md](./ROADMAP.md);_
_promote one here (as `FEAT-NNN`) when it's scoped and ready to build._

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

---

## ✅ Done

_Move closed `BUG-/FEAT-/DEBT-` entries here with their **Closed** date, or link_
_to the commit/PR. (Empty for now — this file was created in 1.0.0.)_
