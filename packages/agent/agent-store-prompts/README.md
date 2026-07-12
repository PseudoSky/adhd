# @adhd/agent-store-prompts

System prompt and instruction templates for @adhd/agent-mcp. Provides default prompts for agents, tool descriptions, and behavioral guidance.

**Status:** Prompt store (shipped v0.0.1)  
**Package:** `npm install @adhd/agent-store-prompts`  
**Consumers:** `@adhd/agent-mcp`, `@adhd/agent-engine-orchestrator`

## What it does

- **System prompts** — default agent personality and behavior instructions
- **Tool descriptions** — structured descriptions of available tools and their constraints
- **Error guidance** — clear error messages and recovery suggestions
- **HITL templates** — human-in-the-loop suspension and resume instructions

## Usage

Prompts are loaded and formatted by the orchestrator before each model call.

```typescript
import { getSystemPrompt } from '@adhd/agent-store-prompts';

const prompt = getSystemPrompt({
  agentName: 'my-agent',
  provider: 'anthropic',
  delegation depth: 0,
});
```

## Key files

- `src/system-prompt.ts` — default system instructions
- `src/tool-descriptions.ts` — tool schemas and descriptions
- `src/error-guidance.ts` — structured error messages

## Architecture

- Part of the 6-package agent framework family
- Depends on: none (pure data + templates)
- Depended on by: `@adhd/agent-engine-orchestrator`

See `/entrypoint/agent-mcp/docs/architecture-and-security.md` for the full agent runtime architecture.
