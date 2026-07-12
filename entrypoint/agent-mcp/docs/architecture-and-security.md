# Architecture and Security — @adhd/agent-mcp

This document explains the system design, process model, state management, and security properties of the agent-mcp runtime.

## System Boundaries

```
MCP Client (e.g., Claude Desktop)
    |
    | JSON-RPC (stdio)
    v
Agent MCP Server
    |
    +-- State Store (SQLite)
    |   +-- agents
    |   +-- sessions
    |   +-- messages
    |   +-- task_usage
    |
    +-- Policy Engine
    |   +-- Delegation depth limits
    |   +-- Token/cost budgets
    |   +-- Filesystem scopes
    |   +-- Tool filters
    |
    +-- Agent Supervisor
    |   +-- Spawn management
    |   +-- Lifecycle (running, completed, failed, cancelled)
    |   +-- Execution traces
    |
    +-- Provider Adapters
    |   +-- Anthropic (claude-opus, claude-sonnet, etc.)
    |   +-- OpenAI (gpt-4-turbo, gpt-4o, etc.)
    |   +-- DeepSeek (deepseek-v4-flash, deepseek-v4-pro)
    |   +-- Gemini (gemini-2.5-pro, etc.)
    |
    +-- Tool Gateway
    |   +-- Filesystem MCP tools
    |   +-- Shell execution
    |   +-- Network requests
    |   +-- External MCP servers
```

The agent-mcp server is a **stateful process** that:
1. Exposes MCP tools to create, control, and inspect agents
2. Manages a SQLite database of agents, conversations, and execution history
3. Enforces runtime policies before each tool call
4. Translates between MCP and provider APIs
5. Handles retries, cancellation, and error recovery

## Process Model

### Single Agent Execution

```
agent_create(name, config, provider, model, budget)
    ↓ (validates agent name, policy, budget)
    ↓ (creates row in agents table)

task(agentName, prompt)          # optionally background: true
    ↓ (fetches agent config and session history)
    ↓ (constructs message list with system prompt + tools)
    ↓ (calls provider.chat())
    ↓ (checks if model returned tool calls)
    ↓ if tool calls:
    |   ├─ [for each tool]
    |   |   ├─ policy.canCallTool(agentName, tool)? (enforced)
    |   |   ├─ execute tool (may call external MCP servers)
    |   |   └─ append tool result to message history
    |   └─ goto model call (max 50 loops by default)
    ↓
    ├─ store all messages in sessions table
    ├─ record usage (tokens, cost) in task_usage
    └─ return {taskId, status, result, usage} to MCP client

result(taskId)
    ├─ fetch a task's current state and result (poll a background task to completion)
    └─ return final result and usage

task_cancel(taskId)
    └─ mark the task as cancelled; clean up active tool calls
```

### Delegation (Parent → Child Agent)

If a parent agent calls a tool that spawns a child agent:

```
parent agent (depth=0, budget=token_limit) →
    checks child policy (subset of parent) →
    spawns child with (depth=1, reduced budget) →
        child runs with enforced tool/file/network restrictions →
        child completes or hits policy limit →
    parent receives tool result from child
```

A child agent:
- Cannot escalate tools beyond what parent has access to
- Cannot expand filesystem scope beyond parent's allowed paths
- Cannot exceed its allocated token budget without failing the task
- Cannot delegate further if `max_depth` is reached

## State Model

### Primary Tables (SQLite)

