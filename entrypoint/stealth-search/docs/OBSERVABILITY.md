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

## Where the records go and how to enable the sink

The sink is on by default: each bin calls `initTelemetry` once, before its first dispatch, with service `stealth-search` and the `file` log sink (`src/telemetry.ts`). There is no environment variable to set (no environment variable is read anywhere in the package). Records are JSONL files written by `@adhd/sox-telemetry`.

- `--log-dir <path>` selects the directory of the telemetry files; without it the sox-telemetry default directory is used. The flag is accepted by both bins.
- If `initTelemetry` fails, the process continues and prints one `[sox-telemetry] WARNING: initTelemetry failed (...)` line on stderr; telemetry records are then dropped for that process (a no-op sink).

## Diagnostics: `--verbose`, `--log-level`, `--log-file`

Diagnostic logging is separate from the telemetry records above.

- `--verbose` writes internal logs to stderr, never to stdout.
- `--log-level <silent|fatal|error|warn|info|debug|trace>` sets the level. The default is `silent` for the CLI and `info` for the MCP host.
- `--log-format <pretty|json>` sets the format (default `pretty` on a terminal, `json` otherwise).
- `--log-file <path>` writes the logs to a file instead of stderr.
- `--trace-file <path>` appends one JSON line per boot stage to the file.
- `--monitor` (CLI) prints the resource usage of the operation on stderr.

The CLI result is the only thing the CLI writes to stdout (one JSON document; `--pretty` indents it). A typed failure is one `<CODE>: <message>` line on stderr (see [ERRORS.md](ERRORS.md)).

## The MCP bin and stdout

With `--transport stdio` (the default), `stealth-search-mcp` writes only JSON-RPC messages to stdout. Every log line, warning and diagnostic goes to stderr, so a client that parses stdout as a JSON-RPC stream is never fed a stray line. Redirect stderr to a file (`2> mcp.err`) to keep the diagnostics while a client owns the pipes. Telemetry records never use stdout either: they go to the files of the sink.
