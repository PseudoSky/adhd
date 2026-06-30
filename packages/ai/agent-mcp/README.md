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
| `usage_query` | Query recorded token usage. Filters by `task_id` (returns full delegation subtree), `root_task_id`, `agent_name`, or `since`. Set `group_by: "agent" \| "model" \| "provider"` to aggregate token spend, latency, and success/fail counts by that dimension — ordered by total token spend desc |
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

**Recommended — put secrets in `~/.adhd/.env`, not in the MCP config**

Create `~/.adhd/.env` (loaded automatically at startup):
```bash
# OpenAI
ADHD_AGENT_OPENAI_SECRET=sk-...

# Anthropic
ADHD_AGENT_ANTHROPIC_SECRET=sk-ant-...
```

Then the MCP config needs no secrets at all:

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"]
    }
  }
}
```

**`.env` load hierarchy.** At startup the server loads up to three `.env` files and
merges them with **most-specific wins**:

| Order | File | Typical use |
|---|---|---|
| 1 (highest) | `<project>/.env` | per-checkout overrides |
| 2 | `<project>/.adhd/.env` | per-project shared (gitignored) |
| 3 (lowest) | `~/.adhd/.env` | your machine-wide secrets |

A key set in `<project>/.env` beats the same key in `~/.adhd/.env`. Values are read
**once** and frozen for the process lifetime — after editing any `.env`, reload the MCP
server (e.g. `/mcp` in your host) so the new values are picked up. Why a file and not the
MCP-config `env` block? A stdio MCP host forwards only a tiny allowlist of OS vars
(`HOME`, `PATH`, …) to the server and does **not** expand `${VAR}` in the config, so the
`.env` files are the reliable, secret-free way to get credentials into the server.

> **Secrets are referenced by env-var *name*, never by value.** An agent's
> `provider.env.secret` holds the *name* of the env var (e.g. `ADHD_AGENT_OPENAI_SECRET`),
> so stored agent definitions — and `agent_read` / `agent_list` output — never contain the
> key itself. Only `ADHD_AGENT_`-prefixed names may be referenced by default (extend with
> `ADHD_AGENT_ENV_ALLOWLIST`).

**LM Studio** (local — no credentials needed; server runs on localhost)
```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"]
    }
  }
}
```

**OpenAI** (put key in `~/.adhd/.env` — see above; or inline for quick tests)
```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"],
      "env": {
        "ADHD_AGENT_OPENAI_SECRET": "sk-..."
      }
    }
  }
}
```

**Anthropic** (put key in `~/.adhd/.env` — see above; or inline for quick tests)
```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"],
      "env": {
        "ADHD_AGENT_ANTHROPIC_SECRET": "sk-ant-..."
      }
    }
  }
}
```

For **Claude Code** save this as `.mcp.json` in your project root. Any other MCP host uses the same `command` / `args` / `env` structure.

All environment variables use the `ADHD_AGENT_` prefix. The full reference:

| Variable | Default | Description |
|---|---|---|
| `ADHD_AGENT_DATABASE_PATH` | `~/.adhd/agent-mcp/agents.db` | Absolute path to the SQLite database file. Created automatically if it does not exist. |
| `ADHD_AGENT_OPENAI_SECRET` | `""` | OpenAI (or OpenAI-compatible) API key |
| `ADHD_AGENT_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL (override to point at LM Studio, Ollama, etc.) |
| `ADHD_AGENT_ANTHROPIC_SECRET` | `""` | Anthropic API key or OAuth bearer token |
| `ADHD_AGENT_DEEPSEEK_SECRET` | `""` | DeepSeek API key |
| `ADHD_AGENT_ALLOWED_AGENTS` | unrestricted | Comma-separated list of agents any agent may delegate to (server-wide fallback) |
| `ADHD_AGENT_MAX_DEPTH` | `5` | Maximum recursion depth |
| `ADHD_AGENT_MAX_TOOL_LOOPS` | `50` | Maximum tool calls per task |
| `ADHD_AGENT_CONTEXT_LIMIT` | `0` (disabled) | Estimated token limit for the message window. When > 0, oldest non-system messages are dropped before each provider call. Set ~10% below the model's actual context window. |
| `ADHD_AGENT_DEFAULT_MAX_TOKENS` | `8192` | Default `max_tokens` for Anthropic providers that do not set `maxTokens` in their agent config. |
| `ADHD_AGENT_LOG_LEVEL` | `info` | Pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`/`silent`) |
| `ADHD_AGENT_QUEUE_CONCURRENCY` | `5` | Max concurrent background tasks |
| `ADHD_AGENT_SSE_PORT` | `3001` | SSE server port |
| `ADHD_AGENT_SSE_BASE_URL` | `http://localhost:{port}` | Public base URL for SSE stream links |
| `ADHD_AGENT_ENV_ALLOWLIST` | `""` | Comma-separated env-var names agents may reference that don't start with `ADHD_AGENT_` |

