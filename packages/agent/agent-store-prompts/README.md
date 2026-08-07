# @adhd/agent-store-prompts

SQLite-backed registry for agent system prompts, instruction components, and composition rules. Part of the agent registry family. **No database import-time side effects** — use `@adhd/agent-core-env` to resolve the shared registry DB path.

**Status:** Shipped v2.1.2  
**Platform:** `platform:node` (runs in Node/CLI, not browser)  
**Consumers:** `@adhd/agent-mcp`, `@adhd/agent-engine-compiler`

## What it does

- **Component Store** — manages reusable prompt components (system instructions, tool descriptions, error guidance, etc.)
- **Agent Store** — stores agent definitions and taxonomy categories
- **Composition Store** — defines and evaluates how components combine into system prompts (with conditional rules)
- **UseCase Store** — models use cases and context-specific component selection
- **ComposedPromptStore** — caches and retrieves final composed prompts with content hashing
- **Database Migrations** — runs schema setup via `runMigrationsOn(db)`
- **Seed Data** — provides `SEED_COMPONENTS` and `PROMPT_TYPES` for initialization

## Usage

First, resolve the shared registry database path:

```typescript
import { resolveRegistryDbPath } from '@adhd/agent-core-env';
import Database from 'better-sqlite3';
import { runMigrationsOn, ComponentStore, ComposedPromptStore } from '@adhd/agent-store-prompts';

const dbPath = resolveRegistryDbPath(); // e.g., ~/.adhd/agent-registry/production/data/registry.db
const db = new Database(dbPath);

// Run migrations
await runMigrationsOn(db);

// Create stores
const componentStore = new ComponentStore(db);
const composedStore = new ComposedPromptStore(db);

// Use the stores
const components = await componentStore.list({ type: 'instruction' });
const composed = await composedStore.get(contextHash);
```

## Key exports

| Export | Purpose |
|--------|---------|
| `ComponentStore` | Reusable prompt components |
| `AgentStore` | Agent definitions |
| `TaxonomyStore` | Category taxonomy |
| `CompositionStore` | Component composition rules |
| `UseCaseStore` | Use case definitions |
| `ComposedPromptStore` | Composed prompt cache |
| `runMigrationsOn(db)` | Initialize database schema |
| `PROMPT_TYPES` | Seed data — available prompt types |
| `SEED_COMPONENTS` | Seed data — initial components |

## Architecture

- **Tier**: `store` (depends on base + core)
- **Schema**: 8 tables managing agents, components, compositions, use cases, prompts, and taxonomy
- **No import-time side effects** — DB path and connection are external (via `agent-core-env`)
- **Part of agent registry family**: `agent-store-prompts` + `agent-store-tools` + `agent-core-policy` + `agent-core-provider` + `agent-engine-compiler`

See `/entrypoint/agent-mcp/` for the agent MCP server (primary consumer).
