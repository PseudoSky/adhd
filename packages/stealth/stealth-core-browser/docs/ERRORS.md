# Errors

Every failure a caller of `@adhd/stealth-core-browser` can hit is a `StealthCoreBrowserError`: one class with a stable `code`, a `remediation` that names a concrete next step, an optional `cause` and structured `detail`. `CaptureError` (the `recording` namespace) and `LifecycleError` (the `lifecycle` namespace) extend it, so a single `instanceof StealthCoreBrowserError` covers every error of the package. No untyped `Error` escapes the library.

```ts
import { StealthCoreBrowserError, ERROR_CODES, exitCodeFor, launchChrome } from '@adhd/stealth-core-browser'

try {
  await launchChrome({ port: 9333 })
} catch (err) {
  if (err instanceof StealthCoreBrowserError) {
    console.error(`${err.code}: ${err.message}`) // stable code, text that names the fix
    process.exitCode = exitCodeFor(err.code)       // the exit status hosts apply
  } else throw err
}
```

`exitCodeFor(code)` returns the status in the Exit column; an unknown code (a host's own) maps to 1. `StealthCoreBrowserError.classifyLaunchFailure(error)` refines a launch failure: a cause chain holding `ENOENT` is `CHROME_NOT_FOUND`, `EADDRINUSE` is `PORT_IN_USE`, any other typed error keeps its code and an untyped one is `LAUNCH_FAILED`.

An endpoint that cannot address a Chrome (a port outside 1-65535 or non-integer, a host with a path or whitespace) is a plain `StealthCoreBrowserError` with code `CDP_UNREACHABLE` and `detail.reason` of `invalid-endpoint`; it is thrown before any socket is touched. Tell it apart by `error.code` (and `error.detail?.reason`), exactly as for every other code. It is not a `RangeError`.

The host is restricted to loopback (`127.0.0.1`, `localhost`, `::1`) unless the hosting process allowed more through `endpoint.configureEndpointPolicy({ allowHosts })`; any other host is refused the same way (`CDP_UNREACHABLE`, `detail.reason` `invalid-endpoint`) before a socket is touched. The debugger WebSocket URL a Chrome reports must point at the host that was asked, otherwise the call fails with `CDP_BAD_RESPONSE` (`detail.reason` `ws-host-mismatch` or `ws-url-invalid`); a CDP frame that is not a message fails every command in flight with `CDP_BAD_RESPONSE` (`detail.reason` `malformed-frame`) and drops the connection. A CDP HTTP request (`/json/version`, `/json/list`, `/json/new`) that does not answer within 5 s fails with `CDP_TIMEOUT`.

The codes below are listed in the order of `ERROR_CODES`.

## Environment

| Code | Exit | When | Remediation |
| --- | --- | --- | --- |
| `CHROME_NOT_FOUND` | 10 | No Chrome binary exists at the resolved path, or spawning it failed with ENOENT. | Install Google Chrome in its standard location (library callers may also pass chromePath to cdp.launchChrome), then retry. |
| `PORT_IN_USE` | 11 | The remote-debugging port is already taken (spawn failed with EADDRINUSE). | Free the port or choose another remote-debugging port. |
| `NODE_TOO_OLD` | 12 | The running Node.js is older than 22.5. Raised by the host preflight from this registry. | Upgrade Node.js to version 22.5 or newer. |
| `CHROME_NOT_RUNNING` | 13 | An operation needs a running Chrome and none answers. Raised by hosts from this registry. | Start Chrome with launchChrome, then retry. |

## Library

| Code | Exit | When | Remediation |
| --- | --- | --- | --- |
| `CHROME_START_TIMEOUT` | 20 | Chrome was spawned but its CDP endpoint did not answer within 10 s. | Check that the Chrome profile is not locked by another process, then retry the launch. |
| `CDP_UNREACHABLE` | 21 | Nothing answers on the CDP host and port, or the host or port you passed cannot address a Chrome (detail.reason is invalid-endpoint). | Start Chrome with launchChrome, or check the host and port you passed. |
| `CDP_BAD_RESPONSE` | 22 | The DevTools HTTP endpoint answered with an error status or a body that is not JSON. | Check that the endpoint is Chrome DevTools and that Chrome is not shutting down, then retry. |
| `TARGET_NOT_FOUND` | 23 | A created page target did not register in /json/list within 3 s. | List the open pages again and use a current target id. |
| `CDP_CONNECT_FAILED` | 24 | The CDP WebSocket failed or timed out before it opened. | Check that the page websocket URL is current and the page is still open, then retry. |
| `CDP_NOT_CONNECTED` | 25 | A command was sent on a session that is not connected. | Connect the session first and use it only while it is connected. |
| `CDP_TIMEOUT` | 26 | Chrome did not answer a CDP command within its timeout. | Increase the command timeout or retry when Chrome is less busy. |
| `CDP_REMOTE_ERROR` | 27 | Chrome answered a CDP command with a protocol error (detail.remoteCode). | Check the method name and parameters against the DevTools protocol, then retry. |
| `CDP_SESSION_CLOSED` | 28 | The session closed while a command was pending. | Open a new session and retry the operation. |
| `CDP_SEND_FAILED` | 29 | Writing a command to the CDP socket threw. | Reconnect the session and retry the command. |
| `NAVIGATION_FAILED` | 30 | Page.navigate reported an errorText. | Check the URL and the network, then retry the navigation. |
| `PAGE_SETTLE_FAILED` | 31 | awaitPageSettled was called with neither navigate nor loaderId. | Pass a navigate URL or a loaderId so the wait can scope to your navigation. |
| `OPERATION_ABORTED` | 32 | The caller aborted the operation through its AbortSignal (the abort reason is the cause). | Retry the operation if the abort was not intended. |
| `SELECTOR_TIMEOUT` | 33 | The result selector never appeared before the DOM-walk timeout. | Check the selector against the page or increase the timeout, then retry. |

## Capture (CaptureError)

| Code | Exit | When | Remediation |
| --- | --- | --- | --- |
| `CAPTURE_CONNECT_FAILED` | 40 | A capture could not connect to the page WebSocket. | Check that the page websocket URL is current and Chrome is running, then retry. |
| `CAPTURE_NAVIGATE_FAILED` | 41 | A capture could not navigate to its URL. | Check the navigate URL and the network, then retry the capture. |
| `CAPTURE_TIMEOUT` | 42 | Nothing was captured within the timeout, or closing the recorder timed out. | Increase the capture timeout or check that the page issues the expected request. |
| `CAPTURE_NO_MATCH` | 43 | No request matched the pattern, or the selector chose none of the captured responses. | Check the URL pattern against the requests the page makes, or relax it. |
| `CAPTURE_BAN_DETECTED` | 44 | The captured response is a ban or challenge page. | Wait, then retry with a different request pattern or solve the challenge in the visible page. |
| `CAPTURE_SESSION_CLOSED` | 45 | The CDP socket closed before any matching response was captured. | Keep the page open for the whole capture and retry. |
| `CAPTURE_SINK_FAILED` | 46 | A recording sink lost data or was written after it closed. | Check the recording sink storage and retry the capture. |
| `CAPTURE_SINK_UNAVAILABLE` | 47 | The recording store adapter could not be loaded or opened, or the table name is invalid. | Install the store adapter and pass a writable database path and a valid table name. |

## Lifecycle (LifecycleError)

| Code | Exit | When | Remediation |
| --- | --- | --- | --- |
| `LAUNCH_FAILED` | 60 | Chrome could not be launched, or the Chrome on the port is not this tool's own (detail.reason is foreign-profile). | Install Chrome in its standard location (library callers may also pass chromePath to cdp.launchChrome), free the port and retry. |
| `LAUNCH_LOCK_TIMEOUT` | 61 | The per-port launch lock was not released in time. | Remove the stale launch lock file if no launcher is running, then retry. |
| `CHROME_UNREACHABLE_AFTER_LAUNCH` | 62 | Chrome started but CDP did not answer afterwards. | Check that nothing else holds the port and the profile is not locked, then retry. |
| `LAUNCH_CIRCUIT_OPEN` | 63 | Three launches failed within 60 s; the breaker refuses until detail.retryAfterMs has passed. | Fix the launch error and retry after retryAfterMs. |
| `REAPER_UNAVAILABLE` | 64 | The idle reaper for the port could not be started. | Use a private state directory (mode 0700, own user) so the reaper can start. |
| `ISOLATED_CONTEXT_FAILED` | 65 | Opening an isolated page failed; the context was disposed. | Check that Chrome is reachable and retry opening the page. |
