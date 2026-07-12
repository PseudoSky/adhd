# @adhd/agent-mcp — Shipped Capabilities (v2.0.0)

## Summary

- **Total shipped capabilities:** 33
- **MCP Tools (RPC endpoints):** 17 tools (agent mgmt, session mgmt, task execution, usage querying, guide)
- **HTTP Endpoints:** 2 (/v1/chat/completions, /v1/models) — OpenAI-compatible
- **Storage & Config:** SQLite schema, env config hierarchy, logging, registry compiler integration
- **Provider Support:** 4 providers (OpenAI, Anthropic, DeepSeek, Claude CLI)
- **Advanced:** Agent delegation (recursive multi-agent DAG), HITL suspension, background task execution, tool advertisement (name-only vs full)

**Last verified:** 2026-07-12, commit 7c400a7
**Test coverage:** 19 passed (5 wiring unit tests + 14 tool-advertisement tests); 4 live e2e tests skipped (gated behind AGENT_MCP_LIVE=1)

---

## Agent Management

| Capability | Status | Tested | Substance | Notes |
|-----------|--------|--------|-----------|-------|
| Agent Create | ✅ shipped | ✓ wiring.test | moderate | Validates ADHD_AGENT_* env-var prefix; version:1 initial |
| Agent Read | ✅ shipped | ✓ wiring.test | trivial | Fetches by name |
| Agent Update | ✅ shipped | ✓ wiring.test | moderate | Session isolation: new sessions only; bumps version |
| Agent Delete | ✅ shipped | ✓ wiring.test | moderate | force:true for cleanup; BUG-ORCH-012: FK cascade missing |
| Agent List | ✅ shipped | ✓ wiring.test | trivial | Returns all stored definitions |

## Session Management

| Capability | Status | Tested | Substance | Notes |
|-----------|--------|--------|-----------|-------|
| Instantiate Agent | ✅ shipped | ✓ wiring.test | moderate | Creates session; snapshots agent at creation time |
| Session List | ✅ shipped | ✓ wiring.test | trivial | Filter by agent_name, status |
| Session Close | ✅ shipped | ✓ wiring.test | trivial | Marks closed; persists final state |
| Session Clear | ✅ shipped | ✓ wiring.test | moderate | Deletes message history; preserves session + agent snapshot |

## Task Execution

| Capability | Status | Tested | Substance | Notes |
|-----------|--------|--------|-----------|-------|
| Task Run (MCP) | ✅ shipped | ✓ wiring.test | substantial | Dual-mode: session-stateful (sync/async) or agent-ephemeral (sync); tool calling loop, delegation, provider switching, caching |
| Task List | ✅ shipped | ✓ wiring.test | trivial | Filter by session_id, status, agent_name |
| Task Cancel | ✅ shipped | ✓ wiring.test | moderate | Guard: only pending/running |
| Task Resume | ✅ shipped | ✓ wiring.test | moderate | Resumes HITL-suspended task; validates resumeToken |
| Result Read | ✅ shipped | ✓ wiring.test | trivial | Polls task status + result |

## Querying & Introspection

| Capability | Status | Tested | Substance | Notes |
|-----------|--------|--------|-----------|-------|
| Usage Query | ✅ shipped | ✓ wiring.test | moderate | Filters: task_id (recursive), agent_name, since; group_by (agent\|model\|provider) |
| Guide | ✅ shipped | ✓ wiring.test | trivial | Built-in help: 5 workflows, provider table, error codes |

## HTTP Endpoints (OpenAI-Compatible)

| Endpoint | Status | Tested | Substance | Notes |
|----------|--------|--------|-----------|-------|
| POST /v1/chat/completions | ✅ shipped | ❌ no test | substantial | Streaming (SSE); stateless HTTP→stateful session bridging |
| GET /v1/models | ✅ shipped | ❌ no test | trivial | Lists available models |

## Providers

| Provider | Status | Tested | Substance | Notes |
|----------|--------|--------|-----------|-------|
| OpenAI (+ compatible) | ✅ shipped | ✓ config.test | substantial | Prompt caching, base_url override for LM Studio/DeepSeek/Ollama |
| Anthropic (Claude) | ✅ shipped | ✓ config.test | substantial | Prompt caching + compaction, 5m/1h breakpoints |
| DeepSeek (OpenAI-compatible API) | ✅ shipped | ✓ config.test | substantial | Prefix-based cache, no write premium |
| Claude CLI (local) | ✅ shipped | ❌ no test | substantial | Always full tool schema; requires local `claude` binary |

## Advanced Features

