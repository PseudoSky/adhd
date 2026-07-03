# Building apigen Plugins

How to create v1 `OutputPlugin` and v2 `Plugin` implementations for apigen.

## Choosing v1 vs v2

| | v1 `OutputPlugin` | v2 `Plugin` |
|---|---|---|
| **Contract** | `generate(PluginInput)` + optional `run(RunInput)` | Four orthogonal capabilities |
| **Input** | `PluginInput` (packages array with ComposedSchemas) | `Descriptor` (canonical Operation[]) |
| **Serve mode** | Not supported | `TargetCapability.serve(harness)` |
| **Middleware** | Not supported | `LayerCapability` wraps operations |
| **Synthetic ops** | Not supported | `MountCapability` adds `/meta/*` endpoints |
| **Status** | Stable, backward-compatible | Recommended for new plugins |

## Building a v1 OutputPlugin

A minimal v1 plugin that emits an OpenAPI spec:

```ts
import type { OutputPlugin, PluginInput, PluginOutput } from '@adhd/apigen-core-client';

export default {
  id: '@myorg/apigen-openapi',
  description: 'Generate OpenAPI 3.1 spec from apigen schemas',
  language: 'ts',
  optionsSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', default: 'My API' },
      version: { type: 'string', default: '1.0.0' },
    },
  },
  generate(input: PluginInput): PluginOutput {
    const spec = buildOpenApiSpec(input.packages, input.options);
    return {
      files: [
        { path: 'openapi.json', content: JSON.stringify(spec, null, 2) },
      ],
    };
  },
} satisfies OutputPlugin;
```

### v1 → v2 Migration

To migrate a v1 plugin to v2:

```ts
import type { Plugin, TargetCapability, Descriptor, File, Harness, Server } from '@adhd/apigen-core-client';
import type { PluginInput } from '@adhd/apigen-core-client'; // v1 types

export default {
  id: '@myorg/apigen-openapi',
  description: 'Generate OpenAPI 3.1 spec',
  capabilities: {
    target: {
      name: 'openapi',
      generate(descriptor: Descriptor, opts: Record<string, unknown>): File[] {
        // Construct v1 PluginInput from the v2 Descriptor
        const input: PluginInput = {
          packages: [{ id: descriptor.namespace ?? '', schemas: {}, importPath: '' }],
          outputDir: '',
          options: opts,
        };
        return buildOpenApiSpec(input.packages, opts);
      },
    },
  },
} satisfies Plugin;
```

## Building a v2 Plugin

### Target Capability: Codegen-only

```ts
import type { Plugin, Descriptor, File } from '@adhd/apigen-core-client';

export default {
  id: '@myorg/apigen-proto',
  description: 'Generate Protocol Buffer definitions',
  capabilities: {
    target: {
      name: 'proto',
      generate(descriptor: Descriptor, opts: Record<string, unknown>): File[] {
        const files: File[] = [];
        for (const op of descriptor.operations) {
          files.push({
            path: `${op.id.replace(/\//g, '_')}.proto`,
            content: generateProtoMessage(op),
          });
        }
        return files;
      },
    },
  },
} satisfies Plugin;
```

### Target + Serve: HTTP Server

```ts
import type { Plugin, Descriptor, Harness, Server, File, Call, Result } from '@adhd/apigen-core-client';

export default {
  id: '@myorg/apigen-http-fastify',
  description: 'Expose domain functions over HTTP/Fastify',
  capabilities: {
    target: {
      name: 'http-fastify',
      generate(descriptor: Descriptor, opts: Record<string, unknown>): File[] {
        return []; // no static files — everything is live
      },
      async serve(descriptor: Descriptor, harness: Harness, opts: Record<string, unknown>): Promise<Server> {
        const app = createFastifyApp(opts);
        for (const op of descriptor.operations) {
          app.post(`/${op.path.map(s => s.raw).join('/')}`, async (req, reply) => {
            const result = await harness.invoke(op, {
              data: req.body ?? {},
              envelope: { 'x-session': req.headers['x-session'] ?? '' },
              transport: 'http',
              signal: req.raw.abortSignal,
            });
            return result;
          });
        }
        await app.listen({ port: 3000 });
        return { close: () => app.close() };
      },
    },
  },
} satisfies Plugin;
```

### Layer: Logger Middleware

```ts
import type { Plugin, Call, Next, Result, Chunk } from '@adhd/apigen-core-client';

export default {
  id: 'logger',
  description: 'Request/response logging middleware',
  capabilities: {
    layer: {
      layer: async (call: Call, next: Next): Promise<Result> => {
        const t = Date.now();
        console.error(`→ ${call.operation.id}`);
        try {
          const result = await next() as Result;
          console.error(`← ${call.operation.id} ${Date.now() - t}ms`);
          return result;
        } catch (e) {
          console.error(`✗ ${call.operation.id} ${Date.now() - t}ms`);
          throw e;
        }
      },
    },
  },
} satisfies Plugin;
```

### Mount: Synthetic Operations

```ts
import type { Plugin, Descriptor, MountedOperation, Call } from '@adhd/apigen-core-client';

export default {
  id: 'openapi',
  description: 'Add /meta/openapi endpoint',
  capabilities: {
    mount: {
      operations(descriptor: Descriptor): MountedOperation[] {
        return [{
          id: `${descriptor.namespace ?? ''}/meta/openapi`,
          host: descriptor.host,
          namespace: { raw: '', words: [] },
          path: [{ raw: 'meta', words: ['meta'] }, { raw: 'openapi', words: ['openapi'] }],
          kind: 'query',
          async: false,
          streaming: false,
          safe: true,
          input: { type: 'object', properties: {}, required: [] },
          output: { type: 'string' },
          envelope: {},
          typeText: null,
          handler: (_call: Call) => JSON.stringify(toOpenApi(descriptor)),
        }];
      },
    },
  },
} satisfies Plugin;
```

### Envelope: Session Middleware

```ts
import type { Plugin } from '@adhd/apigen-core-client';

export default {
  id: 'session',
  description: 'Read/write session tokens via transport metadata',
  capabilities: {
    envelope: {
      request: {
        session: { type: 'string', description: 'Session token from x-session header' },
      },
      response: {
        session: { type: 'string', description: 'Refreshed session token' },
      },
    },
  },
} satisfies Plugin;
```

## Plugin Loading

v2 `Plugin` objects are loaded by the CLI:

```bash
# Type (target capability)
apigen generate --type my-openapi-plugin --out dist/

# Layer/mount/envelope (use)
apigen serve --use logger --use session --type http-fastify
```

The `id` field is accepted as both `--type` and `--use` values. When a plugin is loaded via `--use`, its `layer`, `mount`, and `envelope` capabilities contribute to the composed harness. When loaded via `--type`, its `target` capability runs.

## See Also

- [Plugin reference](../reference/plugin.md) — full type signatures
- [Descriptor reference](../reference/descriptor.md) — `Operation`, `Segment`, `JSONSchema`
- [How-To: Extraction Pipeline](./extraction-pipeline.md) — the pipeline that feeds plugins
