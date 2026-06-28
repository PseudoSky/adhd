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
    openai.ts       — OpenAI + any OpenAI-compatible server (LM Studio, Ollama, DeepSeek) via baseURL
    anthropic.ts    — Anthropic; unified env.secret (API key or OAuth token; wire form inferred from value)
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

> These document **why** the current code is shaped the way it is — read them
> before changing the relevant area so you don't regress something by accident.
> They are explanatory, **not immutable**: a deliberate, understood redesign is
> fair game (update the rationale + tests when you do). Work we actively intend
> to change is tracked in [BACKLOG.md](./BACKLOG.md), and shipped history is in
> [CHANGELOG.md](./CHANGELOG.md).

**In-process recursion.** When an agent's `mcpServers` includes `"agent-mcp"`, the `McpClientRegistry` detects the name and routes tool calls to `InProcessMcpClient` instead of spawning a subprocess. This avoids network hops for recursive delegation and is how orchestrator→sub-agent calls work. The key must be exactly `"agent-mcp"` (or the URL must match `selfUrl` for http/sse transport).

**Anthropic credential inference (unified `env.secret`).** `AnthropicProvider` resolves one secret via `config.getProviderConfig` and infers the wire form from the value: `sk-ant-api…` → `x-api-key` client (system prompt verbatim); `sk-ant-oat…` → `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` + the Claude Code identity prepended as a distinct first `system` block (Anthropic's OAuth gate rejects any other shape with a misleading `429`). The former macOS-keychain `useClaudeOauth` path was **removed** — supply the `claude setup-token` one-year OAuth token through `env.secret` instead.

**Per-task registry lifetime.** `McpClientRegistry` is created fresh for each task and torn down in the `Orchestrator`'s `finally` block via `closeAll()`. Never reused across tasks.

**AbortSignal composition.** Each provider call composes two signals: the task-level cancellation signal and `AbortSignal.timeout(timeoutMs)`. When either fires, the orchestrator throws `PROVIDER_ERROR` with an actionable message. The OpenAI SDK throws `APIUserAbortError` (name stays `"Error"`, not `"AbortError"`), so the catch block checks both `composedSignal.aborted` and `error.name`.

**Agent snapshot isolation.** The agent's full `AgentDefinition` is JSON-serialised into the `sessions.agent_data` column at creation time. Updating the agent definition after that does not affect open sessions.

**Tool name prefixing.** `McpClientRegistry.listAllTools()` prefixes every tool as `<server>__<tool>`. The orchestrator uses this qualified name for policy checks and tool dispatch.

**Parallel tool dispatch — footguns, not commandments.** Tool calls within one model turn execute concurrently (`Promise.all`). The points below explain *why the code looks the way it does* so you don't regress them **by accident** while changing nearby code. They are not "never touch" — a deliberate, understood redesign is welcome; just don't flip them inadvertently, and update the `[inv:…]` tags + tests if you do. (Things we actively *want* to change live in [BACKLOG.md](./BACKLOG.md), not here.)
- **Footgun — `toolCallCount` is incremented before `policy.check()`** (`[inv:toolCallCount-increment-before-check]`). `policy.check()` enforces `count < max`, so counting the about-to-run batch up front means a batch that would cross `AGENT_MCP_MAX_TOOL_LOOPS` is rejected before it runs. Moving the increment after the check silently raises the effective cap by one — so if you reorder this, do it intentionally and re-derive the cap semantics, don't "tidy" it.
- **Contract — `post:tool_call` hooks may interleave within a batch.** `pre:tool_call` for a batch fires serially in Phase 1, but `post:tool_call` fires from inside the concurrent `Promise.all` arms, so hook consumers **cannot** assume strict `pre(A)→post(A)→pre(B)→post(B)` pairing. Tool *result messages* are still appended in original `toolCalls` order (`[inv:message-order]`). This is inherent to concurrent dispatch; serialising to "fix" it would defeat the feature.
- **Known limitation (tracked, not settled) — cancellation latency.** Cancellation is observed only after the in-flight batch settles (the task `signal` isn't threaded into individual `callTool()` calls). This is a limitation we intend to improve — see **BACKLOG.md DEBT-003**, not a decision to preserve.

## Environment variables

All variables use the `ADHD_AGENT_` prefix. Place secrets in `~/.adhd/.env` (loaded automatically) rather than in `.mcp.json` env blocks.

| Variable | Default | Description |
|---|---|---|
| `ADHD_AGENT_DATABASE_PATH` | `~/.adhd/agent-mcp/agents.db` | Absolute path to SQLite file — created if absent |
| `ADHD_AGENT_OPENAI_SECRET` | `""` | OpenAI (or OpenAI-compatible) API key |
| `ADHD_AGENT_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL (override for LM Studio, Ollama, etc.) |
| `ADHD_AGENT_ANTHROPIC_SECRET` | `""` | Anthropic API key or OAuth bearer token |
| `ADHD_AGENT_DEEPSEEK_SECRET` | `""` | DeepSeek API key |
| `ADHD_AGENT_ALLOWED_AGENTS` | unrestricted | Comma-separated server-level agent allowlist |
| `ADHD_AGENT_MAX_DEPTH` | `5` | Max recursion depth |
| `ADHD_AGENT_MAX_TOOL_LOOPS` | `50` | Max tool calls per task |
| `ADHD_AGENT_CONTEXT_LIMIT` | `0` (disabled) | Estimated token limit for the message window passed to each provider call. When > 0, oldest non-system messages are dropped to fit. Set 10% below the model's actual context window. |
| `ADHD_AGENT_DEFAULT_MAX_TOKENS` | `8192` | Default `max_tokens` for Anthropic providers that don't set `maxTokens` in their config. |
| `ADHD_AGENT_QUEUE_CONCURRENCY` | `5` | Max concurrent background tasks |
| `ADHD_AGENT_LOG_LEVEL` | `info` | Pino log level |
| `ADHD_AGENT_SSE_PORT` | `3001` | SSE server port |
| `ADHD_AGENT_SSE_HOST` | `127.0.0.1` | SSE server bind host |
| `ADHD_AGENT_SSE_BASE_URL` | `http://localhost:{port}` | Public base URL used in `stream_url` links |
| `ADHD_AGENT_ENV_ALLOWLIST` | `""` | Comma-separated names agents may reference that don't start with `ADHD_AGENT_` |
| `ADHD_AGENT_CONFIG` | `""` | Path to agent-mcp plugin config YAML |
| `ADHD_AGENT_PLUGINS` | `""` | Comma-separated plugin entry paths |

### Migration from pre-2.0 names

The old bare names (`DATABASE_PATH`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AGENT_MCP_MAX_DEPTH`, etc.) are no longer read. Rename them to the `ADHD_AGENT_*` equivalents above.

Provider config fields also changed: `apiKeyEnv`/`authTokenEnv` → `env: { secret: "ADHD_AGENT_*" }`, and `type: "lmstudio"` → `type: "openai"` (the `lmstudio` alias still works but is deprecated, coerced on load).

### `.env` loading (config.ts is the single source of truth)

`src/config.ts` is the **only** module that reads `process.env`. It runs
`src/utils/load-env.ts` once at startup, then validates + deep-freezes a `config`
singleton; every other module reads `config.*` (never `process.env`). Tests use the pure
`loadConfig(env)` factory.

Load order (`loadEnvHierarchy`, most-specific wins): **`<project>/.env` → `<project>/.adhd/.env` → `~/.adhd/.env`**.
Values are frozen for the process lifetime (no live re-read) — after editing a `.env`,
reload the MCP server. This file path matters because a stdio MCP host forwards only a
~6-var OS allowlist to the server and does **not** expand `${VAR}` in `.mcp.json` `env`
blocks; the `.env` files are the reliable secret-free channel.

### Provider credential model (§3)

- **One unified `env.secret`** (an env-var *name*, not a value) per provider, plus
  optional `env.base_url` / `env.model`. Resolved at runtime by `config.getProviderConfig`.
  Secrets stay name-pointers so `agent_read`/`agent_list` never leak values.
- **`openai`** (the only OpenAI-compatible type — `lmstudio` was removed): `baseURL` is
  `/v1`-normalized at runtime; a missing secret on a non-localhost `baseURL` **fails
  loud**; localhost is exempt (no key needed).
- **`anthropic`**: the wire form is **inferred from the secret value** — `sk-ant-api…` →
  `x-api-key`; `sk-ant-oat…` → `Authorization: Bearer` + `anthropic-beta:
  oauth-2025-04-20` + the Claude Code identity as a distinct first system block (the
  429-avoidance). The macOS-keychain `useClaudeOauth` path was **removed**; supply the
  `claude setup-token` one-year token via `env.secret` instead.
- **Env-name guard:** only `ADHD_AGENT_`-prefixed names may be referenced by an agent
  def, enforced on `agent_create`/`agent_update` **input only** (never on stored reads, so
  legacy rows still parse — DEBT-014). Extend with `ADHD_AGENT_ENV_ALLOWLIST`.

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

## Mandatory: prove it through the LIVE MCP tools — never a bypass

Unit tests use `:memory:` SQLite and a stubbed provider. They are necessary and they are **not** proof the server works. This server's only real consumer is an **MCP host calling its tools** — so the mandatory proof-of-life is exactly that: drive the `mcp__agent-mcp__*` tools **as loaded from `.mcp.json`**, over MCP stdio, against the **real store and a real provider**, and trust the returned payload + exit code. One such pass routinely catches what the whole green unit suite cannot: `.mcp.json` mis-wiring, `dist/` dependency-resolution failures (the externalized `@adhd/*` deps), tool-registration drift after a reload, OAuth/credential reality, and tool-output that blows the host's token ceiling (a no-arg `agent_list` once returned 464 KB). The required loop:

1. **Build, then make the tool actually available** — `nx build agent-mcp`, point `.mcp.json` at `dist/.../index.js`, ask the user to run `/mcp` to reload. (See the update cycle in [AGENT-DEV.md](./AGENT-DEV.md).)
2. **Call the loaded tools as a host does:** `agent_create → agent → task → result`, plus the read paths (`agent_list`, `usage_query`).
3. **Real state, real model:** the real DB (`~/.adhd/agent-mcp/agents.db`, *not* `:memory:`), and a real provider — `claudecli` (local Claude auth) or `anthropic` with an OAuth/API-key token via `env.secret` (e.g. `ADHD_AGENT_ANTHROPIC_SECRET` in `~/.adhd/.env`). Assert the model-independent invariant (`result`, `status: "completed"`, real `usage`), key on the **payload and exit code**, then clean up anything you wrote.

### The anti-pattern this section exists to kill

**If an `mcp__agent-mcp__*` tool is missing or not loaded, that is NOT license to "just run a shell script instead."** Hand-spawning the build — `node dist/index.js` with JSON-RPC piped by hand, or a `.mjs` that **imports the server's own modules and calls its functions directly** — is *our code calling our code*. It skips the exact seam (`.mcp.json` wiring → host → tool registration → dist resolution → output limits) that breaks in real use, so it can pass while the shipped server is unusable. **A missing tool means "load it," never "go around it."** The recovery is always step 1 above: build, repoint `.mcp.json`, `/mcp` reload — then call the tool.

The one legitimate standalone harness is a script that acts as a **real MCP client** (uses `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport` to speak real JSON-RPC stdio to the **unmodified built server**) — e.g. `docs/plan/agent-registry/demo/live-test-mcp.mjs`. That still crosses the real seam; importing server internals does not. When in doubt: *am I calling the server the way a host would, or am I reaching inside it?* Only the former counts.

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

## OAuth / credential handling

**Anthropic** — supply the credential through the unified `env.secret` (an
`ADHD_AGENT_*` env-var name resolved from your `.env`). The value may be a console API
key (`sk-ant-api…`) or an OAuth token from `claude setup-token` (`sk-ant-oat…`); the
provider infers the wire form (see "Anthropic credential inference" under Key design
decisions). A missing secret throws `PROVIDER_AUTH_ERROR`. The macOS-keychain
`useClaudeOauth` mode and the `apiKeyEnv`/`authTokenEnv` fields were removed in the env
overhaul (see CHANGELOG).

```bash
# in ~/.adhd/.env
ADHD_AGENT_ANTHROPIC_SECRET=sk-ant-oat-...   # or sk-ant-api-...
```

**claudecli provider** — uses whatever credentials `claude auth status` shows (no env var
needed). On auth failure, throws `PROVIDER_AUTH_ERROR`.

## Backlog, history, and roadmap

- Open work (bugs, features, tech debt): [BACKLOG.md](./BACKLOG.md)
- What shipped, per version: [CHANGELOG.md](./CHANGELOG.md)
- Strategic feature planning: [ROADMAP.md](./ROADMAP.md)

(The former `GAPS.md` was retired: open items → BACKLOG, shipped items →
CHANGELOG, behavioral invariants → "Key design decisions" above.)
