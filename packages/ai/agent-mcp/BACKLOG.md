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

### BUG-003 — `agent_list` (no args) returns every full agent definition → blows the host's tool-output token ceiling
- **Status:** open
- **Priority:** P2 · **Area:** tools (agent-crud), discovery
- **Reported:** 2026-06-26 (live MCP validation, orchestrator resume)

**Problem.** Calling `agent_list` with no arguments serialises **all** agent
definitions in full, including each complete `systemPrompt`. Against the real
46-agent store this returned **464,821 chars / 692 lines**, which **exceeded the
MCP host's max tool-output tokens** — the host refused the result and spilled it
to a file. The tool meant to power *discovery* is unusable for discovery at real
corpus size. Unit tests never caught it: they list 1–2 in-memory agents, so the
output is tiny. Only a live call against the real store reveals it.

**Impact.** Any host that calls `agent_list` on a populated store gets an
unusable (or refused) response. Gets monotonically worse as the registry/corpus
grows — and Plan 7 will load a much larger corpus. Directly blocks the Plan 8
discovery lane (`component_search`) if that path shares this shape.

**Proposed fix.** Give `agent_list` a sane **default `limit`** (e.g. 20) with
`offset` paging, and return a **summary projection** by default (name,
description, provider type/model, version, tags) — never the full `systemPrompt`
/ body inline. Expose the full definition only via an explicit `agent_read`
(which already exists) or an opt-in `full: true`. Mirror the same projection
discipline in every authoring/discovery list tool added in Plan 8.

**Acceptance criteria**
- `agent_list` against a ≥46-agent store returns a bounded, summary-only payload
  that stays under the host token ceiling (assert byte/row bound in an
  integration test seeded with N≫limit agents).
- Full body is reachable only via `agent_read`/explicit `full:true`.
- Reverting the projection (dumping full bodies) turns the bound test red.

**References** — `src/tools/agent-crud.ts` (`agent_list`), `src/server.ts`
(ListTools/CallTool wiring), USAGE_GUIDE. Cross-ref orchestration-ledger
F-LIVE-1 (`docs/plan/agent-mcp-refactor/orchestration-ledger.md`).

> Telemetry note (not a separate bug): the `claudecli` provider reports
> `inputTokens:0/outputTokens:0` in `usage` (the CLI stream-json surfaces no
> usage), while `anthropic` reports real counts. Budget/metrics on
> claudecli-routed work silently under-report — folded into the `claudecli`
> observability gap tracked by **DEBT-002**. (orchestration-ledger F-LIVE-3.)

---

### BUG-004 — Imported agents lost their `tools:` headers → run with zero tools
> (Tracked as BUG-003 in the credentialing branch; renumbered on merge to avoid an ID clash with the `agent_list` bug above.)
- **Status:** backlog
- **Priority:** P1
- **Area:** agent import tooling → global store (`~/.adhd/agent-mcp/agents.db`), providers
- **Reported:** 2026-06-22

**Problem / Description** — The global agent store contains 46 agents imported from the
claude-agents corpus (`~/dev/ai/claude-agents/categories/`). The source `.md` files declare
tool access in frontmatter — e.g. `code-reviewer.md` has
`tools: Read, Write, Edit, Bash, Glob, Grep, ListMcpResourcesTool, ReadMcpResourceTool,
WaitForMcpServers, AskUserQuestion, WebSearch, Monitor, LSP` (229 of 348 source files carry a
`tools:` header). The importer kept only the markdown **body** as `systemPrompt` and **dropped
the frontmatter**. Every imported record is now: `provider.type = "anthropic"`, `mcpServers: {}`,
no `allowedBuiltinTools`, no `systemPromptIsAgentSpec`, no frontmatter in `systemPrompt`.

**Evidence (verified 2026-06-22, all 46, no sampling)** — 46/46 source files located; 46/46
carry a `tools:` header; the stored `systemPrompt` matches the source body **byte-for-byte after
stripping frontmatter** for all 46 (0 differ); 0/46 stored prompts contain a `tools:`, `name:`,
or leading-frontmatter marker anywhere. Confirms uniform frontmatter-stripping at import, not
per-agent authoring.

