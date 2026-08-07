# AGENTS.md — LLM-Guiding Documentation

This document is written for LLM/agent consumption. It contains only factual, non-marketing claims about @adhd/agent-mcp. All statements are grounded in code or configuration, not speculation.

## What This Package Is (Fact-Based)

`@adhd/agent-mcp` is an MCP (Model Context Protocol) server. When run, it:

1. Accepts JSON-RPC method calls from MCP clients over stdio
2. Manages a local SQLite database at `~/.adhd/agent-mcp/` (configurable)
3. Accepts calls to create agents, send messages, and retrieve results
4. Calls external model providers (OpenAI, Anthropic, DeepSeek, Gemini) via their APIs
5. Enforces runtime policies (token limits, tool allowlists, delegation depth)
6. Returns results and execution traces to the MCP client

## Shipped Status (as of 2.0.2)

All features listed below are shipped and tested.

### Protocol: MCP Tools

The server exposes these MCP tools:

| Tool | Signature | Purpose |
|---|---|---|
| `agent` | `(agentName: string) -> {session}` | Instantiate a session for a named agent |
| `agent_create` | `(name: string, config: object) -> {agentId}` | Create a named agent with provider, model, policy, tool allowlist |
| `agent_read` | `(name: string) -> {config}` | Fetch agent config by name |
| `agent_update` | `(name: string, config: object) -> {version}` | Update agent config; existing sessions isolated from change |
| `agent_delete` | `(name: string, force?: bool) -> {}` | Unregister agent and cascade-delete all sessions (as of 2.0.2) |
| `agent_list` | `() -> {agents: [...]}` | List all registered agents |
| `task` | `(agentName: string, prompt: string) -> {taskId, status}` | Run a prompt against a session and execute tool-call loop until completion |
| `result` | `(taskId: string) -> {status, result, usage}` | Retrieve task result and execution usage |
| `task_list` | `(filter?: object) -> {tasks: [...]}` | List tasks (filter by sessionId, status, agentName) |
| `task_cancel` | `(taskId: string) -> {}` | Cancel a running or pending task |
| `task_resume` | `(taskId: string, resumeInput: string) -> {}` | Resume a HITL-suspended task with user input |
| `session_list` | `(filter?: object) -> {sessions: [...]}` | List sessions (filter by agentName, status) |
| `session_close` | `(sessionId: string) -> {}` | Close a session; marks final state |
| `session_clear` | `(sessionId: string) -> {}` | Delete message history for a session (preserves agent snapshot) |
| `usage_query` | `(filter?: object, groupBy?: string) -> {usage: [...]}` | Query task usage across multiple tasks (grouped by agent, model, provider) |
| `guide` | `() -> {workflows, providers, errors}` | Built-in help: 5 workflows, provider table, error codes |

### Configuration: Environment Variables

These env vars configure the server-wide default agent and provider credentials:

| Variable | Type | Example | Required |
|---|---|---|---|
| `ADHD_AGENT_PROVIDER` | string | `anthropic` | Yes (has a code default of `anthropic`) |
| `ADHD_AGENT_MODEL` | string | `claude-opus-4-1` | Yes (has a code default) |
| `ADHD_AGENT_CONTEXT_LIMIT` | number | `0` (default, disabled) | No |
| `ADHD_AGENT_ANTHROPIC_SECRET` | string | `sk-ant-oat...` or `sk-ant-api...` | If provider type=`anthropic` (`config.ts` `PROVIDER_DEFAULTS`) |
| `ADHD_AGENT_OPENAI_SECRET` | string | (credential) | If provider type=`openai` (also covers OpenAI-compatible endpoints) |
| `ADHD_AGENT_DEEPSEEK_SECRET` | string | (credential) | Only if an `openai`-type agent explicitly overrides `env.secret`/`env.base_url` to point at DeepSeek — there is no separate `"deepseek"` provider type |

