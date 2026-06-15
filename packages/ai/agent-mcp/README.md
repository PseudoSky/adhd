# @adhd/agent-mcp

Give any LLM the ability to spawn, delegate to, and coordinate other AI agents — locally with LM Studio, or via OpenAI and Anthropic.

`agent-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. Connect it to your LLM host and your model gains a set of tools for creating agents, opening conversation sessions, running tasks, and delegating work recursively to sub-agents.

---

## Tool reference

| Tool | Description |
|---|---|
| `agent_create` | Create a new agent definition |
| `agent_read` | Read an agent definition by name |
| `agent_update` | Partially update an agent definition |
| `agent_list` | List all agent definitions |
| `agent_delete` | Delete an agent (requires no active sessions) |
| `agent` | Open a new session for an agent |
| `session_list` | List sessions, optionally filtered by agent or status |
| `session_close` | Close an active session |
| `session_clear` | Clear all messages from a session's context without closing it |
| `task` | Submit a prompt — either to a session (`session_id`) or as a one-shot ephemeral run (`agent_name`); sync or background. Supports `depends_on` (DAG fan-in) and `stream` (SSE). The response includes a `usage` rollup of token counts for the task and its delegation subtree |
| `result` | Get the current state and result of a task (includes the `usage` rollup) |
| `task_list` | List tasks, optionally filtered by session, status, or `is_ephemeral` |
| `task_cancel` | Cancel a pending or running task |
| `task_resume` | Resume a task suspended in `awaiting_input` by supplying the human's answer (see Human-in-the-loop) |
| `usage_query` | Query recorded token usage from `task_usage` by `task_id` (returns the full delegation subtree), `root_task_id`, `agent_name`, or time window |
| `guide` | Return the full server usage guide |

---

## How it works

```mermaid
graph LR
    C(Claude Code\nor any MCP host) -->|MCP| S(@adhd/agent-mcp)
    S -->|orchestrates| O(Claude\norchestrator)
    O -->|agent-mcp task| A(LM Studio\nworker)
    O -->|agent-mcp task| B(OpenAI\nworker)
```

Four concepts:

| Concept | Description |
|---|---|
| **Agent** | A stored definition: provider, model, system prompt, which MCP servers it can use, and which other agents it is allowed to call. |
| **Session** | A stateful conversation thread for one agent. Stores the message history. |
| **Task** | A prompt submitted to a session. Runs the agent's tool-use loop until the model produces a final answer. Can be synchronous or background. |
| **Orchestration** | An agent whose system prompt instructs it to delegate — it calls `agent` + `task` tools to spawn sub-agents, just like you do. |

---

## Quickstart

### 1. Add to your MCP config

Pick the tab for your provider and paste the block into your MCP host config.

**LM Studio**
```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "LMSTUDIO_API_KEY": "your-lmstudio-key",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1"
      }
    }
  }
}
```

**OpenAI**
```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