**Impact** — These agents run with **zero tools**. Three compounding causes:
1. The `tools:` header was discarded at import (root cause — data loss).
2. Even if retained, `provider.type = "anthropic"` cannot honor a header — header-driven tools
   (`systemPromptIsAgentSpec`) and built-in allowlists (`allowedBuiltinTools`) are `claudecli`-only;
   the anthropic provider sources tools solely from `mcpServers` (empty here).
3. The referenced tools (`Read`, `Bash`, `WebSearch`, `LSP`, …) are Claude Code built-ins the
   anthropic provider has no way to execute (see FEAT-007). A `code-reviewer` that must
   `Read`/`Grep`/`Bash` the codebase cannot touch a single file.

**Proposed fix / Approach** — Re-import preserving the header, mapping it to a runtime-honored
form. Cleanest for these file-touching agents: set `provider.type = "claudecli"` +
`systemPromptIsAgentSpec: true` and store the **full** md (frontmatter + body) as `systemPrompt`
so Claude parses the `tools:` header. Alternatively keep `anthropic` and translate the header into
`mcpServers` (filesystem/exec MCP) — but native built-ins (Bash/Read/WebSearch) still require
FEAT-007.

**Tool-name normalization (Claude Code 2.1.185 uses `ToolSearch` / on-demand tool loading).**
The source headers list tools this build does NOT statically advertise. Verified: of
`code-reviewer`'s 13 tools, only `Read, Write, Edit, Bash, AskUserQuestion, WebSearch, Monitor`
are honored; `Glob, Grep, LS, MultiEdit, LSP` exist in the binary (75/52/7/5 string hits) but are
**deferred behind `ToolSearch`** (loaded on demand, never in the `init` set), and
`ListMcpResourcesTool, ReadMcpResourceTool, WaitForMcpServers` only register once an MCP server
connects (async). So an allowlist that names a deferred tool is a no-op. Normalization rule:
include **`ToolSearch`** in the header to retain dynamic access to `Glob`/`Grep`/etc., keep `Bash`
as the deterministic search fallback, drop deferred/MCP-meta names that can't bind, and add
`mcp__<server>__<tool>` entries only when delegation is wanted.

**Acceptance criteria** — A re-imported `code-reviewer` advertises its **statically-bindable**
header tools at runtime (proven via `init`: the non-deferred subset matches exactly, and
`ToolSearch` is present when deferred tools are needed), and can read + search a real file
end-to-end. Note: deferred tools will NOT appear in `init` even when intended — assert on the
bindable subset + `ToolSearch`, not the raw header.

**References** — `~/.adhd/agent-mcp/agents.db` (agents table `data` blob),
`~/dev/ai/claude-agents/categories/04-quality-security/code-reviewer.md` (source header),
`src/providers/claudecli.ts` (`systemPromptIsAgentSpec`), FEAT-007,
`docs/plan/agent-registry/SEED_DATA.md` §"Frontmatter → registry table mapping". (Surfaced 2026-06-22.)

---

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

### FEAT-007 — Public registry-write entrypoint (seed/ingest over a tool/CLI)
- **Status:** backlog
- **Priority:** P2
- **Area:** registry, authoring (Plan 8 dependency)
- **Reported:** 2026-06-25 (filed during agent-mcp-authoring plan authoring)

**Problem / Description**
There is no PUBLIC registry-write entrypoint for seeding/ingesting registry rows
(platforms, tools, models, policies, components, agents). The registry packages
ship no CLI bin, and `agent_define`/`component_define` (Plan 8) cover authoring an
agent/component but not bulk seeding the substrate (tool/model/policy
vocabularies). The Plan 8 `composition-journey-e2e` "zero-internal-import" gate is
forced to seed the substrate via the store API in a separate fixture file the test
does not import — an honest boundary, but a gap.

**Impact**
A zero-context user cannot stand up a registry from scratch over the public
surface; the maintained integration test can drive every step EXCEPT the one-time
substrate seed without a deep import.

