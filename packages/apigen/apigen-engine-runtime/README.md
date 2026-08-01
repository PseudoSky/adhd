# @adhd/apigen-engine-runtime

The apigen **dispatch runtime** — the single canonical call path every plugin and every
generated server uses to turn an inbound request into a function call. Pure TypeScript,
**platform: shared**.

Part of [apigen](../README.md). For end-to-end usage see [`../cli`](../cli).

## Public API

```ts
import { dispatch, buildFnTable, describeParams, needsEnvelopeField, dataParamNames, createLogger, defineMiddleware, createApiPackage, EventBus, wireObservers, buildContext, invokeBatch } from '@adhd/apigen-engine-runtime';
import type { Logger, LogFormat, CreateLoggerOptions, ParamInfo, AnyFn, BatchOptions, BatchItemResult } from '@adhd/apigen-engine-runtime';
```

- **`dispatch(fns, ctx, schema, fnName, envelope, data)`** — the one dispatch path. No plugin
  inlines this; all import it here.
- **`buildFnTable(mod)`** — normalize an imported module into a callable table, recursively
  unwrapping `default` / CommonJS `module.exports` layers and keying functions by their
  `.name` so default- and CJS-wrapped exports resolve (closes ledger finding F28).
- **`describeParams(schema)` → `ParamInfo[]`** — extract the parameter list for route/tool
  logging and CLI flag generation.
- **`needsEnvelopeField` / `dataParamNames`** — envelope + param helpers (single source).
- **`createLogger({ level, format, destination })`** — pino-based logger; defaults to
  **stderr** so MCP stdio stdout stays protocol-clean. `format: 'json' | 'pretty'`.
- **`invokeBatch(invoke, operationId, items, opts, batchOpts)`** — fan out N calls through
  the real `invoke` path (via `createInvoker`'s composed Layer stack) with controlled
  concurrency, error handling, and per-item timeouts. Returns `Promise<BatchItemResult[]>`.
  See `@adhd/apigen-plugin-batch` for mount wiring.
- **`defineMiddleware` / `createApiPackage` / `EventBus` / `wireObservers` / `buildContext`**
  — middleware + observer wiring.
- **`buildToolDescription(schema, ...)`** — builds the human-facing description shown for a
  mounted tool/operation, appending a schema-synthesized worked example (via
  `@adhd/apigen-base-logical`'s `renderExampleNote`) after the envelope-convention note. The
  same function backs both `apigen-plugin-cli-output`'s static codegen and
  `apigen-plugin-mcp`'s dynamic server, so every apigen-mounted tool's description carries a
  concrete example of its own real shape, not just a generic convention sentence.

## Validation error messages include a worked example

The validate-Layer's AJV validation-failure errors append the same schema-synthesized
example described above (`invalid_argument`, `Validation failed: ... — Example: {...}`) —
so a rejected call comes back with both what was structurally wrong and a shape that would
actually pass. This closes a real discoverability gap: previously an error only named the
missing/invalid property, never what a correct call looked like.

## Request envelope

Inbound payloads are wrapped: `{ "data": { ...params }, ...envelope }`. `dispatch` validates
the envelope fields a function requires (e.g. a `session` added by middleware) and passes
`data` to the function.

## Develop

```bash
npx nx build apigen-engine-runtime
npx nx test  apigen-engine-runtime
```
