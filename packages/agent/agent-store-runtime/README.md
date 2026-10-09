# @adhd/agent-store-runtime

Persistent state store for @adhd/agent-mcp. Manages SQLite schema, migrations, and runtime access to agents, sessions, messages, task events, and usage tracking.

**Status:** Core store (shipped v0.0.1)  
**Package:** `npm install @adhd/agent-store-runtime`  
**Consumers:** `@adhd/agent-mcp`, `@adhd/agent-engine-orchestrator`

## What it does

- **SQLite persistence** — agents, sessions, messages, task_events, task_usage tables with proper indexing
- **Migrations** — drizzle-kit migrations (0000–0012, in `entrypoint/agent-mcp/drizzle/`) applied on server startup; tracks schema evolution
- **Query API** — type-safe Drizzle ORM wrappers for all read/write operations
- **Transaction support** — atomic multi-table operations for consistency
- **Usage tracking** — accumulates token counts, cost, and execution traces per task
- **Price history** — append-only `model_price_history` and `price_pull_ledger` (migration 0012) behind `PriceHistoryStore`, with as-of price lookup and anomaly hold/warn rules
- **Cascade cleanup** — sessions→agents FK cascade (restored in 2.0.2) via migration 0009

## Usage

This is an internal package consumed by `@adhd/agent-mcp`. Direct use is rare.

For store access (rare), the exported stores are `SessionStore`, `TaskStore` and `PriceHistoryStore`, each constructed over a drizzle better-sqlite3 handle (`AgentStore` lives in `@adhd/agent-mcp`, not here).

## Database schema

- `agents` — registered agent configs
- `sessions` — conversation instances
- `messages` — chat history (role, content, tool_calls, tool_results)
- `task_events` — MODEL_REQUEST, TOOL_CALL, TASK_COMPLETED events
- `task_usage` — token counts, cost estimates, execution stats
- `model_price_history` — append-only observed prices ($ per million tokens); BEFORE UPDATE/DELETE triggers abort, a correction is a new row
- `price_pull_ledger` — one row per price-pull attempt (`running`, `ok`, `failed`, `rejected_shrink`, `rejected_invalid`)

## Price history

```typescript
import { PriceHistoryStore, createPriceSource } from '@adhd/agent-store-runtime';

const store = new PriceHistoryStore(db);       // db: drizzle better-sqlite3 handle, migrations applied
store.priceAt('deepseek/deepseek-v4.1-flash', '2026-10-09T00:00:00Z'); // price in force at that instant
store.history('deepseek/deepseek-v4.1-flash'); // every observed row, oldest first
store.lastLedger().priceAgeHours;              // hours since the last successful pull (null if none)
const source = createPriceSource(db);          // as-of source accepted by core-provider's estimateCost
```

`applyObservation` appends only rows whose price changed. A move of 20x or more (input or output) or an
input above $1000/M is held unless the model id is passed in `accept`; a 10x to 20x move is applied with a
`warn` anomaly (`ANOMALY_HOLD_FACTOR`, `ANOMALY_WARN_FACTOR`, `ANOMALY_MAX_INPUT_PER_M`). `claimPull` uses
`BEGIN IMMEDIATE`, so several processes on one database file produce one pull. Prices are as observed by the
pulling server, not as effective at the vendor.

## Key files

- `src/db/schema.ts` — Drizzle ORM schema
- migrations (0000–0012) live in `entrypoint/agent-mcp/drizzle/`
- `src/store/` — `SessionStore`, `TaskStore`, `PriceHistoryStore`

## 2.0.2 changes

- **Migration 0008** — adds `peakContextTokens`, `peakContextAt` columns
- **Migration 0009** — restores `sessions.agent_name → agents.name ON DELETE CASCADE` FK

## Architecture

- Part of the 6-package agent framework family
- Depends on: `drizzle-orm`, `better-sqlite3`
- Depended on by: `@adhd/agent-mcp`, `@adhd/agent-engine-orchestrator`

See `/entrypoint/agent-mcp/docs/architecture-and-security.md` for the full agent runtime architecture.
