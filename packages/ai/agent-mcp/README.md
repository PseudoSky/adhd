# @adhd/agent-mcp

Give any LLM the ability to spawn, delegate to, and coordinate other AI agents — locally with LM Studio, or via OpenAI and Anthropic.

`agent-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. Connect it to your LLM host and your model gains a set of tools for creating agents, opening conversation sessions, running tasks, and delegating work recursively to sub-agents.

---

## How it works

```mermaid
graph LR
    C(Claude) -->|@adhd/agent-mcp| O(LM Studio\norchestrator)
    O -->|@adhd/agent-mcp| A(LM Studio\nresearcher)
    O -->|@adhd/agent-mcp| B(LM Studio\ncoder)
    O -->|@adhd/agent-mcp| D(LM Studio\nsummariser)
```

Four concepts:

| Concept | Description |
|---|---|
| **Agent** | A stored definition: provider, model, system prompt, which MCP servers it can use, and which other agents it is allowed to call. |
| **Session** | A stateful conversation thread for one agent. Stores the message history. |
| **Task** | A prompt submitted to a session. Runs the agent's tool-use loop until the model produces a final answer. Can be synchronous or background. |
| **Orchestration** | An agent whose system prompt instructs it to delegate — it calls `agent` + `task` tools to spawn sub-agents, just like you do. |

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
| `task` | Submit a prompt to a session (sync or background) |
| `result` | Get the current state and result of a task |
| `task_list` | List tasks, optionally filtered by session or status |
| `task_cancel` | Cancel a pending or running task |
| `usage` | Show server configuration and runtime info |

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

```json
{
  "type": "anthropic",
  "model": "claude-sonnet-4-5",
  "apiKeyEnv": "ANTHROPIC_API_KEY"
}
```

All providers accept: `timeoutMs`, `maxTokens`, `temperature`, and `retryConfig`.

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

Task statuses: `pending → running → completed | failed | cancelled`.

### List tasks

```
task_list → { session_id: "..." }
task_list → { session_id: "...", status: "completed" }
```

### Cancel

```
task_cancel → { task_id: "..." }
```

Cancels a `pending` or `running` task. Returns `{ success: true }`.

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
| `DELEGATION_NOT_ALLOWED` | Target agent is not in `allowedAgents` |
| `MAX_DEPTH_EXCEEDED` | Recursion depth limit reached |
| `MAX_TOOL_LOOPS_EXCEEDED` | Tool call limit per task reached |
| `PROVIDER_ERROR` | The LLM provider call failed (includes timeout messages) |
| `MCP_CLIENT_ERROR` | An MCP tool call within a task failed |
