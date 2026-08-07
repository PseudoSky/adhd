# @adhd/apigen-plugin-batch

**Batch/bulk operation fan-out plugin for apigen.**

Enable clients to invoke multiple operations of the same kind in a single request with controlled concurrency, error handling, and per-item timeouts.

Part of [apigen](../README.md). For end-to-end usage see [`../cli`](../cli).

## What it does

The batch plugin adds synthetic `_batch/<kind>` mount points to your servers. A single HTTP `POST` or MCP tool invocation can fan out N items across the same operation, with:

- **Per-kind grouping** — `_batch/query` for safe operations, `_batch/action` for mutations
- **Discriminated routing** — clients specify which operation to invoke; the mount routes to it
- **Concurrency control** — parallel execution with bounded concurrency (`concurrency: 2`, `3`, etc.)
- **Partial failure** — by default, failures don't abort the batch; `onItemError: 'abort'` stops on first error
- **Per-item timeouts** — optional `itemTimeoutMs` aborts individual items that exceed the threshold

## Install

```bash
pnpm add @adhd/apigen-plugin-batch
```

## Usage

### Via CLI

```bash
npx @adhd/apigen-cli run --source api.ts --type api-fastify --use batch
```

This mounts:
- `POST /_batch/query` — batch query operations (safe, read-only)
- `POST /_batch/action` — batch mutations (write operations)

### Via library

```ts
import { batchPlugin } from '@adhd/apigen-plugin-batch';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';

await apiFastifyPlugin.run!({
  packages: [{ id: 'api', schemas, importPath: './api.ts', fns: mod }],
  options: {
    port: 3000,
    usePlugins: [batchPlugin],  // Enables _batch/* mounts
  },
  signal: abort.signal,
  operations: ops,
});
```

## Request shape

```json
POST /_batch/action
{
  "operation": "catalog/updateItem",
  "items": [
    { "id": "a", "name": "Updated A" },
    { "id": "b", "name": "Updated B" },
    { "id": "c", "name": "Updated C" }
  ],
  "concurrency": 2,
  "onItemError": "continue",
  "itemTimeoutMs": 5000
}
```

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `operation` | string | required | Which operation to fan out to (e.g. `catalog/updateItem`) |
| `items` | array | required | Array of item inputs; each is `operation.input.items[0]` schema |
| `concurrency` | number | 4 | Max parallel executions (clamped to max 32) |
| `onItemError` | `'continue' \| 'abort'` | `'continue'` | Stop batch on first error or continue? |
| `mode` | `'parallel' \| 'serial' \| 'chained'` | `'parallel'` | Execution strategy (reserved for future) |
| `itemTimeoutMs` | number | — | Abort item if it exceeds this duration |

## Response shape

```json
[
  { "index": 0, "status": "fulfilled", "value": { "id": "a", "name": "Updated A" } },
  { "index": 1, "status": "fulfilled", "value": { "id": "b", "name": "Updated B" } },
  { "index": 2, "status": "rejected", "reason": "Not found", "chunksDelivered": 0 }
]
```

Each result is either:
- **`fulfilled`** — `{ index, status: 'fulfilled', value: <operation output> }` or (for streaming ops) `{ index, status: 'fulfilled', chunks: [...] }`
- **`rejected`** — `{ index, status: 'rejected', reason: <error>, chunksDelivered: <N> }`

## Configuration

Exclude specific operations from batching via the plugin's `exclude` option:

```bash
npx @adhd/apigen-cli run --source api.ts --type api-fastify --use batch --opt batch.exclude=catalog/dangerousOp
```

Or in library code:

```ts
batchPlugin({
  exclude: ['catalog/deleteUser', 'billing/chargeCard']
})
```

## Develop

```bash
npx nx build apigen-plugin-batch
npx nx test apigen-plugin-batch
```

See the [integration test](./src/test/plugin.spec.ts) for real usage examples.

## Architecture

The batch plugin is the **host-facing half** of the batch feature (SPEC §5, BATCH_0.0.1.md). It:

1. Receives `_batch/<kind>` requests from clients
2. Parses the operation discriminator to route to the real operation
3. Wires `invokeBatch` (from `@adhd/apigen-engine-runtime`) to fan out N items with controlled concurrency
4. Collects results and returns the `BatchItemResult[]` array

The schema derivation (how `_batch/<kind>` schemas are built from `Operation[]`) is **host-agnostic** and lives in `@adhd/apigen-core-client/src/lib/batch.ts`:
- `groupBatchableOperationsByKind()` — group by operation kind
- `buildBatchKindSchema()` — build discriminated-union input schema
- `buildBatchMountedOperations()` — emit one synthetic mount per kind

See the [batch spec](../../docs/spec/apigen/BATCH_0.0.1.md) for the full design.
