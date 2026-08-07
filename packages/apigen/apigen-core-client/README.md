# @adhd/apigen-core-client

> The core apigen engine — TypeScript source → JSON Schema extraction, composition, the plugin contract, and the programmatic API for running live servers without code generation.

`@adhd/apigen-core-client` reads TypeScript source files, derives JSON Schemas for each exported function's parameters and return type, composes them with middleware-contributed envelope fields, and provides the `OutputPlugin` contract that every plugin implements. It's the library you import when you want to **use apigen programmatically** — start MCP servers, Fastify HTTP services, or CLI tools directly from your Node.js code, without the CLI.

Part of [apigen](../README.md). See the [apigen spec](../../../docs/apigen/SPEC.md) for the full architecture.

---

## Two paths: CLI or library

apigen serves two audiences through the same engine. Which one are you?

| You want to… | Use the CLI | Use this library |
|---|---|---|
| Start a server with one command, no code | `npx @adhd/apigen-cli run --source ./api.ts --type mcp --opt transport=sse` | — |
| Generate a deployable project to disk | `npx @adhd/apigen-cli generate --source ./api.ts --type api-fastify --out-dir ./out` | — |
| Embed a live server in your own Node.js process | — | `mcpPlugin.run({…})` from `@adhd/apigen-plugin-mcp` |
| Build a custom deploy pipeline with lifecycles | — | `extract()` → `composeSchemas()` → `plugin.run({ signal })` |
| Create a custom output plugin | Combined CLI + library | `OutputPlugin` / `Plugin` interface |
| Serve a multi-language polyglot front | `npx @adhd/apigen-cli serve --source ./api.ts --source ./api.py --port 8080` | — (this is a CLI-only orchestration) |

**The CLI is a thin wrapper** — every `apigen run --source ./api.ts --type mcp` call internally does exactly what you'd write in five lines of library code:

| CLI command | Library equivalent |
|---|---|
| `apigen run --source ./api.ts --type mcp` | `mcpPlugin.run({ packages: [{ id, schemas, importPath: './api.ts', fns: mod }] })` |
| `apigen run --source ./api.ts --type api-fastify --use health --use logger` | `apiFastifyPlugin.run({ packages: [...], options: { usePlugins: [healthPlugin, loggerPlugin] } })` |
| `apigen run --source ./api.ts --type mcp --opt transport=sse --opt port=3100` | `mcpPlugin.run({ packages: [...], options: { transport: 'sse', port: 3100 } })` |
| `apigen generate --source ./api.ts --type jsonschema --out-dir ./schema` | `jsonschemaPlugin.generate({ packages: [...], outputDir: './schema' })` |

**The rest of this document focuses on the library path.** See the [CLI README](../../../entrypoint/apigen-cli/README.md) for CLI usage, or the [How-To: Running Servers](./docs/how-to/running-servers.md) for a step-by-step walkthrough.

---

## Install

```bash
npm install @adhd/apigen-core-client
# Plus the plugins you want to run:
npm install @adhd/apigen-plugin-mcp @adhd/apigen-plugin-api-fastify @adhd/apigen-plugin-openapi
```

All packages are published to npm with `access: public`.

## Quickstart

Extract canonical operation descriptors from a TypeScript file, then compose them with middleware envelope fields:

```ts
import { extract, composeSchemas, generateSchemas } from '@adhd/apigen-core-client';

// v2 extraction — walk a source file and produce Operation[] descriptors
const ops = await extract({ sourceFile: './src/api.ts' });
// ops[0].id === 'api/getUser'
// ops[0].kind === 'action'
// ops[0].input  === { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }

// v1 schema extraction — JSON Schema per exported function
const gen = await generateSchemas({ sourceFile: './src/api.ts' });

// Compose with middleware envelope fields
const composed = composeSchemas(gen, [
  { id: 'auth', envelope: { session: { type: 'string' } } }
]);
// composed.getUser.input.properties.data.properties.id.type === 'string'
// composed.getUser.input.properties.session.type === 'string'
```

Real output from `composeSchemas` with an auth middleware — the `data` wrapper is always present, even for zero-param functions:

```ts
import { composeSchemas } from '@adhd/apigen-core-client';

const composed = composeSchemas(
  {
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
  },
  [{ id: 'auth', envelope: { session: { type: 'string' } } }]
);
```

