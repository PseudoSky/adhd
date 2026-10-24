# AGENTS.md — `@adhd/stealth-core-browser`

Factual notes for LLM/agent consumption. This file is not marketing.

## What this package is

`@adhd/stealth-core-browser` launches Chrome with `--remote-debugging-port` (never `--enable-automation`) and drives it over CDP using DOM walks only (no `Runtime.evaluate`). It exposes a library only: the CLI and the MCP server live in `@adhd/stealth-search` (`entrypoint/stealth-search`), which composes this package's verbs. See `README.md`.

## Layout

- `src/` library source (relative imports use `.js` specifiers); unit specs `test/unit/**/*.spec.ts`, support modules in `test/helpers/`, fixtures in `test/fixtures/`.
- `examples/` runnable usage; `docs/` reference (`docs/ERRORS.md` is the error-code registry).

## Targets

`build` (vite), `typecheck`, `typecheck-spec`, `test` (the unit lane, `test/unit`), `test-wiring`, `lint`, `verify-dist-load`, `dist-manifest`. There is no e2e target: every spec mocks process, network and fs, and no spec starts Chrome.

## Constraints

- Node >= 22.5 (built-in `node:sqlite`).
- Never connect to or kill the developer's Chrome on port 9222; specs never start Chrome, and any spec that needs a port uses a mocked process table on a non-default port.
