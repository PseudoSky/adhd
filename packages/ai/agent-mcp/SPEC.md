# `@adhd/agent-mcp` — Specification

## 1. Problem

Local LLM agents can only call stateless tools. They have no way to delegate work to another agent, maintain a conversation with a sub-agent across turns, or run tasks asynchronously. `@adhd/agent-mcp` is an MCP server that fills this gap: it lets any MCP-capable LLM store named agent definitions and spawn, message, and await them at runtime.

---

## 2. Quick Start

```bash
# 1. Build (Nx project name is "agent-mcp")
npx nx build agent-mcp

# 2. Add to .mcp.json (migrations run automatically on first start)
{
  "mcpServers": {
    "agent-mcp": {
      "command": "node",
      "args": ["/path/to/dist/packages/ai/agent-mcp/index.js"],
      "env": { "DATABASE_PATH": "./data/agents.db" }
    }
  }
}

# 3. Call agent_create from your MCP client
# 4. Call agent({ name }) → get session_id
# 5. Call task({ session_id, prompt }) → get result
```

The server runs `migrate()` synchronously before accepting any connections. Tool listing will not be advertised until migrations are complete.

All log output goes to **stderr**. When `TRANSPORT=stdio`, stdout is exclusively the MCP JSON-RPC stream — any `console.log` would corrupt the protocol framing.

---

## 3. Overview

`@adhd/agent-mcp` runs as an MCP server. Any MCP client (Claude Desktop, LM Studio, a custom client) can connect to it and call its tools. The tools fall into three groups:

- **Agent CRUD** — manage stored agent definitions
- **Session tools** — create, list, and close stateful conversation sessions
- **Task tools** — submit work, cancel running tasks, poll results

An agent that has `@adhd/agent-mcp` listed in its own `mcpServers` config can recursively delegate to other agents, subject to the server's depth and allowlist policy.

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      @adhd/agent-mcp                         │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │           MCP Server (stdio / http / sse)              │  │
│  │              @modelcontextprotocol/sdk                 │  │
│  └──────────────────────┬─────────────────────────────────┘  │
│                         │ tools                               │
│      ┌──────────────────┼──────────────────┐                 │
│      ▼                  ▼                  ▼                 │
│  ┌─────────┐     ┌────────────┐     ┌───────────┐           │
│  │  Agent  │     │  Session   │     │   Task    │           │
│  │  CRUD   │     │  Tools     │     │  Tools    │           │
│  └────┬────┘     └─────┬──────┘     └─────┬─────┘           │
│       │                │                  │                  │
│       ▼                ▼                  ▼                  │
│  ┌──────────┐   ┌─────────────┐   ┌──────────────┐          │
│  │  Agent   │   │   Session   │   │  Execution   │          │
│  │  Store   │   │   Store     │   │  Engine      │          │
│  │ (SQLite) │   │  (SQLite)   │   │ ┌──────────┐ │          │
│  └──────────┘   └─────────────┘   │ │Orchestrat│ │          │
│                                   │ │or + Queue│ │          │
│  ┌──────────┐                     │ └──────────┘ │          │
│  │  Task    │◀────────────────────│ ┌──────────┐ │          │
│  │  Store   │                     │ │  Policy  │ │          │
│  │ (SQLite) │                     │ │  Engine  │ │          │
│  └──────────┘                     │ └──────────┘ │          │
│                                   └──────┬───────┘          │
│                              ┌───────────┘                  │
│                              ▼                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                  MCP Client Registry                 │   │
│  │    resolves McpServerConfig → transport client       │   │
│  │    detects self-referential "agent-mcp" entries      │   │
│  └──────────────────────────────────────────────────────┘   │
│                              │                               │
│           ┌──────────────────┼──────────────────┐           │
│           ▼                  ▼                  ▼           │
│    ┌────────────┐    ┌─────────────┐    ┌────────────┐      │
│    │   stdio    │    │    http     │    │    sse     │      │
│    │  (child    │    │   client    │    │   client   │      │
│    │  process)  │    │             │    │            │      │
│    └────────────┘    └─────────────┘    └────────────┘      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Provider Layer                          │   │
│  │   Anthropic   │   OpenAI   │   LMStudio              │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Data Models

> **Type source of truth:** All types are defined as Zod schemas first. TypeScript types are derived via `z.infer<>`. There are no hand-written parallel type definitions — the Zod schema IS the type.

### 5.1 Agent Definition

The `mcpServers` field uses the **exact same shape** as a standard MCP client configuration (e.g., `claude_desktop_config.json`, `.mcp.json`). No abstraction layer, no registry references — the full config is embedded in the agent definition.

