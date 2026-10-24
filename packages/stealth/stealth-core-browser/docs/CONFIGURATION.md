# Configuration

Every default of `@adhd/stealth-core-browser`, verbatim from the source, and the options that change them. The package has no environment-variable toggles and no config file: configuration is typed input to a call, or a one-time call made by the process that hosts the verbs.

## Defaults

| Setting | Default | Where it comes from |
|---|---|---|
| CDP host | `127.0.0.1` | `DEFAULT_HOST` in `src/lib/endpoint.ts` |
| CDP port | `9222` | `DEFAULT_PORT` in `src/lib/endpoint.ts` (and `DEFAULT_CDP_PORT` in `src/lib/cdp/browser.ts`) |
| Chrome profile (macOS) | `~/Library/Application Support/Google/Chrome-CDP` | `googleSupportDir()` joined with `DEFAULT_PROFILE_NAME` (`Chrome-CDP`) |
| Chrome profile (Linux) | `$XDG_CONFIG_HOME/google/Chrome-CDP`, or `~/.config/google/Chrome-CDP` | `googleSupportDir()` in `src/lib/helpers.ts` |
| Chrome profile (Windows) | `%LOCALAPPDATA%\Google\Chrome-CDP` | `googleSupportDir()` in `src/lib/helpers.ts` |
| Lifecycle state directory | `<os.tmpdir()>/stealth-browser-<uid>-<port>` | `defaultStateDir()` in `src/lib/lifecycle/state-dir.ts` |
| Idle timeout | `120_000` ms (2 minutes) | `ChromeManagerOptions.idleTimeoutMs` |
| Shutdown grace | `30_000` ms | `ChromeManagerOptions.shutdownGraceMs` |
| Orphan window | `30_000` ms | `ChromeManagerOptions.orphanWindowMs` |
| Reaper scope | `port-occupant` | `ChromeManagerOptions.reaperScope` |
| History keeps Chrome alive | `true` (a visit within 2 minutes) | `ChromeManagerOptions.checkHistory` |
| Keep alive | `false` (the idle timer is armed) | `ChromeManagerOptions.keepAlive` |
| `checkChromeActivity` window | `2` minutes | `CheckChromeActivityInput.withinMinutes` |

The profile is a dedicated one, separate from your everyday Chrome profile (`Chrome`, or `google-chrome` on Linux), so launching never touches the profile you browse with.

## Overriding the port and the profile

The six verbs take one plain object. `launchChrome` exposes exactly two settings:

```ts
await launchChrome({ port: 9333, userDataDir: '/path/to/dedicated-profile' })
```

- `port` is the remote-debugging port (`--port` on a host such as the stealth-search CLI maps onto it).
- `userDataDir` is the Chrome user data directory (`--user-data-dir` on a host). `checkChromeActivity` and `getPageContext` accept the same `userDataDir` to read history and cookies from that profile.
- `chromePath` and `extraArgs` exist on the library-level `cdp` launch function only. They are deliberately not part of any verb input: reachable over MCP they would be arbitrary command execution.

Every runnable example under `examples/` targets port `9333`, never `9222`; see [EXAMPLES.md](EXAMPLES.md).

## Endpoint policy

Verbs accept `host` and `port`. Only loopback hosts (`127.0.0.1`, `localhost`, `::1`) are accepted by default; any other host is refused with `CDP_UNREACHABLE` (`detail.reason` `invalid-endpoint`) before a socket is opened. The process that hosts the verbs opts a remote Chrome in once:

```ts
import { endpoint } from '@adhd/stealth-core-browser'

endpoint.configureEndpointPolicy({ allowHosts: ['chrome.internal'] })
```

A verb input can never widen the policy. Errors are listed in [ERRORS.md](ERRORS.md).

## Lifecycle state directory

`<os.tmpdir()>/stealth-browser-<uid>-<port>` is a per-user, per-port directory with mode `0700`. It holds:

- the ownership record `chrome-<port>.json` (the pid and start token of a Chrome this tool launched);
- the launch circuit-breaker file `breaker-<port>.json` (three failed launches within 60 s open the breaker for 30 s);
- the reaper socket the managers connect to.

If the directory cannot be created or is not safely owned, the manager runs in degraded mode: `ready()` still succeeds, `status().reaper` is `false`, an idle Chrome is not closed automatically, and one warning is logged.

## Chrome manager options

`ChromeManagerOptions` (namespace `chromeManager`) in full: `cdpHost` (default `127.0.0.1:9222`), `idleTimeoutMs`, `keepAlive`, `entryPath`, `userDataDir`, `checkHistory`, `shutdownGraceMs`, `orphanWindowMs`, `stateDir`, `reaperScope`, `link`, `logger` (default `console.error`).

- `stateDir` replaces the state directory above.
- `reaperScope: 'port-occupant'` (default) lets the reaper close whichever Chrome answers on the port; `'launched-only'` closes only a Chrome whose ownership record proves this tool launched it.
- `orphanWindowMs` is how long a reaper nobody uses stays alive after Chrome is gone.

A Chrome that answers on the port but was not started with this profile is not attached to: `LAUNCH_FAILED` with `detail.reason` `foreign-profile`.

## Platform support

The package is developed and verified on macOS first. Support by platform:

| Platform | Status |
|---|---|
| macOS | Supported. The default profile path, the Chrome binary path (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`) and the `lsof`/`ps` process probes are exercised here. |
| Linux | Code paths exist (`$XDG_CONFIG_HOME` profile directory, `which google-chrome`/`chromium`/`chromium-browser`, the `fuser` fallback) but are untested; treat as not supported until verified. |
| Windows | A profile directory and a default `chrome.exe` path exist in the source, but the process probes shell out to `lsof`, `fuser` and `ps`, which Windows does not provide. Untested and not supported. |

The unit suite mocks the process table, the filesystem and the network on every platform; no spec starts Chrome, so none of the above is proven by an end-to-end run against a real browser. Node.js 22.5 or newer is required (built-in `node:sqlite`).