**Proposed fix / Approach**
Add a registry seed/ingest CLI subcommand (or MCP tool) that loads the substrate
vocabularies + ingests an agent `.md`, so the e2e journey is fully public-surface.

**Acceptance criteria** The §7 journey + substrate seed both run over a public bin/tool; the e2e test imports zero `packages/ai/**/src/**`.

**Planning update (2026-06-25, agent-registry-migration re-author).** Plan 7 was
re-authored as an LLM-driven ingestion pipeline whose `import-script` state ships a
public `importCorpus(...)` entrypoint (lib export + CLI bin) that runs
parse→ingest→dataset-build and writes components/use-cases/weighted-links/agents/
skills through the published registry stores. That entrypoint is the public
registry-write door this item asks for; FEAT-007 is **owned by Plan 7
`import-script`** (`[dod.4]` / `[import-script.1..3]`) and closes when that state
ships. The executor files the closure note here at that point.

**References** — Plan 8 `docs/plan/agent-mcp-authoring/contexts/composition-journey-e2e.md`; **Plan 7 `docs/plan/agent-registry-migration/contexts/import-script.md`**; DEMO.md §6; demo audit finding (CLI bins: `agent-compiler` exists, registry packages have none).

### FEAT-008 — Model-backed embedder behind the deterministic enrichment seam
- **Status:** backlog
- **Priority:** P3
- **Area:** registry enrichment (Plan 8 D1 follow-up)
- **Reported:** 2026-06-25 (filed during agent-mcp-authoring plan authoring)

**Problem / Description**
Plan 8 D1 ships a deterministic, dependency-free in-package embedding (hashed
lexical vector) as `component_define`'s enrichment substrate — chosen for
determinism/idempotence and because no embedding infra exists in the workspace and
the memory-server is not a local importable path. It is sufficient for relative
ranking but not SOTA semantic recall.

**Impact** `component_search` ranking quality is lexical, not semantic-model-grade.

**Proposed fix / Approach** Swap a model-backed embedder behind the injectable
`EmbedFn = (text)=>Float32Array` seam (default stays deterministic); re-embed
use-case anchors. Keep idempotence (cache by content hash).

**Acceptance criteria** A model-backed `EmbedFn` improves `component_search` ordering on a labeled set; `component_define` stays idempotent on identical content.

**References** — `docs/plan/agent-mcp-authoring/decisions.md` D1; SCOPE.md §"Out of Scope" (embedding-based similarity was excluded from Plans 1–7).

**Update (2026-06-26, owner):** sox-ecosystem is extracting its embedding system into
reusable tooling. When that lands, the model-backed `EmbedFn` here should consume that
shared tooling rather than standing up its own embedder — i.e. the `EmbedFn` seam's
production implementation becomes a thin adapter over the sox-ecosystem embedding tool.
Re-scope this FEAT once the shared tooling's import surface is known.

### FEAT-009 — Discovery-lane corpus dependency on Plan 7 (migration)
- **Status:** backlog
- **Priority:** P3
- **Area:** discovery (Plan 8 / Plan 7 overlap)
- **Reported:** 2026-06-25 (filed during agent-mcp-authoring plan authoring)

**Problem / Description**
Plan 8's discovery lane (`component_search`, `*_list`) is proven against demo
fixture agents. The real 346-agent corpus it should search over is imported by
Plan 7 (`agent-registry-migration`, unbuilt). Until Plan 7 runs, discovery returns
only fixture components — corpus-scale sharing/discovery is NOT-YET-COVERED
(DEMO.md §8 row N2).

**Impact** Discovery is real but shallow until the corpus is migrated.

**Proposed fix / Approach** Sequence Plan 7 before/with Plan 8 execution; re-run the discovery DoD against the migrated corpus.

**Acceptance criteria** `component_search` ranks real corpus components; ≥1 shared component is referenced by ≥N migrated agents.

