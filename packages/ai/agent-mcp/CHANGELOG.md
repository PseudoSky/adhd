# Changelog

All notable changes to `@adhd/agent-mcp`. Format based on
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

Open/actionable work lives in [BACKLOG.md](./BACKLOG.md); strategic feature
planning in [ROADMAP.md](./ROADMAP.md).

---

## [1.1.0] — 2026-06-16

### Added
- **`usage_query` now supports `group_by` aggregation** (FEAT-002 partial). Pass
  `group_by: "agent" | "model" | "provider"` to aggregate `task_usage` rows along
  that dimension instead of returning raw rows. Each group includes `taskCount`,
  `completedCount`, `failedCount`, `cancelledCount` (via LEFT JOIN with `tasks`),
  `inputTokens`, `outputTokens`, `toolCallCount`, `modelCalls`, `avgLatencyMs`
  (zero-latency rows excluded), and `cacheReadTokens`/`cacheCreationTokens`.
  Groups are ordered by total token spend (input + output) descending. All
  existing filters (`agent_name`, `since`, `task_id`, `root_task_id`, `limit`)
  compose with AND before grouping. Existing bare calls without `group_by` are
  unchanged. 12 new tests in `__tests__/usage-group-by.test.ts`.
- **External plugin loading with config file, default locations, and schema enforcement** (FEAT-004).
  Plugins are now declared in `agent-mcp.config.json` (supports per-plugin `config`
  blocks) and discovered automatically — no env var required for the common case.
  Config file search order: `AGENT_MCP_CONFIG` env var → `{cwd}/agent-mcp.config.json`
  → `~/.agent-mcp/config.json` (global). The config file format is validated by the
  server on startup (Zod). Per-plugin schema enforcement: if a plugin module exports
  `configSchema` with a `.safeParse()` method, the server validates the plugin's
  `config` block before invoking the factory; validation failure logs a structured
  error and skips that plugin without affecting others. The validated (coerced +
  defaulted) result is passed as `ctx.config`. `AGENT_MCP_PLUGINS` env var retained
  as a no-options shorthand (CI/simple activations); config-file entries load first.
  Plugin loading extracted to `src/plugins/loader.ts`. Added `PluginContext.config`
  and `PluginFactory` to `@adhd/agent-mcp-types`. 20 new tests in
  `__tests__/plugin-loader.test.ts` cover discovery, config validation, schema
  enforcement, and failure resilience. See `PLUGINS.md`.

### Fixed
- **`timeoutMs` now bounds the SDK's HTTP timeout** (DEBT-005). `OpenAIProvider`
  passes `timeout: config.timeoutMs ?? 60_000` to the `OpenAI` constructor (and
  `AnthropicProvider` does the same). Previously the SDK's built-in ~10-minute
  default fired before a user-configured `timeoutMs > 600s`, producing a generic
  `PROVIDER_ERROR: "Request timed out."` instead of the actionable
  `PROVIDER_TIMEOUT` — and raising `timeoutMs` had no effect. `LMStudioProvider`
  inherits the fix via `OpenAIProvider`. Surfaced by the code-tasking study
  (6 DNF on the 27B dense model).
- **Delegation-opened sessions are now reaped on task failure** (BUG-002).
  `Orchestrator.run()` tracks session IDs returned by `agent-mcp__agent` tool
  calls; on failure or cancellation the `finally` block closes them, preventing
  orphaned `active` sessions that made sub-agents permanently undeletable
  (`AGENT_HAS_ACTIVE_SESSIONS`). Sessions are NOT closed on success. Added
  `force: boolean` to `agent_delete` as a recovery escape hatch that closes
  active sessions before deleting — for existing orphans from the pre-fix era.
- **Top-level unhandled exception safety net** (DEBT-001). `index.ts` now
  registers `process.on("uncaughtException")` and `process.on("unhandledRejection")`
  handlers before `main()`, logging a structured `fatal` entry and calling
  `process.exit(1)`. Added a clarifying comment to `BackgroundQueue.enqueue()`
  explaining why swallowing is intentional there (the orchestrator has already
  updated task status; rethrowing would kill the server for a per-task error).
- **Orchestration no longer hard-fails on a bare (unprefixed) tool name** (DEBT-004).
  Models that emit `task` / `agent` instead of the advertised `agent-mcp__task`
  used to crash the whole task with "Invalid tool name (missing server prefix)".
  A new `resolveToolCallName` resolves a bare name against the advertised tool set
  (unique → qualify; ambiguous → actionable error naming the candidates), wired
  into the openai/anthropic/claudecli providers. Surfaced by the code-tasking
  study (recursive-orchestration test failed for sonnet-4.6 and haiku-4.5).

---

## [1.0.1] — 2026-06-15

### Fixed
- **SSE bind failure no longer crashes the server** (BUG-001). `startSseServer`
  attaches an `'error'` handler and accepts `port`/`host` params; if the port is
  taken (`EADDRINUSE`), SSE streaming degrades to unavailable with a logged
  warning instead of an unhandled `'error'` taking down the whole MCP process.

