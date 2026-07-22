# @adhd/apigen-plugin-mcp

**Target plugin** (`--type mcp`) — exposes a source file's exports as **MCP tools** over `stdio`, `sse`, or `streaming-http`. Each exported function becomes a tool callable from any MCP host (Claude Desktop, Cursor, custom agents). Supports both live (`run`) and code generation (`generate`) modes.

Part of [apigen](../README.md). Driven via [`@adhd/apigen-cli`](../../../entrypoint/apigen-cli/README.md).

---

## How it works

Every exported function in your source becomes an MCP tool. The function name is the tool name. Parameters become the tool's `inputSchema`, inferred from your TypeScript types as JSON Schema. Return types become the tool's `outputSchema`.

```ts
// api.ts — no framework imports, no decorators
export async function greet(name: string): Promise<string> {
  return `hello, ${name}!`;
}

export async function add(a: number, b: number): Promise<number> {
  return a + b;
}
```

Becomes two MCP tools: `greet` (params: `{ data: { name: string } }`) and `add` (params: `{ data: { a: number, b: number } }`).

---

## CLI usage

```bash
# stdio transport (default — for MCP hosts like Claude Desktop)
npx @adhd/apigen-cli run --source api.ts --type mcp

# SSE transport (HTTP accessible)
npx @adhd/apigen-cli run --source api.ts --type mcp --opt transport=sse --opt port=3100 --opt host=0.0.0.0

# Streaming HTTP transport
npx @adhd/apigen-cli run --source api.ts --type mcp --opt transport=streaming-http --opt port=3100

# With logging
npx @adhd/apigen-cli run --source api.ts --type mcp --use logger

# Generate an MCP server project to disk
npx @adhd/apigen-cli generate --source api.ts --type mcp --out-dir ./out
```

---

## Programmatic usage (run)

```ts
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';

async function start() {
  const ops = await extract({ sourceFile: './api.ts', namespace: 'tools' });
  const generated = {
    metadata: { namespace: 'tools', phase: '' },
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

  await mcpPlugin.run!({
    packages: [{
      id: 'tools',
      schemas,
      importPath: './api.ts',
      fns: mod,
      createClient: async () => ({}),
    }],
    outputDir: '',
    options: { transport: 'sse', port: 3100 },
    signal: abort.signal,
    operations: ops,
  });
}
```

---

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | `'stdio' \| 'sse' \| 'streaming-http'` | `'stdio'` | MCP transport protocol |
| `port` | `number` | `3000` | Listen port (HTTP transports only) |
| `host` | `string` | `'127.0.0.1'` | Bind address (HTTP transports only) |
| `toolDescriptions` | `Record<string, string>` | `{}` | Override tool descriptions per function name |

---

## Transport details

### stdio (default)

The server speaks JSON-RPC over standard I/O. **stdout is reserved for JSON-RPC** — all logs go to stderr. Connect any MCP host:

```json
// Claude Desktop config
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": ["@adhd/apigen-cli", "run", "--source", "/path/to/api.ts", "--type", "mcp"]
    }
  }
}
```

### SSE

HTTP-based transport. Connect at `GET /sse`, send messages to `POST /messages?sessionId=...`.

```bash
curl -N http://localhost:3100/sse
# In another terminal:
curl -X POST http://localhost:3100/messages?sessionId=... \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"greet","arguments":{"data":{"name":"ada"}}}}'
```

### streaming-http

Single-request streaming HTTP for long-lived operations (server-sent events per tool call).

---

## Calling MCP tools

MCP tools wrap domain arguments in a `{ data: { … } }` envelope:

```
Tool:    greet
Input:   { data: { name: "ada" } }
Output:  { content: [{ type: "text", text: "\"hello, ada!\"" }] }
```

The `data` wrapper is always present, even for zero-parameter functions.

---

## Exports

| Export | Kind |
|--------|------|
| `mcpPlugin` | v1 `OutputPlugin` — `generate()` + `run()` |
| `default` | Same as `mcpPlugin` |

```ts
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';
// or: import mcpPlugin from '@adhd/apigen-plugin-mcp';
```
