# Running Servers Programmatically

How to start MCP, Fastify HTTP, and Express HTTP servers from your own Node.js process using apigen's library packages — no CLI, no code generation.

This guide assumes you've already read the [extraction pipeline guide](./extraction-pipeline.md) and understand `extract()` → `composeSchemas()`. Here we take those schemas and turn them into running servers.

---

## The pattern (applies to every plugin)

Every plugin with `run()` follows the same sequence:

```
extract(source) → composeSchemas(gen) → import(source) → plugin.run({ packages: [{ schemas, fns }], signal })
```

1. **Extract** operations from your TypeScript source
2. **Build** generated schemas from the operation descriptors
3. **Compose** schemas with middleware envelope fields (or empty array for none)
4. **Import** the source module to get live function references
5. **Call** `plugin.run()` with the packages array, options, and an `AbortSignal`

The `run()` method starts the server and returns a `Promise<void>` that resolves when the signal fires. Your function exports become API routes or MCP tools — zero annotations, zero framework imports in your source.

---

## Prerequisites

```bash
npm install @adhd/apigen-core-client
npm install @adhd/apigen-plugin-mcp          # for MCP server
npm install @adhd/apigen-plugin-api-fastify   # for Fastify HTTP server
npm install @adhd/apigen-plugin-api-express   # for Express HTTP server
npm install @adhd/apigen-plugin-openapi       # for OpenAPI doc endpoint
npm install @adhd/apigen-plugin-health        # for health check endpoint
npm install @adhd/apigen-plugin-logger        # for per-operation logging
```

All packages are published to npm with `access: public`.

---

## 1. MCP Server (stdio transport)

Your source file (`services/tools.ts`):

```ts
// No framework imports, no decorators, no annotations
export async function greet(name: string): Promise<string> {
  return `hello, ${name}!`;
}

export async function add(a: number, b: number): Promise<number> {
  return a + b;
}
```

Your server bootstrap (`start-mcp.ts`):

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';

async function main() {
  const sourceFile = new URL('./services/tools.ts', import.meta.url).pathname;

  // 1. Extract operations from source
  const ops = await extract({ sourceFile, namespace: 'tools' });

  // 2. Build generated schemas from operations
  const generated = {
    metadata: { namespace: 'tools', phase: '' },
    schemas: Object.fromEntries(
      ops.filter(o => o.kind === 'action').map(op => [
        op.path[op.path.length - 1].raw,
        {
          input: op.input,
          output: op.output,
          hasCtx: op.hasCtx,
          'x-apigen-safe': op.safe,
        },
      ])
    ),
  };

  // 3. Compose schemas (no middleware for this example)
  const schemas = composeSchemas(generated, []);

  // 4. Import source for live function references
  const mod = await import(sourceFile);

  // 5. Start the MCP server on stdio (default transport)
  const abort = new AbortController();
  process.on('SIGINT', () => abort.abort());
  process.on('SIGTERM', () => abort.abort());

  await mcpPlugin.run!({
    packages: [{
      id: 'tools',
      schemas,
      importPath: sourceFile,
      fns: mod,
      createClient: async () => ({}),
    }],
    outputDir: '',
    options: {}, // defaults: transport=stdio
    signal: abort.signal,
    operations: ops,
  });
}

main().catch(console.error);
```

Run it:

```bash
npx tsx start-mcp.ts
```

The MCP server speaks JSON-RPC over stdio — connect it to Claude Desktop, Cursor, or any MCP host that supports stdio-based tools.

**CLI equivalent:** `apigen run --source services/tools.ts --type mcp`

---

## 2. MCP Server (SSE transport — HTTP accessible)

Change the `options` to switch transport:

```ts
await mcpPlugin.run!({
  packages: [/* same as above */],
  outputDir: '',
  options: {
    transport: 'sse',  // ← HTTP-based SSE
    port: 3100,
    host: '0.0.0.0',
  },
  signal: abort.signal,
  operations: ops,
});
```

Connect at `http://localhost:3100/sse`, send messages to `POST /messages?sessionId=...`.