```sql
-- Registered agents and their configs
agents (
  name TEXT PRIMARY KEY,
  provider TEXT,
  model TEXT,
  createdAt TIMESTAMP,
  config JSON,           -- tool allowlist, filesystem paths, env vars, etc.
  policy JSON            -- delegation depth, budgets, network, etc.
);

-- Sessions (conversation instances)
sessions (
  id TEXT PRIMARY KEY,
  agent_name TEXT,       -- FK to agents (ON DELETE CASCADE as of 2.0.2)
  createdAt TIMESTAMP,
  metadata JSON
);

-- Messages (conversation history)
messages (
  id TEXT PRIMARY KEY,
  session_id TEXT,       -- FK to sessions
  role TEXT,             -- "system", "user", "assistant", "tool"
  content TEXT,
  toolCalls JSON,        -- [{name, arguments}] if assistant
  toolResults JSON,      -- [{id, result}] if tool
  createdAt TIMESTAMP
);

-- Task execution usage (tokens, cost)
task_usage (
  task_id TEXT PRIMARY KEY,
  root_task_id TEXT,
  agent_name TEXT,            -- agent that owns this task
  provider_type TEXT,         -- provider name (e.g. "anthropic", "openai")
  model TEXT,                 -- model identifier
  input_tokens INTEGER,       -- cumulative across all model calls in this task (SUM, not MAX)
  output_tokens INTEGER,      -- cumulative across all model calls (SUM)
  tool_call_count INTEGER,    -- total tool invocations in this task
  model_calls INTEGER,        -- total model API calls made
  latency_ms INTEGER,         -- wall-clock time from task start to completion
  is_complete INTEGER,        -- 0/1 flag: task reached terminal state
  stop_reason TEXT,           -- "tool_calls", "end_turn", "error", etc.
  max_tokens INTEGER,         -- configured max_tokens for this model
  cache_read_input_tokens INTEGER,       -- cache-hit tokens (2.0.2+; Anthropic: cache_read, DeepSeek: prompt_cache_hit)
  cache_creation_input_tokens INTEGER,   -- cache-write surcharge (2.0.2+; Anthropic only; DeepSeek/OpenAI: 0 or null)
  uncached_input_tokens INTEGER,         -- full-price tokens (cache-miss rate; 2.0.2+)
  reasoning_tokens INTEGER,              -- inference tokens from reasoning models (2.0.2+)
  peak_context_tokens INTEGER,           -- MAX single-call prompt size across all calls (2.0.2+; THE number for "am I near the ceiling?")
  peak_context_at INTEGER,               -- which model-call number (1-based) hit the peak (2.0.2+)
  created_at TEXT                        -- task creation timestamp
);
```

### Message Windowing (2.0.2+)

The system keeps conversation history **append-only** by default:

1. **Cold start** (first model call): system prompt + user message
2. **Subsequent calls**: all prior messages + new user message
3. **When context approaches limit** (via provider's exact `prompt_tokens`):
   - Summarize middle messages into one synthetic assistant message
   - Keep leading messages (system + early context) unchanged
   - Keep trailing messages (recent turns) unchanged
   - Never evict from the front again for this task

**Why:** Providers cache the leading prefix; evicting from the front breaks the cache and makes subsequent calls much more expensive. Collapsing the middle exactly once preserves the cache while reducing history size.

## Provider Abstraction

All providers implement a common interface:

```typescript
interface ProviderAdapter {
  chat(request: ChatRequest): Promise<ChatResponse>;
  // ChatRequest: {model, messages, tools, temperature, max_tokens, ...}
  // ChatResponse: {content, tool_calls, usage: {inputTokens, outputTokens, ...}, stopReason}
}
```

### Provider-Specific Differences

| Aspect | Anthropic | OpenAI | DeepSeek | Gemini |
|---|---|---|---|---|
| **Token accounting** | `inputTokens` excludes cache tokens; must sum `cache_read_input_tokens` + `cache_creation_input_tokens` | `prompt_tokens` includes cached tokens (subset field) | `prompt_tokens` includes cached tokens; provides `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens` | `promptTokenCount` includes cached tokens |
| **Cache pricing** | Write: 1.25x (5m) / 2x (1h); Read: 0.1x | Write: 1.25x (GPT-5.6+); Read: standard cached rate | Write: none; Read: $0.0028/M cache-hit vs $0.14/M miss | Write: standard; Read: 90% discount + hourly storage rent |
| **Tool definitions** | Always JSON-schema function-calling (native) | Always JSON-schema (native) | Always JSON-schema (native) | Supports both `function_declarations` (native) and custom descriptions |
| **Cancellation** | Partial (can cancel in-flight requests; doesn't stop model thinking if already started) | Partial | Partial | Yes |
| **Streaming** | Yes (native) | Yes (native) | Yes (native) | Yes |
| **Per-call tool restriction** | None; any tool-set change busts cache | `allowed_tools` filter (cache-safe) | None; any tool-set change busts cache | None; any tool-set change busts cache |

## Permission Model

### Agent Policy Structure

```typescript
type AgentPolicy = {
  // Delegation
  maxDepth: number;              // 0 = leaf only; 1 = can spawn 1 level; etc.
  maxChildren: number;           // max agents spawned by this one
  
  // Budgets
  maxTokensPerTask: number;      // fail if cumulative tokens exceeded
  maxCostUsdPerTask: number;     // fail if cumulative cost exceeded
  wallClockTimeoutMs: number;    // hard timeout
  
  // Tool access
  tools: {
    allow: string[];             // tool names agent can call
    deny: string[];              // explicit deny (takes precedence)
    requireApproval: string[];    // ask user before calling
  };
  
  // Filesystem
  filesystem: {
    read: string[];              // absolute paths or glob patterns
    write: string[];             // (recommended: empty; writes require approval)
  };
  
  // Network
  network: {
    enabled: boolean;
    allowedHosts?: string[];      // allowlist; if present, ONLY these hosts
  };
  
  // Environment
  environment: {
    allow: string[];             // env var names agent can read (must be ADHD_AGENT_* prefixed)
  };
};
```

### Permission Inheritance

Child agents inherit a **subset** of parent permissions:

```typescript
function isValidChildPolicy(parentPolicy, childPolicy) {
  // Tools: child.allow must be subset of parent.allow
  return childPolicy.tools.allow.every(tool => 
    parentPolicy.tools.allow.includes(tool)
  );
  
  // Budget: child must have stricter or equal budget
  // Path: child paths must be subset of parent paths
  // Network: if parent disables network, child can't enable it
}
```

**Enforcement points:**

| Control | Enforced by | Check point |
|---|---|---|
| Tool allowlist | Runtime | `pre:tool_call` hook before model response |
| Filesystem read | Runtime | MCP tool adapter (filesystem__read_text_file, etc.) |
| Filesystem write | Runtime | MCP tool adapter (filesystem__write_text_file, etc.) |
| Network request | Runtime | Network tool wrapper |
| Token budget | Runtime | After every model call; fail if exceeded |
| Cost budget | Runtime | After every model call; fail if exceeded |
| Delegation depth | Runtime | In `agent_create` hook |
| Environment variables | Runtime | In provider credential resolution (ADHD_AGENT_* prefix check) |
| Tool approval | Runtime | Human interaction hook (if requireApproval includes tool) |

## Failure Recovery

### Hard Failures (Task terminates immediately)

- `MAX_DEPTH_EXCEEDED` — tried to spawn agent deeper than max_depth
- `MAX_TOOL_LOOPS_EXCEEDED` — exceeded 50 (configurable) tool-call rounds
- `TOKEN_BUDGET_EXCEEDED` — cumulative tokens > budget
- `COST_BUDGET_EXCEEDED` — estimated cost > budget
- `CONTEXT_WINDOW_EXCEEDED` — provider rejected: prompt too long (shouldn't happen with 2.0.2+)
- `POLICY_VIOLATION` — tool call denied by policy

### Soft Failures (Retry with backoff)

- Transient provider errors (rate limits, timeouts < configured limit)
- Network errors with deterministic retry logic

### Crash Recovery

If the agent-mcp server process crashes:

- Completed tasks are persisted; results are intact
- Running tasks are marked `cancelled` on next server start
- The MCP client must decide whether to retry or inspect partial results

## Cancellation Semantics

```
task_cancel(taskId)
    ↓
    └─ if task is running:
        ├─ cancel in-flight provider request (if provider supports it)
        ├─ don't process any tool results from that request
        ├─ mark task as cancelled
        └─ don't attempt retry
```

Cancellation is **best-effort**:
- If the model is already generating output, the cancellation may arrive too late
- In-flight tool calls that started before cancellation may complete
- Results are marked as cancelled; the task does not resume

## Trust Boundaries

### Things agent-mcp Can Control

- Which tools the model sees and is allowed to call
- Which filesystem paths are readable/writable
- Which environment variables are accessible
- Which hosts can be contacted
- When the agent is allowed to delegate
- Token and cost limits
- Timeouts

### Things agent-mcp Cannot Control (Prompt-Level Only)

- Whether the model attempts to escape its tool restrictions via prompt injection
- Whether the model makes up fake tool calls or results
- Whether the model's reasoning matches its declared intent
- The content of model outputs (can only reject, not redact)

**Important:** Tool filtering, filesystem restrictions, and network allowlists are **policy enforcement, not security sandboxes**. A model that understands or breaks its constraints can circumvent them. These are *behavioral controls*, not *OS-level isolation*.

### Things agent-mcp Cannot Control (Architecture Limitation)

- Access by the host process itself (agent-mcp runs with the same OS permissions as its parent)
- Indirect attacks via side-channels or timing
- Modifications to the state database by other processes
- Secret leakage via inference-time data (e.g., the model reasoning about secrets in prompts)

## Current Limitations

### 1. No OS-Level Sandboxing

Agent-mcp enforces policies in code, not via OS mechanisms. A buggy or malicious agent can still:
- Read any file the host process can read
- Execute any command the host process can execute
- Contact any host the network allows

Mitigation: Run agent-mcp in a container, VM, or isolated user account if you need OS-level isolation.

### 2. No External Security Audit

This is research-grade software. There has been no formal security review by external auditors. Treat it as experimental.

### 3. Prompt Injection is Not Mitigated

A model can sometimes escape tool restrictions by creative prompting. For example:

```
User: Read the .env file
Agent: [Denied: .env not in allowed paths]
Agent's reasoning: "The user asked for .env, but my policy forbids it. 
                    However, if I call read_dir('/'), I can see all files, 
                    including .env, and the user can parse the directory listing."
```

Tool filtering is a **guidance mechanism**, not a security boundary.

### 4. Single-User Isolation Only

The SQLite database is shared by all MCP clients. There is no per-user access control:
- One MCP client can inspect any agent created by another
- One MCP client can cancel another's tasks
- All clients see all agents in `agent_list`

Mitigation: Run separate agent-mcp instances if you need user isolation, or put them behind a per-user authentication proxy.

### 5. Experimental State Recovery

Agent state recovery after a crash is partially implemented. Assume potential data loss on ungraceful shutdown.

## Security Assumptions

1. **Hosting process is trusted** — the agent-mcp server process itself has not been compromised
2. **Model outputs are partially trusted** — we assume the model generally follows instructions, though creative prompt injection may bypass restrictions
3. **Filesystem permissions are set correctly** — the host OS permissions are the outer boundary
4. **Secrets in the environment are protected** — environment variables passed to agents are not logged or persisted in plaintext in messages
5. **Network connectivity is configured safely** — the network allowlist is the primary control; no external proxy or WAF is assumed

## Related Documentation

- **Provider Prompt Caching**: See `docs/ideas/provider-caching-research.md` in the monorepo for multi-provider cache analysis and the 2.0.2 context-management fix
- **Context Management Strategy**: See `docs/ideas/context-and-cache-strategy.md` in the monorepo for design rationale and wire-trace evidence
- **BACKLOG**: Bugs, findings, and regressions are logged in the monorepo's `BACKLOG.md`

## Recommendations for Production Use

As of 2.0.2:

- **No**. This is experimental, research-grade software.
- **For research/local development**: Reasonable with the limitations above understood.
- **For production serving untrusted users**: Not recommended until external security audit is completed and OS-level sandboxing is added.
- **For production serving only trusted internal agents**: Acceptable if you own the host and the network.

See also: `agent-mcp-recommendation-evidence-requirements.md` in the monorepo `docs/agent-mcp/` directory for a checklist of evidence/features needed before this software is recommended for broader use.
