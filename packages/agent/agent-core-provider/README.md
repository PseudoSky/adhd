# @adhd/agent-core-provider

SQLite-backed registry for LLM providers and models. Part of the agent registry family. **No database import-time side effects** — use `@adhd/agent-core-env` to resolve the shared registry DB path.

**Status:** Shipped v2.1.2  
**Platform:** `platform:node` (runs in Node/CLI, not browser)  
**Consumers:** `@adhd/agent-mcp`, `@adhd/agent-engine-compiler`

## What it does

- **Provider Store** — registers LLM providers (Anthropic, OpenAI, etc.) and their configurations
- **Model Store** — manages model definitions, capabilities, and pricing
- **Tool Format Store** — defines how tools are represented for different models (JSON schema format, request/response specs, etc.)
- **Platform Bindings** — maps models to deployment platforms (local, cloud, etc.)
- **Database Migrations** — runs schema setup via `runMigrationsOn(db)`

## Usage

First, resolve the shared registry database path:

```typescript
import { resolveRegistryDbPath } from '@adhd/agent-core-env';
import Database from 'better-sqlite3';
import { runMigrationsOn, ProviderStore, ModelStore } from '@adhd/agent-core-provider';

const dbPath = resolveRegistryDbPath(); // e.g., ~/.adhd/agent-registry/production/data/registry.db
const db = new Database(dbPath);

// Run migrations
await runMigrationsOn(db);

// Create stores
const providerStore = new ProviderStore(db);
const modelStore = new ModelStore(db);

// Register a provider
const provider = await providerStore.create({
  name: 'my-provider',
  description: 'Custom LLM provider',
  endpoint: 'https://api.example.com',
});

// Register a model
const model = await modelStore.create({
  providerId: provider.id,
  name: 'my-model',
  capabilities: ['tool_use', 'vision'],
  costPer1kTokens: { input: 0.01, output: 0.03 },
});
```

## Key exports

| Export | Purpose |
|--------|---------|
| `ProviderStore` | LLM provider registry |
| `ModelStore` | Model definitions and capabilities |
| `ToolFormatStore` | Tool format specifications per model |
| `runMigrationsOn(db)` | Initialize database schema |
| Schema tables | Model bindings and platform definitions |

## Architecture

- **Tier**: `core` (depends on base)
- **Schema**: Tables for providers, models, tool formats, and platform bindings
- **No import-time side effects** — DB path and connection are external (via `agent-core-env`)
- **Part of agent registry family**: `agent-store-prompts` + `agent-store-tools` + `agent-core-policy` + `agent-core-provider` + `agent-engine-compiler`

See `/entrypoint/agent-mcp/` for the agent MCP server (primary consumer).