**CLI equivalent:** `apigen run --source services/tools.ts --type mcp --opt transport=sse --opt port=3100`

---

## 3. Fastify HTTP Server with OpenAPI + Health

Your source file (`services/api.ts`):

```ts
export async function getUser(id: string): Promise<{ id: string; name: string }> {
  return { id, name: `User ${id}` };
}

export async function createUser(name: string): Promise<{ id: string }> {
  return { id: Math.random().toString(36).slice(2) };
}
```

Your server bootstrap (`start-fastify.ts`):

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';
import { healthPlugin } from '@adhd/apigen-plugin-health';
import { loggerPlugin } from '@adhd/apigen-plugin-logger';

async function main() {
  const sourceFile = new URL('./services/api.ts', import.meta.url).pathname;
  const ops = await extract({ sourceFile, namespace: 'api' });

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
  const mod = await import(sourceFile);

  const abort = new AbortController();
  process.on('SIGINT', () => abort.abort());

  await apiFastifyPlugin.run!({
    packages: [{
      id: 'api',
      schemas,
      importPath: sourceFile,
      fns: mod,
      createClient: async () => ({}),
    }],
    outputDir: '',
    options: {
      port: 3200,
      host: '0.0.0.0',
      // Mount plugins contribute routes and middleware:
      usePlugins: [openapiPlugin, healthPlugin, loggerPlugin],
      // Plugin-specific options:
      useOptions: {
        openapi: { title: 'My API', version: '1.0.0' },
      },
    },
    signal: abort.signal,
    operations: ops,
  });
}

main().catch(console.error);
```

After startup:

| Route | Method | Source |
|-------|--------|--------|
| `GET /api/getUser?id=abc` | GET | Safe operation → query params |
| `POST /api/createUser` | POST | Unsafe operation → `{"data":{"name":"..."}}` body |
| `GET /_meta/health` | GET | Contributed by `healthPlugin` |
| `GET /_meta/openapi` | GET | Contributed by `openapiPlugin` — live OpenAPI 3.1 spec |

The OpenAPI spec is generated at **request time** from the current operation descriptors. Hit `GET /_meta/openapi` to see what your API looks like to a tool like Swagger UI or `openapi-generator`.

**CLI equivalent:** `apigen run --source services/api.ts --type api-fastify --opt port=3200 --use openapi --use health --use logger`

---

## 4. Both servers, one source

Run MCP and Fastify from the same TypeScript file:

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';

async function main() {
  const sourceFile = new URL('./services/api.ts', import.meta.url).pathname;
  const ops = await extract({ sourceFile, namespace: 'svc' });
  const generated = {
    metadata: { namespace: 'svc', phase: '' },
    schemas: Object.fromEntries(
      ops.filter(o => o.kind === 'action').map(op => [
        op.path[op.path.length - 1].raw,
        { input: op.input, output: op.output, hasCtx: op.hasCtx, 'x-apigen-safe': op.safe },
      ])
    ),
  };
  const schemas = composeSchemas(generated, []);
  const mod = await import(sourceFile);
  const pkg = [{
    id: 'svc',
    schemas,
    importPath: sourceFile,
    fns: mod,
    createClient: async () => ({}),
  }];

  const abort = new AbortController();
  process.on('SIGINT', () => abort.abort());

  await Promise.all([
    mcpPlugin.run!({
      packages: pkg, outputDir: '',
      options: { transport: 'sse', port: 3100 },
      signal: abort.signal, operations: ops,
    }),
    apiFastifyPlugin.run!({
      packages: pkg, outputDir: '',
      options: { port: 3200, usePlugins: [openapiPlugin] },
      signal: abort.signal, operations: ops,
    }),
  ]);
}
```

Both servers share the same module import — your functions are compiled once and dispatched by two transport layers.

---

## 5. Express HTTP alternative

