## Unreleased

### 🚀 Features

- `serve <source>` serves the upstream MCP server through `createGateway` and `mcpPlugin.run` from `@adhd/apigen-plugin-mcp`. The gateway owns the upstream (handshake, supervision, restarts); the policy Layer stack wraps each call and a gateway terminal routes it to the upstream.
- MCP tool names are the standard projection of the operation id (`<name>_<tool>`); string results are raw text; `tools/list` carries the upstream's `title` and `annotations`; every refusal or other `ApiError` is a tool result with `isError: true`, text `<code>: <message>` and `_meta['adhd/error']`.
- A crashed upstream is restarted up to 5 times. When the upstream has exited and 5 consecutive restarts fail, or it exits more than 5 times within 60 seconds, `serve` stops and exits 1 with the reason on stderr instead of answering `unavailable` indefinitely.
- A failed startup handshake exits non-zero before the host transport starts, and the gateway is stopped on every exit path.

## 0.0.3 (2026-10-21)

This was a version bump only for policy to align it with other projects, there were no code changes.

## 0.0.2 (2026-10-19)

### 🚀 Features

- **policy:** serve takes an injectable host transport and handshake timeout ([6e27d320](https://github.com/PseudoSky/adhd/commit/6e27d320))
- **policy:** run, serve and mcp-json verbs fronting a bin: source through the policy Layer (T09) ([c4c2b46c](https://github.com/PseudoSky/adhd/commit/c4c2b46c))
- **policy:** adhd-policy, adhd-policy-mcp and adhd-policy-http bins over the client with a baked operation surface (T06) ([ead861c6](https://github.com/PseudoSky/adhd/commit/ead861c6))
- **policy:** scaffold policy domain, policy-core-client, policy entrypoint and apigen-plugin-policy ([e6cfb9ec](https://github.com/PseudoSky/adhd/commit/e6cfb9ec))

### 🩹 Fixes

- **policy:** policy:test builds its own dist before running (4041424f) ([f65fa1b2](https://github.com/PseudoSky/adhd/commit/f65fa1b2))
- **policy:** installed-layout dist lookup, tamper-evident atomic mcp-json, serve --name, strict flags and port, signals only for verbs, strict dereference, doctor exit 2 (E1-E6, E8-E13) ([5d326d8b](https://github.com/PseudoSky/adhd/commit/5d326d8b))
- **apigen-engine-gateway:** user-chosen operation ids, verbatim passthrough of arguments and tool definitions, skip bad tools, follow host and upstream shutdown (G2-G8) ([0cf7897d](https://github.com/PseudoSky/adhd/commit/0cf7897d))

### ❤️ Thank You

- pseudosky