### Changed
- **Tool-call cancellation latency** (DEBT-003). `IMcpClient.callTool` accepts an
  optional `AbortSignal`; the orchestrator threads the composed
  task-cancel/timeout signal into tool dispatch (batch + claudecli paths), so
  cancelling a task interrupts an in-flight tool call instead of waiting for the
  batch to settle. stdio composes it with its per-call timeout; http forwards it;
  in-process short-circuits if already aborted.

---

## [1.0.0] — 2026-06-15

First consolidated release: the full task-orchestration core, shipped as one
interdependent version.

### Added
- **Lifecycle event middleware.** `HookRegistry` implements `IHookRegistry`
  (from `@adhd/agent-mcp-types`) with 11 hooks emitted across the orchestrator
  (`task:start`, `pre:model_request`, `post:model_response`, `pre:tool_call`,
  `post:tool_call`, `message:appended`, `task:completed`, `task:failed`,
  `task:cancelled`), `SessionStore` (`session:created`), and `AgentStore`
  (`agent:mutated`). Plugin packages can register handlers via `hooks.register()`
  without modifying the orchestrator loop. `UsagePlugin` is the first consumer
  and ships alongside. The `hooks` registry is passed through the full call chain
  (server → task tool → orchestrator → stores).
- **Task dependency DAG.** `task` accepts `depends_on`; a task stays `waiting`
  until all upstreams reach a terminal state, then is dispatched with their
  results injected. `on_upstream_failure: "fail" | "skip"`. Cycles are rejected
  at submit time (`VALIDATION_ERROR`, no row created).
- **Parallel tool execution.** Multiple tool calls in one model turn execute
  concurrently (`Promise.all`) instead of serially.
- **Human-in-the-loop.** Opt-in `allowHumanInput` advertises
  `request_human_input`; a calling task suspends in `awaiting_input` with a
  `resume_token`; the new `task_resume` tool continues it.
- **Task-level SSE streaming.** `task` with `stream: true` (background) returns a
  `stream_url`; a separate HTTP server (`SSE_PORT`, default 3001) emits
  `tool_call` / `tool_result` / `status_change` / `done` events.
- **Ephemeral task observability.** `task` with `agent_name` (one-shot, no
  session) now persists a `tasks` row (`is_ephemeral=1`, `session_id` NULL),
  `task_events`, and `task_usage` — so `result`, `task_list`, and `usage_query`
  work on ephemeral task IDs. No `sessions`/`messages` rows are written.
- **Task schema foundation.** `depends_on`, `on_upstream_failure`, `inputs`,
  `resume_token` columns; `waiting` + `awaiting_input` statuses.

### Fixed
- **Migration `0005` no longer cascade-wipes `task_events`.** The table-recreate
  in `0005` would `DROP TABLE tasks` with foreign keys enforced, cascading to
  every `task_events` row — drizzle-kit's in-SQL `PRAGMA foreign_keys=OFF` is a
  no-op inside the migrator transaction. The migration now runs through
  `runMigrationsOn` (`db/migrate-runner.ts`), which toggles FK enforcement off
  on the connection around `migrate()`. Verified on a real DB (148 events
  preserved); regression guard at `scripts/verify-fk-safe-migration.mjs`.
- **Tool-name round-trip** robust to model normalization (`<server>__<tool>`
  resolution survives `-`→`_` mangling by local models).
- **Anthropic OAuth**: send the Claude Code identity as a distinct system block
  (fixed spurious 429s); persist rotated keychain credentials after refresh so
  Claude Code stays in sync.

### Changed
- **Publishing is gated on a clean build + tests.** `nx-release-publish`
  `dependsOn: ["build","test"]` (agent-mcp) / `["build"]` (types); `build` runs
  `clean`, and `agent-mcp-types` now sets `emptyOutDir: true` — so a stray
  `dist/` edit or stale version can never be published. See PUBLISHING.md.
- **Parallel-dispatch behavior** (intentional; see CLAUDE.md → Key design
  decisions for the durable invariants): `toolCallCount` is incremented before
  `policy.check()` so a batch that would cross `AGENT_MCP_MAX_TOOL_LOOPS` is
  rejected up front; `post:tool_call` hooks may interleave within a batch
  (result *messages* still append in call order); cancellation is observed only
  after the in-flight batch settles.
- **Test runner** uses `pool: 'forks'` and the integration harness closes each
  SQLite connection before unlinking — eliminating an intermittent
  better-sqlite3 teardown `SIGSEGV` (exit 139) at process teardown.

### Internal
- Test infra: real-component integration suite + a gated live recursive-DAG e2e
  (`AGENT_MCP_LIVE=1`). `toMcpInputSchema` exported from `server.ts`.

---

## [0.0.6]

### Added
- **Token usage tracking.** `task_usage` table populated on every model call;
  `usage_query` MCP tool exposes per-task and delegation-subtree token counts;
  `task` and `result` responses include a `usage` rollup.
- **`max_tokens` + `stop_reason`** columns on `task_usage` — distinguish a
  truncated response (`stop_reason` = `length`/`max_tokens`) from a normal
  completion, and compute output/`max_tokens` utilisation.
- **Context-window handling.** Provider context-length errors are normalised to
  a dedicated `CONTEXT_WINDOW_EXCEEDED` code; opt-in sliding-window truncation of
  oldest non-system messages via `AGENT_MCP_CONTEXT_LIMIT`.

---

_Earlier 0.0.x releases predate this changelog._