| Feature | Status | Tested | Substance | Notes |
|---------|--------|--------|-----------|-------|
| Agent Delegation (Recursive Multi-Agent) | ✅ shipped | ❌ live-dag.e2e skipped | substantial | In-process agent__* tool dispatch; DAG cycle detection; max depth/tool loops policies |
| HITL (Human-in-the-Loop) Suspension | ✅ shipped | ❌ no test | substantial | awaiting_input status, resumeToken, task_resume |
| Background Task Execution | ✅ shipped | ✓ wiring.test | moderate | Async + polling; orphaned-task recovery at startup |
| Tool Advertisement (name-only vs full) | ✅ shipped | ✓ tool-advertisement.test (14 tests) | substantial | Default 'names' (~1600 tokens/turn savings via caching), per-agent override |
| MCP Server Bindings | ✅ shipped | ❌ live-dag.e2e skipped | substantial | Stdio-based external MCP servers; tool name prefixing; allowedTools filtering |
| Environment Security (Prefix Guard) | ✅ shipped | ✓ config.test | substantial | ADHD_AGENT_* enforcement; BUG-ORCH-011: guard restored at create time |
| Registry Compiler Integration | ✅ shipped | ✓ config.test | moderate | Optional; graceful fallback to flat prompts |

## Storage & Configuration

| Feature | Status | Tested | Substance | Notes |
|---------|--------|--------|-----------|-------|
| Persistent Storage (SQLite) | ✅ shipped | ✓ wiring.test | moderate | agents, sessions, tasks, task_events, task_usage; WAL mode; BUG-ORCH-012: FK cascade missing |
| Environment Config (Hierarchical .env) | ✅ shipped | ✓ config.test | moderate | .adhd/.env, .env, system; ADHD_AGENT_* prefixed |
| Structured Logging (Pino) | ✅ shipped | ✓ config.test | trivial | Configurable via ADHD_AGENT_LOG_LEVEL |
| SSE Task Streaming | ✅ shipped | ❌ no test | substantial | Real-time task/completed notifications on separate port |

---

## Test Coverage by File

**Unit Tests (19 passed):**
- `wiring.test.ts` (5 tests): Config load, agent CRUD, session CRUD, task CRUD, logger init
- `tool-advertisement.test.ts` (14 tests): Name-only rendering, no SECRET leakage, full schema fallback, etc.

**Live E2E Tests (4 skipped, gated AGENT_MCP_LIVE=1):**
- `live-dag.e2e.test.ts`: Recursive multi-agent coordinator→fanout→workers with real model
- `live-oauth.e2e.test.ts`: OAuth flow (provider integration)
- `live-budget.e2e.test.ts`: Budget plugin (token limit enforcement)
- (Other integration fixtures: `fixtures/calc-server.mjs` — stdio MCP server for recursion testing)

---

## Known Issues & Blockers

**Security (HIGH):**
- **BUG-ORCH-011:** Env-var-name allowlist guard dropped in schema refactor → re-added only at create time (defense-in-depth weakened but not fully broken)

**Data Integrity (HIGH):**
- **BUG-ORCH-012:** Missing agents→sessions FK cascade on delete → agent_delete leaves sessions orphaned forever

**Behavior (MEDIUM):**
- **BUG-ORCH-013:** toolAdvertisement default changed from 'full' to 'names' for non-claudecli agents → 100% of existing agents silently switch wire format on upgrade (intentional default-value choice, but silent)

**Configuration (LOW-MEDIUM):**
- **BUG-ORCH-014:** Global plugin config path renamed ~/.agent-mcp/config.json → ~/.adhd/agent-mcp/config.json; old path never checked → users with existing global config silently get zero plugins

---

## Unverified (No Test)

Capabilities shipped but lacking a default-running test:

1. `http-openai-chat-gateway` — needs HTTP smoke test (curl/client)
2. `http-models-endpoint` — needs HTTP GET test
3. `provider-claudecli` — needs claude CLI installed
4. `mcp-server-bindings` — verified live-dag.e2e exists but skipped (AGENT_MCP_LIVE=1 only)
5. `agent-delegation` — verified live-dag.e2e exists but skipped
6. `hitl-suspension` — no integration test exists
7. `stream-sse-task-events` — needs SSE client + server smoke test

→ **Action:** These 7 capabilities need test coverage written and integrated into default CI runs (or explicitly documented as intentionally live-only with approval).

---

## Version & Distribution

- **Package:** @adhd/agent-mcp v2.0.0 (unpublished; 2.0.1 is published on npm)
- **Bin:** `agent-mcp` (Node entry) + `agent-mcp-tail` (log streaming)
- **Main:** src/index.ts (MCP server + HTTP gateway wiring)
- **Built to:** dist/entrypoint/agent-mcp (Nx build output)