**Planning update (2026-06-25, agent-registry-migration re-author).** Plan 7 now
explicitly produces the discovery corpus: `dataset-build` writes the 18-typed
components + the sonnet-consolidated canonical use-cases WITH anchor embeddings (via
Plan 8's `enrich/usecase-anchors` substrate) + weighted component↔use-case links.
That consolidated use-case set IS the ANCHOR vocabulary Plan 8 enrichment resolves
against — Plan 8 ships SEED anchors, Plan 7 `dataset-build` backfills the
corpus-derived ones. The relation is documented sequencing (CLOSEOUT.md), NOT a
`depends_on_plans` edge; Plan 8 proves on seed anchors, Plan 7 backfills the real
ones. Re-run Plan 8's discovery DoD after Plan 7's `dataset-build` to close this.

**References** — DEMO.md §8 N2; CLOSEOUT.md §3 (recommended execution order); **Plan 7 `contexts/sonnet-consolidation.md` + `contexts/dataset-build.md`**; Plan 8 `contexts/embedding-substrate.md` (seed anchors).

### FEAT-010 — LLM-ingestion live-vs-replay corpus determinism
- **Status:** backlog
- **Priority:** P3
- **Area:** registry ingestion (Plan 7 re-author)
- **Reported:** 2026-06-25 (filed during agent-registry-migration re-author)

**Problem / Description**
Plan 7's re-authored ingestion pipeline runs REAL LLMs (haiku fan-out + sonnet
consolidation) on the live path (`AGENT_REGISTRY_INGEST_LIVE=1`,
`corpus-ingest-llm` blocker). LLM output is non-deterministic, so the **CI/offline
path is a captured replay** of one live consolidation; `importCorpus --replay`
reproduces that dataset deterministically. The live path produces a fresh (possibly
different) canonical use-case vocabulary each run.

**Impact** The corpus dataset (and thus Plan 8's discovery anchors) depends on WHICH
live run was captured. Re-running live ingestion can shift the vocabulary, requiring
a re-capture + a Plan 8 discovery-DoD re-verification.

**Proposed fix / Approach** Treat the captured consolidation record as the
versioned source of truth; gate vocabulary changes behind a deliberate re-capture +
anchor-backfill + Plan 8 discovery re-verify. Optionally add a stability metric
(vocabulary churn between live runs) to decide when a re-capture is warranted.

**Acceptance criteria** A captured replay reproduces the dataset deterministically
(twice → equal rows); a documented re-capture procedure re-backfills Plan 8 anchors.

**References** — Plan 7 `contexts/haiku-usecase-batch.md`, `contexts/sonnet-consolidation.md`, `contexts/import-script.md`; `human-blockers.json` `corpus-ingest-llm`.

---

### FEAT-007 — Platform-native tool support across providers (runtime wiring)
- **Status:** backlog
- **Priority:** P2
- **Area:** providers (`src/providers/anthropic.ts`, `openai.ts`, `claudecli.ts`), validation (`src/validation/agent.ts`), `@adhd/agent-mcp-types`
- **Reported:** 2026-06-22

**Problem / Description**
Agents have no first-class way to declare provider/platform-native tools (executed by
the provider, not our registry). Today only `claudecli` exposes built-ins, via
`allowedBuiltinTools` (denylist) or `systemPromptIsAgentSpec` (agent-md `tools:` header).
Other providers have no path:
- `anthropic` — `toAnthropicTools()` only emits *custom* tools; it never emits Anthropic
  **server-side** tool types (`web_search`, `code_execution`) nor **client-executed** tools
  (`bash`, `text_editor`, `computer`, which would need a local executor loop).
- `openai` — built-in tools require the Responses API / Assistants; the provider uses
  chat.completions, so `web_search`/`code_interpreter` are unreachable.

**Relationship to the agent-registry plan** (`docs/plan/agent-registry/`)
The registry's `@adhd/agent-tool-registry` (canonical tools + `TOOL_PLATFORM_BINDING`) and
`@adhd/agent-provider` (`PROVIDER_TOOL_FORMAT`) cover the **declaration + compile-time**
half of this — a canonical `web_search` resolves to `WebSearch` (claude_code) or
`web_search` (claude_api) and the compiler emits the right header shape. It does **not**
cover the agent-mcp **runtime** half: the provider adapters must actually forward those
platform tools to the API and (for client-executed tools) run an execution loop. The seed
catalog also doesn't yet enumerate the tricky natives (Anthropic server-tool versioned
`type` strings, activation-flag tools like Claude Code `--chrome`). So this remains an
agent-mcp runtime gap even if the registry lands. See SCOPE.md "ProviderAdapter Interface".

