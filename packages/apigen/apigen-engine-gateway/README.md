# @adhd/apigen-engine-gateway

Aggregation support for apigen — composing multiple packages into a single API surface. Pure
TypeScript (**platform: shared**).

Part of [apigen](../README.md). For multi-package surfaces see `run-registry` in [`../cli`](../cli).

> Minimal/reserved package for gateway/aggregation helpers.

## Sources (`bin:`)

`parseSourceSpec` / `resolveSource` turn a `bin:<command>` source into the hand-built
`{pkg, operations}` pair that `apigen-plugin-mcp` / `apigen-plugin-cli-output` accept.

- `resolveSource(spec, 'run', deps)`: one argv operation (id = command basename, input
  `{argv, cwd}`, output `{exitCode, stdout, stderr}`). Nothing starts until it is invoked.
- `resolveSource(spec, 'serve', deps)`: starts the command, performs an MCP `initialize`
  handshake over stdio (bounded by `handshakeTimeoutMs`), and builds one operation per
  upstream tool (`<server>.<tool>`). A failed handshake is a `SourceError`, never an argv
  fallback.
- `IProcessLauncher` is the injectable port (`nodeProcessLauncher` is the default:
  `shell: false`, piped stdio). Parsing, resolving for `run` and building operations never
  spawn anything.
