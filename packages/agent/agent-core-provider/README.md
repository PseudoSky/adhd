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

### One registry: `createProviderRegistry`

`createProviderRegistry(db)` returns the single canonical, read-only **data**
registry over the provider / model-binding / tool-format tables. Selection and
provider construction live in `@adhd/agent-engine-orchestrator`, not here.

```typescript
import { createProviderRegistry } from '@adhd/agent-core-provider';

const registry = createProviderRegistry(db);
registry.resolveModelRef('claude_sonnet_4_6', 'claude_api'); // 'claude-sonnet-4-6'
registry.resolveModelRef('claude_sonnet_4_6', 'claude_code'); // 'sonnet'
registry.toolFormatLookup('anthropic', 'web_search')?.emitShape; // 'server_side'
registry.list(); // all providers;  registry.get('anthropic') // Provider | null
```

`toolFormatLookup` is a `ToolFormatLookup`, so it plugs straight into
`emitToolsForProvider`. An unbound (ref, platform) pair throws
`ModelStoreError('MODEL_BINDING_NOT_FOUND')` — never another platform's string.
The shared binding types (`PartialBinding`, `ProviderSelection`, `ModelSlug`,
`ProviderType`) live in `@adhd/agent-base-types`.

## Cost estimation

`estimateCost` prices one call (or a pre-summed rollup) and says how the number was derived.
Unpriced is `null`, never `0`.

```typescript
import { estimateCost, estimateCostUsd } from '@adhd/agent-core-provider';

const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };
estimateCost('claude_sonnet_4_6', usage);
// { costUsd: 3, status: 'priced', basis: 'vendor-direct', pricingRef: 'rate-card:claude_sonnet_4_6', resolvedId: 'claude_sonnet_4_6' }
estimateCostUsd('no-such-model', usage); // null
```

Resolution order: exact `RATE_CARD` key (`vendor-direct`), then OpenRouter (an alias hit is
`owner-assumption`, a plain OpenRouter id is `openrouter-estimate`), then normalised `RATE_CARD` keys and
family aliases (`vendor-direct`). Pass `{ asOf, source }` to price against an as-of `IPriceSource` (the
price history kept by `@adhd/agent-store-runtime`); the bundled OpenRouter snapshot
(`PRICING_SNAPSHOT_META`, 467 models fetched 2026-10-08) is the fallback. The snapshot is generated:
edit `src/pricing/pricing.json`, run `nx run agent-core-provider:gen-pricing-snapshot`; a unit test fails if
`pricing-snapshot.ts` drifts from the JSON.

`PROVIDER_MODEL_ALIASES` maps a provider-side name to the OpenRouter id it is priced as. Each value is an
object `{ target, basis: 'owner-assumption', setAt, setBy, ticket }`; today the only entry is
`deepseek-flash` to `deepseek/deepseek-v4.1-flash`, an owner decision rather than evidence.

## Key exports

| Export | Purpose |
|--------|---------|
| `createProviderRegistry(db)` | Canonical read-only registry: `list`/`get`/`resolveModelRef`/`toolFormatLookup` |
| `ProviderStore` | LLM provider registry |
| `ModelStore` | Model definitions and capabilities |
| `ToolFormatStore` | Tool format specifications per model |
| `runMigrationsOn(db)` | Initialize database schema |
| `estimateCost` / `estimateCostUsd` | Cost with provenance / cost number only (`null` when unpriced) |
| `PROVIDER_MODEL_ALIASES`, `RATE_CARD`, `PRICING_SNAPSHOT_META` | Alias objects, vendor-direct rates, bundled snapshot metadata |
| `parseOpenRouterFeed`, `parseBundledSnapshot`, `perMillion` | OpenRouter feed validation and per-token to per-million conversion |
| Schema tables | Model bindings and platform definitions |

## Architecture

- **Tier**: `core` (depends on base)
- **Schema**: Tables for providers, models, tool formats, and platform bindings
- **No import-time side effects** — DB path and connection are external (via `agent-core-env`)
- **Part of agent registry family**: `agent-store-prompts` + `agent-store-tools` + `agent-core-policy` + `agent-core-provider` + `agent-engine-compiler`

See `/entrypoint/agent-mcp/` for the agent MCP server (primary consumer).