**Anthropic**
```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

For **Claude Code** save this as `.mcp.json` in your project root. For **LM Studio** paste it into the MCP plugin settings. Any other MCP host uses the same `command` / `args` / `env` structure.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_PATH` | required | Absolute path to the SQLite database file. Created automatically if it does not exist. |
| `LMSTUDIO_API_KEY` | `""` | LM Studio API key (any non-empty string if your server doesn't require one) |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio server base URL |
| `OPENAI_API_KEY` | `""` | OpenAI API key |
| `ANTHROPIC_API_KEY` | `""` | Anthropic API key |
| `ALLOWED_AGENTS` | unrestricted | Comma-separated list of agents any agent may delegate to (server-wide fallback) |
| `AGENT_MCP_MAX_DEPTH` | `5` | Maximum recursion depth |
| `AGENT_MCP_MAX_TOOL_LOOPS` | `50` | Maximum tool calls per task |
| `AGENT_MCP_CONTEXT_LIMIT` | `0` (disabled) | Estimated token limit for the message window. When > 0, oldest non-system messages are dropped before each provider call. Set ~10% below the model's actual context window. |
| `AGENT_MCP_DEFAULT_MAX_TOKENS` | `8192` | Default `max_tokens` for Anthropic providers that do not set `maxTokens` in their agent config. |

### 2. Create a sub-agent

Call `agent_create` from your LLM:

```json
{
  "name": "researcher",
  "provider": {
    "type": "lmstudio",
    "model": "your-model-name",
    "apiKeyEnv": "LMSTUDIO_API_KEY",
    "baseURL": "http://localhost:1234/v1",
    "timeoutMs": 120000
  },
  "systemPrompt": "You are a research assistant. Answer questions thoroughly and cite your reasoning.",
  "mcpServers": {},
  "permissions": {}
}
```

### 3. Create an orchestrator

An orchestrator is just an agent whose system prompt tells it to delegate, and whose `mcpServers` gives it access to `agent-mcp` itself:

```json
{
  "name": "orchestrator",
  "provider": {
    "type": "lmstudio",
    "model": "your-model-name",
    "apiKeyEnv": "LMSTUDIO_API_KEY",
    "baseURL": "http://localhost:1234/v1",
    "timeoutMs": 180000
  },
  "systemPrompt": "You coordinate work by delegating to specialised agents. Use the agent and task tools to open sessions and run tasks. Never answer directly if a sub-agent can do better.",
  "mcpServers": {
    "agent-mcp": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "LMSTUDIO_API_KEY": "your-key",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1",
        "ALLOWED_AGENTS": "researcher"
      }
    }
  },
  "permissions": {
    "allowedAgents": ["researcher"]
  }
}
```

`ALLOWED_AGENTS` and `permissions.allowedAgents` restrict which agents the orchestrator can delegate to. Both must list the same agents.

### 4. Call the orchestrator

```
agent → { name: "orchestrator" }                           → { session_id: "..." }
task  → { session_id: "...", prompt: "...", background: false }
```

The orchestrator model runs its tool-use loop, delegates to `researcher`, and returns a final answer.

---

## Providers

### LM Studio (local)

```json
{
  "type": "lmstudio",
  "model": "your-model-name",
  "apiKeyEnv": "LMSTUDIO_API_KEY",
  "baseURL": "http://localhost:1234/v1",
  "timeoutMs": 180000
}
```

Set `LMSTUDIO_API_KEY` to any non-empty string if your local server does not require authentication.

### OpenAI

```json
{
  "type": "openai",
  "model": "gpt-4o-mini",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

### Anthropic

Three auth modes, tried in order:

**API key** (standard, all platforms)
```json
{
  "type": "anthropic",
  "model": "claude-haiku-4-5",
  "apiKeyEnv": "ANTHROPIC_API_KEY"
}
```

**Bearer token via env var** (all platforms — works with `claude setup-token` or any manually-set token)
```json
{
  "type": "anthropic",
  "model": "claude-haiku-4-5",
  "authTokenEnv": "ANTHROPIC_AUTH_TOKEN"
}
```
Set `ANTHROPIC_AUTH_TOKEN` in your MCP server env to the token value.

**Claude Max keychain** (macOS only — no API key or billing required)
```json
{
  "type": "anthropic",
  "model": "claude-haiku-4-5",
  "useClaudeOauth": true
}
```
Reads the OAuth token that Claude Code stores in the macOS keychain under `Claude Code-credentials`. Automatically refreshes when the token is within 5 minutes of expiry. Requires Claude Code to be installed and authenticated (`claude auth login --claude-ai`). No additional env vars needed.

> **Platform note:** `useClaudeOauth` only works on macOS. Use `authTokenEnv` on Linux or Windows.

**What OAuth mode adds to your agent's system prompt.** When the Anthropic token is an OAuth/subscription token (`sk-ant-oat…` — used by both `useClaudeOauth` and an OAuth `authTokenEnv`), the provider automatically (a) sets the `anthropic-beta: oauth-2025-04-20` header and (b) prepends the Claude Code identity — `"You are Claude Code, Anthropic's official CLI for Claude."` — to the request's `system` **as a distinct first block**, with your agent's own system prompt preserved as the second block. Anthropic's OAuth gate requires this: a request whose `system` isn't the identity as its own block is rejected with a *misleading* `429 rate_limit_error` (with no rate-limit headers). So under OAuth your model is told it is "Claude Code" before it sees your agent's instructions. Plain API keys (`sk-ant-api…`) get neither the header nor the identity and use your system prompt verbatim.

### Claude CLI

```json
{
  "type": "claudecli",
  "model": "claude-haiku-4-5",
  "claudePath": "claude",
  "allowedBuiltinTools": []
}
```

Drives the local `claude` CLI as a subprocess using bidirectional `stream-json` I/O. Uses whatever credentials Claude Code already has (`claude auth status`). No API key or env var needed.

The agent's `mcpServers` are written to a temp file and passed via `--mcp-config --strict-mcp-config` — so MCP tools (including in-process agent-mcp delegation) work exactly as with other providers. The subprocess runs its own internal tool loop and returns a final answer; the orchestrator sees `stopReason: "completed"` directly.

**Tool access:** All Claude Code built-in tools (`Bash`, `Edit`, `Read`, `Write`, etc.) are blocked by default via `--disallowedTools`. To selectively re-enable specific built-ins, list them in `allowedBuiltinTools`:

```json
{ "type": "claudecli", "allowedBuiltinTools": ["WebFetch"] }
```

> **Limitations:**
> - No `temperature`, `maxTokens`, or `retryConfig` — those are not exposed by the CLI
> - Per-tool-call hooks, policy enforcement (max tool loops, delegation checks), and task event logging do not fire for tool calls that happen inside the subprocess — only the final result is surfaced to the orchestrator
> - Conversation history across tasks is text-encoded in the prompt, not structured messages

`anthropic`, `openai`, and `lmstudio` providers accept: `timeoutMs`, `maxTokens`, `temperature`, and `retryConfig`.

#### retryConfig

```json
{
  "retries": 3,
  "minTimeout": 1000,
  "maxTimeout": 30000,
  "factor": 2
}
```

---

## Agents

### Create

`agent_create` — stores a new agent definition. Returns the created agent.

Required fields: `name`, `provider`, `systemPrompt`, `mcpServers`, `permissions`.

### Read

`agent_read` — returns a single agent by name.

### Update

`agent_update` — partial patch. Only the fields you include are changed; everything else is preserved.

```json
{ "name": "researcher", "patch": { "systemPrompt": "New prompt." } }
```

### List

`agent_list` — returns all stored agents.

### Delete

`agent_delete` — removes an agent. Fails with `AGENT_HAS_ACTIVE_SESSIONS` if any sessions are still open. Close them first.

### Equipping agents with external tools

Any agent — not just orchestrators — can have MCP servers in its `mcpServers` config. This is how you give a local model write access to the filesystem, database access, browser tools, or any other MCP-compatible capability.

**Example: LM Studio agent with filesystem write access**

Create an agent with `@modelcontextprotocol/server-filesystem` restricted to a specific directory:

```json
{
  "name": "file-writer",
  "provider": {
    "type": "lmstudio",
    "model": "qwen2.5-coder-7b-instruct-mlx",
    "baseURL": "http://localhost:1234/v1",
    "timeoutMs": 60000
  },
  "systemPrompt": "You are a file-writing assistant. You have access to filesystem tools restricted to the ./tmp directory. When asked to write a file, use the write_file tool. Confirm what you wrote after completing the action.",
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/tmp"]
    }
  },
  "permissions": { "allowedAgents": [] }
}
```

Run a one-shot write (no session needed):

```
task → { agent_name: "file-writer", prompt: "Write a file to /absolute/path/to/tmp/hello.txt with content 'hello world'" }
// → { status: "completed", result: "File written to hello.txt." }
```

> **Tip:** Smaller local models (7B–9B range) are literal with paths — use the full absolute path in the prompt rather than a relative `./tmp/hello.txt`. The model calls `write_file` reliably when given an unambiguous target.

---

## Sessions

A session is a conversation thread tied to one agent. The agent's definition is snapshotted at creation time — updating the agent does not affect open sessions.

### Open

```
agent → { name: "researcher" }
```

Returns `{ session_id }`.

### List

```
session_list → {}                                   # all sessions
session_list → { agentName: "researcher" }          # filter by agent
session_list → { status: "active" }                 # filter by status
```

Statuses: `active`, `closed`.

### Close

```
session_close → { session_id: "..." }
```

Running tasks are not affected. Once closed, no new tasks can be submitted.

### Clear context

```
session_clear → { session_id: "..." }
```

Deletes all messages in the session's history without closing it. Returns `{ session_id, cleared }` where `cleared` is the number of messages removed. The session stays active and the next task starts with a blank slate.

---

## Tasks

### Run (sync)

```json
{ "session_id": "...", "prompt": "Summarise this document.", "background": false }
```

Blocks until the task completes. Returns `{ task_id, status }`.

### Run (background)

```json
{ "session_id": "...", "prompt": "...", "background": true }
```

Returns immediately with `{ task_id, status: "pending" }`. Poll with `result`.

### Poll result

```
result → { task_id: "..." }
```

Returns the full task record including `status`, `result` (on completion), and `error` (on failure).

Task statuses:

```
pending → running → completed | failed | cancelled
waiting  ─(deps resolved)→ pending        (see Task dependencies)
running  ─(request_human_input)→ awaiting_input ─(task_resume)→ running
```

| Status | Meaning |
|---|---|
| `pending` | Queued, not yet started |
| `running` | Executing the tool-use loop |
| `waiting` | Has unmet `depends_on` upstreams; dispatched automatically once they finish |
| `awaiting_input` | Suspended on a `request_human_input` call; resume with `task_resume` |
| `completed` / `failed` / `cancelled` | Terminal |

### List tasks

```
task_list → { session_id: "..." }
task_list → { session_id: "...", status: "completed" }
task_list → { is_ephemeral: true }
```

### Cancel

```
task_cancel → { task_id: "..." }
```

Cancels a `pending` or `running` task. Returns `{ success: true }`.

### Ephemeral tasks (one-shot, no session)

Call `task` with `agent_name` instead of `session_id` to run an agent once without
opening a persistent session:

```json
{ "agent_name": "summariser", "prompt": "Summarise this." }
```

No `sessions` or `messages` rows are written (the conversation context is not
retained), but the run is **fully observable**: a `tasks` row (`is_ephemeral: 1`,
`session_id: null`), its `task_events` (model/tool calls), and `task_usage` are all
persisted — so `result`, `task_list`, and `usage_query` work on ephemeral task IDs.
Ephemeral tasks cannot use `request_human_input` (no durable session to resume) and
are not re-enqueued on server restart (their in-memory context is gone).

### Task dependencies (DAG fan-in)

A task may declare upstream dependencies. It stays `waiting` until they all reach a
terminal state, then is dispatched automatically with the upstreams' results injected
as inputs:

```json
{ "session_id": "...", "prompt": "Merge the two analyses.",
  "depends_on": ["<taskId-A>", "<taskId-B>"], "on_upstream_failure": "fail" }