**Impact** No web search / code execution / native browser for `anthropic` or `openai`
agents without routing everything through MCP servers or the `claudecli` subprocess.

**Proposed fix / Approach** Decide an interface (per-provider field vs canonical
capability aliases — the registry favors the latter), then wire the cheap wins first:
`claudecli` built-ins (done) + `anthropic` server-side `web_search`/`code_execution`
(emit `{type:"…"}` entries in `toAnthropicTools`; no local executor needed). Gate
unsupported entries (openai, anthropic client-exec) behind an explicit error.

**Acceptance criteria** An `anthropic` agent can be granted `web_search` and the model
performs a real search end-to-end (live test); unsupported native-tool requests fail with
an actionable error rather than silently doing nothing.

**References** — `src/providers/anthropic.ts` (`toAnthropicTools`), `docs/plan/agent-registry/RUNTIME_GAPS.md` (full analysis + recommended handoff), `docs/plan/agent-registry/{SCOPE,DATA_MODEL,SEED_DATA}.md`. (Surfaced during agent-registry plan review, 2026-06-22.)

---

## 🔧 Tech Debt / Improvements

### DEBT-006 — server.ts USAGE_GUIDE doc examples still show systemPrompt as required
- **Status:** backlog
- **Priority:** P3
- **Area:** docs / server
- **Reported:** 2026-06-26

**Problem / Description** — `server.ts` contains USAGE_GUIDE inline-doc strings
that show `agent_create` examples with `systemPrompt` as a required authoring
field (e.g. `"systemPrompt": "You are a helpful assistant"`). After Plan 6 wave 3
(`agent-store-retire`) the field is an optional computed compat shim populated from
`compileAgent()` output — not user-authored. The USAGE_GUIDE examples should be
updated to reflect this: either omit `systemPrompt` from the example payload or add
a comment clarifying it is auto-populated from compiler output.

**Impact** — Documentation only; no runtime regression. Callers passing
`systemPrompt` in `agent_create` will still have it accepted (it is now
`.optional()`, not removed), so backward-compatibility is intact. The misleading
examples could confuse future integrators.

**Proposed fix / Approach** — In `server.ts`, locate the `agent_create` USAGE_GUIDE
JSON snippets and either (a) remove the `systemPrompt` key, or (b) replace it with
a comment noting it is computed. `server.ts` is outside the `agent-store-retire`
mutate reservation; this edit is owned by a doc-refresh pass after Plan 6 completes.

**Acceptance criteria** — `server.ts` USAGE_GUIDE examples do not show
`systemPrompt` as a required user-provided field.

**References** — `packages/ai/agent-mcp/src/server.ts` (USAGE_GUIDE strings),
`docs/plan/agent-mcp-refactor/contexts/agent-store-retire.md` (reservation note),
`decisions.md` Decision 3.

---

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

**Proposed fix / Approach** — Extract `HookRegistry` out of `agent-mcp-types` into a
dedicated `@adhd/agent-mcp-hooks` package (`packages/ai/agent-mcp-hooks/`,
`layer:logic platform:shared`). Dependency graph after the move:

```
agent-mcp-types      (interfaces/enums only — zero runtime, passWithNoTests removed)
      ↑
agent-mcp-hooks      (HookRegistry class — tested, platform:shared)
    ↑       ↑
agent-mcp   agent-mcp-budget  (and any future plugin packages)
```

`agent-mcp-types` goes back to being a pure-types package with no runtime code and no
`passWithNoTests` workaround. `HookRegistry` gets a proper home with its own test suite.
Plugin authors depend on `@adhd/agent-mcp-hooks` as a devDependency for unit-testing
their handlers (the host server provides `HookRegistry` at runtime via `agent-mcp`, so
it stays a devDep, not a peer). `agent-mcp` imports `HookRegistry` from
`@adhd/agent-mcp-hooks` instead of from `agent-mcp-types`.

