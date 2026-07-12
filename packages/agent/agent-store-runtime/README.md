# @adhd/agent-store-runtime

Persistent state store for @adhd/agent-mcp. Manages SQLite schema, migrations, and runtime access to agents, sessions, messages, task events, and usage tracking.

**Status:** Core store (shipped v0.0.1)  
**Package:** `npm install @adhd/agent-store-runtime`  
**Consumers:** `@adhd/agent-mcp`, `@adhd/agent-engine-orchestrator`

## What it does

- **SQLite persistence** — agents, sessions, messages, task_events, task_usage tables with proper indexing
- **Migrations** — drizzle-kit migrations (0000–0009) applied on server startup; tracks schema evolution
- **Query API** — type-safe Drizzle ORM wrappers for all read/write operations
- **Transaction support** — atomic multi-table operations for consistency
- **Usage tracking** — accumulates token counts, cost, and execution traces per task
- **Cascade cleanup** — sessions→agents FK cascade (restored in 2.0.2) via migration 0009

## Usage

This is an internal package consumed by `@adhd/agent-mcp`. Direct use is rare.

For store access (rare):

```typescript
import { AgentStore } from '@adhd/agent-store-runtime';

const store = new AgentStore({
  databasePath: '~/.adhd/agent-mcp/agent-mcp.db',
});

const agents = await store.listAgents();
const task = await store.getTask(taskId);
```

## Database schema

- `agents` — registered agent configs
- `sessions` — conversation instances
- `messages` — chat history (role, content, tool_calls, tool_results)
- `task_events` — MODEL_REQUEST, TOOL_CALL, TASK_COMPLETED events
- `task_usage` — token counts, cost estimates, execution stats

## Key files

- `src/db/schema.ts` — Drizzle ORM schema
- `drizzle/` — migrations (0000–0009)
- `src/database.ts` — AgentStore class and query API

## 2.0.2 changes

- **Migration 0008** — adds `peakContextTokens`, `peakContextAt` columns
- **Migration 0009** — restores `sessions.agent_name → agents.name ON DELETE CASCADE` FK

## Architecture

- Part of the 6-package agent framework family
- Depends on: `drizzle-orm`, `better-sqlite3`
- Depended on by: `@adhd/agent-mcp`, `@adhd/agent-engine-orchestrator`

See `/entrypoint/agent-mcp/docs/architecture-and-security.md` for the full agent runtime architecture.
