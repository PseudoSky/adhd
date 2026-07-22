# @adhd/apigen-plugin-health

**Mount plugin** — adds a `GET /_meta/health` endpoint to any apigen server. Reports runtime readiness for load balancers, orchestrators, and the apigen gateway (§13).

Part of [apigen](../README.md). Driven via [`@adhd/apigen-cli`](../../../entrypoint/apigen-cli/README.md).

---

## What it adds

When loaded via `--use`, the health plugin contributes a synthetic `_meta/health` operation that returns:

```json
GET /_meta/health
→ {"status":"ok","host":"ts"}
```

The gateway (§13.1) routes a host's operations only after this endpoint reports `ready`. For an in-process runtime (non-gateway), it always reports `ok` — if the handler can respond, the runtime is alive.

---

## CLI usage

```bash
# Fastify with health check
npx @adhd/apigen-cli run --source api.ts --type api-fastify --opt port=3000 --use health

# MCP with health check (SSE transport)
npx @adhd/apigen-cli run --source api.ts --type mcp --opt transport=sse --opt port=3000 --use health

# With custom metadata in the response
npx @adhd/apigen-cli run --source api.ts --type api-fastify --use health \
  --opt 'useOptions={"health":{"meta":{"version":"1.0","region":"us-east"}}}'
```

After startup:

```bash
curl http://localhost:3000/_meta/health
# → {"status":"ok","host":"ts","meta":{"version":"1.0","region":"us-east"}}
```

---

## Programmatic usage

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { healthPlugin } from '@adhd/apigen-plugin-health';

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
    host: '0.0.0.0',
    usePlugins: [
      healthPlugin,   // ← mounts GET /_meta/health
    ],
    // With custom metadata:
    // useOptions: { health: { meta: { version: '1.0', region: 'us-east' } } },
  },
  signal: abort.signal,
  operations: ops,
});
```

---

## Options

```ts
import { type HealthOptions } from '@adhd/apigen-plugin-health';
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `meta` | `Record<string, string \| number \| boolean \| null>` | `undefined` | Extra metadata included in every health response payload |

---

## Response shape

```ts
interface HealthResponse {
  status: 'ok';
  host: string;                          // language runtime tag (e.g. 'ts')
  meta?: Record<string, string | number | boolean | null>;
}
```

---

## Exports

| Export | Kind |
|--------|------|
| `healthPlugin` | v2 `Plugin<HealthOptions>` — mount capability only |
| `HealthOptions` | TypeScript interface |
| `HealthResponse` | TypeScript interface |

```ts
import { healthPlugin, type HealthOptions, type HealthResponse } from '@adhd/apigen-plugin-health';
```
