## Unreleased

### 🚀 Features

- `serve <source>` serves the upstream MCP server through `createGateway` and `mcpPlugin.run` from `@adhd/apigen-plugin-mcp`. The gateway owns the upstream (handshake, supervision, restarts); the policy Layer stack wraps each call and a gateway terminal routes it to the upstream.
- MCP tool names are the standard projection of the operation id (`<name>_<tool>`); string results are raw text; `tools/list` carries the upstream's `title` and `annotations`; every refusal or other `ApiError` is a tool result with `isError: true`, text `<code>: <message>` and `_meta['adhd/error']`.
- A crashed upstream is restarted up to 5 times. When the upstream has exited and 5 consecutive restarts fail, `serve` stops and exits 1 with the reason on stderr instead of answering `unavailable` indefinitely.
- A failed startup handshake exits non-zero before the host transport starts, and the gateway is stopped on every exit path.