```
// => composed.getUser.input.properties.data.properties.id.type === 'string'
// => composed.getUser.input.properties.session.type === 'string'
// => composed.ping.input.properties.data.properties is {}  (zero-param → empty data wrapper)
// => composed.ping.input.required === ['session', 'data']   (data always required)
```

Source-language routing identifies file languages for polyglot pipelines:

```ts
import { tokenize, languageOfSource, sourcesForPlugin } from '@adhd/apigen-core-client';

tokenize('humanizeBytes');    // => ['humanize', 'bytes']
tokenize('SOME_CONST');       // => ['some', 'const']

languageOfSource('src/api.ts');   // => 'ts'
languageOfSource('src/api.py');   // => 'py'
languageOfSource('README.md');    // => undefined

sourcesForPlugin({ language: 'ts' }, ['src/api.ts', 'src/api.py', 'README.md']);
// => ['src/api.ts']
```

---

## Run Servers Programmatically

The core use case for the library path: **extract operations from your TypeScript source, then start a live server — no code generation, no CLI.**

Every plugin with a `run()` method receives a `RunInput` with three things: the composed schemas (for routing and validation), the live function references (your actual module imports), and an `AbortSignal` for graceful shutdown. The `run()` starts the server and returns a `Promise<void>` that resolves when the signal fires.

### Start an MCP server (SSE transport)

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';

// A function — no framework imports, no decorators, no annotations
// (this lives in, say, services/api.ts)
export async function greet(name: string): Promise<string> {
  return `hello, ${name}!`;
}
```

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';

async function startMcp(sourceFile: string) {
  // 1. Extract operations from your TypeScript source
  const ops = await extract({ sourceFile, namespace: 'demo' });

  // 2. Build generated schemas (one per exported function)
  const generated = {
    metadata: { namespace: 'demo', phase: '' },
    schemas: Object.fromEntries(
      ops.filter(o => o.kind === 'action').map(op => [
        op.path[op.path.length - 1].raw,
        { input: op.input, output: op.output, hasCtx: op.hasCtx, 'x-apigen-safe': op.safe },
      ])
    ),
  };

  // 3. Compose with middleware envelope (empty for this example)
  const schemas = composeSchemas(generated, []);

  // 4. Import the source to get live function references
  const mod = await import(sourceFile);

  // 5. Start the MCP server — no codegen, live dispatch
  const abort = new AbortController();
  process.on('SIGINT', () => abort.abort());

  await mcpPlugin.run!({
    packages: [{
      id: 'demo',
      schemas,
      importPath: sourceFile,
      fns: mod,           // your actual exported functions
      createClient: async () => ({}),
    }],
    outputDir: '',
    options: {
      transport: 'sse',   // stdio | sse | streaming-http
      port: 3100,
      host: '0.0.0.0',
      // Override tool descriptions per function (optional):
      // toolDescriptions: { greet: 'Say hello to a user' },
    },
    signal: abort.signal,
    operations: ops,      // needed for --use mount plugins
  });
}
```

The MCP server is now live at `http://localhost:3100/sse` with `POST /messages?sessionId=...`. Every exported function in your source is an MCP tool — callable from Claude Desktop, Cursor, or any MCP host. **Equivalent CLI command:** `apigen run --source <file> --type mcp --opt transport=sse --opt port=3100`

### Start a Fastify HTTP server (with OpenAPI docs)

Add the OpenAPI plugin as a `--use` mount plugin — it contributes a `GET /_meta/openapi` endpoint that serves a live OpenAPI 3.1 document derived from your operations at request time.

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';
import { healthPlugin } from '@adhd/apigen-plugin-health';
import { loggerPlugin } from '@adhd/apigen-plugin-logger';