Steps:
1. `./generate-lib.sh lib agent-mcp-hooks logic shared` (routes to `packages/ai/`)
2. Move `registry.ts` + enforcement implementation to `agent-mcp-hooks/src/`
3. Update `agent-mcp-types/src/index.ts` — remove `HookRegistry` re-export
4. Update `agent-mcp/src/engine/hooks.ts` — import from `@adhd/agent-mcp-hooks`
5. Update `agent-mcp-budget` and any other consumers
6. Write `agent-mcp-hooks/src/__tests__/registry.test.ts` with full behavioural coverage:
   - `emit()` swallows handler errors (does not reject)
   - `emit()` calls all handlers even if one throws
   - `enforce()` propagates the first `IEnforcementError` throw
   - `enforce()` swallows non-`IEnforcementError` throws
   - `enforce()` aborts on first `IEnforcementError` (remaining handlers not called)
   - Multiple stacked handlers work correctly
   - Teeth check on each invariant
7. Remove `passWithNoTests: true` from `agent-mcp-types/vite.config.ts`
8. Update `PLUGINS.md` devDependency guidance (`@adhd/agent-mcp-hooks` for testing)

**Acceptance criteria**
- `npx nx test agent-mcp-types` exits 0 with no test files (no runtime code to cover).
- `passWithNoTests: true` removed from `agent-mcp-types/vite.config.ts`.
- `npx nx test agent-mcp-hooks` runs the registry unit tests and exits non-zero on a
  regression in `HookRegistry`.
- The Nx project graph has no circular edges involving `agent-mcp-types`,
  `agent-mcp-hooks`, `agent-mcp`, or `agent-mcp-budget`.
- `agent-mcp-budget/src/__tests__/budget-plugin.test.ts` imports `HookRegistry` from
  `@adhd/agent-mcp-hooks`.

**References** — `packages/ai/agent-mcp-types/src/registry.ts` (runtime code to move),
`packages/ai/agent-mcp-types/vite.config.ts` (`passWithNoTests: true`),
`packages/ai/agent-mcp/src/engine/hooks.ts` (import to update),
`packages/ai/agent-mcp-budget/src/__tests__/budget-plugin.test.ts` (import to update),
`packages/ai/agent-mcp/PLUGINS.md` (devDependency guidance to update).

---

### DEBT-010 — `vite.config.ts` hardcodes a per-package source alias for dynamic `@adhd` imports (workaround, not the real fix)
- **Status:** open
- **Priority:** P3 · **Area:** build/test tooling, workspace `@adhd/*` resolution
- **Reported:** 2026-06-26 (registry merge — `live-budget.e2e.test.ts` resolution)

**Problem.** `live-budget.e2e.test.ts` does `await import("@adhd/agent-mcp-budget")`.
Under vitest, `nxViteTsPaths()` aliases **static** `@adhd/*` imports to source via
`tsconfig.base.json` paths, but a bare **dynamic-import** specifier falls through to
node resolution → the package's `package.json` `exports` (`./index.mjs` / `./index.js`,
which only exist after a build) → vite throws *"Failed to resolve entry for package
@adhd/agent-mcp-budget … incorrect main/module/exports"*. The suite failed for a
resolution reason unrelated to the code under test.

**Workaround applied (the debt).** A hardcoded `resolve.alias` in
`packages/ai/agent-mcp/vite.config.ts` maps `@adhd/agent-mcp-budget` → its
`src/index.ts`. It works, but it is **per-package and per-consumer**: every workspace
`@adhd` dep that is ever imported dynamically would need its own alias line, in every
package's vite config that does so. It also masks the deeper issue (same family as
**F-P6-13**: `@adhd/*` `exports` point at unbuilt artifacts, so nothing resolves them
in-workspace without tsconfig-paths or a symlink).

**Proposed real fix (pick one, workspace-wide).**
1. Add a **`"development"`/source export condition** to every `@adhd/*` `package.json`
   (`exports["."].development = "./src/index.ts"`) and have vitest resolve with that
   condition — fixes static + dynamic uniformly, no per-package aliases.