**Not real:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY` (bare SDK-style names) are never read by this codebase — only the `ADHD_AGENT_<PROVIDER>_SECRET` names above are resolved, and only via `process.env` directly (see "Provider credentials are excluded from the config cascade" below). There is no Gemini support (`GOOGLE_API_KEY` implies a provider that does not exist in code).

**Provider credentials are excluded from the `@adhd/environment` config cascade.** `AgentMcpConfig` (`src/config.ts`) declares only `db`, `logging`, `queue`, `server`, `transport`, `sse`, `plugins` as cascade-managed fields — no `providers`/secret field exists. Provider credentials resolve exclusively from `process.env` on the running server process, at agent-construction time, never from a config file layer (global/project/namespace). This repo's own `.mcp.json` entry for `agent-mcp` does not forward any `ADHD_AGENT_<PROVIDER>_SECRET` today — tracked as backlog `agent-mcp-001`.

### Database

- **Location:** zero-config default under the resolved scope root (never the repo tree), configurable via `ADHD_AGENT_DATABASE_PATH` (`src/config.ts` `"db.path"` field — falls back to `env.files.db` when unset)
- **Tables:** `agents`, `sessions`, `messages`, `task_usage`, `migrations`
- **Persistence:** All agents, conversations, and usage records persist across server restarts
- **Migration:** `npm run db:migrate` (drizzle-kit auto-applied on server start as of 2.0.2)

### Providers (Supported Models)

There are exactly three provider `type`s in code (`packages/agent/agent-engine-orchestrator/src/validation/agent.ts`: `anthropicProviderSchema`, `openaiProviderSchema`, `claudecliProviderSchema`). "DeepSeek" and "Gemini" are **not** separate provider types:

| Provider `type` | Models | Notes |
|---|---|---|
| `anthropic` | claude-opus-4-1, claude-sonnet-4 | Full JSON-schema tool support; cache-aware usage reporting; credential via `ADHD_AGENT_ANTHROPIC_SECRET` |
| `openai` | gpt-4-turbo, gpt-4o, gpt-4o-mini, and any OpenAI-compatible model (e.g. DeepSeek's `deepseek-v4-flash`/`deepseek-v4-pro` via an explicit `env.base_url` override) | Full JSON-schema tool support; cache-aware usage reporting (2.0.2+); credential via `ADHD_AGENT_OPENAI_SECRET` (or `ADHD_AGENT_DEEPSEEK_SECRET` when overridden for DeepSeek) |
| `claudecli` | Whatever the host's authenticated `claude` CLI supports | Subprocess-based; needs no provider-credential env var at all |

**Not shipped:** a dedicated `"deepseek"` provider type, and Gemini support in any form (no provider adapter, no `GOOGLE_API_KEY`/credential path, no model recognized). Prior versions of this document listed both as supported; they were not verified against code and are corrected here.

### Token Accounting (2.0.2 Changes)

**New fields in `task_usage` response:**

```json
{
  "inputTokens": 715316,              // cumulative across all model calls
  "peakContextTokens": 43187,         // max prompt size in any single call (NEW 2.0.2)
  "cacheReadTokens": 525056,          // cache-hit tokens (provider-dependent; 2.0.2+)
  "uncachedInputTokens": 190260,      // full-price tokens (provider-dependent; 2.0.2+)
  "cacheCreationTokens": 0,           // Anthropic cache-write surcharge, if any (2.0.2+)
  "reasoningTokens": 2101,            // inference tokens from reasoning-capable models (2.0.2+)
  "outputTokens": 7370                // generation tokens
}
```

**Breaking change:** Code that interpreted `inputTokens` as "max context size" must now use `peakContextTokens` for that purpose.

### Context Management (2.0.2 Changes)

**Default behavior:** `ADHD_AGENT_CONTEXT_LIMIT=0` (disabled). No automatic message eviction.

**If limit is enabled** (limit > 0):
- Messages are kept append-only until the provider's actual `prompt_tokens` approaches the limit
- When triggered, the **middle** of the conversation is collapsed into a synthetic summary message, exactly once
- The leading prefix (system + early context) is never mutated; this preserves provider-side prefix caching

**Prior behavior (2.0.0-2.0.1):** Evicted from the front on every threshold crossing, destroying cache hits (measured: 3.3x cost inflation).

### Tool Advertisement (2.0.2 Changes)

**Default:** Full JSON-Schema function-calling for all non-claudecli providers.

**Alternative:** Set `toolAdvertisement: 'names'` on agent creation to use name-only tools (with prose descriptions in system message).

**Prior behavior (2.0.0-2.0.1):** Silently defaulted to name-only for all non-claudecli agents, breaking provider-side tool-call validation.

### Delegation (Agent → Child Agent)

An agent can delegate to child agents by calling the `task` tool targeting another agent (when allowed by parent policy). Child agents:
- Have reduced token/cost budgets
- Have restricted tool and filesystem access (subset of parent)
- Cannot delegate further if `maxDelegationDepth` is reached
- Are supervised by the same SQLite database and policy engine

## Known Limitations (as of 2.0.2)

| Limitation | Status | Impact |
|---|---|---|
| No OS-level sandboxing | By design | Filesystem/network enforcement is policy-based, not OS-based |
| No external security audit | Incomplete | Treat as experimental/research-grade |
| Single-user isolation | By design | All MCP clients share the same agent database and access all agents |
| Prompt injection not mitigated | By design | Tool filtering is guidance; creative prompts may bypass it |
| Experimental state recovery | Partial | Assume data loss on ungraceful shutdown |
| No multi-provider per-agent | By design | One provider per agent; agent-mcp server-wide provider is the default |
| No agent-specific timeouts | Not implemented | Uses server-wide `maxToolLoops` only |

## Roadmap Items (Not Shipped)

These are not yet implemented:

- Per-agent provider selection (currently server-wide)
- per-agent-specific request timeouts (independent of maxToolLoops)
- Runtime budget monitoring API (only stored after task completion)
- Agent state snapshots / recovery on host crash
- Multi-user isolation (per-API-key access control)
- OS-level sandboxing (container, seccomp, pledge/unveil)
- External security audit and compliance matrix

Do not document these as shipped features.

## Dependencies

### Runtime (Required)

- `@adhd/agent-engine-orchestrator` — orchestration engine
- `@adhd/agent-store-runtime` — state persistence
- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `drizzle-orm`, `better-sqlite3` — database access
- `pino` — logging
- `zod` — validation

### Build/Test

- TypeScript, Vite, ESLint (standard monorepo tooling)

## Database Migrations

As of 2.0.2, two migrations are required:

- **0008:** Adds `peak_context_tokens`, `peak_context_at`, and cache/reasoning fields to `task_usage` table
- **0009:** Restores `sessions.agent_name → agents.name ON DELETE CASCADE` foreign-key constraint

Migration is auto-applied on server start.

## Example Usage (Fact-Based)

When an MCP client sends:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "agent_create",
  "params": {
    "name": "research-agent",
    "config": {
      "provider": "anthropic",
      "model": "claude-opus-4-1",
      "tools": {
        "allow": ["filesystem__read_text_file", "filesystem__read_dir"]
      },
      "filesystem": {
        "read": ["/Users/me/code"]
      }
    }
  }
}
```

