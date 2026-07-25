# @adhd/agent-mcp

An MCP (Model Context Protocol) server exposing a bounded, supervised agent runtime. This package serves as the public protocol interface to the agent framework, enabling MCP clients to create, monitor, and control child agents running within enforced resource and permission boundaries.

## What is this?

`@adhd/agent-mcp` is an MCP server that:

- **Runs agents as stateful processes** — each agent maintains conversation history, executes tools, and interacts with model providers (Anthropic, OpenAI, and OpenAI-compatible endpoints such as DeepSeek via an explicit `baseURL` override — see [Providers and credentials](#providers-and-credentials) below)
- **Enforces runtime policies** — maximum delegation depth, token/cost budgets, filesystem scope, network allowlist, tool deny/allow filters
- **Persists state locally** — SQLite-backed storage for agents, sessions, messages, and execution traces
- **Exposes a tool-call interface** — MCP clients call tools like `agent_create`, `task`, `result`, `task_cancel` to interact with the runtime
- **Supports multi-turn delegation** — parent agents can spawn child agents with subset-of-parent permissions

## Quick start

### Installation

```bash
npm install -g @adhd/agent-mcp
```

### Run as an MCP server

```bash
agent-mcp
```

This starts a JSON-RPC server over stdio. Configure in your MCP host (e.g., Claude's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-mcp": {
      "command": "agent-mcp",
      "env": {
        "ADHD_AGENT_PROVIDER": "anthropic",
        "ADHD_AGENT_MODEL": "claude-opus-4-1",
        "ADHD_AGENT_CONTEXT_LIMIT": "0"
      }
    }
  }
}
```

### Common environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ADHD_AGENT_PROVIDER` | `anthropic` | Provider *type* for the server-wide default agent: `anthropic`, `openai`, or `claudecli` (see [Providers and credentials](#providers-and-credentials)) |
| `ADHD_AGENT_MODEL` | `claude-opus-4-1` | Model identifier for the provider |
| `ADHD_AGENT_CONTEXT_LIMIT` | `0` | Max context size in tokens; 0 = no limit (enforce only at provider ceiling) |
| `ADHD_AGENT_MAX_TOOL_LOOPS` | `50` | Max tool-call iterations per task |
| `ADHD_AGENT_MAX_DEPTH` | `3` | Max delegation depth (agent → child → grandchild) |

## Providers and credentials

`@adhd/agent-mcp` supports three provider `type`s (`packages/agent/agent-engine-orchestrator/src/validation/agent.ts`):

| `type` | Needs a credential env var? | Notes |
|---|---|---|
| `anthropic` | Yes — `ADHD_AGENT_ANTHROPIC_SECRET` | Accepts either a `claude setup-token` OAuth token (`sk-ant-oat...`) or a console.anthropic.com API key (`sk-ant-api...`) — the provider branches on the prefix automatically. |
| `openai` | Yes — `ADHD_AGENT_OPENAI_SECRET` | Also the type to use for any OpenAI-*compatible* endpoint (e.g. DeepSeek): set `env.base_url` / `ADHD_AGENT_OPENAI_BASE_URL` to the provider's URL. DeepSeek additionally has its own default names, `ADHD_AGENT_DEEPSEEK_SECRET` / `ADHD_AGENT_DEEPSEEK_BASE_URL` / `ADHD_AGENT_DEEPSEEK_MODEL`, but they must be passed explicitly as an agent's `env.secret`/`env.base_url` override — there is no separate `"deepseek"` provider `type`. |
| `claudecli` | No | Shells out to the already-authenticated `claude` CLI on the host instead of calling an API directly — nothing to configure here. Use this to avoid provider-credential wiring entirely. |

**The bare SDK-style names `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are never read anywhere in this codebase.** Only the `ADHD_AGENT_<PROVIDER>_SECRET` names above are honored.

**Gemini is not implemented.** There is no `gemini` provider `type`, no Gemini provider adapter, and no `GOOGLE_API_KEY`/Gemini credential path — despite having appeared in older versions of this document.

### Provider credentials are NOT part of the `@adhd/environment` config cascade

Most of agent-mcp's configuration (`db`, `logging`, `queue`, `server`, `transport`, `sse`, `plugins`) resolves through `@adhd/environment`'s file-based cascade (code defaults → global → project → env var), documented in `src/config.ts`. **Provider-credential env vars are deliberately excluded from that cascade** — they are not declared fields of `AgentMcpConfig` at all. They resolve purely from `process.env` on the agent-mcp server process itself, at the moment an agent is constructed, and never from a config file (`.adhd/agent-mcp/config.json` or any namespace/scope file).

Practically: whatever process spawns the agent-mcp server (an MCP host, a shell, `.mcp.json`) must already have `ADHD_AGENT_ANTHROPIC_SECRET` (or the sibling `_OPENAI_`/`_DEEPSEEK_` names) set in *its own* environment before spawning — a config file cannot supply it.

### Known gap: this repo's `.mcp.json` does not forward provider credentials

The `agent-mcp` entry in this repo's own `.mcp.json` only forwards `ADHD_ENV_SCOPE`, `ADHD_AGENT_CONFIG`, and `ADHD_AGENT_REGISTRY_DB_PATH` in its `env` block — there is no `ADHD_AGENT_ANTHROPIC_SECRET` (or other provider secret) passthrough, and nothing derives one from an existing Claude Code OAuth token. A real `task` call against an `anthropic`- or `openai`-type agent spawned this way currently fails with `No credential for <provider>; set ADHD_AGENT_<PROVIDER>_SECRET` unless the variable happens to already be set in the environment that launched the MCP host. This is a known, tracked gap (backlog `agent-mcp-001` in the `adhd` repo) — there is no config-file-based fix, since credentials are deliberately excluded from the cascade (above). Until it's closed, either:

- export the relevant `ADHD_AGENT_<PROVIDER>_SECRET` in the shell/session that launches your MCP host before it spawns `agent-mcp`, or
- use a `claudecli`-type agent, which needs no credential env var at all (see the table above).

### Example: Create and run an agent task (via MCP client)

When connected to `agent-mcp` via MCP, call tools in sequence:

```json
// 1. Register an agent
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "agent_create",
  "params": {
    "name": "my-agent",
    "config": {
      "provider": "anthropic",
      "model": "claude-opus-4-1",
      "tools": { "allow": ["file_read", "code_execute"] },
      "filesystem": { "read": ["/Users/me/project"] }
    }
  }
}
// Returns: {"agentId": "my-agent"}

// 2. Run a task against the agent
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "task",
  "params": {
    "agentName": "my-agent",
    "prompt": "Analyze the TypeScript code in /Users/me/project and list the 3 most critical issues"
  }
}
// Returns: {"taskId": "task-abc123", "status": "running"}