### 2. Create a sub-agent

Call `agent_create` from your LLM:

```json
{
  "name": "researcher",
  "provider": {
    "type": "openai",
    "model": "your-model-name",
    "baseURL": "http://localhost:1234/v1",
    "timeoutMs": 120000
  },
  "systemPrompt": "You are a research assistant. Answer questions thoroughly and cite your reasoning.",
  "mcpServers": {},
  "permissions": {}
}
```

For a local LM Studio server no credentials are needed — the localhost exemption applies automatically. For OpenAI, set `ADHD_AGENT_OPENAI_SECRET` in `~/.adhd/.env` and omit `baseURL`.

### 3. Create an orchestrator

An orchestrator is just an agent whose system prompt tells it to delegate, and whose `mcpServers` gives it access to `agent-mcp` itself:

```json
{
  "name": "orchestrator",
  "provider": {
    "type": "openai",
    "model": "your-model-name",
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
        "ADHD_AGENT_ALLOWED_AGENTS": "researcher"
      }
    }
  },
  "permissions": {
    "allowedAgents": ["researcher"]
  }
}
```

`ADHD_AGENT_ALLOWED_AGENTS` and `permissions.allowedAgents` restrict which agents the orchestrator can delegate to. Both must list the same agents.

### 4. Call the orchestrator

```
agent → { name: "orchestrator" }                           → { session_id: "..." }
task  → { session_id: "...", prompt: "...", background: false }
```

The orchestrator model runs its tool-use loop, delegates to `researcher`, and returns a final answer.

---

## Providers

### LM Studio (local, Ollama, and any OpenAI-compatible server)

Local servers on `localhost` or `127.0.0.1` require no credentials — the localhost exemption applies automatically:

```json
{
  "type": "openai",
  "model": "your-model-name",
  "baseURL": "http://localhost:1234/v1",
  "timeoutMs": 180000
}
```

For Ollama use `baseURL: "http://localhost:11434/v1"`. No `env.secret` needed for either.

> **Migration note:** The `"type": "lmstudio"` alias still works but is deprecated. Use `"type": "openai"` with an explicit `baseURL`.

### OpenAI

```json
{
  "type": "openai",
  "model": "gpt-4o-mini",
  "env": { "secret": "ADHD_AGENT_OPENAI_SECRET" }
}
```

Set `ADHD_AGENT_OPENAI_SECRET` in `~/.adhd/.env`. The `env.secret` field is the env-var **name** that holds the key, not the key itself — so secrets never appear in agent definitions stored in the database.

### Anthropic

One credential field — `env.secret` — holds **either** a console API key (`sk-ant-api…`)
**or** an OAuth/subscription token (`sk-ant-oat…`, from `claude setup-token`). The provider
infers the wire form from the value's prefix; there is no separate field or flag.

```json
{
  "type": "anthropic",
  "model": "claude-sonnet-4-6",
  "env": { "secret": "ADHD_AGENT_ANTHROPIC_SECRET" }
}
```

Set `ADHD_AGENT_ANTHROPIC_SECRET` in `~/.adhd/.env` to **either** form:

