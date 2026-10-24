# search-mcp-iserror evidence: entrypoint/stealth-search

ADR-0018 (apigen): every ApiError is an isError tool result with `_meta['adhd/error']`; only non-ApiError throws reject.

## 4909102e decision

`StealthSearchError` extends the core's `StealthCoreBrowserError` (an `Error` with a string `code`). `ApiError` is a separate `Error` subclass with a canonical `ApiErrorCode`. One class cannot extend both, so a StealthSearchError cannot be made an ApiError. The apigen plugin therefore re-throws it and the client call rejects with a JSON-RPC error (message carried, isError unset). `UNKNOWN_PROVIDER` stays a rejection and `test/unit/hosts/mcp-error-channel.spec.ts` [search-mcp-iserror.2] tests exactly that, next to an ApiError from the same verb that is an isError result. Today the provider enum makes an unregistered provider an `invalid_argument` isError result at the schema boundary; `src/errors.ts` and `docs/ERRORS.md` now describe this.

## Red-first

The specs mcp-inprocess, use-cases/hosts (already isError after an earlier state) were tightened to assert the `invalid_argument` text and `_meta`; they passed on untouched source. The new error-channel spec was run on untouched source:

RED: test/unit/hosts/mcp-error-channel.spec.ts > 4909102e isError: src/errors.ts names the rejection form of a typed error and no longer claims an isError code form: AssertionError: expected src/errors.ts not to contain 'isError: true' (line 16 claimed "MCP form: a tool result with `isError: true` carrying the code and message")
RED: src/server.ts still defined `dereferenceSchema` and assembled the package by hand (guard search-mcp-iserror.3: missing /buildApigenPackage/, still has /dereferenceSchema/)
RED: project.json still had the `e2e` target with no test/e2e files (guard search-mcp-iserror.4)

## Fix and green

GREEN: stealth-search:test 61 files, 743 tests passed (mcp-error-channel, mcp-inprocess, use-cases/hosts, package included).
GREEN: src/server.ts uses `buildApigenPackage` from `@adhd/apigen-engine-runtime`, `dereferenceSchema` removed, `requireExplicitInput` kept (P1 spec: launchChrome requires data.input).
GREEN: `vitest.e2e.config.ts` and the `e2e` target removed; `node tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs` exits 0 and prints no line naming entrypoint/stealth-search.

## Gates (fresh, --skip-nx-cache)

EXIT pnpm nx run stealth-search:lint: 0
EXIT pnpm nx run stealth-search:typecheck: 0
EXIT pnpm nx run stealth-search:typecheck-spec: 0
EXIT pnpm nx run stealth-search:test: 0
EXIT pnpm nx run stealth-search:build: 0
EXIT node tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs: 0
