# @adhd/apigen-plugin-openapi

**Mount plugin** — serves a **live OpenAPI 3.1 document** at `GET /_meta/openapi`. The document is derived from the extracted operations at request time, so it always reflects the current service definition.

Part of [apigen](../README.md). Driven via [`@adhd/apigen-cli`](../../../entrypoint/apigen-cli/README.md).

---

## What it does

When loaded via `--use` on any HTTP target plugin (`api-fastify`, `api-express`), the openapi plugin contributes a synthetic `_meta/openapi` operation. Hitting `GET /_meta/openapi` returns a full OpenAPI 3.1 spec derived from your operations at request time — every endpoint, parameter type, and response shape, all inferred from your TypeScript types.

**No code generation, no build step.** The spec is always current with your running service.

```bash
curl http://localhost:3000/_meta/openapi
# → {
#   "openapi": "3.1.0",
#   "info": { "title": "My API", "version": "1.0.0" },
#   "paths": {
#     "/api/getUser": {
#       "get": {
#         "parameters": [{ "name": "id", "in": "query", "schema": { "type": "string" } }],
#         "responses": { "200": { "description": "success" } }
#       }
#     }
#   }
# }
```

---

## CLI usage

```bash
# Fastify with OpenAPI doc
npx @adhd/apigen-cli run --source api.ts --type api-fastify --opt port=3000 --use openapi

# With custom title and version
npx @adhd/apigen-cli run --source api.ts --type api-fastify --use openapi \
  --opt 'useOptions={"openapi":{"title":"User API","version":"2.0.0"}}'

# Combined with other plugins
npx @adhd/apigen-cli run --source api.ts --type api-fastify --use openapi --use health --use logger
```

---

## Programmatic usage

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';

const ops = await extract({ sourceFile: './api.ts', namespace: 'api' });
const schemas = composeSchemas(
  {
    metadata: { namespace: 'api', phase: '' },
    schemas: Object.fromEntries(
      ops.filter(o => o.kind === 'action').map(op => [
        op.path[op.path.length - 1].raw,
        { input: op.input, output: op.output, hasCtx: op.hasCtx, 'x-apigen-safe': op.safe },
      ])
    ),
  },
  []
);
const mod = await import('./api.ts');

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());

await apiFastifyPlugin.run({
  packages: [{ id: 'api', schemas, importPath: './api.ts', fns: mod, createClient: async () => ({}) }],
  outputDir: '',
  options: {
    port: 3000,
    usePlugins: [
      openapiPlugin,  // ← mounts GET /_meta/openapi
    ],
    // Custom title and version:
    // useOptions: { openapi: { title: 'User API', version: '2.0.0' } },
  },
  signal: abort.signal,
  operations: ops,
});
```

---

## Options

```ts
import { type OpenapiOptions } from '@adhd/apigen-plugin-openapi';
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | `string` | `'API'` | `info.title` in the generated OpenAPI document |
| `version` | `string` | `'0.0.0'` | `info.version` in the generated OpenAPI document |

---

## What gets documented

Every operation extracted from your source file appears in the `paths` section:

- **Safe operations** (`x-apigen-safe: true`) → listed as `GET` with query parameters
- **Unsafe operations** → listed as `POST` with `requestBody`

Rich types (Date, Decimal, bigint, UUID) use their canonical JSON Schema representations with `x-apigen-*` hints so codegen tools can reconstruct the correct types.

---

## How it works

The openapi plugin implements the **mount capability** (SPEC §7.2b). At compose time, it registers a synthetic `_meta/openapi` operation. At request time, the handler calls `toOpenApi()` from `@adhd/apigen-codegen-openapi` with the full `Operation[]` descriptor — the same one used to serve requests — and returns the live document. No caching, no staleness.

This is the same function you can use independently:

```ts
import { toOpenApi } from '@adhd/apigen-codegen-openapi';
import type { Operation } from '@adhd/apigen-core-client';

const doc = toOpenApi(operations, { title: 'My API', version: '1.0.0' });
// doc satisfies the OpenAPI 3.1 schema
```

---

## Exports

| Export | Kind |
|--------|------|
| `openapiPlugin` | v2 `Plugin<OpenapiOptions>` — mount capability only |
| `OpenapiOptions` | TypeScript interface |

```ts
import { openapiPlugin, type OpenapiOptions } from '@adhd/apigen-plugin-openapi';
```
