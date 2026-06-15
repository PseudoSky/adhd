# agent-mcp

MCP server that lets any LLM host create agents, open sessions, run tasks, and delegate to sub-agents recursively. Published to npm as `@adhd/agent-mcp`.

## Commands

```bash
npx nx build agent-mcp          # compile to dist/packages/ai/agent-mcp
npx nx test agent-mcp           # run vitest unit tests
npx nx build agent-mcp --watch  # watch mode
```

> **IMPORTANT FOR LLM AGENTS**: After any change to files in `src/`, follow the full
> update cycle in [AGENT-DEV.md](./AGENT-DEV.md) — build, ask the user to run `/mcp`
> to reload the connection, verify, then test. The MCP client (`.mcp.json`) points at
> compiled `dist/` output; source edits have no effect until rebuilt and reloaded.

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

**Parallel tool dispatch — invariants (do NOT "fix" these).** Tool calls within one model turn execute concurrently (`Promise.all`). Three intentional consequences:
- `toolCallCount` is incremented in the Phase-1 pre-dispatch loop, **before** `policy.check()` (`[inv:toolCallCount-increment-before-check]`). `policy.check()` enforces `count < max`, so counting the about-to-run batch up front means a batch that would cross `AGENT_MCP_MAX_TOOL_LOOPS` is rejected before it runs, not after. Moving the increment after the check silently raises the effective cap by one.
- `pre:tool_call` hooks for a batch fire serially in Phase 1, but `post:tool_call` hooks fire from within the concurrent `Promise.all` arms — so hook consumers **cannot** assume strict `pre(A)→post(A)→pre(B)→post(B)` pairing; `post` events may interleave. Tool *result messages* are still appended in original `toolCalls` order (`[inv:message-order]`).
- Cancellation is observed only after the in-flight batch settles (the task `signal` is not threaded into individual `callTool()` calls). Tightening this is tracked as BACKLOG DEBT-003.

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
| `AGENT_MCP_CONTEXT_LIMIT` | `0` (disabled) | Estimated token limit for the message window passed to each provider call. When > 0, oldest non-system messages are dropped to fit. Set 10% below the model's actual context window. |
| `AGENT_MCP_DEFAULT_MAX_TOKENS` | `8192` | Default `max_tokens` for Anthropic providers that don't set `maxTokens` in their config. |
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
| `PROVIDER_TIMEOUT` | Orchestrator (provider call timed out) |
| `PROVIDER_AUTH_ERROR` | Orchestrator, providers/anthropic, providers/claudecli |
| `PROVIDER_RATE_LIMITED` | Orchestrator (HTTP 429 / rate-limit message) |
| `CONTEXT_WINDOW_EXCEEDED` | Orchestrator (context_length_exceeded from provider) |
| `MCP_CLIENT_ERROR` | clients/* |

## OAuth / claudecli keychain trust

**`useClaudeOauth: true`** (Anthropic provider) reads the OAuth access token from the macOS keychain service `Claude Code-credentials` on every `chat()` call. The MCP host process must share the same keychain trust context as Claude Code.

**Fallback chain** — if the keychain read fails, the Anthropic provider degrades in order:
1. `ANTHROPIC_API_KEY` env var (standard API key)
2. `ANTHROPIC_AUTH_TOKEN` env var (OAuth token or bearer token)
3. If both are absent → throws `PROVIDER_AUTH_ERROR`

**Manual token injection** — run `claude setup-token` to print an OAuth access token, then:
```bash
export ANTHROPIC_AUTH_TOKEN=<token>
```
Or set `authTokenEnv: "MY_TOKEN_VAR"` in the provider config to read from a named env var.

**claudecli provider** — uses whatever credentials `claude auth status` shows. On token-injection failure, throws `PROVIDER_AUTH_ERROR` with the keychain error and the same recovery hint.

## Backlog, history, and roadmap

- Open work (bugs, features, tech debt): [BACKLOG.md](./BACKLOG.md)
- What shipped, per version: [CHANGELOG.md](./CHANGELOG.md)
- Strategic feature planning: [ROADMAP.md](./ROADMAP.md)

(The former `GAPS.md` was retired: open items → BACKLOG, shipped items →
CHANGELOG, behavioral invariants → "Key design decisions" above.)