```typescript
type McpStdioConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;           // default: 30_000
};

type McpHttpConfig = {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;           // default: 30_000
};

type McpSseConfig = {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;           // default: 30_000
};

// Standard MCP server config — identical to claude_desktop_config.json shape,
// extended with optional timeoutMs.
type McpServerConfig =
  | ({ transport: "stdio" } & McpStdioConfig)
  | ({ transport: "http" }  & McpHttpConfig)
  | ({ transport: "sse" }   & McpSseConfig);

type RetryConfig = {
  maxAttempts: number;          // default: 3
  baseDelayMs: number;          // default: 1_000; exponential backoff applied
};

type ProviderConfig =
  | {
      type: "anthropic";
      model: string;
      apiKeyEnv?: string;       // default: "ANTHROPIC_API_KEY"
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;       // LLM API call timeout; default: 60_000
      retryConfig?: RetryConfig;
    }
  | {
      type: "openai";
      model: string;
      apiKeyEnv?: string;       // default: "OPENAI_API_KEY"
      baseUrl?: string;
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;       // LLM API call timeout; default: 60_000
      retryConfig?: RetryConfig;
    }
  | {
      type: "lmstudio";
      model: string;
      baseUrl?: string;         // default: "http://localhost:1234/v1"
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;       // LLM API call timeout; default: 60_000
      retryConfig?: RetryConfig;
    };

type AgentPermissions = {
  // Which named agents this agent may delegate to via agent().
  // undefined = fall back to the server-level ALLOWED_AGENTS default.
  // Empty array = no delegation allowed (explicitly locked down).
  allowedAgents?: string[];
};

type AgentDefinition = {
  name: string;                                     // unique; immutable after create
  description?: string;
  version: number;                                  // starts at 1, increments on every update
  provider: ProviderConfig;
  systemPrompt: string;
  mcpServers: Record<string, McpServerConfig>;      // full standard MCP server configs
  permissions: AgentPermissions;
  maxToolLoops?: number;                            // max tool-use iterations per task; default: 10
  createdAt: string;                                // ISO 8601
  updatedAt: string;
};
```

**Example agent definition:**

```json
{
  "name": "code-reviewer",
  "description": "Reviews code and delegates test writing to a sub-agent",
  "provider": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5",
    "retryConfig": { "maxAttempts": 3, "baseDelayMs": 1000 }
  },
  "systemPrompt": "You are a code reviewer...",
  "maxToolLoops": 20,
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "timeoutMs": 10000
    },
    "agent-mcp": {
      "transport": "http",
      "url": "http://localhost:3000"
    }
  },
  "permissions": {
    "allowedAgents": ["test-writer"]
  }
}
```

### 5.2 Session

Sessions are **snapshotted at creation time**. The `agentVersion` records which version of the agent definition was active when `agent()` was called. Subsequent `task()` calls on this session always use the snapshotted definition — updating the agent does not affect open sessions.

The full snapshotted `AgentDefinition` JSON is stored in the `agent_data` column of the `sessions` table (see §14). This column is **storage-only** — it does not appear in the `Session` Zod type. The `SessionStore` exposes a separate `getAgentDefinition(sessionId): AgentDefinition` method that reads and Zod-parses it. The `task()` tool calls this to construct `ExecutionContext` before each run.

```typescript
type SessionStatus = "active" | "closed";

type Session = {
  id: string;
  agentName: string;
  agentVersion: number;         // version of AgentDefinition at session creation time
  status: SessionStatus;        // "active" until session_close is called
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  // NOTE: agentData (the snapshotted AgentDefinition JSON) is storage-only.
  // It is NOT part of this type. Access it via SessionStore.getAgentDefinition().
};
```

### 5.3 Message

```typescript
type MessageRole = "system" | "user" | "assistant" | "tool";

type ToolCall = {
  id: string;
  server: string;
  tool: string;
  arguments: unknown;
};

type ToolResult = {
  toolCallId: string;
  server: string;
  tool: string;
  result: unknown;
  isError?: boolean;
};

type Message = {
  id: string;
  sessionId: string;
  role: MessageRole;
  content?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  createdAt: string;
};
```

### 5.4 Task

```typescript
type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type Task = {
  id: string;
  sessionId: string;
  parentTaskId?: string;        // set when spawned by a recursive agent call
  recursionDepth: number;       // 0 for top-level tasks
  status: TaskStatus;
  result?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
  cancelledAt?: string;
};
```

### 5.5 Task Event

Structured event log emitted during task execution. Persisted to SQLite for observability.

```typescript
type TaskEventType =
  | "TASK_CREATED"
  | "TASK_STARTED"
  | "MODEL_REQUEST"
  | "MODEL_RESPONSE"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "AGENT_DELEGATION"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_CANCELLED";

type TaskEvent = {
  id: string;
  taskId: string;
  type: TaskEventType;
  payload: unknown;             // structured; shape varies by type
  createdAt: string;
};
```

### 5.6 Execution Context

Threaded through the orchestration loop; never persisted independently (derived from the Task row).

```typescript
type ExecutionContext = {
  taskId: string;
  sessionId: string;
  // The agent currently executing in this context.
  agentName: string;
  // The snapshotted AgentDefinition for agentName — never re-read mid-task.
  // This is what PolicyEngine uses as "callingAgent" when checking allowedAgents.
  agentDefinition: AgentDefinition;
  parentTaskId?: string;
  recursionDepth: number;
  // The name of the agent that spawned THIS task via agent()/task().
  // undefined for top-level (externally submitted) tasks.
  // Used for audit logging only — policy checks use agentDefinition.permissions.
  callingAgentName?: string;
  // Incremented after each tool call completes. Used by PolicyEngine check #2.
  toolCallCount: number;
};
```

