# AGENTS.md — `@adhd/stealth-core-browser`

Factual notes for LLM/agent consumption. This file is not marketing.

## What this package is

`@adhd/stealth-core-browser` launches Chrome with `--remote-debugging-port` (never `--enable-automation`) and drives it over CDP using DOM walks only (no `Runtime.evaluate`). It exposes a library, a CLI (`bin/cli.ts`) and an MCP server (`bin/mcp.ts`). See `README.md`.

## Layout

- `src/` library source (relative imports use `.js` specifiers); unit specs `test/unit/**/*.spec.ts`, support modules in `test/helpers/`, fixtures in `test/fixtures/`.
- `bin/` CLI and MCP entry points, compiled by `build-bin` into `dist/bin` and `dist/src`.

## Targets

`build` (vite), `build-bin` (tsc), `typecheck`, `typecheck-spec`, `test` (unit lane), `e2e` (subprocess lane via `vitest.e2e.config.ts`), `lint`, `verify-dist-load`, `dist-manifest`.

## Constraints

- Node >= 22.5 (built-in `node:sqlite`).
- Never connect to or kill the developer's Chrome on port 9222; e2e uses a dedicated free port, temp user-data-dir and fake HOME.