The server:
1. Validates `config` against the schema
2. Checks the env-name guard (any `provider.env` keys must be `ADHD_AGENT_` prefixed; NEW in 2.0.2)
3. Creates a row in the `agents` table
4. Returns `{agentId: "research-agent"}`

When the client sends:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "task",
  "params": {
    "agentName": "research-agent",
    "prompt": "Find all TypeScript files in /Users/me/code"
  }
}
```

The server:
1. Fetches the agent config and prior session history
2. Constructs a message list: `[system_prompt, prior_messages..., new_user_message]`
3. Calls `provider.chat({model: "claude-opus-4-1", messages, tools})`
4. If the model returns tool calls, executes them (respecting the `allow` filter)
5. Appends tool results and repeats (up to 50 loops)
6. When the model stops tool-calling, records the task in `task_usage` with token counts
7. Returns `{taskId, status, result, usage}`

All data persists in SQLite; the client can later call `result(taskId)` to retrieve the task's result or `usage_query()` to retrieve token usage.

## Verifiable Claims

Every claim in this document is tied to:

- **Code:** Method exists in `src/` and is called by the MCP transport layer
- **Tests:** Behavior is tested in `src/__tests__/`
- **Database:** Schema fields exist and are persisted
- **BACKLOG:** Bugs and fixes are logged with receipts (BUG-ORCH-003 through BUG-ORCH-014)
- **Research docs:** `docs/ideas/` contain wire-trace evidence for 2.0.2 changes

Do not present this document as aspirational. All features are currently shipped.