---

## 6. Server Configuration

Add `@adhd/agent-mcp` to `.mcp.json` like any other MCP server. Server-level env vars set **global policy** — agent definitions operate within these bounds.

```json
{
  "mcpServers": {
    "agent-mcp": {
      "command": "node",
      "args": ["/path/to/packages/ai/agent-mcp/dist/index.js"],
      "env": {
        "DATABASE_PATH": "./data/agents.db",
        "MAX_DEPTH": "3",
        "MAX_TOOL_LOOPS": "15",
        "ALLOWED_AGENTS": "researcher,summarizer,test-writer",
        "TRANSPORT": "stdio"
      }
    }
  }
}
```

| Env Var | Type | Default | Description |
|---|---|---|---|
| `DATABASE_PATH` | string | `./data/agents.db` | SQLite file path |
| `MAX_DEPTH` | number | `5` | Hard ceiling on agent recursion depth — cannot be overridden per-agent |
| `MAX_TOOL_LOOPS` | number | `10` | Hard ceiling on tool-use iterations per task — per-agent `maxToolLoops` cannot exceed this |
| `ALLOWED_AGENTS` | string | `""` (any) | Comma-separated default delegation allowlist. Used when an agent definition omits `permissions.allowedAgents`. Empty = any. |
| `QUEUE_CONCURRENCY` | number | `5` | Max concurrent background tasks across all sessions |
| `TRANSPORT` | `stdio \| http \| sse` | `stdio` | How the MCP server itself listens |
| `PORT` | number | `3000` | Listen port (only when `TRANSPORT=http` or `TRANSPORT=sse`) |
| `LOG_LEVEL` | string | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) |

**Ceiling vs default:**
- `MAX_DEPTH` and `MAX_TOOL_LOOPS` are hard ceilings. No agent definition can exceed them.
- `ALLOWED_AGENTS` is a default. A stored agent definition that sets its own `permissions.allowedAgents` overrides it entirely (see Section 9 for precedence rules).

---

## 7. MCP Tool Reference

### Error Codes

All tool errors return a structured object as MCP `isError: true` content:

```typescript
type ToolError = {
  code: ErrorCode;
  message: string;            // human-readable detail
};

type ErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_ALREADY_EXISTS"
  | "SESSION_NOT_FOUND"
  | "SESSION_CLOSED"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_CANCELLABLE"    // task is already completed/failed/cancelled
  | "DELEGATION_NOT_ALLOWED"  // target agent not in effectiveAllowedAgents
  | "MAX_DEPTH_EXCEEDED"
  | "MAX_TOOL_LOOPS_EXCEEDED"
  | "PROVIDER_ERROR"          // LLM API error after retries exhausted
  | "MCP_CLIENT_ERROR"        // sub-agent MCP server error
  | "INTERNAL_ERROR";
```

---

### 7.1 Agent CRUD

#### `agent_create`

Creates a new agent definition. `version` is set to `1`. `createdAt` and `updatedAt` are set to now.

```typescript
// Input
type AgentCreateInput = Omit<AgentDefinition, "version" | "createdAt" | "updatedAt">;

// Output
type AgentCreateOutput = AgentDefinition;

// Error codes: AGENT_ALREADY_EXISTS
```

#### `agent_read`

```typescript
// Input
type AgentReadInput = { name: string };

// Output
type AgentReadOutput = AgentDefinition;

// Error codes: AGENT_NOT_FOUND
```

#### `agent_update`

Updates one or more fields. `version` is auto-incremented. `name` and `createdAt` are immutable. Does not affect existing open sessions (they are snapshotted at creation).

```typescript
// Input
type AgentUpdateInput =
  { name: string } &
  Partial<Omit<AgentDefinition, "name" | "version" | "createdAt" | "updatedAt">>;

// Output
type AgentUpdateOutput = AgentDefinition;

// Error codes: AGENT_NOT_FOUND
```

#### `agent_delete`

Deletes an agent definition. Fails if any sessions with `status: "active"` exist for this agent.

```typescript
// Input
type AgentDeleteInput = { name: string };

// Output
type AgentDeleteOutput = { deleted: true };

// Error codes: AGENT_NOT_FOUND, INTERNAL_ERROR (active sessions exist)
```

#### `agent_list`

```typescript
// Input — none

// Output
type AgentListOutput = AgentDefinition[];
```

---

### 7.2 Session Tools

#### `agent`

Instantiates a stateful session for a named agent. Snapshots the current `AgentDefinition` (including `mcpServers`, `systemPrompt`, and `provider`) at creation time. Subsequent `task()` calls on this session always use the snapshotted definition.

```typescript
// Input
type AgentInput = { name: string };

// Output
type AgentOutput = { session_id: string };

// Error codes: AGENT_NOT_FOUND, DELEGATION_NOT_ALLOWED (when called from within a running task)
```

#### `session_list`