```

- `on_upstream_failure: "fail"` (default) — if any upstream fails, this task is marked
  `failed` and never runs.
- `on_upstream_failure: "skip"` — failed upstreams are dropped; the task runs with only
  the succeeded upstreams' inputs.

Cycles are rejected at submit time (`VALIDATION_ERROR`, no task row created).

### Parallel tool execution

Within a single turn, when the model emits multiple tool calls at once the orchestrator
executes them **concurrently** (`Promise.all`), not serially — so a fan-out turn that
delegates N sub-tasks dispatches them in parallel. Recursion-depth and tool-loop policy
are enforced *before* dispatch.

### Human-in-the-loop (HITL)

Set `allowHumanInput: true` on an agent to advertise the `builtin__request_human_input`
tool. When the model calls it, the task suspends in `awaiting_input` with a
`resume_token`. Provide the human's answer to continue:

```
task_resume → { taskId: "...", resumeToken: "...", userInput: "yes, proceed" }
```

The task transitions back to `running` and the loop continues with the answer injected.

### Streaming (SSE)

Call `task` with `stream: true` in background mode to get a `stream_url` back. A separate
HTTP server (default `SSE_PORT=3001`) exposes `GET /tasks/:id/stream`, emitting
`tool_call`, `tool_result`, `status_change`, and `done` events as the task runs.
(Per-token streaming is not yet emitted — see BACKLOG.md, FEAT-001.)

### Usage / cost tracking

Every model call records tokens, `max_tokens`, `stop_reason`, latency, and tool-call
count to `task_usage`. `task` and `result` include a `usage` rollup (the task plus its
full delegation subtree); `usage_query` reports by `task_id`, `root_task_id`,
`agent_name`, or time window.

---

## Orchestration

When an agent's `mcpServers` includes `agent-mcp`, the server detects it and routes calls in-process — no extra network hop. This is how recursive delegation works without external servers.

### Policy engine

Before each delegation, the server checks:

1. **Recursion depth** — default max 5. Configurable via `AGENT_MCP_MAX_DEPTH`.
2. **Tool loop limit** — default max 50 tool calls per task. Configurable via `AGENT_MCP_MAX_TOOL_LOOPS`.
3. **allowedAgents** — per-agent `permissions.allowedAgents` takes precedence over the server-level `ALLOWED_AGENTS` env var.
   - `undefined` = unrestricted
   - `[]` = block all delegation
   - `["researcher"]` = only allow delegation to `researcher`

### Example agent graph

```
orchestrator
  ├─ researcher   (web search, document analysis)
  ├─ coder        (code generation, review)
  └─ summariser   (distil long outputs)
