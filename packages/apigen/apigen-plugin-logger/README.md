# @adhd/apigen-plugin-logger

**Layer plugin** — wraps every operation dispatch with entry/exit/error logging. Compatible with any target plugin (MCP, Fastify, Express, CLI). Stream-lifecycle aware: logs per-chunk for streaming operations and aggregates chunk count on stream end.

Part of [apigen](../README.md). Driven via [`@adhd/apigen-cli`](../../../entrypoint/apigen-cli/README.md).

---

## What it does

When loaded via `--use`, the logger plugin wraps every operation call:

```
→ getUser                          (entry — op started)
← getUser 12ms                     (exit — op completed)
✗ getUser 45ms                     (error — op threw)
```

For streaming operations:

```
→ streamEvents                     (entry)
  chunk 1                          (per-chunk debug)
  chunk 2
← streamEvents 3200ms 2 chunks     (stream ended)
```

All logs go to **stderr** only — stdout is reserved for the MCP stdio JSON-RPC channel.

---

## CLI usage

```bash
# Fastify with logging
npx @adhd/apigen-cli run --source api.ts --type api-fastify --opt port=3000 --use logger

# MCP with logging
npx @adhd/apigen-cli run --source api.ts --type mcp --use logger

# Custom log level and format
npx @adhd/apigen-cli run --source api.ts --type api-fastify --use logger \
  --opt 'useOptions={"logger":{"level":"debug","format":"pretty"}}'

# Log to a file (never stdout)
npx @adhd/apigen-cli run --source api.ts --type api-fastify --use logger \
  --opt 'useOptions={"logger":{"destination":"./logs/api.log"}}'
```

---

## Programmatic usage

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { loggerPlugin, makeLoggerPlugin } from '@adhd/apigen-plugin-logger';

// Use the default logger plugin (json lines → stderr)
const ops = await extract({ sourceFile: './api.ts', namespace: 'api' });
const schemas = composeSchemas(/* ... */);
const mod = await import('./api.ts');
const abort = new AbortController();
process.on('SIGINT', () => abort.abort());

await apiFastifyPlugin.run({
  packages: [{ id: 'api', schemas, importPath: './api.ts', fns: mod, createClient: async () => ({}) }],
  outputDir: '',
  options: {
    port: 3000,
    usePlugins: [loggerPlugin],
  },
  signal: abort.signal,
  operations: ops,
});
```

### With custom configuration

Use `makeLoggerPlugin()` for per-deployment control:

```ts
import { makeLoggerPlugin } from '@adhd/apigen-plugin-logger';

await apiFastifyPlugin.run({
  // ...
  options: {
    port: 3000,
    usePlugins: [
      makeLoggerPlugin({ level: 'debug', format: 'pretty' }),
    ],
  },
  // ...
});
```

### Reading the logger in your domain functions

The logger plugin seeds a `Logger` instance into `call.ctx`. Downstream layers and domain functions can read it:

```ts
import { Logger } from '@adhd/apigen-plugin-logger';

export async function getUser(ctx: Logger, id: string) {
  // ctx is injected by apigen (first param named 'ctx')
  // It's a Logger instance seeded by the logger plugin
  ctx.info({ id }, `fetching user ${id}`);
  return db.find(id);
}
```

Or read it from `call.ctx` in a custom layer:

```ts
const log = call.ctx.get(Logger);
log?.info('hello from custom layer');
```

---

## Options

```ts
import { type LoggerOptions, makeLoggerPlugin } from '@adhd/apigen-plugin-logger';
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `level` | `string` | `'info'` | pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `format` | `'json' \| 'pretty'` | `'pretty'` on TTY stderr, else `'json'` | Output format |
| `destination` | `string` | stderr (fd 2) | File path for logs. **Never stdout.** |

---

## Log format (JSON mode)

```json
{"level":30,"time":"12:00:00.000","op":"getUser","msg":"→ getUser"}
{"level":30,"time":"12:00:00.012","op":"getUser","msg":"← getUser ok","ms":12}
```

---

## Exports

| Export | Kind |
|--------|------|
| `loggerPlugin` | v2 `Plugin<LoggerOptions>` — default (json → stderr) |
| `makeLoggerPlugin(opts)` | Factory function — returns configured `Plugin<LoggerOptions>` |
| `Logger` | Class — typed `call.ctx` key for reading the per-request logger |
| `LoggerOptions` | TypeScript interface |

```ts
import { loggerPlugin, makeLoggerPlugin, Logger, type LoggerOptions } from '@adhd/apigen-plugin-logger';
```
