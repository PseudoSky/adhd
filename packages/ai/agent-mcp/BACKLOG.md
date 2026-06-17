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

### BUG-002 — Delegation-opened sessions are never reaped → leak + undeletable sub-agent
- **Status:** done (in source; ships in the next publish) · **Closed:** 2026-06-16
- **Priority:** P2
- **Area:** engine (orchestrator), store/session, store/agent
- **Reported:** 2026-06-15

**Resolution (2026-06-16):** Two complementary fixes. (1) **Orchestrator reap**: `Orchestrator.run()` now tracks a `delegationSessions: Set<string>` — every `agent-mcp__agent` tool call result is inspected for a `session_id`; on failure or cancellation (i.e. `!taskSucceeded`) the `finally` block closes each tracked session, suppressing `SESSION_CLOSED` errors for races. Sessions are NOT closed on success so the caller can continue using them. (2) **`agent_delete` force flag**: `agentDeleteInputSchema` gains an optional `force: boolean`; `agentDelete()` lists active sessions and closes them before calling `agentStore.delete()` when `force: true` — the recovery escape hatch for existing orphans. `AgentCrudDeps` now includes `sessionStore`; all five crud call sites in `server.ts` updated. Tested in `__tests__/bug-002-session-reap.test.ts` (6 tests: failure closes sessions, success doesn't, cancel closes, force closes+deletes, no-force skips, force swallows SESSION_CLOSED; teeth verified by reverting the respective code paths).

**Problem / Description** — A session created during a task (e.g. an orchestrating
agent calls the `agent` tool to instantiate a stateful session for a sub-agent)
is **only** closed by an explicit `session_close`. Nothing reaps it when the
creating task reaches a terminal state. `SessionStore.create()` always writes
`status: "active"` (`store/session-store.ts:32`); the orchestrator's `finally`
only tears down the MCP client registry (`registry.closeAll()`,
`engine/orchestrator.ts:604-606`) — it does **not** close sessions; and a
stdio-spawned child server dying leaves its DB session rows `active`. So if a
delegating task **fails mid-delegation**, the sub-agent's session is orphaned in
`active` forever. Because `AgentStore.delete()` hard-refuses when any session for
the agent is `active` (`store/agent-store.ts:108-121`, `AGENT_HAS_ACTIVE_SESSIONS`),
that sub-agent becomes **undeletable** until someone manually finds and closes the
orphan session.

**Reproduction (observed):** in the code-tasking study's orchestration test, a
`lead` agent delegated to `synth-coder` (opening a session), then the `lead` task
failed (`PROVIDER_ERROR` — unrelated tool-naming trip). The `synth-coder` session
stayed `active`; `agent_delete synth-coder` then failed with
`AGENT_HAS_ACTIVE_SESSIONS`. Manual recovery: `session_list {agentName, status:active}`
→ `session_close` → `agent_delete`.

**Impact** — Session/row leak on every failed (or never-explicitly-closed)
delegation, and orchestrator sub-agents accumulate undeletable definitions. Hits
any recursive/orchestration workload, exactly where reliability matters most.
Silent: the only symptom is a later `AGENT_HAS_ACTIVE_SESSIONS`.

**Proposed fix / Approach** — Distinguish *delegation-scoped* sessions (opened by
an orchestrating task for a sub-agent) from *user-persistent* sessions (meant to
outlive a task for multi-turn): the former should be closed when the parent task
reaches a terminal state (track session ids opened during the task; close them in
the orchestrator `finally`, including the failure path). User-persistent sessions
must **not** be auto-closed. As an operational escape hatch, add a
`force`/`cascade` option to `agent_delete` that closes the agent's `active`
sessions and then deletes. Optionally reap sessions idle past a TTL on startup.

**Acceptance criteria**
- An orchestration where the parent task **fails** after opening a sub-agent
  session leaves **no** `active` orphan session (integration test drives a real
  lead→sub-agent delegation, forces the parent to fail, then asserts
  `session_list {status:"active"}` is empty and `agent_delete` succeeds).
- A user-opened persistent session is **not** closed by an unrelated task ending
  (negative control — must stay `active`).
- `agent_delete {force:true}` closes active sessions and deletes; without `force`
  the `AGENT_HAS_ACTIVE_SESSIONS` guard is unchanged.
- Reverting the fix turns the first test red.

**References** — `engine/orchestrator.ts:604-606` (finally only closes the registry),
`store/session-store.ts:32` (`create` → `status:"active"`), `store/session-store.ts:127`
(`close`), `store/agent-store.ts:108-121` (delete guard). Surfaced by
`docs/agent-mcp/study/code-tasking/` (Experiment 7/8, test-14 orchestration).

> The follow-on "audit for other unhandled exceptions" spawned by BUG-001 is
> tracked separately as **DEBT-001** (still open).

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

### FEAT-002 — Agent & task metrics via `usage_query` `group_by`
- **Status:** done (in source; ships in next publish) · **Closed:** 2026-06-16
- **Priority:** P2
- **Area:** observability (`tools/usage.ts`, `validation/usage.ts`)
- **Reported:** 2026-06-15

**Resolution (2026-06-16):** Added `group_by: "agent" | "model" | "provider"` to
`usage_query`. When set, the query does a LEFT JOIN with `tasks` and aggregates by
the chosen dimension, returning `taskCount`, `completedCount`, `failedCount`,
`cancelledCount`, token totals, `avgLatencyMs` (zero-latency excluded), and cache
tokens per group, ordered by total token spend desc. All existing filters compose
before grouping. No new MCP tool, no plugin, no interface change — the right home
for a query over core-owned tables is the core tool that already owns that surface.
12 tests in `__tests__/usage-group-by.test.ts`.

**Problem / Description**
No aggregated visibility: which agent is most expensive, success rate over a
window, slowest tasks, tokens per agent. Only raw `task_usage`/`tasks` rows.

**Impact** Cost attribution, perf tuning, and anomaly detection require manual querying.

**References** — ROADMAP Strategic 8.10 (highest-scored MOAT feature). (Migrated from GAPS §5.)

### FEAT-004 — External plugin loading via `AGENT_MCP_PLUGINS` env var
- **Status:** done (in source; ships in next publish) · **Closed:** 2026-06-16
- **Priority:** P2
- **Area:** server startup (`index.ts`), types (`agent-mcp-types`)
- **Reported:** 2026-06-16

**Resolution (2026-06-16):** Implemented `loadExternalPlugins()` in `index.ts`.
`AGENT_MCP_PLUGINS` is a comma-separated list of module specifiers (absolute file
paths or npm package names). Each module must export a `createPlugin(ctx: PluginContext): Plugin`
factory as `default` or named export. Resolution order: CWD's `node_modules` first
(covers `npx` and project-installed packages), then the server binary's own location.
Failures are logged at `error` level and skipped — a bad plugin never kills the server.
Added `PluginContext` and `PluginFactory` types to `@adhd/agent-mcp-types`. Documented
both activation paths (env var and hard-wired in `index.ts`) plus the full `.mcp.json`
shape in `PLUGINS.md`.

**Problem / Description** — Plugins were compile-time only (import in `index.ts`,
rebuild). The published `npx @adhd/agent-mcp@latest` entry had no mechanism to
activate external plugins. Users of the published package couldn't add plugins
without forking the package.

**Impact** — Plugin system not usable by external consumers of the published package.

**References** — `src/index.ts` (`loadExternalPlugins`), `packages/ai/agent-mcp-types/src/hooks.ts` (`PluginContext`, `PluginFactory`), `PLUGINS.md`.

---

### FEAT-005 — Enforcement hook API (`registerEnforcement` / `enforce`)
- **Status:** done · **Closed:** 2026-06-17
- **Priority:** P1
- **Area:** engine (orchestrator), types (`agent-mcp-types`)
- **Reported:** 2026-06-17

**Resolution (2026-06-17):** Added `registerEnforcement<E>(event, handler)` and
`enforce<E>(event, payload)` to `IHookRegistry` and `HookRegistry`. Unlike `emit()`,
`enforce()` propagates `IEnforcementError` throws — all other errors are swallowed.
The orchestrator calls `hooks.enforce("pre:model_request")` before every LLM call; an
`IEnforcementError` becomes `ToolError("BUDGET_EXCEEDED")`. New types in
`@adhd/agent-mcp-types@1.1.0`: `IEnforcementError`, `EnforcementEvent`,
`EnforcementHandler`, `EnforcementEventMap`. `BUDGET_EXCEEDED` added to
`AgentMcpErrorCode`. Tested in `__tests__/enforcement.test.ts`: propagates / swallows /
aborts on first throw; orchestrator bails on 2nd call; "teeth" test distinguishing
`register` from `registerEnforcement`.

**Problem / Description** — `emit()` swallows all handler errors (safety net for
observational plugins). Budget and guardrail plugins need a throw-propagating path to
abort model calls before they are made.

**References** — `packages/ai/agent-mcp-types/src/hooks.ts`,
`packages/ai/agent-mcp-types/src/registry.ts`,
`packages/ai/agent-mcp/src/engine/orchestrator.ts`,
`packages/ai/agent-mcp/src/__tests__/enforcement.test.ts`.

---

### FEAT-006 — `@adhd/agent-mcp-budget` cost budget plugin
- **Status:** done · **Closed:** 2026-06-17
- **Priority:** P2
- **Area:** new package (`packages/ai/agent-mcp-budget/`)
- **Reported:** 2026-06-17

**Resolution (2026-06-17):** Shipped `@adhd/agent-mcp-budget@0.0.2`. Registers a
`pre:model_request` enforcement handler and a `post:model_response` observational
handler. Configurable limits via `configSchema` (Zod): `maxModelCalls`,
`maxTotalTokens`, `maxInputTokens`, `maxOutputTokens`, `maxWallClockMs`, `maxModelMs`,
`maxCostUSD`. Exports `createPlugin` factory and `configSchema` for server-side
validation. Activated via `agent-mcp.config.json`. End-to-end integration tested
against the real built binary in `plugin-loader.test.ts` (both config-file and
`AGENT_MCP_PLUGINS` env-var paths). ROADMAP Strategic 6.98 (MOAT — "Cost budget
enforcement"). See `PLUGINS.md`.

**References** — `packages/ai/agent-mcp-budget/src/index.ts`,
`packages/ai/agent-mcp/src/__tests__/plugin-loader.test.ts`,
`packages/ai/agent-mcp/PLUGINS.md`. ROADMAP feature #4.

---

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
- **Status:** done (in source; ships in the next publish) · **Closed:** 2026-06-16
- **Priority:** P1
- **Area:** server-wide (streaming, providers, engine/queue, db, transport)
- **Reported:** 2026-06-15

**Resolution (2026-06-16):** Completed the error boundary audit and added the missing top-level safety net. Boundary inventory: (a) **SSE server** — `'error'` event handler added in BUG-001; degrades to unavailable on bind failure. (b) **BackgroundQueue** — `catch` in `enqueue()` swallows task errors after the orchestrator's own `try/catch/finally` has already updated task status; rethrowing would turn a per-task failure into an unhandled rejection and kill the server. Added an explanatory comment referencing DEBT-001 to confirm this is intentional. (c) **Orchestrator** — per-task `try/catch/finally` updates status and re-throws to the queue's swallower. (d) **Providers** — `pRetry` wraps network calls; the orchestrator's inner `try/catch` translates provider errors to typed `ToolError` codes. (e) **Top-level gap (now fixed)**: added `process.on("uncaughtException")` + `process.on("unhandledRejection")` handlers in `index.ts` before `main()` — log fatal + `process.exit(1)` so any structural bug that slips through all the per-component handlers produces structured output instead of an opaque crash. Tested in `__tests__/bug-002-session-reap.test.ts` (DEBT-001 section: queue error-swallowing verified with two cases — `onIdle()` resolves after a throwing task, and subsequent tasks still run).

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

---

### DEBT-004 — Orchestration hard-fails when a model calls a bare (unprefixed) tool name
- **Status:** done (in source; ships in the next publish) · **Closed:** 2026-06-16
- **Priority:** P2
- **Area:** providers (openai/anthropic/claudecli), clients/tool-naming
- **Reported:** 2026-06-15

**Resolution (2026-06-16):** added `resolveToolCallName(rawName, advertised)` in
`clients/tool-naming.ts` — a qualified `<server>__<tool>` name splits as before; a
**bare** name resolves against the advertised tool set (unique match → qualify;
ambiguous → actionable error listing the qualified candidates; none → literal split
so downstream "unknown tool" still surfaces). All three providers now call it
instead of throwing "missing server prefix". Tested in `__tests__/tool-naming.test.ts`
(unit: unique/ambiguous/normalized/unknown; **consumer:** the real `OpenAIProvider`
resolves a bare `task` → `{agent-mcp, task}` instead of throwing). Not yet published —
the study's runner uses `@adhd/agent-mcp@1.0.1`, so T14 in the comparison still
reflects the unpatched server until a 1.0.2 publish.

**Problem / Description** — Sub-server tools are exposed to a delegating agent as
`<server>__<tool>` (intentional — see CLAUDE.md "Tool name prefixing"). But when a
model emits the **bare** name (`agent` / `task` instead of `agent-mcp__agent`),
dispatch throws `Invalid tool name (missing server prefix)` and the whole task
fails. Observed in the code-tasking study: `claude-sonnet-4-6`'s `lead` called a
bare `agent` and failed test-14 (`tasks` row `7062edff`). It is **model-specific,
not universal** — in the same study `claude-haiku-4-5` and `qwen2.5-14b` leads used
the prefixed names and orchestrated fine (the `qwen3.5-9b` lead failed test-14 a
different way — empty output). So orchestration reliability currently depends in
part on the model guessing a naming convention rather than purely on capability —
a sharp, silent DX edge: when a model trips it, the whole delegation dies with an
error it can't easily self-correct.

**Impact** — Orchestration/delegation tasks fail non-deterministically by model;
the error is opaque to the model (it can't easily self-correct). Undermines the
recursive-delegation value prop.

**Proposed fix / Approach** — When a called tool name is **unambiguous** across the
registry (exactly one server exposes a tool with that bare name), resolve it
instead of throwing. If ambiguous, throw an actionable error that lists the
qualified candidates (e.g. `agent-mcp__agent`) so the model can retry. Keep the
qualified name canonical for policy/dispatch.

**Acceptance criteria**
- A `lead` whose model calls bare `agent`/`task` completes the delegation (the
  bare name resolves to the single `agent-mcp` server). Integration test drives a
  real orchestration with a stubbed model that emits bare names; reverting the
  resolver turns it red.
- An ambiguous bare name yields an error message naming the qualified candidates.
- Existing prefixed calls and policy checks are unchanged.

**References** — CLAUDE.md "Tool name prefixing"; `clients/registry.ts`
(`listAllTools()` prefixing), `engine/orchestrator.ts` (tool dispatch). Surfaced by
`docs/agent-mcp/study/code-tasking/` test-14 (Experiments 7 & 8).

---

### DEBT-005 — provider `timeoutMs` doesn't bound the OpenAI-SDK client's HTTP timeout
- **Status:** done (in source; ships in the next publish) · **Closed:** 2026-06-16
- **Priority:** P2
- **Area:** providers (`src/providers/openai.ts`)
- **Reported:** 2026-06-16

**Resolution (2026-06-16):** `OpenAIProvider` constructor now passes `timeout: config.timeoutMs ?? 60_000` to `new OpenAI({...})`, aligning the SDK's built-in HTTP timeout with the user-configured value. All `AnthropicProvider` client construction sites (`constructor` + OAuth refresh path in `chat()`) similarly receive `timeout: this.config.timeoutMs`. Without the passthrough, slow models exceeded the SDK's ~10-min default and threw `APIConnectionTimeoutError` ("Request timed out.") — a generic `PROVIDER_ERROR` that bypassed the actionable `PROVIDER_TIMEOUT` path and ignored `timeoutMs` entirely. `LMStudioProvider` inherits the fix through `OpenAIProvider`'s constructor. Tested in `__tests__/debt-005-sdk-timeout.test.ts` (4 tests: explicit timeout, default fallback, large value, LMStudio inheritance; reverting the `timeout:` line makes the constructor-arg assertion fail).

**Problem / Description** — The OpenAI/LM Studio provider constructs `new OpenAI({apiKey, baseURL})`
without a `timeout`, so it uses the SDK default (~10 min). The agent's `timeoutMs` only feeds the
orchestrator's `AbortSignal.timeout()` — it is **not** passed to the SDK client. With a slow local
model, the SDK's own HTTP timeout fires first and throws `Request timed out` (a generic
`PROVIDER_ERROR`), *not* the actionable `PROVIDER_TIMEOUT` ("increase timeoutMs…"), and **raising
`timeoutMs` has no effect**. Observed running a dense 27B reasoning model: long responses (~15 tok/s
× verbose `<think>`) died at the SDK limit regardless of `--timeout 1200000`.

**Impact** — Slow models (large dense / long reasoning) can't complete long generations; the failure
is mislabeled and un-tunable via the documented knob. Bit the code-tasking study (6 of the 27b's
verbose cells DNF'd as `Request timed out`).

**Proposed fix / Approach** — Pass the resolved timeout to the SDK client (or per-request):
`new OpenAI({ …, timeout: this.config.timeoutMs })`, or `client.chat.completions.create(body, { signal, timeout })`. Then `timeoutMs` bounds both the abort signal and the HTTP request consistently.
Consider the same audit for the anthropic provider's client.

**Acceptance criteria** — With a stubbed slow provider, a request that exceeds the SDK default but is
under `timeoutMs` completes (doesn't throw `Request timed out`); one that exceeds `timeoutMs` throws
the actionable `PROVIDER_TIMEOUT`. Reverting the passthrough turns the first test red.

**References** — `src/providers/openai.ts` (client construction + `chat()`); error seen as
"Provider call failed: Request timed out." Surfaced by `docs/agent-mcp/study/code-tasking/`
(Qwen3.5-27B-opus-distilled run, Experiment 12).

---

### DEBT-006 — `HookRegistry` class relocated to `@adhd/agent-mcp-types`
- **Status:** done · **Closed:** 2026-06-17
- **Priority:** P1
- **Area:** types (`packages/ai/agent-mcp-types/`), engine (`packages/ai/agent-mcp/src/engine/hooks.ts`)
- **Reported:** 2026-06-17

**Resolution (2026-06-17):** Moved the concrete `HookRegistry` class from
`packages/ai/agent-mcp/src/engine/hooks.ts` to
`packages/ai/agent-mcp-types/src/registry.ts`. `engine/hooks.ts` is now a one-line
re-export: `export { HookRegistry } from "@adhd/agent-mcp-types"`. Exported from the
`agent-mcp-types` package root so plugin tests can import directly without a server
package dependency. Tested via the existing `enforcement.test.ts` suite (both
`HookRegistry` from `@adhd/agent-mcp-types` and via `agent-mcp` re-export are
exercised end-to-end).

**Problem / Description** — `agent-mcp-budget` tests imported `HookRegistry` from
`@adhd/agent-mcp`, creating a circular Nx project-graph build edge:
`agent-mcp:build → agent-mcp-budget:build → agent-mcp:build`. The Nx graph scanner
tracks all imports, including test files, so `tsconfig.lib.json` exclusions don't
help. Moving `HookRegistry` to the lowest shared package breaks the cycle.

**References** — `packages/ai/agent-mcp-types/src/registry.ts`,
`packages/ai/agent-mcp-types/src/index.ts`,
`packages/ai/agent-mcp/src/engine/hooks.ts`,
`packages/ai/agent-mcp-budget/src/__tests__/budget-plugin.test.ts`.

---

### DEBT-007 — `generate-lib.sh` routing and post-generation patches
- **Status:** done · **Closed:** 2026-06-17
- **Priority:** P2
- **Area:** tooling (`scripts/generate-lib.sh`)
- **Reported:** 2026-06-17

**Resolution (2026-06-17):** Two fixes to `scripts/generate-lib.sh`:
(1) **`agent-mcp-*` routing**: added a guard before the `node-tools` override so any
library named `agent-mcp-*` routes to `packages/ai/` regardless of layer/platform.
Without this, `logic node` packages fell into `packages/node-tools/`. The check runs
first so it takes precedence.
(2) **Post-generation patches**: after scaffolding, the script now applies two
idempotent patches — `emptyOutDir: true` in `vite.config.ts` (prevents stale
`dist/package.json` surviving a version bump) and `dependsOn: ["build","test"]` on
the `nx-release-publish` target in `project.json` (enforces clean build + passing
tests before every publish). Both patches skip if already present. Implemented via
an inline Python3 heredoc (vite config) and a Node.js heredoc (project.json).

**References** — `scripts/generate-lib.sh`.

---

### DEBT-008 — Enforcement API couples core to plugin stop-reason semantics
- **Status:** backlog
- **Priority:** P2
- **Area:** engine (orchestrator), types (`agent-mcp-types`)
- **Reported:** 2026-06-17

**Problem / Description** — The current enforcement path requires the orchestrator
to duck-type `IEnforcementError` (`if (err.isEnforcementError)`) and hard-code a
conversion to `ToolError("BUDGET_EXCEEDED")`. This creates a directional coupling
from the core to plugin-space: the orchestrator must know that a plugin threw
something, and must decide how to surface it as a terminal task state. The same
pattern will repeat for every new enforcement class (guardrails, capability profiles,
cost-per-turn caps) — each adding another `if` branch or a second error code to
the orchestrator's catch block.

More fundamentally, "budget exceeded" is a *stop reason* — structurally identical
to `CONTEXT_WINDOW_EXCEEDED` or `MAX_TOOL_LOOPS_EXCEEDED` — not a plugin exception
that bubbles up through the orchestrator's generic error handler. The current design
accidentally makes the orchestrator's error-handling path into the plugin communication
channel, rather than having plugins signal through a first-class task termination
mechanism.

**Impact** — Every new enforcement category requires a core change (new `if` branch
or new error code in the orchestrator's catch). Plugins cannot declare a stop reason
without knowing how the orchestrator will translate it. The semantics of `enforce()`
are already partially core-aware (the orchestrator must check `isEnforcementError`),
making the "plugin never touches core" invariant aspirational rather than structural.

**Proposed fix / Approach** — Generalize `IEnforcementError` into a
`TaskTerminationSignal` (or extend the existing stop-reason vocabulary) that the
orchestrator recognizes as "terminate task cleanly with this stop reason, no error."
Options:

1. **Stop-reason signal**: `enforce()` resolves (not rejects) with an optional
   `{ terminate: true; reason: AgentMcpErrorCode; message: string }` return value.
   The orchestrator checks the resolved value, not the catch block — cleaner control
   flow, no duck-typing. Enforcement handlers that want to abort return a termination
   object; those that just validate return `undefined`.

2. **Typed abort**: Replace `IEnforcementError` with a dedicated `EnforcementAbort`
   class that extends `Error` and carries a `stopReason: AgentMcpErrorCode`. The
   orchestrator catches `EnforcementAbort` specifically (instanceof check, not
   duck-type) and maps `stopReason` directly to the task failure code — no
   hard-coded `"BUDGET_EXCEEDED"` translation.

3. **Pre:model_request returns a verdict**: `enforce()` aggregates handler results
   into a `{ proceed: boolean; reason?: AgentMcpErrorCode; message?: string }` and
   the orchestrator checks the verdict synchronously — closest to a guardrail
   middleware pattern.

Any of these removes the requirement that the orchestrator know about specific plugin
error codes and decouples the stop-reason vocabulary from the exception hierarchy.

**Acceptance criteria**
- Adding a new enforcement stop reason (e.g. `CAPABILITY_VIOLATION`) requires no
  change to orchestrator code — only a new `AgentMcpErrorCode` value and a plugin
  handler.
- The orchestrator's catch block has no `isEnforcementError` duck-type check.
- Existing `@adhd/agent-mcp-budget` behaviour is preserved under the new API.
- A negative-control test: a plugin that returns/throws a non-termination value does
  not abort the model call.

**References** — `packages/ai/agent-mcp/src/engine/orchestrator.ts` (enforce call +
catch block), `packages/ai/agent-mcp-types/src/hooks.ts` (`IEnforcementError`,
`EnforcementEvent`), `packages/ai/agent-mcp-budget/src/index.ts` (current throw
usage). Related: `CONTEXT_WINDOW_EXCEEDED` handling in `orchestrator.ts` as the
model for a first-class stop reason.

---

### DEBT-009 — `@adhd/agent-mcp-types` ships untested runtime code (`HookRegistry`)
- **Status:** backlog
- **Priority:** P2
- **Area:** `packages/ai/agent-mcp-types/`
- **Reported:** 2026-06-17

**Problem / Description** — `@adhd/agent-mcp-types` was originally a types-only
package (interfaces, enums, type aliases — zero runtime behaviour). When `HookRegistry`
was relocated here from `agent-mcp` to break the circular build dep (DEBT-006), the
package gained a concrete class with real runtime behaviour: map management, async
iteration, error-swallowing logic in `emit()`, throw-propagation logic in `enforce()`.
To avoid a vitest "no test files found" exit-1, `passWithNoTests: true` was added to
`vite.config.ts`. That flag now silently suppresses the missing-coverage gap —
`npx nx test agent-mcp-types` exits 0 and reports nothing, making it invisible that
the package's only runtime code is completely untested.

The `HookRegistry` implementation is exercised *indirectly* through
`agent-mcp/src/__tests__/enforcement.test.ts`, but that's a downstream consumer
importing the class as a user would — not a unit test owned by the package. If a
regression is introduced in `registry.ts`, the failure surfaces in a different
package's test run, with no clear ownership signal.

**Impact**
- Any regression in `HookRegistry` (emit swallowing, enforce propagation, handler
  ordering, multi-handler abort-on-first-throw) is invisible to `nx test agent-mcp-types`.
- `passWithNoTests: true` is a footgun: a future contributor who removes the one
  import of `HookRegistry` from `agent-mcp-types/src/index.ts` (say, during a
  refactor) will see zero test failures — the package's tests still pass, because
  there are none.
- Ownership is diffuse: the tests that cover `HookRegistry` live in `agent-mcp`,
  but the code lives in `agent-mcp-types`. A PR touching only `agent-mcp-types`
  won't obviously trigger those tests.

**Proposed fix / Approach** — Add a `src/__tests__/registry.test.ts` to
`packages/ai/agent-mcp-types/` and remove `passWithNoTests: true`:

- `emit()` swallows handler errors (does not reject)
- `emit()` calls all handlers even if one throws
- `enforce()` propagates the first `IEnforcementError` throw
- `enforce()` swallows non-`IEnforcementError` throws (continues other handlers)
- `enforce()` aborts on first `IEnforcementError` (remaining handlers not called)
- Multiple `register()` / `registerEnforcement()` calls stack handlers correctly
- "Teeth" check: revert the swallow and confirm `emit()` test goes red

These are pure unit tests — no SQLite, no provider, no `agent-mcp` import needed.
The tests already exist conceptually in `agent-mcp/src/__tests__/enforcement.test.ts`;
they should be canonical in the package that owns the code.

**Acceptance criteria**
- `npx nx test agent-mcp-types` runs real tests and exits non-zero on a regression.
- `passWithNoTests: true` removed from `vite.config.ts`.
- All behavioural invariants above covered by at least one test with a teeth check.
- `agent-mcp/src/__tests__/enforcement.test.ts` retains its orchestrator-level
  integration tests (which use `HookRegistry` as a dependency) but does not
  duplicate the unit-level registry tests.

**References** — `packages/ai/agent-mcp-types/src/registry.ts` (runtime code),
`packages/ai/agent-mcp-types/vite.config.ts` (`passWithNoTests: true`),
`packages/ai/agent-mcp/src/__tests__/enforcement.test.ts` (downstream coverage).

---

## ✅ Done

### BUG-001 — SSE server crashes the whole process on `EADDRINUSE`
- **Status:** done
- **Priority:** P1 · **Area:** streaming
- **Reported:** 2026-06-15 · **Closed:** 2026-06-15

**Resolution.** `startSseServer` now takes optional `port`/`host` params and
attaches an `'error'` handler to the `http.Server`: a bind failure (e.g.
`EADDRINUSE`) is logged with an actionable warning and SSE streaming degrades to
unavailable — the stdio MCP transport keeps serving instead of the process
crashing on an unhandled `'error'` event. The integration harness now binds an
ephemeral port via the new `port` param (no more double-`listen`).
**Test:** `sse.integration.test.ts` → "BUG-001 … bind failure does not crash the
process" (teeth-checked: removing the handler makes vitest catch the unhandled
EADDRINUSE error and the run fails). The broader unhandled-exception audit
remains open as **DEBT-001**.

### DEBT-003 — Cancellation latency (thread `signal` into `callTool`)
- **Status:** done
- **Priority:** P3 · **Area:** engine
- **Reported:** 2026-06-15 · **Closed:** 2026-06-15

**Resolution.** `IMcpClient.callTool` gained an optional `signal?: AbortSignal`;
the orchestrator threads the composed task-cancel/timeout signal into both
dispatch sites (the `Promise.all` batch and the claudecli `executeTool` path).
The stdio client composes it with its per-call timeout; the http client forwards
it; the in-process client short-circuits if already aborted. A cancel mid-call
now interrupts the in-flight tool call instead of waiting for the batch.
**Test:** `parallel.integration.test.ts` → "DEBT-003 … cancel interrupts an
in-flight tool call via the threaded signal" (teeth-checked: dropping the signal
arg makes the stub hang → the test times out).

---

_Open `BUG-/FEAT-/DEBT-` entries live in the sections above; move them here with a_
_**Closed** date + resolution when shipped._
