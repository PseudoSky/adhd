# Observability

Both hosts (the `stealth-search` CLI and the `stealth-search-mcp` server) write one span per dispatched call through the shared apigen tracing plugin, configured once in `src/tracing.ts` as `makeTracingPlugin({ serviceName: 'adhd' })` and mounted in every `usePlugins` list of both hosts. Telemetry service `stealth-search`; role `cli` for the CLI and `live-service` for the MCP host.

## Records

Every dispatched call writes, to the sox-telemetry JSONL sink:

- `adhd.<op>.start`, written before the verb runs, so a hang is visible.
- `adhd.<op>.finish` on success, or exactly one `adhd.<op>.error` on failure.

`<op>` is the operation id of the package (for example `stealth/chrome-status`). Attributes: `adhd.op`, `adhd.transport` (`cli` or `mcp`), `trace_id`, `session_id`, `worktree`, `role`, and `duration_ms` on finish and error. The error record carries `error` (the message of the failure). It does not carry the typed error code: the code is the CLI exit status, and over MCP it is not a separate field (see ERRORS.md).

### The `adhd.op.error` twin

The shared plugin also writes an upstream twin event, `adhd.op.error`, next to every `adhd.<op>.error`. The twin carries the op id literal `op` in its event name (the plugin names it `<serviceName>.op.error`), while its `adhd.op` attribute holds the real operation id, plus `span`, `duration_ms` and `err`. This is known upstream behaviour and is kept as is: a failing call writes exactly one `adhd.<op>.error` for its real op id and exactly one `adhd.op.error` twin, and no other record carries the op id `op`.

## What counts as a dispatch

- A verb call that the verb rejects (for example an unregistered provider, which raises `UNKNOWN_PROVIDER` from the verb on both hosts) is a dispatch: start plus error span, with the verb's message in `error`.
- A rejected flag on the CLI (for example `chromeStatus --cdp-port abc`) is traced too: telemetry starts before any flag is validated (`--log-dir` is read from the command line first), and the refused call is run through the same mounted plugin layer, so it writes the start and error span of the operation the command line names (no second emitter). A command line that names no operation has no operation id and writes no span.
- `--help` is not a dispatch: it starts no telemetry and writes no span. The same holds for `-h` and for running the CLI with no arguments (both print the help).

## Where the records go

`--log-dir <path>` selects the directory of the telemetry files; the default is the sox-telemetry default.
