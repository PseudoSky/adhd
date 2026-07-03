# @adhd/apigen-core-client

> The core apigen engine — TypeScript source → JSON Schema extraction, composition, and the plugin contract every apigen target implements.

## What it does

`@adhd/apigen-core-client` reads TypeScript source files, derives JSON Schemas for each exported function's parameters and return type, and composes them with middleware-contributed envelope fields. It defines the **v1 `OutputPlugin`** contract for code generation and the **v2 `Plugin`** capability interface (target / layer / mount / envelope) for the full plugin lifecycle. Pure TypeScript — designed for Node and the browser, though ts-morph's type resolution is Node-only. Runtime dependencies: ts-morph, ts-json-schema-generator, pino, typescript, decimal.js, and @adhd/apigen-base-logical.

Part of [apigen](../README.md). See the [apigen spec](../../../docs/apigen/SPEC.md) for the full architecture.

## Install

```bash
npm install @adhd/apigen-core-client
```

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

### v2 Plugin Capability Interface

The `Plugin` interface (SPEC §7.1) declares four orthogonal capabilities — a plugin implements only what it needs:

| Capability | Purpose | Example |
|-----------|---------|---------|
| `target` | Project descriptor to transport/format (codegen) or host functions in-process (serve) | MCP server, Fastify HTTP server, proto client |
| `layer` | Wrap all operations in the onion (middleware) | Logger, auth, rate-limiting |
| `mount` | Add synthetic operations | `/meta/openapi`, `/meta/health` |
| `envelope` | Declare transport-agnostic side-channel fields (request/response headers, metadata) | Session tokens, request IDs |

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
| [Plugin](./docs/reference/plugin.md) | v1 & v2 Plugin contracts | `Plugin`, `OutputPlugin`, `TargetCapability`, `LayerCapability`, `MountCapability`, `EnvelopeCapability` |
| [Extraction Session](./docs/reference/session.md) | Per-run caching | `createExtractionSession()`, `clearPersistentProjectCache()`, `ExtractionSession` |
| [Extract Classes](./docs/reference/extract-classes.md) | Class export extraction | `extractClasses()`, `ExtractClassesOptions` |
| [Source Language](./docs/reference/source-language.md) | Polyglot file routing | `languageOfSource()`, `sourcesForPlugin()`, `pluginConsumesSource()` |
| [Descriptor](./docs/reference/descriptor.md) | Canonical types | `Operation`, `Segment`, `JSONSchema`, `TypeText`, `OperationKind` |

## How-To Guides

- [End-to-End Extraction Pipeline](./docs/how-to/extraction-pipeline.md) — From source file to composed schemas
- [Building apigen Plugins](./docs/how-to/building-plugins.md) — v1 OutputPlugin and v2 Plugin development

## Develop

```bash
npx nx build apigen-core-client
npx nx test  apigen-core-client
```

## License

MIT — see [LICENSE](./LICENSE).