// 3. Poll for result
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "result",
  "params": { "taskId": "task-abc123" }
}
// Returns: {
//   "taskId": "task-abc123",
//   "status": "completed",
//   "result": "Found 3 issues:\n1. Unhandled promise rejection...",
//   "usage": {
//     "inputTokens": 15234,
//     "peakContextTokens": 8500,
//     "cacheReadTokens": 12000,
//     "uncachedInputTokens": 3234,
//     "outputTokens": 412
//   }
// }
```

See the source repository's `examples/` directory for end-to-end client libraries (Node.js, Python).

## 2.0.2 Release Notes

This release fixes six critical regressions from 2.0.0/2.0.1 related to context management, token accounting, security guards, and configuration discovery:

### Cache-preserving context management

**Issue:** The context limiter dropped oldest messages on every call, mutating the prefix that providers use for caching. This destroyed prefix cache hits (from ~93-100% to ~5-6%) and inflated token spend by ~3.3x on affected tasks.

**Fix:** Replaced with append-only history that only summarizes the middle when the real context (from the provider's own `prompt_tokens`) approaches the model's actual window. `ADHD_AGENT_CONTEXT_LIMIT` now defaults to `0` (disabled), and the hardcoded 30,000-token default is gone.

**Impact:** Users with active context limits should re-evaluate whether they still need them, or switch to input-capping strategies (limiting individual tool-result sizes) instead.

### Provider-neutral token accounting

**Issue:** `inputTokens` meant different things on different providers (Anthropic excludes cached tokens; others include them), making cross-provider cost aggregation impossible. Peak-context-size tracking didn't exist anywhere.

**Fix:** New normalized usage fields:
- `uncachedInputTokens` — full-price tokens this call
- `cacheReadTokens` — discounted cache-hit tokens
- `cacheCreationTokens` — Anthropic cache-write surcharge (Anthropic only)
- `reasoningTokens` — inference tokens (when provider reports them)
- `peakContextTokens` — max prompt size across all calls in the task (distinct from cumulative `inputTokens`)

**Impact:** Callers must update code that reads `inputTokens` to distinguish between `cumulativeBilledInputTokens` (what was `inputTokens` before) and `peakContextTokens` (new, for "am I close to the window?" checks). Database migration 0008 adds the new columns.

### Create-time environment-variable guard restored

**Issue:** The env-name allowlist guard (`ADHD_AGENT_` prefix requirement) was refactored but never wired up, allowing arbitrary host environment variables (like `AWS_SECRET_ACCESS_KEY`) to be injected into agent credentials at creation time.

**Fix:** Restored validation so `agent_create` and `agent_update` reject any provider environment variable not prefixed `ADHD_AGENT_`.

**Impact:** Existing agents with non-compliant env names will need to be recreated with correct names.

### Sessions→agents foreign-key cascade restored

**Issue:** Database migration 0007 (schema restructuring) silently dropped the `sessions.agent_name → agents.name ON DELETE CASCADE` foreign key, causing `agent_delete` to orphan session and message history forever.

**Fix:** Database migration 0009 restores the cascade constraint.

**Impact:** Requires migration 0009. Old orphaned sessions remain in the database (manual cleanup may be needed); all future deletes will cascade correctly.

### Default tool advertisement restored to full JSON schemas

**Issue:** Tool advertisement mode silently switched from full JSON-Schema function-calling (2.0.1 default) to name-only (with prose doc in system message), affecting every non-claudecli agent post-upgrade with no migration or changelog note.

**Fix:** Restored full JSON-Schema as default. Name-only mode remains available via `toolAdvertisement: 'names'` on agent creation.

**Impact:** Wire format changes for any agent created under 2.0.0/2.0.1 without an explicit `toolAdvertisement` setting. Existing agents should see restored tool-definition accuracy.

### Plugin global-config back-compat

**Issue:** Plugin loader stopped checking `~/.agent-mcp/config.json` (the legacy path), breaking users with existing global plugin configurations.

**Fix:** Restored fallback to legacy path. Loader now checks (in order):
1. `~/.adhd/agent-mcp/config.json` (new preferred path)
2. `./.adhd/agent-mcp/config.json` (project-local override)
3. `~/.agent-mcp/config.json` (legacy fallback)

**Impact:** Existing configs at the legacy path will load again. No action required.

## Architecture & Security

See [docs/architecture-and-security.md](./docs/architecture-and-security.md) for details on:
- System boundaries and process model
- Provider abstraction and state persistence
- Permission inheritance and trust boundaries
- Filesystem and network access controls
- Failure recovery and cancellation semantics
- Known limitations and security assumptions

## Limitations

- **No OS-level sandboxing** — filesystem/network access is enforced by policy, not by OS isolation. A malicious or compromised agent can still access the host if the policy permits.
- **No external audit** — this is research-grade software. Security evaluation by an external auditor is incomplete.
- **Prompt-level controls only** — tool-use filtering can be bypassed by prompt injection; it is not a security boundary.
- **Single-user only** — no multi-user isolation; all agents share the same SQLite database.
- **Experimental recovery** — agent state recovery after host crash is partially implemented; assume data loss on unexpected termination.

## Support

- **Issues:** Report bugs at the monorepo issue tracker
- **Security:** See SECURITY.md for responsible disclosure
- **Documentation:** Full architecture docs in `docs/`

## License

See LICENSE file in this directory.
