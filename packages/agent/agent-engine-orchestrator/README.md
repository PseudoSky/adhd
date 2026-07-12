# @adhd/agent-engine-orchestrator

Orchestration engine for @adhd/agent-mcp. Implements the core agent execution loop, provider adapters, message windowing, tool calling, and delegation supervision.

**Status:** Core engine (shipped v0.0.1)  
**Package:** `npm install @adhd/agent-engine-orchestrator`  
**Consumers:** `@adhd/agent-mcp` (primary)

## What it does

- **Agent orchestration loop** — coordinates model calls, tool execution, message history, and task completion
- **Provider adapters** — normalizes Anthropic, OpenAI, DeepSeek, and Gemini APIs to a unified interface
- **Context management** — implements append-only message history with intelligent collapse (2.0.2+)
- **Token accounting** — provider-neutral usage tracking with cache-aware fields
- **Delegation supervision** — enforces delegation depth, budget caps, and permission inheritance for child agents
- **Hook system** — pre/post interceptors for policy enforcement and observability

## Usage

This is an internal package consumed by `@adhd/agent-mcp`. End users interact with it through the MCP server's tools (`task`, `result`, `agent_create`, etc.).

For engine integration (rare):

```typescript
import { Orchestrator } from '@adhd/agent-engine-orchestrator';

const orchestrator = new Orchestrator({
  policy: policyEngine,
  db: agentDatabase,
  hooks: hookRegistry,
});

const result = await orchestrator.run({
  agentName: 'my-agent',
  messages: [{ role: 'user', content: 'Find bugs in /src' }],
  model: 'claude-opus-4-1',
  provider: 'anthropic',
});
```

## Key files

- `src/engine/orchestrator.ts` — main orchestration loop
- `src/providers/` — Anthropic, OpenAI, DeepSeek, Gemini adapters
- `src/engine/windowing.ts` — context management
- `src/plugins/` — hook system and tool dispatch

## Architecture

- Part of the 6-package agent framework family
- Depends on: `@adhd/agent-base-types`, `@adhd/agent-store-runtime`
- Depended on by: `@adhd/agent-mcp`

See `/entrypoint/agent-mcp/docs/architecture-and-security.md` for the full agent runtime architecture.
