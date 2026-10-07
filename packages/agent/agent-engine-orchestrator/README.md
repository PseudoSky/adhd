# @adhd/agent-engine-orchestrator

Orchestration engine for @adhd/agent-mcp. Implements the core agent execution loop, provider adapters, message windowing, tool calling, and delegation supervision.

**Status:** Core engine (shipped v0.0.1)  
**Package:** `npm install @adhd/agent-engine-orchestrator`  
**Consumers:** `@adhd/agent-mcp` (primary)

## What it does

- **Agent orchestration loop** — coordinates model calls, tool execution, message history, and task completion
- **Provider adapters** — normalizes the three real provider types — `anthropic`, `openai` (which also covers OpenAI-compatible endpoints such as DeepSeek via an explicit `baseURL`), and `claudecli` (subprocess) — to a unified interface. There is no separate `deepseek` or `gemini` adapter.
- **Context management** — implements append-only message history with intelligent collapse (2.0.2+)
- **Token accounting** — provider-neutral usage tracking with cache-aware fields
- **Delegation supervision** — enforces delegation depth, budget caps, and permission inheritance for child agents
- **Hook system** — pre/post interceptors for policy enforcement and observability

## Usage

This package is **published and importable** (`npm install @adhd/agent-engine-orchestrator`) — it is not truly `private`. Primary consumer is `@adhd/agent-mcp`, whose end users interact with it through the MCP server's tools (`task`, `result`, `agent_create`, etc.).

⚠️ **A direct (non-agent-mcp) consumer MUST wire provider credentials itself.** The engine ships `EngineConfig` as an **interface only** (`src/interfaces.ts`); there is no built-in `Environment`-backed default. In particular `createProvider(...)` resolves a credential via `EngineConfig.getProviderConfig(...)`; if you construct the engine without that wiring, every provider call fails with:

```
No credential for <provider>; set ADHD_AGENT_<PROVIDER>_SECRET
```

The `env: { secret: "ADHD_AGENT_..." }` pointers on agent definitions only resolve when the host supplies an `EngineConfig` whose `getProviderConfig` is backed by `@adhd/environment` (as `@adhd/agent-mcp` does in `entrypoint/agent-mcp/src/config.ts`'s `toEngineConfig()`). See `entrypoint/agent-mcp/src/__tests__/config.provider-credentials.test.ts` for the negative control that asserts this failure mode with no env layers.

For engine integration:

```typescript
import { Orchestrator } from '@adhd/agent-engine-orchestrator';

// `run()` is an instance method taking the full dependency set; the
// constructor takes no dependencies. The host supplies an EngineConfig.
const orchestrator = new Orchestrator();

const result = await orchestrator.run({
  executionContext,   // { taskId, sessionId, agentName, agentDefinition, recursionDepth, toolCallCount }
  messages,
  registry,           // McpClientRegistry
  provider,           // an LLMProvider (createProvider(agentDefinition.provider, ...))
  policy,             // PolicyEngine
  taskStore,
  sessionStore,
  signal: new AbortController().signal,
  taskId: executionContext.taskId,
  config: engineConfig, // REQUIRED for provider credentials
});
```

## Key files

- `src/engine/orchestrator.ts` — main orchestration loop
- `src/providers/` — `anthropic`, `openai` (incl. OpenAI-compatible endpoints), and `claudecli` adapters
- `src/engine/policy.ts` — `PolicyEngine` (depth / tool-loop / delegation-allowlist enforcement)
- `src/plugins/` — hook system, config-file + default plugin loading

## `claudecli` provider: isolation defaults

The `claudecli` adapter spawns `claude -p` as a worker, not as an interactive session. It always passes:

- `--strict-mcp-config` with `--mcp-config` set to the agent's own servers (an inline empty config when it declares none), so the child never loads the operator's MCP set (which includes agent-mcp itself).
- `--tools <allowedBuiltinTools>` (an allowlist; no tools -> `--tools ""`), so no newer built-in (Workflow, Skill, SendMessage, Cron*, Task*, ...) is available. Ignored in `systemPromptIsAgentSpec` mode, where the spec's `tools:` header governs.
- `--no-session-persistence`, so tasks do not write transcripts into `~/.claude/projects`. Keep them for diagnosis with `keepSessionTranscript: true` on the provider config or `ADHD_AGENT_CLAUDECLI_KEEP_SESSION_TRANSCRIPT=1`.
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the child env (unless already set explicitly), so the operator's CLAUDE.md files and auto-memory are not injected into every task.

The CLI executes its own built-in tools inside the one invocation, so the adapter only answers `tool_use` blocks for `mcp__`-prefixed tools the agent declared.

## Architecture

- Part of the 6-package agent framework family
- Depends on: `@adhd/agent-base-types`, `@adhd/agent-store-runtime`
- Depended on by: `@adhd/agent-mcp`

See `/entrypoint/agent-mcp/docs/architecture-and-security.md` for the full agent runtime architecture.