2. A **shared vitest resolver plugin** that reads `tsconfig.base.json` paths and aliases
   ALL `@adhd/*` (static + dynamic) to source, dropped into every package's config.
3. Make `agent-mcp-budget` a declared build dependency so `test dependsOn build` produces
   the `index.mjs` the `exports` already name (heavier; rebuilds on every test).

When the real fix lands, delete the `resolve.alias` block from `vite.config.ts`.

**References** — `packages/ai/agent-mcp/vite.config.ts` (the alias),
`packages/ai/agent-mcp-budget/package.json` (`exports` → unbuilt files),
`tsconfig.base.json` (paths), F-P6-13 (publish-time `@adhd` dep resolution).

---

### DEBT-011 — `nx typecheck` target is misconfigured (composite + rootDir) → never green
- **Status:** open
- **Priority:** P2 · **Area:** build/test tooling, tsconfig project references
- **Reported:** 2026-06-26 (registry merge verification)

**Problem.** The `typecheck` target cannot pass as configured:
1. `tsconfig.json` references `tsconfig.spec.json` but the latter lacks
   `"composite": true` → `tsc --build` fails with `TS6306` (×66) before it checks any code.
2. Running `tsc -p tsconfig.lib.json` directly surfaces 73 `TS6059` "File … is not under
   rootDir 'agent-mcp/src'" errors, because cross-package `@adhd/*` imports resolve to
   **source** (via tsconfig paths) instead of built `.d.ts`, and source sits outside the
   package `rootDir`. So the package has **no working static type-check gate** — exactly the
   blind spot DEMO.md §0.3 calls out ("39/39 green while `nx typecheck` was red, hiding 13 errors").

This is pre-existing and repo-wide (not introduced by the registry merge — the merge left
`agent-mcp/tsconfig*.json` untouched). The actual source is type-clean today (a direct
`tsc` shows **zero** errors in `src/` once the config artifacts are excluded), but nothing
*enforces* that.

**Proposed fix.** Either (a) give every package a `references`-free `typecheck` tsconfig that
sets `composite:false`, `noEmit:true`, and resolves `@adhd/*` to built `.d.ts` (build deps
first), or (b) a project-references setup where each `@adhd` package is `composite:true` with
emitted declarations so cross-package checks use `.d.ts`, not source. Then wire `nx typecheck`
to the corrected target and add it to the CI gate so source type errors fail loudly.

**References** — `packages/ai/agent-mcp/tsconfig.json` / `tsconfig.spec.json` / `tsconfig.lib.json`,
`tsconfig.base.json` paths, DEMO.md §0.3 (the green-but-untyped failure mode).

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

### BUG-002 — `@adhd/agent-mcp-budget` dist missing `index.mjs` breaks live-budget e2e test
- **Status:** backlog
- **Priority:** P2
- **Area:** build, providers
- **Reported:** 2026-06-26

`dist/packages/ai/agent-mcp-budget/package.json` declares `"import": "./index.mjs"`
in its exports map, but the Vite build only emits `index.js` and `index.cjs` — no
`index.mjs`. Vite's Vitest resolver fails with "Failed to resolve entry for package
@adhd/agent-mcp-budget" when `live-budget.e2e.test.ts` tries to import it.

**Root cause:** The `agent-mcp-budget` vite.config is likely missing `formats: ["es"]`
or has the output filename set to `.js` instead of `.mjs` for the ESM build.

**Fix:** In `packages/ai/agent-mcp-budget/vite.config.ts`, ensure
`build.lib.formats` includes `"es"` with `fileName: () => "index.mjs"`, or align
the `exports."import"` field in the generated `package.json` with the actual
output filename (`index.js`).

**Evidence:** `ls dist/packages/ai/agent-mcp-budget/` → `index.cjs index.d.ts index.js package.json` (no `index.mjs`).

---

_Open `BUG-/FEAT-/DEBT-` entries live in the sections above; move them here with a_
_**Closed** date + resolution when shipped._
