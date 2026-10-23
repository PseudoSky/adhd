# @adhd/apigen-engine-gateway

The router behind a mixed-source apigen surface: one `Gateway` holds a `HostAdapter` per binding, supervises them, and routes each call to the adapter named by `operation.binding ?? operation.host`. The `sources/` module adds the foreign source kinds: a PATH executable (`argv`) and an MCP stdio upstream (`mcp`). It spawns processes through `node:child_process` (**platform: node**).

Part of [apigen](../README.md). Design: adhd [ADR-0017](../../../docs/decisions/0017-apigen-source-model.md) (source model), [SPEC §4 and §13](../../../docs/apigen/SPEC.md).

## Model

A source goes through three stages:

| Stage | What it does | Here |
| --- | --- | --- |
| Resolve | A reference (`bin:touch`, `./server.js`, `notes`) is classified by the core `resolveSourceReference(reference, probe)`. `nodeSourceProbe` supplies the filesystem and `PATH` checks. | `nodeSourceProbe` |
| Extract | A translator turns the asset into IR (`Operation[]`) and reports the files it read. | `registerSourceExtractors` |
| Execute | An adapter registered with the gateway runs the operation. | `createArgvAdapter`, `createMcpUpstreamAdapter` |

`Operation.host` names the extractor that produced an operation; `Operation.binding` names the runtime that executes it.

| Source | `host` | `binding` | Operation id | Input |
| --- | --- | --- | --- | --- |
| Executable | `argv` | `bin:<base>` | `bin/<base>` | `{ argv: string[], cwd: string }` |
| MCP upstream | `mcp` | `mcp:<name>` | `<name>/<tool>` | the upstream tool's `inputSchema` |

`<base>` is the command basename without a known executable extension (`touch`, `server`). `<name>` is the `name` option or the command basename, lowercased to `[a-z0-9_-]`; the upstream's own `serverInfo.name` is never used, so an upstream cannot claim another source's prefix. Ids are rendered by the core `buildId`, which tokenises each segment: an upstream tool `read_file` becomes `<name>/read-file` (`src/lib/sources/mcp-source.ts:114`, `argv-operation.ts:67-89`, `command-name.ts`).

## Extractors

`registerSourceExtractors(registry, { launcher?, onWarn? })` registers both translators with a registry from the core `createExtractorRegistry()`; the core `extractSourceEntry` then produces the IR.

- `argv`: one `action` operation. Nothing starts. When the command names a path, that file is reported as the one file read; a bare name resolved through `PATH` reports none.
- `mcp`: starts the upstream once, performs the MCP `initialize` handshake, reads every `tools/list` page, translates the tools and closes the upstream. The result is IR only; the live connection that serves calls belongs to the adapter. It reports no source files. Options come from `ExtractCall.extractorOptions` (`IMcpExtractorOptions`): `args`, `cwd`, `env`, `name`, `handshakeTimeoutMs`. All are plain data, so an IR cache keyed on the call sees every input that changes the result.

The MCP translator (`operationsFromMcpTools`) is pure. Each tool becomes one `action` operation carrying the tool's `title`, `description`, `annotations` and `outputSchema` in `Operation.tool`. A tool with an invalid definition, a non-object `inputSchema`, a duplicate name, a reserved name (`__proto__`, `constructor`, `prototype`) or a rendered id that collides with an earlier tool is skipped, reported once through `onWarn` (default: stderr) and listed in `skipped`. The rest of the source stays usable. `Operation.safe` is always `false`: the upstream's `readOnlyHint` and `destructiveHint` are advisory claims, kept only in a `hints` side map, and nothing may rely on them for enforcement.

## Adapters and the gateway

```ts
import { createGateway, createArgvAdapter, createMcpUpstreamAdapter, defaultBackoff } from '@adhd/apigen-engine-gateway';

const upstream = createMcpUpstreamAdapter({
  name: 'notes',
  transport: { kind: 'stdio', command: 'node', args: ['./server.js'], cwd: process.cwd() },
});
const gateway = createGateway({
  adapters: [upstream, createArgvAdapter({ command: 'touch' })],
  backoff: { delayMs: defaultBackoff.delayMs, maxRestarts: 5 },
});
await gateway.start();
const operations = upstream.operations(); // `notes/<tool>`, binding `mcp:notes`
```

