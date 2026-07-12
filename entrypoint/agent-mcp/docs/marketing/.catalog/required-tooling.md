# @adhd/agent-mcp — Required Tooling & Unverified Capabilities

**Catalog date:** 2026-07-12  
**Total shipped capabilities:** 33  
**Capabilities marked 🔴 UNVERIFIED:** 7  

---

## Summary

Seven shipped capabilities cannot be proven with the current tooling setup. Each is marked as shipped in code but lacks a default-running test (either because the test is gated behind an env flag, or the test infrastructure doesn't exist).

---

## Unverified Capabilities & Root Causes

### 1. HTTP OpenAI-Compatible Chat Gateway (`/v1/chat/completions`)

**Status:** ✅ Shipped (implemented in src/streaming/chat-gateway.ts + src/streaming/sse-server.ts)  
**Tested:** ❌ No test  
**Reason:** No HTTP client smoke test exists; SSE server is started but never exercised in CI

**Needed to verify:**
- **Tool:** HTTP client (curl, node-fetch, or similar) to POST to /v1/chat/completions
- **Setup:** Start agent-mcp server with running SQLite DB, create agent, POST request
- **Assertion:** Parse JSON response, verify status + content + streaming format

**Effort:** ~2 hours (write integration test using vitest + node http or got library)

**File locations:**
- Capability: `src/streaming/chat-gateway.ts:handleChatCompletions` (comprehensive implementation)
- Server wiring: `src/streaming/sse-server.ts:45-50` (route registration)
- Entry point: `src/index.ts:188` (SSE server startup)

---

### 2. HTTP Models Endpoint (`GET /v1/models`)

**Status:** ✅ Shipped (implemented in src/streaming/chat-gateway.ts)  
**Tested:** ❌ No test  
**Reason:** Part of SSE server, not exercised in tests

**Needed to verify:**
- **Tool:** HTTP GET client (curl -s localhost:ADHD_AGENT_SSE_PORT/v1/models | jq)
- **Setup:** Start agent-mcp, create agent
- **Assertion:** Parse JSON response, verify models array

**Effort:** ~1 hour (trivial HTTP GET test)

**File locations:**
- Capability: `src/streaming/chat-gateway.ts:handleGetModels`
- Server wiring: `src/streaming/sse-server.ts:44-45`

---

### 3. Claude CLI Provider (`claudecli` type)

**Status:** ✅ Shipped (configured in src/config.ts, documented in USAGE_GUIDE)  
**Tested:** ❌ No test  
**Reason:** Requires `claude` binary on PATH; not available in CI environment

**Needed to verify:**
- **Tool:** Claude CLI binary (`claude --version` must succeed)
- **Setup:** Install Claude CLI locally, create agent with type:'claudecli', run task
- **Assertion:** Task completes, output matches claudecli format

**Effort:** ~3 hours (integration test + conditional skip if claude unavailable)

**File locations:**
- Config: `src/config.ts` (no explicit claudecli block; handled separately)
- Documentation: `src/server.ts:259` (USAGE_GUIDE provider table)

---

### 4. MCP Server Bindings & Tool Registration

**Status:** ✅ Shipped (core feature, wired in orchestrator)  
**Tested:** ❌ Live e2e test exists but skipped (AGENT_MCP_LIVE=1 only)  
**Reason:** Requires real model (LM Studio or Anthropic) to exercise multi-agent recursion

**Needed to verify:**
- **Tool:** LM Studio (`http://localhost:1234/v1`) OR Anthropic API key
- **Setup:** Start calc-server.mjs (stdio MCP), create agent with mcpServers binding, run task using calc tool
- **Assertion:** Tool call reaches MCP server, result comes back, persisted in DB

**Effort:** ~2 hours (make live-dag.e2e.test.ts run by default with fallback provider detection)

**File locations:**
- Live test: `src/__tests__/integration/live-dag.e2e.test.ts:75-76` (skipIf(!isLive) guard)
- Calc server fixture: `src/__tests__/integration/fixtures/calc-server.mjs`

---

### 5. Agent Delegation (Recursive Multi-Agent DAG)

**Status:** ✅ Shipped (core feature, tested live)  
**Tested:** ❌ Live e2e test exists but skipped (AGENT_MCP_LIVE=1 only)  
**Reason:** Same as #4 — requires real model to exercise delegation logic

**Needed to verify:**
- **Tool:** Real LLM (LM Studio or Anthropic)
- **Setup:** Same as #4; test wiring in src/__tests__/integration/live-dag.e2e.test.ts already exists
- **Assertion:** 3-level recursion happens (coordinator→fanout→workers); every worker invokes calc tool; all tasks persisted

**Effort:** ~1 hour (remove skipIf guard + add provider auto-detection fallback)

**File locations:**
- Test: `src/__tests__/integration/live-dag.e2e.test.ts` (complete test, just gated)

---

### 6. Human-in-the-Loop (HITL) Task Suspension

**Status:** ✅ Shipped (awaiting_input status, task_resume tool, documented in USAGE_GUIDE)  
**Tested:** ❌ No test  
**Reason:** No integration test exercises the HITL flow (create task, wait for suspension, resume with input)

**Needed to verify:**
- **Tool:** Real model that calls `request_human_input` tool; test harness to simulate human response
- **Setup:** Create agent with allowHumanInput:true, run task with model that triggers HITL
- **Assertion:** Task suspends with awaiting_input status, resumeToken issued, task_resume moves task to running, final result produced

**Effort:** ~4 hours (write integration test with mock model or real LM Studio)

**File locations:**
- Tool: `src/server.ts:513-517` (task_resume definition)
- USAGE_GUIDE: `src/server.ts:269-276` (error codes reference)
- Config: allowHumanInput field in agent definition

---

### 7. Server-Sent Events (SSE) Task Streaming

**Status:** ✅ Shipped (SSE server on separate port, task/completed notifications)  
**Tested:** ❌ No test  
**Reason:** No SSE client test; SSE server starts but is never polled in CI

**Needed to verify:**
- **Tool:** SSE client (node EventSource or similar) to subscribe to task stream
- **Setup:** Start agent-mcp, create agent, run background task, subscribe to SSE /tasks endpoint
- **Assertion:** Receive task/completed event with correct task_id + status

**Effort:** ~2 hours (write integration test using EventSource or fetch EventStream)

**File locations:**
- SSE server: `src/streaming/sse-server.ts`
- Event bus: `src/streaming/event-bus.ts:subscribeToTaskDone`
- Wiring: `src/index.ts:188` (SSE server startup)

---

## Tooling Gap Summary

| Need | Tool | Status | Impact | Priority |
|------|------|--------|--------|----------|
| HTTP client | curl, node-fetch, got | ✅ available | 2 HTTP endpoints unproven | HIGH |
| Real LLM | LM Studio (localhost) or Anthropic API | ⚠ optional | 2 features unproven (delegation, DAG) | HIGH |
| Claude CLI binary | claude (system PATH) | ❌ not in CI | 1 provider unproven | MEDIUM |
| EventSource client | node EventSource | ✅ available | SSE streaming unproven | MEDIUM |

---

## Capability Impact

**If these 7 capabilities are not proven by catalog v2.0.2:**

- 🟢 Agent/session/task management: ✅ Proven (19 unit tests pass)
- 🟢 Provider (OpenAI, Anthropic, DeepSeek): ✅ Proven (config tests pass)
- 🟢 Tool advertisement (names-only vs full): ✅ Proven (14 tool-advertisement tests pass)
- 🔴 HTTP API (OpenAI compat): ❌ Unproven — consumers cannot verify it works before deploying
- 🔴 Agent delegation: ❌ Unproven in CI — works live but no regression guard
- 🔴 HITL suspension: ❌ Unproven — no evidence it works beyond code review
- 🔴 SSE streaming: ❌ Unproven — no evidence real-time events flow

**Risk:** Publishing 2.0.2 with these 7 gaps means consumers reporting "chat gateway doesn't work" or "delegation failed" after install, with no CI gates to catch regression.

---

## Action Items for Next Catalog Run

### Must-Have (blocker for 2.0.2 publish):

1. **Add HTTP smoke test** (curl or node-fetch client) for /v1/chat/completions and /v1/models
   - File: src/__tests__/integration/http-gateway.test.ts (new)
   - Time: ~2 hours
   - Dependency: HTTP client library (already in Nx workspace)

2. **Add HITL integration test** (with mock model or real LM Studio)
   - File: src/__tests__/integration/hitl.test.ts (new)
   - Time: ~4 hours
   - Dependency: LM Studio running on localhost:1234

### Nice-to-Have (gated by env, runs in CI with fallback):

3. **Ungat live-dag.e2e.test.ts** — remove AGENT_MCP_LIVE=1 guard, add provider auto-detection
   - File: src/__tests__/integration/live-dag.e2e.test.ts (modify)
   - Time: ~1 hour
   - Dependency: LM Studio OR Anthropic API key (env var)
   - Fallback: Skip if neither available, warn in logs

4. **Add SSE integration test**
   - File: src/__tests__/integration/sse-stream.test.ts (new)
   - Time: ~2 hours
   - Dependency: EventSource client (available)

5. **Add Claude CLI test**
   - File: src/__tests__/integration/claudecli.test.ts (new)
   - Time: ~3 hours
   - Dependency: claude CLI binary on PATH
   - Fallback: Skip if not available

---

## Recommendation

**For 2.0.2:**
- ✅ **Mandatory:** HTTP smoke test (2 hrs) — blocks OpenAI compat consumer trust
- ✅ **Strongly recommended:** HITL test (4 hrs) — blocks HITL feature launch
- ⚠ **Nice-to-have:** Ungat live-dag.e2e, add SSE test (3 hrs total) — regression guards
- ⚠ **Optional:** Claude CLI test (3 hrs) — lower priority (fewer users)

**Total effort to verify all 7 capabilities:** ~12 hours across 5 new test files.

→ Cartographer recommends 2.0.2 proceed without all 7 verified, but with HTTP + HITL tests added. Delegation + SSE + Claude CLI can be deferred to 2.0.3 with async CI integration.
