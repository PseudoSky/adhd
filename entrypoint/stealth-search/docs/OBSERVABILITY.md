# Observability

Both hosts (the `stealth-search` CLI and the `stealth-search-mcp` server) write one span per dispatched call through the `adhd` tracing layer in `src/tracing.ts`. Telemetry service `stealth-search`; role `cli` for the CLI and `live-service` for the MCP host.

## Records

Every dispatched call writes, to the sox-telemetry JSONL sink:

- `adhd.<op>.start`, written before the verb runs, so a hang is visible.
- `adhd.<op>.finish` on success, or exactly one `adhd.<op>.error` on failure.

`<op>` is the operation id of the package (for example `stealth/chrome-status`). Attributes: `adhd.op`, `adhd.transport` (`cli` or `mcp`), `trace_id`, `session_id`, `worktree`, `role`, and `duration_ms` on finish and error. The error record also carries `error` (the message) and `error_code` (the typed `StealthSearchError` code, for example `UNKNOWN_PROVIDER`).

A failing call writes ONE error record. No `adhd.op.error` record is written, and no record carries the literal op id `op`.

## What counts as a dispatch

- A verb call that the verb rejects (for example an unregistered provider, which raises `UNKNOWN_PROVIDER` from the verb on both hosts) is a dispatch: start plus error span with `error_code`.
- A rejected flag on the CLI (for example `chromeStatus --cdp-port abc`) is traced too: telemetry starts before any flag is validated (`--log-dir` is read from the command line first), and the refused call writes the start and error span of the operation the command line names. A command line that names no operation has no operation id and writes no span.
- `--help` is not a dispatch: it starts no telemetry and writes no span. The same holds for `-h` and for running the CLI with no arguments (both print the help).

## Where the records go

`--log-dir <path>` selects the directory of the telemetry files; the default is the sox-telemetry default.
