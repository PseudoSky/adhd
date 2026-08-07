# @adhd/apigen-plugin-api-fastify

**Target plugin** (`--type api-fastify`) — exposes a source file's exports as a **Fastify HTTP API**. Every exported function becomes an HTTP route with inferred JSON Schema for validation. Supports both live (`run`) and code generation (`generate`) modes.

Part of [apigen](../README.md). Driven via [`@adhd/apigen-cli`](../../../entrypoint/apigen-cli/README.md).

---

## How it works

Every exported function becomes an HTTP route:

```ts
// api.ts
export async function getUser(id: string): Promise<{ id: string; name: string }> {
  return { id, name: `User ${id}` };
}

export async function createUser(name: string): Promise<{ id: string }> {
  return { id: Math.random().toString(36).slice(2) };
}
```

Becomes two routes:

| Operation | Route | Method | How to call |
|---|---|---|---|
| Safe (primitives only) | `GET /<namespace>/<fn>?param=val` | GET | Query params |
| Unsafe (complex params) | `POST /<namespace>/<fn>` | POST | `{"data":{…}}` body |

---

## CLI usage

```bash
# Run a live server
npx @adhd/apigen-cli run --source api.ts --type api-fastify --namespace api --opt port=3000

# With OpenAPI doc + health check + logging
npx @adhd/apigen-cli run --source api.ts --type api-fastify --opt port=3000 \
  --use openapi --use health --use logger

# Custom route prefix
npx @adhd/apigen-cli run --source api.ts --type api-fastify --opt routePrefix=/v1

# Generate a deployable project to disk
npx @adhd/apigen-cli generate --source api.ts --type api-fastify --out-dir ./out
```

### Calling the server

```bash
# Safe operation → GET with query params
curl http://localhost:3000/api/getUser?id=abc

# Unsafe operation → POST with body envelope
curl -X POST http://localhost:3000/api/createUser \
  -H 'content-type: application/json' \
  -d '{"data":{"name":"Ada"}}'
# → {"result":{"id":"..."}}
```

---

## Programmatic usage

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';
import { healthPlugin } from '@adhd/apigen-plugin-health';

async function start() {
  const ops = await extract({ sourceFile: './api.ts', namespace: 'api' });
  const generated = {
    metadata: { namespace: 'api', phase: '' },
    schemas: Object.fromEntries(
      ops.filter(o => o.kind === 'action').map(op => [
        op.path[op.path.length - 1].raw,
        { input: op.input, output: op.output, hasCtx: op.hasCtx, 'x-apigen-safe': op.safe },
      ])
    ),
  };
  const schemas = composeSchemas(generated, []);
  const mod = await import('./api.ts');

  const abort = new AbortController();
  process.on('SIGINT', () => abort.abort());

  await apiFastifyPlugin.run({
    packages: [{
      id: 'api',
      schemas,
      importPath: './api.ts',
      fns: mod,
      createClient: async () => ({}),
    }],
    outputDir: '',
    options: {
      port: 3000,
      host: '0.0.0.0',
      routePrefix: '',
      usePlugins: [openapiPlugin, healthPlugin],
      useOptions: {
        openapi: { title: 'User API', version: '1.0.0' },
      },
    },
    signal: abort.signal,
    operations: ops,
  });
}
```

---

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `3000` | Listen port |
| `host` | `string` | `'127.0.0.1'` | Bind address |
| `routePrefix` | `string` | `''` | Path prefix before `/<namespace>/<fn>` |
| `usePlugins` | `Plugin[]` | `[]` | Mount/layer/envelope plugins |
| `useOptions` | `Record<string, Record<string, unknown>>` | `{}` | Per-plugin options, keyed by plugin id |
| `projection` | `ProjectionConfig` | `{}` | HTTP verb and naming overrides |

---

## Route mapping

The Fastify server registers routes following this pattern:

| Source export | Route | Method | Request format |
|---|---|---|---|
| Safe function | `GET /<ns>/<fn>?param=val` | GET | Query string params |
| Unsafe function | `POST /<ns>/<fn>` | POST | `{"data":{…}}` body |
| Mount plugin contribution | `GET /_meta/<name>` | GET | — |

**Safe vs unsafe** is determined automatically:

```ts
// Safe → GET /api/searchUsers?q=ada&limit=10
export async function searchUsers(q: string, limit?: number) { ... }

// Unsafe → POST /api/createUser (body: {"data":{"name":"Ada"}})
export async function createUser(name: string) { ... }
```

See the [Writing Source Files guide](../apigen-core-client/docs/how-to/writing-source-files.md#safe-vs-unsafe--get-vs-post) for details.

---

## Error handling

Errors are returned as JSON with an `ApiError` shape:

```json
// 400 — invalid argument
{"code":"invalid_argument","message":"Expected string, got number"}

// 404 — not found
{"code":"not_found","message":"User not found"}

// 500 — internal error
{"code":"internal","message":"Something went wrong"}
```

---

## Multi-package (multi-namespace)

Pass multiple source files — each becomes a separate route prefix:

```bash
npx @adhd/apigen-cli run --source users.ts --source orders.ts --type api-fastify --opt port=3000
```

```
POST /users/createUser
POST /orders/createOrder
GET  /users/getUser?id=abc
GET  /orders/getOrder?id=xyz
```

---

## Exports

| Export | Kind |
|--------|------|
| `apiFastifyPlugin` | v1 `OutputPlugin` — `generate()` + `run()` |
| `default` | Same as `apiFastifyPlugin` |
| `generate(input)` | Raw generate function |
| `run(input)` | Raw run function |
| `sendStreamSse(…)` | SSE stream utility |

```ts
import { apiFastifyPlugin, run, generate } from '@adhd/apigen-plugin-api-fastify';
```