async function startFastify(sourceFile: string) {
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
      routePrefix: '',
      // Mount plugins contributed as HTTP routes:
      usePlugins: [openapiPlugin, healthPlugin, loggerPlugin],
      // Per-plugin options:
      // useOptions: { openapi: { title: 'My API', version: '1.0.0' } },
    },
    signal: abort.signal,
    operations: ops,
  });
}
```

After startup:
- `GET /api/greet?name=ada` — safe operations are GET (query params)
- `POST /api/greet` — unsafe operations use `{"data":{…}}` body
- `GET /_meta/health` — contributed by `healthPlugin`
- `GET /_meta/openapi` — contributed by `openapiPlugin`, serves a live OpenAPI 3.1 spec

**Equivalent CLI command:** `apigen run --source <file> --type api-fastify --opt port=3200 --use openapi --use health --use logger`

### Run both servers side by side

```ts
async function startAll(sourceFile: string) {
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
    mcpPlugin.run!({ packages: pkg, outputDir: '', options: { transport: 'sse', port: 3100 }, signal: abort.signal, operations: ops }),
    apiFastifyPlugin.run!({ packages: pkg, outputDir: '', options: { port: 3200, usePlugins: [openapiPlugin, healthPlugin] }, signal: abort.signal, operations: ops }),
  ]);
}
```

One source file, two servers, both live from the same import.

### Integrate with your deploy system

Because `run()` returns a `Promise<void>` that resolves on `signal.abort`, you can wrap it in any lifecycle model — containers, process managers, custom mesh registrations.

```ts
export async function deployService(config: {
  source: string;
  port: number;
  type: 'mcp' | 'api-fastify';
}) {
  const ops = await extract({ sourceFile: config.source, namespace: 'deploy' });
  /* build schemas, import module — same pattern as above */

  const plugin = config.type === 'mcp' ? mcpPlugin : apiFastifyPlugin;
  const opts = config.type === 'mcp'
    ? { transport: 'sse', port: config.port }
    : { port: config.port, usePlugins: [openapiPlugin, healthPlugin] };

  const abort = new AbortController();
  // Your deployer hook: register with service mesh, health probe, etc.
  const server = plugin.run!({ packages, outputDir: '', options: opts, signal: abort.signal });
  return { abort, running: server }; // call abort.abort() to stop gracefully
}
```

### Options reference for `run()`

The `options` object in `RunInput` accepts plugin-specific keys. Here are the common ones:

| Key | Plugin(s) | Type | Default | Description |
|-----|-----------|------|---------|-------------|
| `transport` | `mcp` | `'stdio' \| 'sse' \| 'streaming-http'` | `'stdio'` | MCP transport protocol |
| `port` | `mcp` (HTTP), `api-fastify` | `number` | `3000` | Listen port |
| `host` | All | `string` | `'127.0.0.1'` | Bind address |
| `routePrefix` | `api-fastify` | `string` | `''` | Path prefix before `/<ns>/<fn>` |
| `usePlugins` | All `run()` targets | `Plugin[]` | `[]` | Layer/mount/envelope plugins to compose |
| `toolDescriptions` | `mcp` | `Record<string, string>` | `{}` | Per-tool description overrides |

### Plugin cheat sheet

| Plugin | Package | `run()` | `generate()` | What it builds |
|--------|---------|---------|--------------|----------------|
| `mcpPlugin` | `@adhd/apigen-plugin-mcp` | ✓ | ✓ | MCP server (stdio/SSE/streaming-http) |
| `apiFastifyPlugin` | `@adhd/apigen-plugin-api-fastify` | ✓ | ✓ | Fastify HTTP server |
| `apiExpressPlugin` | `@adhd/apigen-plugin-api-express` | ✓ | ✓ | Express HTTP server |
| `cliPlugin` | `@adhd/apigen-plugin-cli-output` | ✓ | ✓ | Commander CLI tool |
| `jsonschemaPlugin` | `@adhd/apigen-plugin-jsonschema` | — | ✓ | JSON Schema files |
| `openapiPlugin` | `@adhd/apigen-plugin-openapi` | — | — | Mount: `GET /_meta/openapi` |
| `healthPlugin` | `@adhd/apigen-plugin-health` | — | — | Mount: `GET /_meta/health` |
| `loggerPlugin` | `@adhd/apigen-plugin-logger` | — | — | Layer: per-operation logging |

> See the [How-To: Running Servers](./docs/how-to/running-servers.md) for a complete walkthrough with all three transports and deployment patterns.

## Features

### v2 Symbol-Based Extraction

`extract()` walks a TypeScript source module and produces canonical `Operation[]` descriptors — one per exported function, const, or class member. Handles the full six-shape export matrix:

- **Named function exports** — `export function foo(…)`
- **Named const/arrow exports** — `export const foo = (…) => …`
- **Named-object exports** — `export const api = { foo, bar }`
- **Default-export named functions** — `export default function foo(…)`
- **Anonymous default exports** — `export default () => …` (id synthesized from filename)
- **CJS source** — `module.exports = { foo, bar }`

Each operation carries an `id` derived deterministically from `namespace/path`, a `kind` (action / query / constructor / instance-method), JSON Schema 2020-12 `input` and `output`, and optional `typeText` for same-host sugar.

```ts
import { extract } from '@adhd/apigen-core-client';

