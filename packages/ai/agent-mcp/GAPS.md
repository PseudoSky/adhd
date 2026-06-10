# Known Gaps

Confirmed implementation gaps in the current codebase. Each has a clear fix path documented below.

---

## 1. `claudecli` — hooks, policy, and event logging are blind to internal tool calls

**What happens:** When a `claudecli` agent makes tool calls, the entire exchange (tool call → result → next model turn) happens inside the subprocess. The orchestrator's tool-use loop never fires, so `pre:tool_call`, `post:tool_call`, and `TOOL_CALL`/`TOOL_RESULT` task events are not emitted. Policy checks (max tool loops, delegation allowlist) are also skipped for those calls.

**Impact:** Hooks consumers (future plugins), task event log, and delegation policy enforcement are all ineffective for claudecli agents. The final result is still returned correctly.

**Fix path:** Either (a) surface tool call events out of the subprocess via stream-json and re-emit them into the orchestrator's event system, or (b) accept this as a fundamental limitation of the subprocess model and document it clearly for claudecli users.

---

## 2. `useClaudeOauth` — token refresh path tested and fixed

**Status:** Verified and fixed. The refresh path was tested by inflating `REFRESH_BUFFER_MS` to 8h, which triggered `refreshOauthToken()`. The refresh succeeded but the original implementation did not write the rotated credentials back to the macOS keychain, leaving Claude Code with stale/revoked credentials.

**Fix applied:** `writeKeychainCreds()` now persists the fresh `accessToken`, `refreshToken`, and `expiresAt` back to the keychain after every successful refresh, keeping Claude Code in sync. The full existing keychain payload is preserved — only `claudeAiOauth` is overwritten.

---

## 3. Streaming — not implemented

**Current state:** All providers return a complete response after the full tool-use loop. No partial token streaming is exposed to callers.

**Roadmap position:** Feature #30, lowest strategic score (3.68). Scored TABLE STAKES — needed eventually, but low differentiation. Blocked on lifecycle middleware hooks (Phase 1) which must exist before stream events can be forwarded.

**Fix path:** Add a `task_stream` tool (or SSE endpoint) that subscribes to the orchestrator lifecycle hooks and forwards events as NDJSON. `claudecli` already has internal streaming via `--output-format stream-json` — it just needs to be forwarded rather than buffered.

---

## 5. Agent and task metrics — not implemented

**What's missing:** No aggregated visibility into agent or task performance. Operators cannot answer: which agent is most expensive? What is agent X's success rate this week? Which tasks are slowest? How many tokens has a given agent consumed across all sessions?

**Impact:** Cost attribution, performance tuning, and anomaly detection all require manual querying of raw `task_usage` and `tasks` rows. No pre-computed aggregates, no time-windowed rollups, no per-agent summaries.

**Depends on:** Gap #4 item "Token usage tracking" — the `task_usage` table (Phase 1 CORE) must exist before metrics can be computed.

**Fix path:** `@adhd/metrics-plugin` (Phase 2, Strategic 8.10 — highest-scored MOAT feature). Exposes MCP tools:
- `agent_metrics` — per-agent rollup: total tasks, success/failure count, total tokens consumed, average latency, last active
- `task_metrics` — per-task breakdown: latency, token cost, tool call count, subtree cost (recursive via `root_task_id`)
- `metrics_summary` — server-wide snapshot: active agents, tasks today, total token spend, error rate

All read-only queries over `task_usage` + `tasks`. No new hooks required — plugin only reads DB.

---

## 6. `max_tokens` and `stop_reason` not tracked in `task_usage`

**Status: implemented (0.0.6)**

**What was missing:** The `task_usage` table stored token counts but not the model's configured output ceiling (`max_tokens` from the agent's provider config) nor the stop reason returned by the provider (`stop_reason: "max_tokens"` / `finish_reason: "length"`). Without these, a truncated response was indistinguishable from a normal completion in the usage data.

**Impact:** Silent truncation — tasks that hit their output token ceiling succeed with `status: completed` but return a clipped result. No alert, no flag in `task_usage`, no way to detect from `usage_query` output alone.

**Fix path:** Two additions:
1. `max_tokens` column in `task_usage` — written once at task-start from `provider.maxTokens` (or the provider's default if unset). Lets callers compute utilisation ratio (`output_tokens / max_tokens`).
2. `stop_reason` column — written on each `post:model_response` event. OpenAI returns `finish_reason` (`"stop"` / `"length"` / `"tool_calls"`); Anthropic returns `stop_reason` (`"end_turn"` / `"max_tokens"` / `"tool_use"`). Map to a normalised enum. `"length"` / `"max_tokens"` → truncation signal.

These are two new columns on `task_usage` + two new fields on `TokenUsage`. No schema migration complexity beyond adding nullable columns.

---

## 7. Context window full — no handling strategy

**Status: implemented (0.0.6)**

**What happened:** When a session's message history grew to fill the model's context window, the provider threw a context-length error. The orchestrator caught it as `PROVIDER_ERROR` and failed the task. No warning was issued before the limit was hit; no recovery path existed.

**Impact:** Long-running tasks with many tool-call rounds (common for orchestrator agents with large system prompts and tool schemas) fail unrecoverably at an unpredictable point. The session is left in a broken state and the caller receives a generic `PROVIDER_ERROR`.

**Fix path — two layers:**

1. **Detection (CORE):** Normalise context-length errors from all providers into a dedicated error code `CONTEXT_WINDOW_EXCEEDED` so callers can distinguish it from other `PROVIDER_ERROR` failures. Anthropic throws `BadRequestError` with body `{"type":"invalid_request_error","message":"prompt is too long"}`. OpenAI/LM Studio throws with `code: "context_length_exceeded"`. Map both to the same code.

2. **Recovery strategies (pick one or layer them):**
   - **Sliding-window truncation (CORE, simplest):** Drop the oldest non-system messages from the session history when the estimated token count approaches the limit. Preserves the system prompt and recent context. Lossy but keeps the task alive.
   - **Summarisation (PLUGIN):** `@adhd/summary-plugin` fires on `message:appended`; when estimated tokens exceed a threshold it compresses older turns into a summary message and replaces them. Less lossy than truncation. Already in roadmap as item #26.
   - **Session split + hand-off (CORE):** On `CONTEXT_WINDOW_EXCEEDED`, create a new session, seed it with a compressed summary of the completed turns, and continue the task. Stateful but maximally recoverable.

**Recommended path for 0.0.6:** Implement detection (#1) and sliding-window truncation first. Document the threshold as a configurable env var (`AGENT_MCP_CONTEXT_LIMIT`). Defer summarisation to `@adhd/summary-plugin`.

---

## 4. Phase 1 roadmap items not started

The following CORE features from Phase 1 of the build order are unimplemented or in progress:

| Feature | Notes |
|---|---|
| Token usage tracking | **Status: implemented** — `task_usage` table populated on every model call; `usage_query` MCP tool exposes per-task and subtree token counts; `task` and `result` tools include a `usage` rollup in their responses |
| Per-task priority queue | `p-queue` wrapper exists but no priority levels |
| Per-agent concurrency limit | No per-agent cap, only server-wide `QUEUE_CONCURRENCY` |
