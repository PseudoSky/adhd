# schemas

Schema generation and composition — the v1 extraction pipeline for producing JSON Schemas from TypeScript source.

## Exports

### `generateSchemas(opts: GenerateSchemasOptions): Promise<GeneratedSchemas>`

Reads a TypeScript source file and returns `GeneratedSchemas` — per-export input/output JSON Schemas (domain only, no middleware envelope).

Supports three mutually exclusive extraction modes via `exportMode`:
- **`named`** (default) — one entry per exported function
- **`default`** — treat the default export as the sole function
- **`named-object`** — extract from `export const api = { … }` by name

A first parameter named `ctx` is excluded from the schema by name match only (`ctx-name-only` invariant) and recorded via `hasCtx: true` so dispatch can re-inject it as the first argument.

`Promise<T>` return types are unwrapped to `T` for the output schema.

When `opts.session` is supplied, the ts-morph Project, built generators, and computed schemas are shared with other extraction calls in the same run — turning the orchestrator's double pass into cache hits.

```ts
import { generateSchemas } from '@adhd/apigen-core-client';

const gen = await generateSchemas({
  sourceFile: '/absolute/path/to/api.ts',
  exportMode: { type: 'named' },    // default
  namespace: 'myapi',               // informational, written to metadata
  phase: '',                        // informational
  tsconfig: '/path/to/tsconfig.json',
  session: mySession,               // optional — share cache
});
```

### `GenerateSchemasOptions`

```ts
interface GenerateSchemasOptions {
  sourceFile: string;           // absolute path to .ts source
  exportMode?: ExportMode;      // default: { type: 'named' }
  namespace?: string;           // informational, written to metadata
  phase?: string;               // informational, written to metadata
  tsconfig?: string;            // absolute tsconfig path for type resolution
  session?: ExtractionSession;  // optional per-run shared cache
}
```

### `ExportMode`

```ts
type ExportMode =
  | { type: 'named' }
  | { type: 'default' }
  | { type: 'named-object'; name: string };
```

### `GeneratedSchemas`

```ts
interface GeneratedSchemas {
  metadata: { namespace: string; phase: string };
  schemas: Record<string, {
    input: Record<string, unknown>;   // JSON Schema
    output: Record<string, unknown>;  // JSON Schema
    hasCtx?: boolean;  // true when source fn's first param is named 'ctx'
  }>;
}
```

### `composeSchemas(domainSchemas, middlewares, overrides?): ComposedSchemas`

Merges domain schemas (from `generateSchemas`) with middleware envelope fields into `ComposedSchemas`.

The `middlewares` array takes objects of shape `{ id: string; envelope?: Record<string, unknown> }` — plain objects matching the `SlimMiddleware` interface in source (not exported; inline objects suffice for callers).

Invariants:
- **`data: {}` wrapper always present** — even for zero-parameter functions (`data-wrapper-always-present`).
- **`false` suppresses a middleware** — per-function overrides: `{ fnName: { middlewareId: false } }`. `null`/`undefined`/`0`/`''` do NOT suppress (`false-suppresses-middleware`).
- **`hasCtx` carried through** — from `GeneratedSchemas` to `ComposedSchemas`.

```ts
import { composeSchemas } from '@adhd/apigen-core-client';

const domain = {
  metadata: { namespace: 'demo', phase: '' },
  schemas: {
    getUser: {
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      output: { type: 'object', properties: { name: { type: 'string' } } }
    },
    ping: {
      input: { type: 'object', properties: {} },
      output: { type: 'string' }
    }
  }
};

const composed = composeSchemas(domain, [
  { id: 'auth',  envelope: { session: { type: 'string' } } },
  { id: 'log',   envelope: { requestId: { type: 'string' } } },
], {
  ping: { log: false },  // suppress log middleware for ping only
});

// composed.getUser.input.required → ['session', 'requestId', 'data']
// composed.ping.input.required    → ['session', 'data']         (log suppressed)
// composed.ping.input.properties.data.properties → {}           (zero-param → empty wrapper)
```

### `ComposedSchemas`

```ts
type ComposedSchemas = Record<string, {
  input: Record<string, unknown>;   // includes envelope fields + data wrapper
  output: Record<string, unknown>;
  hasCtx?: boolean;
}>;
```

## See Also

- [`extract`](./extract.md#extract) — v2 symbol-based extraction (produces `Operation[]`)
- [`composeSchemas` specification](../how-to/extraction-pipeline.md) — end-to-end walkthrough
