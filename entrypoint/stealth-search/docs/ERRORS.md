# Errors

Every failure a user can hit in `@adhd/stealth-search` is a `StealthSearchError` carrying a stable
`code`. `StealthSearchError` extends the core's `StealthCoreBrowserError`, so one
`instanceof StealthCoreBrowserError` covers the library and the entrypoint. The registry is
`SEARCH_ERROR_CODES` and the exit status of a code is `exitCodeFor(code)`, both exported from
`src/errors.ts`.

## Outcomes are data, not exceptions

A search or fetch result carries an `outcome` of `success|empty|error|timeout|hitl|captcha|rate_limited|banned`.
Outcomes are returned as data and never thrown. An error is thrown only for a failure the call could not
turn into a result (an unknown provider, a refused URL, a bad flag). A fetch whose URL is refused is
reported as an outcome `error` whose message carries `FETCH_URL_REFUSED`.

## Codes

| Code | Exit | Cause | Remedy |
| --- | --- | --- | --- |
| `UNKNOWN_PROVIDER` | 70 | The requested provider id is not registered. | Use one of the registered provider ids, then retry. |
| `SEARCH_FAILED` | 71 | A search could not run. `detail.reason` names why; `strategy-unsupported` means a forced strategy a provider cannot run (the message names the provider and the strategy). | Read the message and `detail.reason`, fix the query, provider or strategy option, then retry. |
| `SELECTOR_TIMEOUT` | 33 | A selector did not appear before the timeout (core code, re-listed). | Check the selector against the page or increase the timeout. |
| `HITL_ABORTED` | 2 | The human-in-the-loop challenge was abandoned or timed out. Exit 2 is the exit code of a `hitl` response. | Retry and solve the challenge in the visible browser, or choose another provider. |
| `TRIPWIRE_STATE_UNREADABLE` | 72 | The tripwire state file exists but cannot be read or parsed. | Check it is readable JSON in a private directory, or remove it to reset. |
| `TRIPWIRE_CLEAR_FAILED` | 73 | A tripped tripwire could not be cleared. | Check the state file is writable, then clear again. |
| `PROVIDER_STATE_IO` | 74 | Reading or writing per-provider state failed. | Check the state directory exists, is writable and not full. |
| `FETCH_URL_REFUSED` | 75 | The fetch URL is private, loopback or not http(s). Also carried in the message of a response outcome `error`. | Pass a public http(s) URL. |
| `PDF_EXTRACT_FAILED` | 76 | A PDF could not be extracted. | Check the URL serves a readable, non-encrypted PDF. |
| `HOST_FLAG_INVALID` | 77 | A CLI or host flag has an invalid value. | Run with `--help` and pass a valid value. |
| `HOST_TRANSPORT_UNSUPPORTED` | 78 | The requested MCP transport is not supported. | Use a supported transport. |
| `HOST_BOOT_FAILED` | 79 | The host failed while starting. | Read the cause, fix the configuration, start again. |
| `NODE_TOO_OLD` | 12 | Node.js is older than 22.5 (core code, re-listed). | Upgrade Node.js to 22.5 or newer. |

Any code outside this table (for example a core `CDP_*` code) keeps the core's exit status, or 1 when unknown.

## Rendering

CLI: one line on stderr, `<CODE>: <message>`, then the process exits with `exitCodeFor(code)`.

```
$ stealth-search search --provider nope "query"
UNKNOWN_PROVIDER: provider "nope" is not registered — Use one of the registered provider ids ...
$ echo $?
70
```

MCP: a typed failure (a `StealthSearchError`, or any core `StealthCoreBrowserError` that reaches the search host) is a tool result with `isError: true` (apigen ADR-0018), never a JSON-RPC rejection. The text is `<canonical>: <CODE>: <message>`: `<canonical>` is the apigen code (`invalid_argument` for `UNKNOWN_PROVIDER`, `HOST_FLAG_INVALID` and `FETCH_URL_REFUSED`, `internal` for every other typed code), `<CODE>` is the stable code of this table and `<message>` the message with its remediation. `_meta['adhd/error']` carries the canonical code. A thrown value that is not a typed error, an unknown tool name and a malformed request stay JSON-RPC protocol errors. A request the host schema rejects, such as `extraArgs` on `launchChrome`, answers with `invalid_argument` and no library code.

```json
{ "isError": true, "content": [{ "type": "text", "text": "invalid_argument: UNKNOWN_PROVIDER: provider \"nope\" is not registered — Use one of the registered provider ids ..." }], "_meta": { "adhd/error": { "code": "invalid_argument" } } }
```
