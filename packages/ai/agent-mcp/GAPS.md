# Known Gaps

Confirmed implementation gaps in the current codebase. Each has a clear fix path documented below.

---

## 1. `claudecli` — hooks, policy, and event logging are blind to internal tool calls

**What happens:** When a `claudecli` agent makes tool calls, the entire exchange (tool call → result → next model turn) happens inside the subprocess. The orchestrator's tool-use loop never fires, so `pre:tool_call`, `post:tool_call`, and `TOOL_CALL`/`TOOL_RESULT` task events are not emitted. Policy checks (max tool loops, delegation allowlist) are also skipped for those calls.

**Impact:** Hooks consumers (future plugins), task event log, and delegation policy enforcement are all ineffective for claudecli agents. The final result is still returned correctly.

**Fix path:** Either (a) surface tool call events out of the subprocess via stream-json and re-emit them into the orchestrator's event system, or (b) accept this as a fundamental limitation of the subprocess model and document it clearly for claudecli users.

---

## 2. `useClaudeOauth` — token refresh path never exercised

**What happens:** `AnthropicProvider.refreshOauthToken()` fires when the stored token's `expiresAt` is within 5 minutes of now. This branch has never been hit in live testing — only the happy-path keychain read has been verified.

**Impact:** Token expiry during a long-running session could cause a failed API call rather than a transparent refresh.

**How to test:** Retrieve the current keychain JSON via:
```bash
security find-generic-password -s "Claude Code-credentials" -w
```
Manually set `claudeAiOauth.expiresAt` to `Date.now() + 4 * 60 * 1000` (4 minutes from now), write it back, then trigger a `useClaudeOauth` task. The refresh branch should fire and restore a valid token.

---

## 3. Streaming — not implemented

**Current state:** All providers return a complete response after the full tool-use loop. No partial token streaming is exposed to callers.

**Roadmap position:** Feature #30, lowest strategic score (3.68). Scored TABLE STAKES — needed eventually, but low differentiation. Blocked on lifecycle middleware hooks (Phase 1) which must exist before stream events can be forwarded.

**Fix path:** Add a `task_stream` tool (or SSE endpoint) that subscribes to the orchestrator lifecycle hooks and forwards events as NDJSON. `claudecli` already has internal streaming via `--output-format stream-json` — it just needs to be forwarded rather than buffered.

---

## 4. Phase 1 roadmap items not started

The following CORE features from Phase 1 of the build order are unimplemented:

| Feature | Notes |
|---|---|
| Token usage tracking | No token count stored per task or session |
| Per-task priority queue | `p-queue` wrapper exists but no priority levels |
| Per-agent concurrency limit | No per-agent cap, only server-wide `QUEUE_CONCURRENCY` |
