# agent-mcp Session Context
_Last updated: 2026-05-14_

## Project Location
`/Users/nix/dev/node/adhd/packages/ai/agent-mcp`

Nx monorepo. Build: `npx nx build agent-mcp`. Dist: `dist/packages/ai/agent-mcp/`.

## What This Package Is
A stateful MCP (Model Context Protocol) server that lets LLM agents:
- Create/store agent definitions (provider, model, system prompt, MCP tools, permissions)
- Open sessions (stateful conversation threads)
- Run tasks (sync or background) against sessions
- Delegate recursively to sub-agents

Transport: stdio (default) or HTTP. Database: better-sqlite3 via Drizzle ORM (WAL mode). Logger: pino bound to fd 2 (stderr) — stdout is reserved for MCP JSON-RPC framing.

## .mcp.json Config Block (for connecting to this server)
```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/nix/dev/node/adhd/dist/packages/ai/agent-mcp/src/index.js"],
      "env": {
        "DATABASE_PATH": "/Users/nix/dev/node/adhd/packages/ai/agent-mcp/data/agents.db",
        "LMSTUDIO_BASE_URL": "http://192.168.1.59:1234/v1"
      }
    }
  }
}
```

## Current DB State (as of session end)
- **`test` agent** — exists, working
- **`test-orchestrator` agent** — EXISTS BUT CORRUPTED: `mcpServers: {}` and `permissions: {}` were clobbered by the `agent_update` bug (now fixed). Needs to be repaired.

### How to repair test-orchestrator
Call `agent_update` with:
```json
{
  "name": "test-orchestrator",
  "patch": {
    "mcpServers": {
      "agent-mcp": {
        "transport": "stdio",
        "command": "node",
        "args": ["/Users/nix/dev/node/adhd/dist/packages/ai/agent-mcp/src/index.js"],
        "env": {
          "DATABASE_PATH": "/Users/nix/dev/node/adhd/packages/ai/agent-mcp/data/agents.db",
          "LMSTUDIO_BASE_URL": "http://192.168.1.59:1234/v1",
          "ALLOWED_AGENTS": "test"
        }
      }
    },
    "permissions": {}
  }
}
```

## Bugs Fixed This Session (all built and in dist)

### Bug 1 — Dead code: `buildSelfConfig()` in server.ts
- Function body remained after `self_config` tool was removed for security reasons (API keys exposed in plaintext)
- Fixed: removed the entire function

### Bug 2 — `tool_calls` missing from assistant messages (CRITICAL)
- File: `packages/ai/agent-mcp/src/providers/openai.ts`
- `toOpenAIMessages()` `assistant` case only emitted `content`, never `tool_calls`
- Effect: first LLM iteration worked, but second call (with history) hit API error because `role: "tool"` had no preceding `role: "assistant"` with `tool_calls` → TASK_FAILED → error log
- This caused "task status changes coming back as error logs even when successful"
- Fix: assistant case now emits `tool_calls` array when `message.toolCalls` is present

### Bug 3 — `agent_update` clobbered `mcpServers` and `permissions`
- Files: `packages/ai/agent-mcp/src/validation/agent.ts` + `src/store/agent-store.ts`
- Root cause: patch schema was derived from `agentDefinitionSchema` which has `.default({})` on `mcpServers` and `permissions`. Zod filled in defaults for absent fields → patch had `mcpServers: {}`, `permissions: {}` even when not provided
- Secondary cause: store spread patch over existing without filtering undefined values
- Fix 1 (validation): replaced derived patch schema with explicit `agentPatchSchema` that has no defaults
- Fix 2 (store): added `Object.fromEntries(Object.entries(input.patch).filter(([, v]) => v !== undefined))` before merging

## Key Architecture Notes

### Stdout / Stderr
- **stdout**: MCP JSON-RPC only. NEVER write anything else to stdout.
- **stderr (fd 2)**: pino logger. LM Studio labels ALL stderr as [ERROR] in its UI — this is cosmetic, not a functional error.

### In-process client
When an agent's `mcpServers` contains `"agent-mcp"`, the registry detects it as self-referential and routes calls via `InProcessMcpClient` — no network round-trip. This is how recursive delegation works.

### Policy engine precedence
- Per-agent `permissions.allowedAgents` → always wins over server default
- Server `ALLOWED_AGENTS` env var → fallback when agent has no per-agent setting
- `undefined` = unrestricted, `[]` = block all

### Session snapshot
`agentData` is stored at session creation. `SessionStore.getAgentDefinition(sessionId)` is the only access point. The public `Session` type does NOT expose it. Updating an agent definition does not affect open sessions.

### Task status flow
`pending` → `running` → `completed` | `failed` | `cancelled`

### Provider message format (OpenAI/LMStudio)
```typescript
// assistant with tool calls:
{ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "server__tool", arguments: "{...}" } }] }
// tool result:
{ role: "tool", tool_call_id: "...", content: JSON.stringify(result) }
```
Tool names use `server__tool` double-underscore convention.

## Outstanding Work
- No regression tests for the 3 fixed bugs
- `test-orchestrator` DB record needs mcpServers/permissions restored (see above)

## LM Studio Config
- Model: `qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8`
- Base URL: `http://192.168.1.59:1234/v1`
- API Key env: `LMSTUDIO_API_KEY` (export in your shell or a gitignored local override — never commit the value; LM Studio ignores it anyway)