- **`sk-ant-api…`** (console.anthropic.com API key) → sent as an `x-api-key` client; your
  agent's system prompt is used verbatim.
- **`sk-ant-oat…`** (OAuth token; run `claude setup-token`) → sent as
  `Authorization: Bearer` with the `anthropic-beta: oauth-2025-04-20` header, and the
  Claude Code identity (`"You are Claude Code, Anthropic's official CLI for Claude."`) is
  prepended as a **distinct first `system` block**, your agent's own prompt following as
  the second block. Anthropic's OAuth gate requires this exact shape — a `system` that
  isn't the identity as its own block is rejected with a *misleading* `429
  rate_limit_error` (no rate-limit headers). So under an OAuth token the model is told it
  is "Claude Code" before it sees your instructions.

> **Removed in the env overhaul (see CHANGELOG):** the macOS-keychain `useClaudeOauth`
> mode and the separate `apiKeyEnv` / `authTokenEnv` fields. Use the unified `env.secret`
> above; the one-year token from `claude setup-token` is the supported keychain-free path.

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

**Header-driven tools (`systemPromptIsAgentSpec`):** If you'd rather let an agent's own
markdown spec govern its tools, set `systemPromptIsAgentSpec: true` and make the agent's
`systemPrompt` a complete Claude Code agent file — YAML frontmatter (`name`, `description`,
`tools`, …) plus body:

```json
{ "type": "claudecli", "systemPromptIsAgentSpec": true }
```

```markdown
---
name: my-runner
description: runs delegated tasks
tools: Read, Grep, mcp__agent-mcp__task
---
You are a careful task runner…
```

In this mode the provider writes the spec to an isolated temp project dir and passes
`--add-dir … --setting-sources project --agent <name>` instead of `--system-prompt` /
`--disallowedTools`, so **Claude internally parses the `tools:` header** and that header
governs tool access — taking precedence over `allowedBuiltinTools` (which is ignored).
`--agent` matches the frontmatter `name:` (not the filename), and the working directory is
preserved so `Bash`/`Read`/`Write` keep their root. Omit `tools:` to inherit all tools; list
`mcp__<server>__<tool>` entries to expose specific MCP tools.

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
full delegation subtree); `usage_query` reports raw rows by `task_id`, `root_task_id`,
`agent_name`, or time window. Pass `group_by: "agent" | "model" | "provider"` to
aggregate across all matching rows — each group includes `taskCount`,
`completedCount`, `failedCount`, `cancelledCount`, token totals, and `avgLatencyMs`,
ordered by total token spend descending.

---

## Orchestration

When an agent's `mcpServers` includes `agent-mcp`, the server detects it and routes calls in-process — no extra network hop. This is how recursive delegation works without external servers.

### Policy engine

Before each delegation, the server checks:

1. **Recursion depth** — default max 5. Configurable via `AGENT_MCP_MAX_DEPTH`.
2. **Tool loop limit** — default max 50 tool calls per task. Configurable via `AGENT_MCP_MAX_TOOL_LOOPS`.
3. **allowedAgents** — per-agent `permissions.allowedAgents` takes precedence over the server-level `ADHD_AGENT_ALLOWED_AGENTS` env var.
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
    "type": "openai",
    "model": "your-local-model",
    "baseURL": "http://localhost:1234/v1"
  },
  "systemPrompt": "You are a local assistant. Complete the task you are given.",
  "mcpServers": {},
  "permissions": {}
}
```

No credentials needed — the localhost exemption applies automatically for `localhost`/`127.0.0.1`.

**2. Create a Claude orchestrator**

The `mcpServers` key must be `"agent-mcp"` exactly — the registry detects this name and routes calls in-process rather than spawning a new subprocess.

