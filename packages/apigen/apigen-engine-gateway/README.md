# @adhd/apigen-engine-gateway

Aggregation support for apigen — composing multiple packages into a single API surface, plus
the `bin:` source kind (spawns processes via `node:child_process`; **platform: node**).

Part of [apigen](../README.md). For multi-package surfaces see `run-registry` in [`../cli`](../cli).

> Minimal/reserved package for gateway/aggregation helpers.

## Sources (`bin:`)

`parseSourceSpec` / `resolveSource` turn a `bin:<command>` source into the hand-built
`{pkg, operations}` pair that `apigen-plugin-mcp` / `apigen-plugin-cli-output` accept, and
`serveMcpPassthrough` fronts an MCP source behind a Layer stack for an unmodified MCP host.

- `resolveSource(spec, 'run', deps)`: one argv operation (id = command basename, input
  `{argv, cwd}`, output `{exitCode, stdout, stderr, signal?}`). Nothing starts until it is
  invoked. The invocation honours `deps.signal` and `deps.argvTimeoutMs` (default 120000 ms):
  on abort or timeout the whole process group gets SIGTERM, then SIGKILL after 2 s, and the
  result is `exitCode: -1` with the terminating `signal`. Output is capped at 1 MiB per stream.
- `resolveSource(spec, 'serve', deps)`: starts the command, performs an MCP `initialize`
  handshake over stdio (bounded by `handshakeTimeoutMs`), and builds one operation per
  upstream tool. A failed handshake is a `SourceError`, never an argv fallback.
  - **Operation ids** are `<name>.<tool>`, where `<name>` is `deps.name` or the command
    basename (lowercased to `[a-z0-9_-]`). The upstream's own `serverInfo.name` is never used,
    so an upstream cannot claim another source's prefix.
  - A tool with a non-object `inputSchema`, a duplicate name, or a reserved name
    (`__proto__`, `constructor`, `prototype`) is skipped, listed in `resolved.skipped`, and
    reported once each through `deps.onWarn` (default: stderr). The rest of the source works.
  - `Operation.safe` is always `false`. The upstream's `readOnlyHint` / `destructiveHint` are
    **advisory claims**, kept only in the `hints` side map (used by `draft`); nothing may rely
    on them for enforcement.
- `serveMcpPassthrough({source, usePlugins, serverInfo, transport, signal, onError?})`
  advertises the full upstream `Tool` objects (title, description, `inputSchema`,
  `outputSchema`, annotations) and forwards `tools/call` arguments to the upstream verbatim,
  undeclared properties included, after the Layer stack runs. Layer refusals become
  `isError` results; errors the upstream itself returned are re-raised unchanged; anything
  else becomes a generic `isError` result and is passed to `onError` (default: one stderr
  line, no argument values). The server shuts down, disposing the source and its process
  group, when the signal aborts, the host disconnects (use `createStdioHostTransport()`, which
  closes on stdin EOF; the SDK's own stdio transport does not), or the upstream exits.
  The request's cancellation reaches the Layer as `call.signal`.
- `IProcessLauncher` is the injectable port. `nodeProcessLauncher` (default) uses
  `shell: false` and piped stdio; on POSIX the child leads its own process group and `kill`
  signals the whole group. Parsing, resolving for `run` and building operations never spawn
  anything.

### Security notes

- **Arbitrary execution.** A `bin:` source runs whatever the command is, including
  `bin:sh -c '...'`. Nothing in this package restricts it: the only gate is the policy Layer
  you compose in front of it. Treat the source string as code.
- **Environment allowlist.** A started process inherits only `PATH`, `HOME`, `USER`, `LANG`,
  `LC_ALL`, `TMPDIR`, `TERM` and `SHELL` from the parent, plus whatever you pass in
  `spec.env` / `deps.env`. Tokens and credentials in the parent environment are withheld
  unless you pass them explicitly. (The allowlist is POSIX-oriented; Windows needs extra
  variables passed through `env`.)
- **Hints are advisory.** MCP annotations are the upstream's self-description.