```typescript
// Input
type SessionListInput = {
  agentName?: string;           // filter by agent
  status?: SessionStatus;       // filter by status; default: all
};

// Output
type SessionListOutput = Session[];
```

#### `session_close`

Marks a session as closed. Prevents further `task()` submissions. Does not delete message history.

```typescript
// Input
type SessionCloseInput = { session_id: string };

// Output
type SessionCloseOutput = Session;

// Error codes: SESSION_NOT_FOUND, SESSION_CLOSED (already closed)
```

---

### 7.3 Task Tools

#### `task`

Submits a prompt to an active session.

- **`background: false`** (default): runs synchronously; blocks until complete; returns result inline.
- **`background: true`**: enqueues task via `p-queue`, returns immediately with `status: "pending"`. Poll with `result()`.

```typescript
// Input
type TaskInput = {
  session_id: string;
  prompt: string;
  background?: boolean;         // default: false
};

// Output
type TaskOutput = {
  task_id: string;
  session_id: string;
  status: TaskStatus;
  result?: string;              // present when status === "completed"
  error?: string;               // present when status === "failed"
};

// Error codes: SESSION_NOT_FOUND, SESSION_CLOSED, MAX_DEPTH_EXCEEDED,
//              DELEGATION_NOT_ALLOWED, PROVIDER_ERROR, MCP_CLIENT_ERROR
```

#### `task_list`

```typescript
// Input
type TaskListInput = {
  session_id?: string;          // filter by session
  status?: TaskStatus;          // filter by status
};

// Output
type TaskListOutput = Task[];
```

#### `task_cancel`

Requests cancellation of a pending or running task. Sets `status: "cancelled"`. For running tasks, signals the orchestrator loop to abort after the current tool call completes and cleans up any stdio child processes.

```typescript
// Input
type TaskCancelInput = { task_id: string };

// Output
type TaskCancelOutput = Task;

// Error codes: TASK_NOT_FOUND, TASK_NOT_CANCELLABLE
```

#### `result`

Polls a task by ID. Returns current state. Poll until `status` is `"completed"`, `"failed"`, or `"cancelled"`.

```typescript
// Input
type ResultInput = { task_id: string };

// Output — same shape as TaskOutput
type ResultOutput = TaskOutput;

// Error codes: TASK_NOT_FOUND
```

---

## 8. Execution Model

### 8.1 Synchronous task

The `task()` tool handler constructs `ExecutionContext` before calling the orchestrator. The orchestrator owns the loop and the registry teardown.

```
tools/task.ts: task({ session_id, prompt, background: false })
  ├─ assert Session.status === "active"  → SESSION_CLOSED if not
  ├─ agentDefinition = sessionStore.getAgentDefinition(session_id)
  ├─ create Task row (status: "pending", recursionDepth: N, parentTaskId?)
  ├─ build ExecutionContext {
  │     taskId, sessionId, agentName, agentDefinition,
  │     parentTaskId, recursionDepth: N, callingAgentName?, toolCallCount: 0
  │   }
  ├─ create AbortController; register with TaskStore.registerCancellation(taskId, controller)
  ├─ registry = new McpClientRegistry(agentDefinition.mcpServers, selfUrl, inProcessHandler)
  ├─ emit TASK_CREATED event
  ├─ load message history from SQLite
  ├─ append user Message
  ├─ update Task row (status: "running")
  ├─ emit TASK_STARTED event
  ├─ try:
  │    Orchestrator.run({ messages, executionContext, registry, provider, policy, signal: controller.signal })
  │      └─ loop (up to min(agentDef.maxToolLoops ?? MAX_TOOL_LOOPS, MAX_TOOL_LOOPS)):
  │           ├─ check signal.aborted → throw TaskCancelledError if set
  │           ├─ emit MODEL_REQUEST event
  │           ├─ combined = AbortSignal.any([signal, AbortSignal.timeout(provider.timeoutMs ?? 60_000)])
  │           ├─ provider.chat({ messages, tools, signal: combined })  ← wrapped in p-retry
  │           ├─ emit MODEL_RESPONSE event
  │           ├─ if stopReason == "completed": break
  │           └─ for each tool_call:
  │                ├─ PolicyEngine.check({ executionContext, targetServer, targetTool, targetAgentName? })
  │                ├─ emit TOOL_CALL event
  │                ├─ registry.getClient(server).callTool(tool, args)
  │                ├─ emit TOOL_RESULT event
  │                └─ executionContext.toolCallCount++
  ├─ finally:
  │    registry.closeAll()                  // terminates all stdio child processes
  │    TaskStore.unregisterCancellation(taskId)
  ├─ persist assistant Message
  ├─ update Task row (status: "completed" | "failed" | "cancelled", result/error)
  ├─ emit TASK_COMPLETED | TASK_FAILED | TASK_CANCELLED event
  └─ return TaskOutput
```

### 8.2 Background task

Background tasks are enqueued via `p-queue` (not fire-and-forget Promises). The queue has a configurable concurrency limit (`QUEUE_CONCURRENCY` env var, default: `5`) to prevent file descriptor and API rate-limit exhaustion.

