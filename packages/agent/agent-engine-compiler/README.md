# @adhd/agent-engine-compiler

Compiles agent configurations from the registry into runtime-ready manifests. Resolves component compositions, tool bindings, policy constraints, and model specifications. Part of the agent registry family.

**Status:** Shipped v2.1.2  
**Platform:** `platform:node` (runs in Node/CLI, not browser)  
**Consumers:** `@adhd/agent-mcp`, `@adhd/dispatch-cli`

## What it does

- **Body Resolution** — Assembles agent components from the registry composition store into a complete prompt body
- **Tool Resolution** — Resolves tool aliases and platform-specific bindings (HTTP, MCP, CLI, etc.)
- **Model Resolution** — Looks up model capabilities and configurations
- **Policy Constraint Resolution** — Evaluates effective authorization policies
- **Output Emission** — Compiles agent definitions into YAML frontmatter, JSON objects, or Markdown documents
- **Database Migrations** — Runs schema setup via `runMigrationsOn(db)`

## Usage

First, resolve the shared registry database path:

```typescript
import { resolveRegistryDbPath } from '@adhd/agent-core-env';
import Database from 'better-sqlite3';
import { runMigrationsOn, compileAgent } from '@adhd/agent-engine-compiler';

const dbPath = resolveRegistryDbPath(); // e.g., ~/.adhd/agent-registry/production/data/registry.db
const db = new Database(dbPath);

// Run migrations
await runMigrationsOn(db);

// Compile an agent from the registry
const compiled = await compileAgent(db, {
  agentId: 'my-agent',
  platform: 'mcp', // or 'http', 'cli', 'json'
  models: modelStore,
  tools: toolStore,
  policies: policyStore,
  composition: compositionStore,
});

// Emit as YAML or JSON
const yaml = emitYamlFrontmatter({
  agentId: compiled.agentId,
  tools: compiled.tools,
  modelAlias: compiled.modelAlias,
  policyConstraints: compiled.policyConstraints,
});
```

## Key exports

| Export | Purpose |
|--------|---------|
| `resolveBody(db, ...)` | Assemble component composition into prompt body |
| `resolveTools(db, ...)` | Resolve tools and platform bindings |
| `resolveModel(db, ...)` | Look up model and capabilities |
| `resolvePolicyConstraints(db, ...)` | Resolve effective policies |
| `compileAgent(db, input)` | Complete compilation orchestrator |
| `emitYamlFrontmatter(input)` | Emit as YAML frontmatter + body |
| `emitJsonObject(input)` | Emit as JSON (e.g., for REST API) |
| `runMigrationsOn(db)` | Initialize database schema |

## Architecture

- **Tier**: `engine` (depends on base + core + stores)
- **Consumption**: Reads from all registry family stores (prompts, tools, policy, provider)
- **No import-time side effects** — DB path and connection are external (via `agent-core-env`)
- **Part of agent registry family**: `agent-store-prompts` + `agent-store-tools` + `agent-core-policy` + `agent-core-provider` + `agent-engine-compiler`

See `/entrypoint/agent-mcp/` for the agent MCP server (primary consumer).
