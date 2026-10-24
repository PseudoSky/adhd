# stealth-core-browser

This library was generated with [Nx](https://nx.dev).

## Building

Run `nx build stealth-core-browser` to build the library.

## Running unit tests

Run `nx test stealth-core-browser` to execute the unit tests via [Vitest](https://vitest.dev/).

## Endpoint policy (`endpoint` namespace)

Every verb and the chrome manager address Chrome through the `endpoint` namespace of the package root. By default only loopback hosts (`127.0.0.1`, `localhost`, `::1`) are accepted; any other `host` input is refused with `CDP_UNREACHABLE` (`detail.reason` `invalid-endpoint`) before a socket is opened. The process that hosts the verbs opts a remote Chrome in once, never a verb input:

```ts
import { endpoint } from '@adhd/stealth-core-browser'

endpoint.configureEndpointPolicy({ allowHosts: ['chrome.internal'] })
endpoint.resolveEndpoint({ host: 'chrome.internal', port: 9333 }) // { host, port, cdpHost: 'chrome.internal:9333' }
```

The `stealth-search` host exposes the same opt-in as `--allow-cdp-hosts <comma-separated list>`. Members: `DEFAULT_HOST`, `DEFAULT_PORT`, `allowedHosts`, `assertSameEndpoint`, `configureEndpointPolicy`, `isLoopbackHost`, `portOf`, `resolveEndpoint`. See `docs/reference/README.md` for the full policy.
