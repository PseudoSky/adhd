# AGENTS.md — `@adhd/stealth-core-browser`

Factual notes for LLM/agent consumption. This file is not marketing.

## What this package is

`@adhd/stealth-core-browser` launches Chrome with `--remote-debugging-port` (never `--enable-automation`) and reads pages over CDP using network capture and DOM walks only (never `Runtime.evaluate`). Those two choices are the entire meaning of "stealth" here; the package makes no claim that a site cannot detect it. It is a library only: the CLI and the MCP server live in `@adhd/stealth-search` (`entrypoint/stealth-search`), which projects this package's six verbs. See `README.md`.

## Public surface

One entry, the package root. No subpath exports, no default export. Version policy: 0.x; the six verbs and their types are the stable surface, the namespaces are experimental until 1.0.

- Flat verbs (`src/api.ts`), each takes one plain object: `chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`.
- Namespaces (`src/index.ts`): `cdp`, `storage`, `capture`, `parsers`, `chromeManager`, `lifecycle`, `recording`, `endpoint`.
- Errors: `StealthCoreBrowserError`, `ERROR_CODES`, `exitCodeFor`. Every failure is a `StealthCoreBrowserError` with a stable `code`; the registry is `docs/ERRORS.md`.

## Facts that change what code you write

- Defaults: host `127.0.0.1`, port `9222`, profile `~/Library/Application Support/Google/Chrome-CDP` on macOS. Full table: `docs/CONFIGURATION.md`. Never connect to or kill the developer's Chrome on 9222.
- `host` is loopback-only unless the hosting process called `endpoint.configureEndpointPolicy({ allowHosts })`. A verb input cannot widen it. A refusal is `CDP_UNREACHABLE` with `detail.reason` `invalid-endpoint`.
- `launchChrome` accepts only `port` and `userDataDir`. `chromePath` and `extraArgs` are library-level (`cdp`) options and are not verb inputs.
- `shutdownChrome` never throws for a failed soft shutdown: it returns `{ ok, running }`. An invalid endpoint still rejects.
- `getPageContext` returns cookie counts, never names or values. The `storage` readers open Chrome databases read-only and immutable.
- Lifecycle state lives in `<os.tmpdir()>/stealth-browser-<uid>-<port>` (mode 0700). If it cannot be created the manager runs degraded: idle Chrome is not closed automatically.
- Google result-page parsers in `parsers` are provisional and verified against synthetic fixtures only.
- macOS is the verified platform. Linux and Windows code paths exist and are untested.

## Layout

- `src/` library source (relative imports use `.js` specifiers); unit specs `test/unit/**/*.spec.ts`, support modules in `test/helpers/`, fixtures in `test/fixtures/`.
- `examples/` runnable usage, one file per verb and namespace, each targeting port 9333; `docs/` public documentation (`docs/ERRORS.md` is the error-code registry, `docs/CONFIGURATION.md`, `docs/RESPONSIBLE-USE.md`, `docs/EXAMPLES.md`, `docs/reference/` the API and protocol reference).

## Targets

`build` (vite), `typecheck`, `typecheck-spec`, `test` (the unit lane, `test/unit`), `test-wiring`, `lint`, `verify-dist-load`, `dist-manifest`. There is no e2e target: every spec mocks process, network and fs, and no spec starts Chrome.

## Constraints

- Node >= 22.5 (built-in `node:sqlite`).
- Specs never start Chrome; any spec that needs a port uses a mocked process table on a non-default port.
- Documentation claims must match `docs/marketing/.catalog/capabilities.json`.