```
caller → task({ session_id, prompt, background: true })
  ├─ create Task row (status: "pending")
  ├─ enqueue onto p-queue (runs same loop as 8.1 above)
  └─ return { task_id, status: "pending" } immediately

caller → result({ task_id })
  └─ read Task row → return current { status, result?, error? }
```

### 8.3 Recursive delegation

**Self-referential detection:** When the orchestrator builds `McpClientRegistry` for a session, it inspects each `McpServerConfig` entry. If any entry's transport URL (for http/sse) matches the server's own bound address, or if the server name is the reserved value `"agent-mcp"`, that entry is registered as an **in-process client** rather than a real network client. The in-process client routes `agent`, `task`, and `result` calls directly to the runtime tool handlers, bypassing network I/O and preserving `ExecutionContext` across the call boundary.

```
Agent A's tool-use loop → calls agent({ name: "B" })
  ├─ McpClientRegistry routes to in-process handler
  ├─ PolicyEngine: "B" ∈ effectiveAllowedAgents for A?  → DELEGATION_NOT_ALLOWED if not
  ├─ create Session for B (snapshot B's AgentDefinition at current version)
  └─ return { session_id }

Agent A's tool-use loop → calls task({ session_id, prompt, background: false })
  ├─ McpClientRegistry routes to in-process handler
  ├─ PolicyEngine: ctx.recursionDepth < MAX_DEPTH?  → MAX_DEPTH_EXCEEDED if not
  ├─ create Task { parentTaskId: A.taskId, recursionDepth: A.depth + 1 }
  ├─ run B synchronously (new Orchestrator instance, new ExecutionContext)
  └─ return result to A as tool result

Agent A's tool-use loop → calls task({ session_id, prompt, background: true })
  ├─ McpClientRegistry routes to in-process handler
  ├─ PolicyEngine depth check applies
  ├─ enqueue B's task onto p-queue
  └─ return { task_id, status: "pending" } to A as tool result
```

**Registry lifetime:** `McpClientRegistry` is **per-task**. It is created in `tools/task.ts` at the start of each `task()` call, passed into `Orchestrator.run()`, and torn down in the `finally` block of `Orchestrator.run()` via `registry.closeAll()`. Sequential tasks on the same session each get a fresh registry. This is slightly more expensive for `stdio` servers (child processes are respawned per task), but is simpler and avoids stale connection state between tasks.

**stdio child process lifecycle:** Each `stdio` `McpServerConfig` entry in the agent's `mcpServers` spawns a child process when the `McpClientRegistry` connects to it. Child processes are tracked inside the registry and terminated (SIGTERM, then SIGKILL after 5 s if still running) when `registry.closeAll()` is called. This happens in the `Orchestrator.run()` `finally` block, covering task completion, failure, and cancellation.

If a child process exits unexpectedly mid-task, the `StdioMcpClient` catches the exit event, logs `warn` with `{ server, exitCode, signal }`, and causes the next `callTool()` to throw, which the orchestrator surfaces as `MCP_CLIENT_ERROR`.

**Server shutdown:** `index.ts` registers `process.on("SIGTERM")` and `process.on("SIGINT")` handlers that call `server.close()` on the MCP server. Per-task registries are torn down by the `finally` blocks in their own tasks — no global registry tracker is needed.

---

## 9. Policy Engine

A single `PolicyEngine` class checks all constraints before any tool call is dispatched.

```typescript
type PolicyConfig = {
  serverMaxDepth: number;          // from MAX_DEPTH — hard ceiling
  serverMaxToolLoops: number;      // from MAX_TOOL_LOOPS — hard ceiling
  serverAllowedAgents?: string[];  // from ALLOWED_AGENTS — default; undefined = any
};

type PolicyCheckInput = {
  executionContext: ExecutionContext;
  targetServer: string;
  targetTool: string;
  // Resolved only when targetServer is self-referential and tool is "agent".
  // The name of the agent the caller is trying to instantiate.
  targetAgentName?: string;
};

// Checks run in order; first failure throws ToolError with the appropriate ErrorCode.
// 1. executionContext.recursionDepth < serverMaxDepth           → MAX_DEPTH_EXCEEDED
// 2. executionContext.toolCallCount < min(
//      executionContext.agentDefinition.maxToolLoops ?? serverMaxToolLoops,
//      serverMaxToolLoops
//    )                                                          → MAX_TOOL_LOOPS_EXCEEDED
// 3. if targetAgentName is set:
//    a. callingAgent = executionContext.agentDefinition         (the currently-executing agent)
//    b. resolve effectiveAllowedAgents:
//       - callingAgent.permissions.allowedAgents defined → use it  (agent definition wins)
//       - else serverAllowedAgents defined → use it               (server default)
//       - else → unrestricted (pass)
//    c. targetAgentName ∈ effectiveAllowedAgents                → DELEGATION_NOT_ALLOWED
```

**Precedence rules:**