const ops = await extract({ sourceFile: './src/api.ts', namespace: 'myapi' });
for (const op of ops) {
  console.log(`${op.id}  kind=${op.kind}  async=${op.async}  safe=${op.safe}`);
}
```

### Two-Tier Extraction Caching

Building a TypeScript program (parsing lib.d.ts + type-checking) is the dominant cost. Two cache layers eliminate redundant work:

- **Per-run `ExtractionSession`** — pass one session to every `extract` / `generateSchemas` / `extractClasses` call and they share one ts-morph Project per tsconfig, one schema generator per file, and memoized `(file, typeText)` schemas. `dispose()` releases the run.

- **Persistent process-lifetime tier** — Projects and generators are reused across sessions in the same process (watch/serve rebuilds, test loops), version-checked by mtime+size. The generator cache is LRU-capped (`APIGEN_PROGRAM_CACHE`, default 8 entries; each is a full TS program, ~100–200 MB). Set to `0` to disable persistence.

```ts
import { createExtractionSession, extract, generateSchemas } from '@adhd/apigen-core-client';

const session = createExtractionSession();
// => session.stats === { projectsBuilt: 0, generatorsBuilt: 0, schemaCacheHits: 0, schemaCacheMisses: 0 }

try {
  const ops = await extract({ sourceFile: './src/api.ts', session });
  // session.stats.projectsBuilt is now 1 (first Project construction)
  const gen = await generateSchemas({ sourceFile: './src/api.ts', session });
  // session.stats.generatorsBuilt === 1, schemaCacheHits > 0 — pure cache hits
} finally {
  session.dispose();
}
```

**Important:** Do **not** parallelize `buildSchema` loops — the work is synchronous CPU under an async signature, and morph-walk mutates the shared SourceFile, so `Promise.all` gains nothing and can race.

### Mount capability: Synthetic operations and batch fan-out

Mount plugins add synthetic operations to your server — both simple mounts like `GET /_meta/health` and complex features like batch bulk fan-out. The batch plugin demonstrates the pattern:

```ts
import { buildBatchMountedOperations } from '@adhd/apigen-core-client';

// Derive one _batch/<kind> mount per distinct operation kind
const batchMounts = buildBatchMountedOperations(descriptor, { exclude: ['catalog/delete'] });
// => [
//   { id: '_batch/query', kind: 'query', input: { oneOf: [...] }, output: { ... } },
//   { id: '_batch/action', kind: 'action', input: { oneOf: [...] }, output: { ... } }
// ]
```

The batch feature provides:
- `groupBatchableOperationsByKind()` — group operations by kind (query vs. action)
- `buildBatchKindSchema()` — build discriminated-union input/output schemas for one kind
- `buildBatchMountedOperations()` — emit one synthetic mount per distinct kind
- `syntheticOp()` — shared helper to build synthetic operation shapes

See [apigen-plugin-batch](../../packages/apigen/apigen-plugin-batch) for the host-specific wiring.

### v2 Plugin Capability Interface

The `Plugin` interface (SPEC §7.1) declares four orthogonal capabilities — a plugin implements only what it needs:

| Capability | Purpose | Example |
|-----------|---------|---------|
| `target` | Project descriptor to transport/format (codegen) or host functions in-process (serve) | MCP server, Fastify HTTP server, proto client |
| `layer` | Wrap all operations in the onion (middleware) | Logger, auth, rate-limiting |
| `mount` | Add synthetic operations | `/meta/openapi`, `/meta/health`, batch fan-out |
| `envelope` | Declare transport-agnostic side-channel fields (request/response headers, metadata) | Session tokens, request IDs |

The `MountCapability.operations()` method receives an optional `hostBridge` parameter carrying the actual invoker and option schemas — enabling mounts like batch to route directly to real operations without a separate dispatch layer.

```ts
import type { Plugin } from '@adhd/apigen-core-client';