The Express plugin follows the exact same `run()` contract:

```ts
import { apiExpressPlugin } from '@adhd/apigen-plugin-api-express';

// Same extract → compose → import flow as Fastify
await apiExpressPlugin.run!({
  packages: [{ /* id, schemas, importPath, fns, createClient */ }],
  outputDir: '',
  options: {
    port: 3300,
    host: '0.0.0.0',
    routePrefix: '',
    usePlugins: [healthPlugin, loggerPlugin],
  },
  signal: abort.signal,
  operations: ops,
});
```

Express routes are registered as `GET /<ns>/<fn>` and `POST /<ns>/<fn>` following the same safe/unsafe verb derivation.

---

## 6. Deployer integration

Wrap the pattern in a reusable function that fits your deployment lifecycle:

```ts
import { extract, composeSchemas, type OutputPlugin, type RunInput } from '@adhd/apigen-core-client';

export interface ServiceConfig {
  sourceFile: string;
  namespace?: string;
  plugin: OutputPlugin;
  options: Record<string, unknown>;
}

export async function createService(config: ServiceConfig) {
  const ns = config.namespace ?? 'svc';
  const ops = await extract({ sourceFile: config.sourceFile, namespace: ns });

  const generated = {
    metadata: { namespace: ns, phase: '' },
    schemas: Object.fromEntries(
      ops.filter(o => o.kind === 'action').map(op => [
        op.path[op.path.length - 1].raw,
        { input: op.input, output: op.output, hasCtx: op.hasCtx, 'x-apigen-safe': op.safe },
      ])
    ),
  };
  const schemas = composeSchemas(generated, []);
  const mod = await import(config.sourceFile);
  const pkg = [{
    id: ns,
    schemas,
    importPath: config.sourceFile,
    fns: mod,
    createClient: async () => ({}),
  }];

  const abort = new AbortController();
  // Your deployer hook: register with service mesh, health check, etc.

  const running = config.plugin.run!({
    packages: pkg,
    outputDir: '',
    options: config.options,
    signal: abort.signal,
    operations: ops,
  });

  return {
    abort,       // call abort.abort() to stop
    running,     // Promise<void> that resolves on graceful shutdown
    operations: ops,
  };
}

// Usage:
// const svc = await createService({
//   sourceFile: './api.ts',
//   plugin: apiFastifyPlugin,
//   options: { port: 3200, usePlugins: [healthPlugin] },
// });
// // ... later:
// svc.abort.abort();
// await svc.running;
```

---

## Options reference

| Key | Plugin(s) | Type | Default | Description |
|-----|-----------|------|---------|-------------|
| `transport` | `mcp` | `'stdio' \| 'sse' \| 'streaming-http'` | `'stdio'` | MCP transport |
| `port` | `mcp` (HTTP), `api-fastify`, `api-express` | `number` | `3000` | Listen port |
| `host` | All | `string` | `'127.0.0.1'` | Bind address |
| `routePrefix` | `api-fastify`, `api-express` | `string` | `''` | Path prefix before `/<ns>/<fn>` |
| `usePlugins` | All `run()` targets | `Plugin[]` | `[]` | Layer/mount/envelope plugins |
| `useOptions` | All `run()` targets | `Record<string, Record<string, unknown>>` | `{}` | Per-plugin options, keyed by plugin id |
| `toolDescriptions` | `mcp` | `Record<string, string>` | `{}` | Per-tool description overrides |

---

## See also

- [Extraction Pipeline](./extraction-pipeline.md) — the first half of the pattern
- [Building Plugins](./building-plugins.md) — create your own `OutputPlugin` with `run()`
- [Plugin reference](../reference/plugin.md) — full type signatures for `RunInput`, `OutputPlugin`
- [@adhd/apigen-cli README](../../../../entrypoint/apigen-cli/README.md) — CLI equivalent commands
- [apigen spec](../../../../docs/apigen/SPEC.md) — full architecture