- `MAX_DEPTH` and `MAX_TOOL_LOOPS` are hard server ceilings. No agent definition can exceed them.
- `ALLOWED_AGENTS` (server) is a **default**. A stored agent definition that sets its own `permissions.allowedAgents` overrides this default entirely — not an intersection. This allows a restrictive global default with selectively widened agents, or a permissive default with locked-down agents.
- Both `permissions.allowedAgents` (per-agent) and `ALLOWED_AGENTS` (server) default to unrestricted when absent.

---

## 10. Provider Layer

All providers implement one interface:

```typescript
type ToolDefinition = {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

interface LLMProvider {
  chat(request: {
    messages: Message[];
    tools?: ToolDefinition[];
    signal?: AbortSignal;       // cancellation / timeout signal
  }): Promise<{
    message: Message;
    stopReason: "completed" | "tool_calls";
  }>;
}
```

Tool names are encoded as `{serverName}__{toolName}` in provider API calls and decoded back on return. This convention is consistent across all providers.

**Timeout and retry:** Provider calls are wrapped in `p-retry` using `retryConfig` from `ProviderConfig`. The per-call timeout uses `AbortSignal.any([orchestratorCancellationSignal, AbortSignal.timeout(provider.timeoutMs ?? 60_000)])`. Note: `timeoutMs` on `ProviderConfig` governs LLM API call timeout; `timeoutMs` on `McpServerConfig` governs MCP client connection timeout. These are independent fields on separate config types.

| Provider | `type` value | Notes |
|---|---|---|
| Anthropic Claude | `"anthropic"` | API key from `ANTHROPIC_API_KEY` or `apiKeyEnv` |
| OpenAI | `"openai"` | API key from `OPENAI_API_KEY` or `apiKeyEnv`; optional `baseUrl` |
| LM Studio | `"lmstudio"` | Extends OpenAI; default `baseUrl` = `http://localhost:1234/v1` |

> **v2 consideration:** The `LLMProvider` interface is intentionally compatible with the Vercel AI SDK's `LanguageModel` abstraction, which provides a unified surface over all three providers (and many more). Migrating to the Vercel AI SDK in a future version would require only replacing the provider implementations — tool contracts and the orchestrator are unaffected.

---

## 11. MCP Client Registry

The `McpClientRegistry` is responsible for resolving `McpServerConfig` entries into live transport clients. It is **per-task**: created in `tools/task.ts` at the start of each `task()` call and torn down in `Orchestrator.run()`'s `finally` block via `closeAll()`.

```typescript
interface IMcpClient {
  listTools(): Promise<ToolDefinition[]>;
  callTool(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

class McpClientRegistry {
  // selfUrl is the server's own bound address (e.g., "http://localhost:3000").
  // When TRANSPORT=stdio, selfUrl is undefined — only condition (a) applies for self-ref detection.
  constructor(
    mcpServers: Record<string, McpServerConfig>,
    selfUrl: string | undefined,
    inProcessHandler: InProcessMcpClient,
  ) {}

  getClient(serverName: string): IMcpClient;
  listAllTools(): Promise<ToolDefinition[]>;
  closeAll(): Promise<void>;    // SIGTERM → SIGKILL (5s) on all stdio children; close http/sse
}
```

**Self-referential detection logic:**

1. If the entry key is `"agent-mcp"` → in-process client *(applies in all transport modes)*
2. If `selfUrl` is defined AND the entry transport is `http` or `sse` AND the entry URL matches `selfUrl` → in-process client
3. Otherwise → real transport client (stdio / http / sse)

When `TRANSPORT=stdio`, `selfUrl` is `undefined` — condition 2 is never evaluated, but condition 1 still catches the reserved `"agent-mcp"` key.

---

## 12. MCP Client Transport

The client implementation uses `@modelcontextprotocol/sdk`.

| Transport | Client class | Behavior |
|---|---|---|
| `stdio` | `StdioClientTransport` (SDK) | Spawns `command` as a child process; MCP JSON-RPC over stdin/stdout |
| `http` | `StreamableHTTPClientTransport` (SDK) | HTTP POST with MCP JSON-RPC envelope |
| `sse` | `SSEClientTransport` (SDK) | SSE connection |

All transport calls respect `timeoutMs` from the `McpServerConfig` via `AbortSignal.timeout()`.

**MCP SDK input schemas:** Use Zod 4's built-in `z.toJsonSchema(schema)` to convert Zod validation schemas to JSON Schema objects for MCP tool registration. No additional `zod-to-json-schema` package is needed — Zod 4 ships this natively.

---

## 13. Logging

**All log output goes to stderr.** When `TRANSPORT=stdio`, stdout is exclusively the MCP JSON-RPC stream. Any output to stdout corrupts the protocol framing and will cause the client to drop the connection.

Library: **`pino`** — structured JSON logs to `process.stderr`. Log level controlled by `LOG_LEVEL` env var.

```typescript
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" }, process.stderr);
```

Structured log events emitted at each stage of execution:

| Event | Level | Fields |
|---|---|---|
| Task created | `info` | `taskId`, `sessionId`, `agentName`, `recursionDepth` |
| Task started | `info` | `taskId` |
| Model request | `debug` | `taskId`, `messageCount`, `toolCount` |
| Model response | `debug` | `taskId`, `stopReason`, `toolCallCount` |
| Tool call | `debug` | `taskId`, `server`, `tool` |
| Tool result | `debug` | `taskId`, `server`, `tool`, `isError` |
| Agent delegation | `info` | `taskId`, `targetAgent`, `newDepth` |
| Task completed | `info` | `taskId`, `durationMs` |
| Task failed | `warn` | `taskId`, `errorCode`, `error` |
| Task cancelled | `info` | `taskId` |
| Child process exit | `warn` | `server`, `exitCode`, `signal` |

---

## 14. Storage

SQLite via Drizzle ORM. Drizzle Kit (`drizzle-kit generate` + `drizzle-orm/better-sqlite3`'s `migrate()`) manages migrations — no custom migration runner. Migrations run synchronously at server startup before connections are accepted.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE agents (
  name        TEXT    PRIMARY KEY,
  version     INTEGER NOT NULL DEFAULT 1,
  data        TEXT    NOT NULL,    -- JSON blob of AgentDefinition (all fields)
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  agent_version INTEGER NOT NULL,  -- snapshotted at session creation
  agent_data    TEXT NOT NULL,     -- snapshotted AgentDefinition JSON
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_at     TEXT
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  content      TEXT,
  tool_calls   TEXT,              -- JSON: ToolCall[]
  tool_results TEXT,              -- JSON: ToolResult[]
  created_at   TEXT NOT NULL
);

CREATE TABLE tasks (
  id               TEXT    PRIMARY KEY,
  session_id       TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_task_id   TEXT,
  recursion_depth  INTEGER NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL,
  result           TEXT,
  error            TEXT,
  created_at       TEXT    NOT NULL,
  completed_at     TEXT,
  cancelled_at     TEXT
);