```

Each agent has its own system prompt, provider, and optional `allowedAgents` restriction. The orchestrator calls whichever is appropriate for each sub-task.

### Cross-provider orchestration (Claude + local LM Studio)

Agents are provider-agnostic — the orchestrator and workers can run on completely different backends. A practical pattern is a Claude orchestrator (using your existing subscription, no extra billing) delegating to free local models for bulk work.

**1. Create a local worker**
```json
{
  "name": "lmstudio-worker",
  "provider": {
    "type": "lmstudio",
    "model": "your-local-model",
    "baseURL": "http://localhost:1234/v1"
  },
  "systemPrompt": "You are a local assistant. Complete the task you are given.",
  "mcpServers": {},
  "permissions": {}
}
```

**2. Create a Claude orchestrator**

The `mcpServers` key must be `"agent-mcp"` exactly — the registry detects this name and routes calls in-process rather than spawning a new subprocess.

```json
{
  "name": "claude-orchestrator",
  "provider": {
    "type": "anthropic",
    "model": "claude-haiku-4-5",
    "useClaudeOauth": true
  },
  "systemPrompt": "You coordinate work. Use the agent-mcp__task tool to delegate tasks to other agents. Always report back what the sub-agent returned.",
  "mcpServers": {
    "agent-mcp": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1"
      }
    }
  },
  "permissions": {
    "allowedAgents": ["lmstudio-worker"]
  }
}
```

**3. Dispatch to the orchestrator**

```
task → { agent_name: "claude-orchestrator", prompt: "Ask lmstudio-worker to summarise this paragraph: ..." }
```

Claude runs the tool-use loop, calls `agent-mcp__task` targeting `lmstudio-worker`, gets the local model's response, and returns a synthesised result. Both calls are logged as separate tasks in the database.

**Alternative: `claudecli` orchestrator**

If you have Claude Code installed and authenticated, you can use the `claudecli` provider instead of `anthropic` — no API key config required, and it uses Claude Code's built-in auth (subscription or API key, whichever is configured):

```json
{
  "name": "claudecli-orchestrator",
  "provider": {
    "type": "claudecli",
    "model": "claude-haiku-4-5"
  },
  "systemPrompt": "You coordinate work. Use the mcp__agent-mcp__task tool to delegate tasks to other agents. Always report back exactly what the sub-agent said.",
  "mcpServers": {
    "agent-mcp": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/agents.db",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1"
      }
    }
  },
  "permissions": {
    "allowedAgents": ["lmstudio-worker"]
  }
}
```

> **Note:** Inside the `claudecli` subprocess, MCP tools are prefixed `mcp__` — the tool is `mcp__agent-mcp__task`, not `agent-mcp__task`. Update the system prompt accordingly. The `claudecli` provider handles the prefix stripping when routing the actual call.

---

## Error codes

| Code | Meaning |
|---|---|
| `AGENT_NOT_FOUND` | No agent with that name exists |
| `AGENT_ALREADY_EXISTS` | `agent_create` with a duplicate name |
| `AGENT_HAS_ACTIVE_SESSIONS` | Cannot delete an agent with open sessions |
| `SESSION_NOT_FOUND` | No session with that ID |
| `SESSION_CLOSED` | Session is closed; submit tasks to an active session |
| `TASK_NOT_FOUND` | No task with that ID |
| `TASK_NOT_CANCELLABLE` | Task is already completed, failed, or cancelled |
| `TASK_NOT_RESUMABLE` | `task_resume` on a task that is not `awaiting_input`, or with a bad `resumeToken` |
| `VALIDATION_ERROR` | Invalid input — e.g. a `depends_on` cycle, or `request_human_input` from an ephemeral (`agent_name`) task |
| `DELEGATION_NOT_ALLOWED` | Target agent is not in `allowedAgents` |
| `MAX_DEPTH_EXCEEDED` | Recursion depth limit reached |
| `MAX_TOOL_LOOPS_EXCEEDED` | Tool call limit per task reached |
| `PROVIDER_ERROR` | Generic LLM provider failure |
| `PROVIDER_TIMEOUT` | Provider call timed out (`timeoutMs` exceeded) |
| `PROVIDER_AUTH_ERROR` | Provider authentication failed (HTTP 401, keychain denial, or OAuth fallback exhausted). Run `claude setup-token` and set `ANTHROPIC_AUTH_TOKEN`, or use `authTokenEnv` in the provider config. |
| `PROVIDER_RATE_LIMITED` | Provider rate limit exceeded (HTTP 429 after retries) |
| `CONTEXT_WINDOW_EXCEEDED` | Session history exceeded the model's context window. Set `AGENT_MCP_CONTEXT_LIMIT` to enable automatic sliding-window truncation. |
| `MCP_CLIENT_ERROR` | An MCP tool call within a task failed |
