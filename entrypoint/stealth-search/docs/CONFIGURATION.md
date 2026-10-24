# Configuration

Both bins (`stealth-search` and `stealth-search-mcp`) take every setting from command-line flags. No environment variable is read anywhere in the package. `--help` prints the whole flag table with its defaults.

## Platform support

macOS is the supported platform: the Chrome-CDP profile default and the process handling the package ships were written and exercised on macOS. Other platforms are untested. The core resolves a per-platform Google application-data directory for Windows (`%LOCALAPPDATA%\Google`) and for other systems (`$XDG_CONFIG_HOME/google`, default `~/.config/google`), but Windows and Linux are not tested by this package and are not supported. Node.js 22.5 or newer is required on every platform (`NODE_TOO_OLD` otherwise).

## Chrome defaults

| Setting | Default | Flag |
| --- | --- | --- |
| Remote-debugging host | `127.0.0.1` | `--cdp-host <host>` |
| Remote-debugging port | `9222` | `--cdp-port <n>` |
| Chrome profile (`launchChrome`) | `~/Library/Application Support/Google/Chrome-CDP` (the `Chrome-CDP` profile under the Google application-data directory) | `--user-data-dir <path>` |
| State directory of a launched Chrome (reaper socket, owner record, launch-breaker state) | `<os.tmpdir()>/stealth-browser-<uid>-<port>`, created mode 0700 | none (derived from the port) |

The port default `9222` is the value the Chrome operations use when no port is given. The `launchChrome` operation takes its own `--port` and `--user-data-dir` inputs (`launchChrome --port 9333`); the host flags `--cdp-port` and `--user-data-dir` set the port and the profile when the call gives none. `launchChrome` takes only a port and a profile directory: no binary path and no extra Chrome arguments.

An unsafe or uncreatable state directory does not throw: the Chrome manager runs in degraded mode.

The `host` input of the Chrome operations and of `search` is restricted to loopback (`127.0.0.1`, `localhost`, `::1`). A remote Chrome needs `--allow-cdp-hosts <list>` (comma-separated), or a non-default `--cdp-host`, which is allowed for that run.

## State on disk

| Setting | Default | Flag |
| --- | --- | --- |
| Data root for tripwire, cooldown and audit state | `~/.adhd/reverse/data` | `--data-dir <path>` |
| Audit log | `audit.log` under the data directory | `--audit-path <path>` |
| Audit log cap | `5242880` bytes | `--audit-max-bytes <bytes>` |
| Telemetry record files | the `@adhd/sox-telemetry` default directory | `--log-dir <path>` |

Runtime state files are written owner-only (0600).

## Guard defaults

| Setting | Default | Flag |
| --- | --- | --- |
| Tripwire time to live | `7200000` ms (2 h) | `--tripwire-ttl-ms <ms>` |
| Cooldown after a `captcha` outcome | `30000` ms | `--cooldown-captcha-ms <ms>` |
| Cooldown after a `rate_limited` outcome | `20000` ms | `--cooldown-rate-ms <ms>` |
| Cooldown after a `banned` outcome | `60000` ms | `--cooldown-banned-ms <ms>` |
| Searches in flight per process | `2` (0 or less disables the cap) | `--max-concurrent <n>` |
| Sibling host processes tolerated before a warning | `4` (launching is never refused) | `--max-siblings <n>` |
| Registry of live host pids | none | `--pid-file <path>` |

## Chrome lifetime

| Setting | Default | Flag |
| --- | --- | --- |
| Idle shutdown of the Chrome this host launched | `120000` ms | `--idle-shutdown <ms>` |
| Never close Chrome on idle | off | `--keep-alive` |
| Soft-shut Chrome down before the first operation | off | `--restart-browser` |
| Let a recent Chrome history visit keep Chrome alive | off | `--check-history` |

## MCP transport

| Setting | Default | Flag |
| --- | --- | --- |
| Transport | `stdio` (also `sse`, `streaming-http`) | `--transport <name>` |
| Listen port (sse, streaming-http) | `3100` | `--listen-port <n>` |
| Listen host (sse, streaming-http) | `127.0.0.1` | `--listen-host <addr>` |
| Allow a non-loopback listen host | off | `--allow-remote-listen` |

`sse` and `streaming-http` carry no authentication and expose `launchChrome` and `shutdownChrome`; keep them on loopback or behind your own authenticating proxy. Any other transport name is refused with `HOST_TRANSPORT_UNSUPPORTED`.

## Output and diagnostics

| Setting | Default | Flag |
| --- | --- | --- |
| Pretty-print the JSON result (CLI) | off | `--pretty` |
| Resource usage on stderr (CLI) | off | `--monitor` |
| Internal logs on stderr | off | `--verbose` |
| Log level | `silent` for the CLI, `info` for the MCP host | `--log-level <level>` |
| Log format | `pretty` on a terminal, `json` otherwise | `--log-format <format>` |
| Log file instead of stderr | none | `--log-file <path>` |
| One JSON line per boot stage | none | `--trace-file <path>` |

See [OBSERVABILITY.md](OBSERVABILITY.md) for what the logs and telemetry records contain.

## Bad values

A flag with a bad value (a non-integer where an integer is expected, a port outside 1 to 65535, an unknown log level) fails with `HOST_FLAG_INVALID`, exit status 77, before anything else runs. See [ERRORS.md](ERRORS.md).