CREATE TABLE task_events (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,       -- JSON
  created_at TEXT NOT NULL
);
```

---

## 15. Third-Party Dependencies

| Library | Why |
|---|---|
| `@modelcontextprotocol/sdk` | MCP protocol (server + client transports). Already present. |
| `drizzle-orm` + `better-sqlite3` | SQLite storage. Already present. |
| `drizzle-kit` | Migration generation (`drizzle-kit generate`). Dev dependency. |
| `zod` | Schema validation + type derivation via `z.infer<>`. Already present. `z.toJsonSchema()` used for MCP tool registration (no extra package needed). |
| `pino` | Structured logging to stderr. Required for stdio transport correctness. |
| `p-queue` | Concurrency-limited background task queue. Prevents file descriptor / API exhaustion. |
| `p-retry` | Exponential backoff retries for provider and MCP client calls. |

---

## 16. Package Structure

```
packages/ai/agent-mcp/
├── src/
│   ├── index.ts                   # Entry: read env, wire stores + engine, start server
│   ├── server.ts                  # MCP server via @modelcontextprotocol/sdk; registers all tools
│   ├── logger.ts                  # Pino instance writing to process.stderr
│   ├── validation/
│   │   ├── agent.ts               # Zod schema for AgentDefinition + ProviderConfig + McpServerConfig
│   │   ├── session.ts             # Zod schema for Session + session tool I/O
│   │   ├── task.ts                # Zod schema for Task + TaskEvent + task tool I/O
│   │   ├── message.ts             # Zod schema for Message + ToolCall + ToolResult
│   │   ├── execution.ts           # Zod schema for ExecutionContext
│   │   ├── errors.ts              # Zod schema for ErrorCode + ToolError
│   │   └── mcp.ts                 # Zod schema for McpServerConfig transport union (re-exported from agent.ts)
│   ├── db/
│   │   ├── schema.ts              # Drizzle table definitions
│   │   ├── client.ts              # DB singleton (better-sqlite3 + drizzle)
│   │   └── migrate.ts             # Calls drizzle-orm migrate() synchronously at startup
│   ├── store/
│   │   ├── agent-store.ts         # AgentStore: CRUD + snapshot helpers
│   │   ├── session-store.ts       # SessionStore: create/list/close; getAgentDefinition(); appendMessage()
│   │   └── task-store.ts          # TaskStore: create/updateStatus/read/list/appendEvent;
│   │                              #   registerCancellation(taskId, AbortController) — in-memory Map
│   │                              #   unregisterCancellation(taskId)
│   │                              #   cancel(taskId) — aborts controller + sets status=cancelled
│   │                              #   NOTE: does NOT depend on BackgroundQueue; queue is wired
│   │                              #   externally in tools/task.ts via dependency injection
│   ├── providers/
│   │   ├── types.ts               # LLMProvider interface
│   │   ├── anthropic.ts           # AnthropicProvider
│   │   ├── openai.ts              # OpenAIProvider
│   │   ├── lmstudio.ts            # LMStudioProvider (extends OpenAI)
│   │   └── factory.ts             # createProvider(config) → LLMProvider
│   ├── clients/
│   │   ├── types.ts               # IMcpClient interface
│   │   ├── registry.ts            # McpClientRegistry: resolves configs → clients; detects self-ref
│   │   ├── in-process.ts          # InProcessMcpClient: routes to runtime handlers directly
│   │   ├── stdio-client.ts        # StdioMcpClient: child process + SDK StdioClientTransport
│   │   └── http-client.ts         # HttpMcpClient + SseMcpClient via SDK
│   ├── engine/
│   │   ├── orchestrator.ts        # Tool-use loop; uses McpClientRegistry; checks cancellation;
│   │   │                          #   finally { registry.closeAll(); taskStore.unregisterCancellation() }
│   │   ├── policy.ts              # PolicyEngine: depth + toolLoops + allowedAgents checks
│   │   └── queue.ts               # BackgroundQueue: wraps p-queue; enqueue(taskId, runFn)
│   └── tools/
│       ├── agent-crud.ts          # agent_create / agent_read / agent_update / agent_delete / agent_list
│       ├── session.ts             # agent() / session_list / session_close
│       └── task.ts                # task() / task_list / task_cancel / result()
```

---

## 17. What to Keep from the Existing Code

| File | Decision | Reason |
|---|---|---|
| `providers/anthropic.ts` | Keep | Correct SDK usage, `server__tool` encoding, role mapping |
| `providers/openai.ts` | Keep | Full role coverage, correct tool call parsing |
| `providers/lmstudio.ts` | Keep | Correct OpenAI extension |
| `providers/core/base.ts` | Keep (rename to `providers/types.ts`) | Clean `LLMProvider` interface |
| `providers/core/factory.ts` | Keep | Exhaustive switch with `never` guard |
| `validation/agents.ts` | Reference → migrate to `validation/agent.ts` | Adapt to `z.infer<>` pattern; drop parallel TS types |
| `validation/mcp.ts` | Reference → migrate to `validation/mcp.ts` | Transport discriminated union is correct |
| `runtime/policyEngine.ts` | Refactor | Solid logic; update to new `PolicyCheckInput` shape |
| `utils/ids.ts`, `utils/timestamps.ts` | Keep | Correct |
| `storage/sqlite/db.ts` | Keep | Correct Drizzle + better-sqlite3 setup |
| `storage/schema.ts` | Adapt | Add session snapshot columns, `task_events` table, FK cascades; remove `mcp_servers` table |
| `mcp/server.ts` | Discard | Not MCP-compliant; replace with SDK |
| `mcp/client.ts` | Discard | stdio unimplemented, arg mismatch; replace with SDK clients in `clients/` |
| `runtime/agentRegistry.ts` | Discard | In-memory, wrong type shape |
| `runtime/sessionStore.ts` | Discard | File-based; replace with SQLite |
| `runtime/kernel/runtime.ts` | Discard | Sync only, no task tracking, no context threading |
| `runtime/kernel/orchestrator.ts` | Discard | Hardcoded config, no cancellation, no context threading |
| `runtime/toolExecutor.ts` | Discard | Arg count mismatch; crashes at runtime |
| `index.ts` | Discard | Imports non-existent file; crashes on start |

---

## 18. Implementation Roadmap

Steps are dependency-ordered.

1. **Validation schemas** — write all Zod schemas in `validation/`; export TypeScript types via `z.infer<>`. No hand-written parallel types.
2. **Schema** — write `db/schema.ts` with all tables, FK cascade constraints, and new columns (`agent_version`, `agent_data`, `status`, `closed_at`, `cancelled_at`, `task_events`)
3. **Store layer** — implement `AgentStore`, `SessionStore` (with snapshot logic), `TaskStore` (with event appending)
4. **Provider layer** — port existing providers; add `signal?: AbortSignal` to `chat()`; wire `p-retry` + `AbortSignal.timeout()`
5. **MCP client layer** — implement `IMcpClient`, `McpClientRegistry` (with self-ref detection), `StdioMcpClient`, `HttpMcpClient`, `InProcessMcpClient`
6. **Policy engine** — implement `PolicyEngine` with depth + toolLoops + allowedAgents checks
7. **Orchestrator** — write from scratch: accepts `ExecutionContext` + `McpClientRegistry`; checks cancellation signal each loop iteration; emits `TaskEvent`s
8. **Background queue** — wire `p-queue` into `TaskStore`; expose `QUEUE_CONCURRENCY` env var
9. **Agent CRUD tools** — `tools/agent-crud.ts` handlers backed by `AgentStore`
10. **Session tools** — `tools/session.ts`: `agent()` (with snapshot), `session_list`, `session_close`
11. **Task tools** — `tools/task.ts`: `task()`, `task_list`, `task_cancel`, `result()`; wire `InProcessMcpClient` for recursive delegation
12. **MCP server** — `server.ts`: register all tools via `@modelcontextprotocol/sdk`; wire stdio, http, and sse transports; validate all inputs against Zod schemas
13. **Logging** — wire `pino` to `process.stderr` throughout; emit structured events at each execution phase
14. **Entry point** — `index.ts`: read env, run migrations, instantiate stores + engine, start server
15. **Tests** — policy engine unit tests; store layer integration tests; orchestrator unit tests with mock clients; end-to-end test: agent A delegates to agent B synchronously and asynchronously
