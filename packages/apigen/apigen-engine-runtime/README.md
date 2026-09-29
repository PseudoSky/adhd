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

## Validation error messages are actionable

The validate-Layer's AJV validation-failure errors (`invalid_argument`) are built so a
caller — including an LLM — can correct the call in one round-trip:

- **`additionalProperties`** names the offending key, lists the keys that *would* have been
  accepted, and adds a nearest-key "did you mean" hint — e.g.
  `unknown key 'agge' at data; allowed keys: name, age (did you mean 'age'?)`.
- **`required`** names the missing key and the accepted set.
- **`enum`** echoes the rejected value and lists the allowed values.

This closes the discoverability gap where AJV's raw message was the bare
"must NOT have additional properties" — which named neither the offending key nor the
accepted set, so a caller could only guess again. Violations are listed one per line and
capped (with an `…and N more` tail) rather than concatenated into an unreadable run.

The message still appends the schema-synthesized worked example described above,
**except** when that example would synthesize to nested empty objects (an all-optional
input, e.g. `{"data":{"input":{}}}`) — then it is dropped rather than shown, because it
reads as "pass an empty object" and teaches nothing.

> Requires AJV `verbose: true`: the formatter reads `parentSchema` (the accepted-key set)
> and `data` (the rejected value) off each `ErrorObject`, neither of which is present on
> AJV's default error shape.

## Request envelope

Inbound payloads are wrapped: `{ "data": { ...params }, ...envelope }`. `dispatch` validates
the envelope fields a function requires (e.g. a `session` added by middleware) and passes
`data` to the function.

## Develop

```bash
npx nx build apigen-engine-runtime
npx nx test  apigen-engine-runtime
```

`nx test` runs only the cheap in-process `*.spec.ts` lane (and is what
`nx affected -t test` / the git hooks run). The resource-consuming self-tests
(real `git` subprocesses, a real `node:http` server) live in sibling
`*.e2e.ts` files and run on demand only:

```bash
npx nx run apigen-engine-runtime:e2e
```

Both `.e2e.ts` suites are currently `describe.skip`'d (CPU-THRASH-SKIP,
owner-requested); `*.spec.ts` stubs at the original paths hold their mocked
`it.todo` inventory.
