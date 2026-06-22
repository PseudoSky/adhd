# @adhd/apigen-runtime

The apigen **dispatch runtime** — the single canonical call path every plugin and every
generated server uses to turn an inbound request into a function call. Pure TypeScript,
**platform: shared**.

Part of [apigen](../README.md). For end-to-end usage see [`../cli`](../cli).

## Public API

```ts
import {
  dispatch, buildFnTable, describeParams,
  needsEnvelopeField, dataParamNames,
  createLogger, defineMiddleware, createApiPackage,
  EventBus, wireObservers, buildContext,
} from '@adhd/apigen-runtime'
import type { Logger, LogFormat, CreateLoggerOptions, ParamInfo, AnyFn } from '@adhd/apigen-runtime'
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
- **`defineMiddleware` / `createApiPackage` / `EventBus` / `wireObservers` / `buildContext`**
  — middleware + observer wiring.

## Request envelope

Inbound payloads are wrapped: `{ "data": { ...params }, ...envelope }`. `dispatch` validates
the envelope fields a function requires (e.g. a `session` added by middleware) and passes
`data` to the function.

## Develop

```bash
npx nx build apigen-runtime
npx nx test  apigen-runtime
```
