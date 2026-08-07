# @adhd/agent-store-tools

SQLite-backed registry for agent tools, MCP servers, and tool-to-platform bindings. Part of the agent registry family. **No database import-time side effects** — use `@adhd/agent-core-env` to resolve the shared registry DB path.

**Status:** Shipped v2.1.2  
**Platform:** `platform:node` (runs in Node/CLI, not browser)  
**Consumers:** `@adhd/agent-mcp`, `@adhd/agent-engine-compiler`

## What it does

- **Tool Store** — registers and manages tools (functions, API endpoints, MCP tools, etc.)
- **Binding Store** — manages tool-to-platform bindings (how a tool is exposed on HTTP, MCP, CLI, etc.)
- **MCP Server Store** — tracks MCP servers and their configurations
- **Agent Tool Store** — grants tools to agents with permission levels and access control
- **Database Migrations** — runs schema setup via `runMigrationsOn(db)`
- **Seed Data** — provides initial platform definitions and tool examples

## Usage

First, resolve the shared registry database path:

```typescript
import { resolveRegistryDbPath } from '@adhd/agent-core-env';
import Database from 'better-sqlite3';
import { runMigrationsOn, ToolStore, AgentToolStore } from '@adhd/agent-store-tools';

const dbPath = resolveRegistryDbPath(); // e.g., ~/.adhd/agent-registry/production/data/registry.db
const db = new Database(dbPath);

// Run migrations
await runMigrationsOn(db);

// Create stores
const toolStore = new ToolStore(db);
const agentToolStore = new AgentToolStore(db);

// Register a tool
const tool = await toolStore.create({
  name: 'my-tool',
  description: 'Does something useful',
  type: 'api',
});

// Grant it to an agent
const grant = await agentToolStore.grant(agentId, tool.id, {
  permissionLevel: 'execute',
});
```

## Key exports

| Export | Purpose |
|--------|---------|
| `ToolStore` | Tool registry and management |
| `BindingStore` | Tool-to-platform bindings (HTTP, MCP, CLI) |
| `McpServerStore` | MCP server configurations |
| `AgentToolStore` | Agent tool grants and permissions |
| `runMigrationsOn(db)` | Initialize database schema |
| Schema tables | `toolsTable`, `toolTypesTable`, `mcpServersTable`, `toolPlatformBindingsTable`, `platformsTable`, `agentToolsTable` |

## Architecture

- **Tier**: `store` (depends on base + core)
- **Schema**: 6 tables managing tools, platforms, MCP servers, bindings, and agent grants
- **No import-time side effects** — DB path and connection are external (via `agent-core-env`)
- **Permission model**: Tool access is gated by `PermissionLevel` (read, execute, admin)
- **Part of agent registry family**: `agent-store-prompts` + `agent-store-tools` + `agent-core-policy` + `agent-core-provider` + `agent-engine-compiler`

See `/entrypoint/agent-mcp/` for the agent MCP server (primary consumer).
