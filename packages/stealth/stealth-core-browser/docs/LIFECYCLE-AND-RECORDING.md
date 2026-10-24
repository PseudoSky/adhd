# Lifecycle and recording namespaces

Members of the `lifecycle`, `recording` and `endpoint` namespaces, which have no per-file reference. Both are experimental until 1.0. Defaults are in [CONFIGURATION.md](CONFIGURATION.md); error codes in [ERRORS.md](ERRORS.md). Runnable scenarios: `examples/namespaces/lifecycle.ts` and `examples/namespaces/recording.ts` ([EXAMPLES.md](EXAMPLES.md)).

## `lifecycle`

| Member | Purpose |
|---|---|
| `managerFor`, `configureManagers`, `chromeExitTarget` | The manager seam: one Chrome manager per host and port, and its settings |
| `createProxyReaperLink`, `defaultReaperEntry`, `reaperSingletonKey`, `REAPER_ENTRY_SCRIPT`, `LINK_GIVE_UP_MS`, `ReaperLink` | The connection to the per-port reaper host |
| `reaper-host` and `reaper-entry` exports | The reaper host that registers clients and performs the ordered reap |
| `reap-policy` exports, `ReaperScope` | The decision whether an idle Chrome may be closed (`launched-only` or `port-occupant`) |
| `page-tier` exports | Counting open http(s) pages as active use |
| `createLaunchBreaker` and `breakerPath` | The launch circuit breaker: three failed launches within 60 s open it for 30 s |
| `createOwnershipStore` | The owner record of a Chrome this tool launched (pid and start token) |
| `resolveStateDir`, `defaultStateDir` | The private per-user, per-port state directory |
| `isolated-page` exports | Open an isolated page target and dispose it afterwards |
| `exit-hooks` exports | Soft shutdown on process exit |
| `lifecycleError`, `LifecycleError` | Typed lifecycle errors (`LAUNCH_FAILED` and the other codes in ERRORS.md) |

## `recording`

| Member | Purpose |
|---|---|
| `NetworkRecorder` | Collects the network exchanges of a page, with headers merged from the extra-info events |
| `MemoryRecordingSink` | Keeps recorded exchanges in memory |
| `StoreRecordingSink`, `openStoreRecordingSink`, `recordingDdl`, `DEFAULT_RECORDING_TABLE`, `RECORDING_SCHEMA_VERSION` | Persist exchanges through a store adapter |
| `redactHeaders`, `DEFAULT_REDACTED_HEADERS`, `REDACTED` | Opt-in masking of cookie and authorization headers; pass `redactHeaders()` as the recorder's `redact` option |
| `CaptureError`, `CAPTURE_ERROR_CODES` | Capture errors (`CAPTURE_*` codes) |
| `decodeBody`, `mergeHeaders`, `EXTRA_INFO_BUFFER_MAX`, `EXTRA_INFO_BUFFER_TTL_MS` | Body decoding and header-merge helpers |

## `endpoint`

`DEFAULT_HOST`, `DEFAULT_PORT`, `allowedHosts`, `assertSameEndpoint`, `configureEndpointPolicy`, `isLoopbackHost`, `portOf`, `resolveEndpoint`. See the endpoint policy section of the [README](../README.md).