// A minimal logger layer plugin
export default {
  id: 'logger',
  capabilities: {
    layer: {
      layer: async (call, next) => {
        const t = Date.now();
        console.error(`→ ${call.operation.id}`);
        try {
          const r = await next();
          console.error(`← ${call.operation.id} ${Date.now() - t}ms`);
          return r;
        } catch (e) {
          console.error(`✗ ${call.operation.id}`);
          throw e;
        }
      },
    },
  },
} satisfies Plugin;
```

All transports (`http`, `grpc`, `mcp`, `cli`) share the same `Call` / `Next` / `Result` / `Chunk` contract. The v1 `OutputPlugin` interface coexists — migrate by wrapping `generate(PluginInput)` in a `TargetCapability.generate(Descriptor)`.

### Schema Pipeline: generateSchemas + composeSchemas

`generateSchemas` supports three mutually exclusive extraction modes:

- **`named`** (default) — per-function schemas for all exported functions
- **`default`** — treat the default export as the sole function
- **`named-object`** — extract from `export const api = { … }` by object name

The first parameter named `ctx` is excluded from the schema by name-match only (`ctx-name-only` invariant) and recorded via `hasCtx` so dispatch can re-inject it.

`composeSchemas` folds middleware envelope fields into the composed `input`, always wrapping domain params in a `data: {}` wrapper. Override a middleware per-function with `false` to suppress its contribution.

### Polyglot Source-Language Routing

When `apigen serve` watches a directory containing multiple host languages, the source-language helpers route each file to the correct plugin:

```ts
import { languageOfSource, pluginConsumesSource, sourcesForPlugin } from '@adhd/apigen-core-client';

languageOfSource('src/api.py');                          // => 'py'
pluginConsumesSource({ language: 'py' }, 'src/api.py');  // => true
pluginConsumesSource({ language: 'ts' }, 'src/api.py');  // => false

sourcesForPlugin({ language: 'ts' }, ['src/api.ts', 'src/utils.mts', 'src/api.py']);
// => ['src/api.ts', 'src/utils.mts']
```

Recognized extensions: `.ts/.tsx/.mts/.cts` → `ts`, `.py` → `py`, `.rs` → `rust`, `.go` → `go`, `.java` → `java`. Plugins without an explicit `language` default to `'ts'`.

### Class Extraction

`extractClasses()` extracts exported class members per SPEC §10:
- **Static methods** — always extracted as `kind: 'action'`
- **Constructor** — opt-in via `includeInstances: true`, emits `kind: 'constructor'` with `instanceId` output
- **Instance methods** — opt-in, emit `kind: 'instance-method'` with `instanceId` envelope
- Private/protected members are skipped; `_`-prefixed methods are skipped (SPEC §3 opt-out ladder)

## Module Map

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| [Extract](./docs/reference/extract.md) | v2 symbol-based extraction | `extract()`, `tokenize()`, `ExtractOptions` |
| [Schemas](./docs/reference/schemas.md) | Schema generation & composition | `generateSchemas()`, `composeSchemas()`, `GenerateSchemasOptions`, `ComposedSchemas` |
| [Plugin](./docs/reference/plugin.md) | v1 & v2 Plugin contracts | `Plugin`, `OutputPlugin`, `TargetCapability`, `LayerCapability`, `MountCapability`, `EnvelopeCapability`, `syntheticOp()` |
| [Extraction Session](./docs/reference/session.md) | Per-run caching | `createExtractionSession()`, `clearPersistentProjectCache()`, `ExtractionSession` |
| [Extract Classes](./docs/reference/extract-classes.md) | Class export extraction | `extractClasses()`, `ExtractClassesOptions` |
| [Source Language](./docs/reference/source-language.md) | Polyglot file routing | `languageOfSource()`, `sourcesForPlugin()`, `pluginConsumesSource()` |
| [Batch Fan-Out](./docs/reference/batch.md) | Bulk operation dispatch schemas | `groupBatchableOperationsByKind()`, `buildBatchKindSchema()`, `buildBatchMountedOperations()`, `BatchMountOptions`, `BatchKindSchema`, `BatchKindOperation` |
| [Descriptor](./docs/reference/descriptor.md) | Canonical types | `Operation`, `Segment`, `JSONSchema`, `TypeText`, `OperationKind` |

## How-To Guides

- [Writing Source Files for apigen](./docs/how-to/writing-source-files.md) — How to structure your TypeScript source: naming, exports, types, and what makes a good API surface
- [Running Servers Programmatically](./docs/how-to/running-servers.md) — Start MCP, Fastify, or Express servers from your own Node.js process
- [End-to-End Extraction Pipeline](./docs/how-to/extraction-pipeline.md) — From source file to composed schemas
- [Building apigen Plugins](./docs/how-to/building-plugins.md) — v1 OutputPlugin and v2 Plugin development

## Develop

```bash
npx nx build apigen-core-client
npx nx test  apigen-core-client
```

## License

MIT — see [LICENSE](./LICENSE).
