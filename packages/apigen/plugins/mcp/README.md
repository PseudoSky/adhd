# @adhd/apigen-plugin-mcp

apigen target plugin (`--type mcp`) — exposes a source file's exports as **MCP tools** over
`stdio`, `sse`, or `streaming-http`. Generates a server to disk *and* runs one live.

Part of [apigen](../../README.md). Driven via [`@adhd/apigen-cli`](../../cli).

```bash
alias apigen='npx tsx packages/apigen/cli/src/index.ts'

# live
apigen run      --source ./api.ts --type mcp                          # stdio (default)
apigen run      --source ./api.ts --type mcp --opt transport=sse --opt port=3000
# generate
apigen generate --source ./api.ts --type mcp --out-dir ./out          # → out/server.ts
```

`--opt` keys: `transport` (`stdio` \| `sse` \| `streaming-http`, default `stdio`),
`port` (`3000`), `host` (`127.0.0.1`). On `stdio`, **stdout is reserved for JSON-RPC** — all
logs go to stderr. Each export becomes a tool; call args are passed as `{ data: { … } }`.
