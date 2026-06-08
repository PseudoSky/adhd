# agent-mcp

MCP server that lets any LLM host create agents, open sessions, run tasks, and delegate to sub-agents recursively. Published to npm as `@adhd/agent-mcp`.

## Commands

```bash
npx nx build agent-mcp          # compile to dist/packages/ai/agent-mcp
npx nx test agent-mcp           # run vitest unit tests
npx nx build agent-mcp --watch  # watch mode
```

> **IMPORTANT FOR LLM AGENTS**: After any change to files in `src/`, you **must** run
> `npx nx build agent-mcp` before testing or using the server. The MCP client
> (`.mcp.json`) points at the compiled `dist/` output — editing TypeScript source
> has no effect until the build is re-run.

After building, the server runs as:
```bash
node dist/packages/ai/agent-mcp/src/index.js
```

Or via npx without building:
```bash
npx @adhd/agent-mcp@latest
```

## Architecture

```
src/
  index.ts          — entrypoint: reads env, runs migrations, starts MCP server
  server.ts         — MCP tool registration and dispatch (USAGE_GUIDE lives here)
  logger.ts         — pino logger; writes to stderr so stdout stays clean for MCP

  engine/
    orchestrator.ts — tool-use loop: calls provider, executes tool calls, loops until "completed"
    policy.ts       — enforces recursion depth, tool loop limit, allowedAgents
    queue.ts        — p-queue wrapper for background tasks

  store/
    agent-store.ts   — agent CRUD (SQLite via Drizzle)
    session-store.ts — session lifecycle + message history; clearMessages() resets context
    task-store.ts    — task status, events, cancellation token registry

  providers/
    factory.ts      — creates provider from AgentDefinition.provider config
    openai.ts       — OpenAI + LM Studio (OpenAI-compatible)
    anthropic.ts    — Anthropic; supports apiKey, authToken env, and useClaudeOauth keychain mode
    claudecli.ts    — drives local `claude` CLI as a subprocess (no external tool calls)
    lmstudio.ts     — thin alias for OpenAI provider with lmstudio defaults
    types.ts        — LLMProvider interface, ToolDefinition, ProviderChatResponse

  clients/
    registry.ts     — per-task McpClientRegistry; self-referential detection routes to in-process
    in-process.ts   — InProcessMcpClient: bypasses network for agent-mcp self-calls
    stdio-client.ts — StdioMcpClient for external MCP servers
    http-client.ts  — HttpMcpClient / SseMcpClient

  tools/
    agent-crud.ts   — agent_create / agent_read / agent_update / agent_delete / agent_list
    session.ts      — agent / session_list / session_close / session_clear
    task.ts         — task / result / task_list / task_cancel

  validation/       — Zod schemas and inferred types for all domain objects
  db/
    schema.ts       — Drizzle table definitions (agents, sessions, messages, tasks, task_events)
    client.ts       — better-sqlite3 connection (WAL mode)
    migrate.ts      — runs drizzle migrations on startup
```

## Key design decisions

**In-process recursion.** When an agent's `mcpServers` includes `"agent-mcp"`, the `McpClientRegistry` detects the name and routes tool calls to `InProcessMcpClient` instead of spawning a subprocess. This avoids network hops for recursive delegation and is how orchestrator→sub-agent calls work. The key must be exactly `"agent-mcp"` (or the URL must match `selfUrl` for http/sse transport).

**Anthropic OAuth keychain (`useClaudeOauth`).** Setting `useClaudeOauth: true` on an anthropic provider causes `AnthropicProvider` to read the OAuth access token directly from the macOS keychain service `Claude Code-credentials` on every `chat()` call. The token is automatically refreshed when within 5 minutes of expiry. This lets Claude Max subscribers run agents without an API key or billing setup. **macOS only** — depends on the `security` CLI. On other platforms use `authTokenEnv` instead.

**Per-task registry lifetime.** `McpClientRegistry` is created fresh for each task and torn down in the `Orchestrator`'s `finally` block via `closeAll()`. Never reused across tasks.

**AbortSignal composition.** Each provider call composes two signals: the task-level cancellation signal and `AbortSignal.timeout(timeoutMs)`. When either fires, the orchestrator throws `PROVIDER_ERROR` with an actionable message. The OpenAI SDK throws `APIUserAbortError` (name stays `"Error"`, not `"AbortError"`), so the catch block checks both `composedSignal.aborted` and `error.name`.

**Agent snapshot isolation.** The agent's full `AgentDefinition` is JSON-serialised into the `sessions.agent_data` column at creation time. Updating the agent definition after that does not affect open sessions.

