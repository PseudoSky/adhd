# @adhd/agent-base-types

Shared TypeScript type definitions and schemas for the @adhd/agent-* family. Provides interfaces for agents, tasks, sessions, messages, usage, and validation schemas.

**Status:** Shared types (shipped v2.0.0)  
**Package:** `npm install @adhd/agent-base-types`  
**Consumers:** All agent-* packages

## What it does

- **Core types** — Agent, Task, Session, Message, TaskEvent interfaces
- **Token accounting** — TokenUsage interface with provider-neutral fields (2.0.2+)
- **Validation schemas** — Zod schemas for agent config, task input, message validation
- **Execution models** — Status enums, stop-reason normalization, error types
- **MCP contract** — Tool input/output schemas for the 16 MCP tools

## Usage

```typescript
import {
  Agent,
  Task,
  TokenUsage,
  agentCreateSchema,
} from '@adhd/agent-base-types';

const agentConfig = agentCreateSchema.parse({
  name: 'my-agent',
  config: { provider: 'anthropic', model: 'claude-opus-4-1' },
});
```

## Key files

- `src/domain.ts` — core interface definitions (Agent, Task, Session, Message, TokenUsage)
- `src/validation/` — Zod schemas for all inputs
- `src/index.ts` — public exports

## 2.0.2 changes

- **TokenUsage expansion** — adds `uncachedInputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `reasoningTokens` fields (provider-neutral accounting)
- Added `peakContextTokens` to task_usage tracking

## Architecture

- Part of the 6-package agent framework family
- Depends on: `zod`
- Depended on by: All other @adhd/agent-* packages

See `/entrypoint/agent-mcp/docs/architecture-and-security.md` for the full agent runtime architecture.