```json
{
  "name": "claude-orchestrator",
  "provider": {
    "type": "anthropic",
    "model": "claude-haiku-4-5",
    "env": { "secret": "ADHD_AGENT_ANTHROPIC_SECRET" }
  },
  "systemPrompt": "You coordinate work. Use the agent-mcp__task tool to delegate tasks to other agents. Always report back what the sub-agent returned.",
  "mcpServers": {
    "agent-mcp": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp"],
      "env": {
        "ADHD_AGENT_ALLOWED_AGENTS": "lmstudio-worker"
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
        "ADHD_AGENT_ALLOWED_AGENTS": "lmstudio-worker"
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

## Plugins

The server supports external plugins that hook into the task lifecycle. Plugins are
enabled via an `agent-mcp.config.json` file (project root or `~/.agent-mcp/config.json`,
or pointed at by `ADHD_AGENT_CONFIG`):

```json
{
  "plugins": [
    { "module": "@adhd/agent-mcp-budget",  "config": { "maxTotalTokens": 50000 } },
    { "module": "@adhd/agent-mcp-sanitize" }
  ]
}
```

Or via the `ADHD_AGENT_PLUGINS` environment variable (legacy shorthand):

```
ADHD_AGENT_PLUGINS="@adhd/agent-mcp-budget,@adhd/agent-mcp-sanitize"
```

Official plugins:

| Package | Purpose |
|---------|---------|
| [`@adhd/agent-mcp-budget`](https://www.npmjs.com/package/@adhd/agent-mcp-budget) | Cap token spend, cost, wall-clock time per task/session/agent |
| [`@adhd/agent-mcp-policy`](https://www.npmjs.com/package/@adhd/agent-mcp-policy) | Rate limits and delegation permissions |
| [`@adhd/agent-mcp-sanitize`](https://www.npmjs.com/package/@adhd/agent-mcp-sanitize) | Sub-agent output sanitization (prompt-injection defence) |

All failures are logged and skipped — a broken plugin never prevents the server from
starting.

### Writing a plugin

A plugin is a package that exports a `createPlugin` factory (default or named) and
optionally a `configSchema` (Zod-compatible). The factory receives `{ db, config }`
and returns a `Plugin` with an `install(hooks)` method:

```ts
import type { Plugin, PluginContext } from "@adhd/agent-mcp-types";

export const configSchema = z.object({ ... });

export default function createPlugin({ config }: PluginContext): Plugin {
  return {
    name: "my-plugin",
    install(hooks) {
      hooks.register("transform:tool_result", (payload) => {
        // mutate payload.result before it reaches the parent model
      });
    },
  };
}
```

Available hook events:

| Event | Contract |
|-------|----------|
| `task:start` | Observational |
| `pre:model_request` | **Enforcement** (throws fail the task) |
| `post:model_response` | Observational |
| `pre:tool_call` | Observational |
| `post:tool_call` | Observational |
| `transform:tool_result` | **Transform** (mutate `payload.result` in place) |
| `message:appended` | Observational |
| `task:completed` / `task:failed` / `task:cancelled` | Observational |

Observational handlers have errors swallowed — a buggy plugin never kills a task.
Enforcement handlers on `pre:model_request` can throw to fail the task (used by the
budget plugin). Transform handlers on `transform:tool_result` mutate the tool result
before it enters conversation history (used by the sanitize plugin).

---

## MCP notifications

When a background task completes, the server pushes a `notifications/task/completed`
notification over the connected transport. Hosts that support MCP notifications can
react without polling the `result` tool.

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
| `PROVIDER_AUTH_ERROR` | Provider authentication failed (HTTP 401, or no credential resolved). Set the provider's `env.secret` env var in `~/.adhd/.env` (for Anthropic, an API key `sk-ant-api…` or a `claude setup-token` OAuth token `sk-ant-oat…`). |
| `PROVIDER_RATE_LIMITED` | Provider rate limit exceeded (HTTP 429 after retries) |
| `CONTEXT_WINDOW_EXCEEDED` | Session history exceeded the model's context window. Set `AGENT_MCP_CONTEXT_LIMIT` to enable automatic sliding-window truncation. |
| `MCP_CLIENT_ERROR` | An MCP tool call within a task failed |