**Tool name prefixing.** `McpClientRegistry.listAllTools()` prefixes every tool as `<server>__<tool>`. The orchestrator uses this qualified name for policy checks and tool dispatch.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_PATH` | required | Absolute path to SQLite file — created if absent |
| `LMSTUDIO_API_KEY` | `""` | LM Studio API key |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio base URL |
| `OPENAI_API_KEY` | `""` | OpenAI API key |
| `ANTHROPIC_API_KEY` | `""` | Anthropic API key (console.anthropic.com) |
| `ANTHROPIC_AUTH_TOKEN` | `""` | Anthropic bearer token (subscription users — generate with `claude setup-token`, or set to an OAuth access token directly) |
| `ALLOWED_AGENTS` | unrestricted | Comma-separated server-level agent allowlist |
| `AGENT_MCP_MAX_DEPTH` | `5` | Max recursion depth |
| `AGENT_MCP_MAX_TOOL_LOOPS` | `50` | Max tool calls per task |
| `QUEUE_CONCURRENCY` | `5` | Max concurrent background tasks |
| `LOG_LEVEL` | `info` | Pino log level |

## Adding a new tool

1. Add input/output Zod schemas and types to the relevant file in `src/validation/`
2. Implement the function in `src/tools/`
3. In `src/server.ts`:
   - Import the function and schema
   - Add descriptor to `inProcessDescriptors` array (for recursive calls)
   - Add case to `inProcessHandler` switch
   - Add entry to the `ListToolsRequestSchema` handler
   - Add case to the `CallToolRequestSchema` switch
4. Add the tool to the USAGE_GUIDE string in `server.ts` if it warrants documentation
5. Add the tool to the README tool reference table

## Tests

Unit tests live in `src/__tests__/`. They use in-memory SQLite (`:memory:`) and stub the LLM provider — no network calls.

```bash
npx nx test agent-mcp           # run once
npx nx test agent-mcp --watch   # watch mode
```

The E2E suite (`E2E_PROMPT.md` + `run-e2e.mjs`) runs 14 scenarios against a live LM Studio instance and requires `DATABASE_PATH`, `LMSTUDIO_API_KEY`, and `LMSTUDIO_BASE_URL` to be set.

## Error codes

| Code | Thrown by |
|---|---|
| `AGENT_NOT_FOUND` | AgentStore |
| `AGENT_ALREADY_EXISTS` | AgentStore |
| `AGENT_HAS_ACTIVE_SESSIONS` | AgentStore |
| `SESSION_NOT_FOUND` | SessionStore |
| `SESSION_CLOSED` | SessionStore |
| `TASK_NOT_FOUND` | TaskStore |
| `TASK_NOT_CANCELLABLE` | TaskStore |
| `DELEGATION_NOT_ALLOWED` | PolicyEngine |
| `MAX_DEPTH_EXCEEDED` | PolicyEngine |
| `MAX_TOOL_LOOPS_EXCEEDED` | PolicyEngine |
| `PROVIDER_ERROR` | Orchestrator |
| `MCP_CLIENT_ERROR` | clients/* |

## Known Gaps

These are confirmed implementation gaps as of the current codebase. Each has a clear fix path documented below.

### 1. `claudecli` — hooks, policy, and event logging are blind to internal tool calls

**What happens:** When a `claudecli` agent makes tool calls, the entire exchange (tool call → result → next model turn) happens inside the subprocess. The orchestrator's tool-use loop never fires, so `pre:tool_call`, `post:tool_call`, and `TOOL_CALL`/`TOOL_RESULT` task events are not emitted. Policy checks (max tool loops, delegation allowlist) are also skipped for those calls.

**Impact:** Hooks consumers (future plugins), task event log, and delegation policy enforcement are all ineffective for claudecli agents. The final result is still returned correctly.

**Fix path:** Either (a) surface tool call events out of the subprocess via stream-json and re-emit them into the orchestrator's event system, or (b) accept this as a fundamental limitation of the subprocess model and document it clearly for claudecli users.

---

### 2. `useClaudeOauth` — token refresh path never exercised

**What happens:** `AnthropicProvider.refreshOauthToken()` fires when the stored token's `expiresAt` is within 5 minutes of now. This branch has never been hit in live testing — only the happy-path keychain read has been verified.

**Impact:** Token expiry during a long-running session could cause a failed API call rather than a transparent refresh.

**How to test:** Retrieve the current keychain JSON via:
```bash
security find-generic-password -s "Claude Code-credentials" -w
```
Manually set `claudeAiOauth.expiresAt` to `Date.now() + 4 * 60 * 1000` (4 minutes from now), write it back, then trigger a `useClaudeOauth` task. The refresh branch should fire and restore a valid token.

---

### 3. Streaming — not implemented

**Current state:** All providers return a complete response after the full tool-use loop. No partial token streaming is exposed to callers.

**Roadmap position:** Feature #30, lowest strategic score (3.68). Scored TABLE STAKES — needed eventually, but low differentiation. Blocked on lifecycle middleware hooks (Phase 1) which must exist before stream events can be forwarded.

**Fix path:** Add a `task_stream` tool (or SSE endpoint) that subscribes to the orchestrator lifecycle hooks and forwards events as NDJSON. `claudecli` already has internal streaming via `--output-format stream-json` — it just needs to be forwarded rather than buffered.

---

### 4. Phase 1 roadmap items not started

The following CORE features from Phase 1 of the build order are unimplemented:

| Feature | Notes |
|---|---|
| Token usage tracking | No token count stored per task or session |
| Per-task priority queue | `p-queue` wrapper exists but no priority levels |
| Per-agent concurrency limit | No per-agent cap, only server-wide `QUEUE_CONCURRENCY` |