- `createMcpUpstreamAdapter(spec, { launcher?, handshakeTimeoutMs?, callTimeoutMs?, onWarn? })`: `start()` spawns the process, performs `initialize` (bounded by `handshakeTimeoutMs`, default 10000 ms) and reads `tools/list`; a failed start rejects with the gateway `unavailable` error (`makeUnavailableError('mcp:<name>', '(start)', reason)`), never an argv fallback. After the upstream exits, `start()` respawns it under the gateway's supervision. `invoke` sends `tools/call` with the arguments exactly as given (undeclared keys survive) and returns the upstream's `CallToolResult` verbatim. A call outliving `callTimeoutMs` (default 120000 ms) rejects with `deadline_exceeded`; a dropped connection rejects with `unavailable`; an error the upstream itself returned rejects with the SDK `McpError` unchanged. Only the `stdio` transport is implemented; `http` throws `invalid_argument`. It also exposes `tools()`, `operations()` and `skipped()`.
- `createArgvAdapter({ command, cwd? }, { launcher?, timeoutMs? })`: nothing starts until a call. Each call runs the command once with `req.data.argv` in `req.data.cwd` (else `spec.cwd`) and resolves with `{ exitCode, stdout, stderr, signal? }`. Cancellation, or exceeding `timeoutMs` (default 120000 ms; `0` disables), sends SIGTERM to the process group and SIGKILL after 2 s. A timeout rejects with `deadline_exceeded`; a command that cannot start rejects with `unavailable`. Output is capped at 1 MiB per stream.
- `resolveSource(resolution, { launcher?, intent?, argvTimeoutMs?, signal? })`: resolves an `argv` source to the `{ pkg, operations, dispose }` triple that `apigen-plugin-mcp` and `apigen-plugin-cli-output` accept. An `mcp` translator, a code or schema-document asset, or a reference that is not a command is `invalid_argument`: an MCP upstream is IR plus a binding (extractor plus adapter above), not a resolved source.
- `parseSourceSpec(text)`: pure syntactic parse of `bin:<command>` / `remote:<url>` / a file path into a `SourceSpec`.
- `IProcessLauncher` is the injectable port. `nodeProcessLauncher` (default) uses `shell: false` and piped stdio; on POSIX the child leads its own process group and `kill` signals the whole group.

Failures of source resolution or startup are core `ApiError`s: an invalid or unsupported source is `invalid_argument`; a process that cannot start or an upstream that fails its handshake is the gateway `unavailable` error naming the binding.

## Serving an MCP source behind Layers

Two ways to put a Layer stack in front of an upstream:

1. **Through `apigen-plugin-mcp`**, as `entrypoint/policy`'s `serve` does: `mcpPlugin.run` serves `adapter.operations()` with the Layer stack as `usePlugins` and a dispatch terminal that calls `gateway.route`. Tool names are the BA-1 projection of each operation id.
2. **`serveMcpPassthrough({ operations, gateway, usePlugins, serverInfo, transport, signal, onError? })`**: an SDK `Server` that advertises the full upstream `Tool` objects (title, description, `inputSchema`, `outputSchema`, annotations) and forwards `tools/call` arguments to the gateway verbatim after the Layer stack runs. Tool names are the BA-1 projection of each operation (`<namespace>_<path>`, words joined with `_`). The caller owns the started gateway (`try { await gateway.start(); ... } finally { await gateway.stop(); }`, with a finite `backoff.maxRestarts` so a dead upstream is not restarted forever). Layer refusals and other `ApiError`s become `isError` results; an error the upstream itself returned is re-raised with its code and message; anything else becomes the generic `isError` result `The tool call failed.` and is passed to `onError` (default: one stderr line with the tool name and error class, never argument values). The request's cancellation reaches the Layer as `call.signal`. The returned `closed` promise settles when `signal` aborts or the host disconnects.

`createStdioHostTransport()` is the host-facing stdio transport for either path: it closes when stdin reaches end-of-file, which the SDK's own `StdioServerTransport` does not.

## Security notes

- **Arbitrary execution.** A `bin:` source runs whatever the command is, including `bin:sh -c '...'`. Nothing in this package restricts it: the only gate is the policy Layer you compose in front of it. Treat the source string as code.
- **Spawn before gating.** An MCP source is spawned at startup, before any Layer runs, to list its tools. A bare unprefixed word that matches no file is looked up on `PATH` last (ADR-0017 D4), so a mistyped word can start a real binary.
- **Environment allowlist.** A started process inherits only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM` and `SHELL` from the parent, plus whatever you pass in `spec.env` / `deps.env`. Tokens and credentials in the parent environment are withheld unless you pass them explicitly. (The allowlist is POSIX-oriented; Windows needs extra variables passed through `env`.)
- **Hints are advisory.** MCP annotations are the upstream's self-description.
