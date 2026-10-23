# fix-core-errors evidence

Change: removed the `Symbol.hasInstance` bridge and the `InvalidEndpointError` RangeError subclass from `src/errors.ts`; `StealthCoreBrowserError.invalidEndpoint` now returns a plain `StealthCoreBrowserError` (code CDP_UNREACHABLE, detail.reason invalid-endpoint). Consumers of the bridge: none outside stealth-core-browser (`rg "hasInstance|invalidEndpoint|invalid-endpoint"` over packages/ finds only this package). Specs api.spec.ts, registry.spec.ts, api-launch-errors.spec.ts moved from RangeError/instanceof to the typed code.

RED: test/unit/surface/api.spec.ts "an invalidEndpoint failure carries a typed code ..." on untouched src: AssertionError: expected [Function InvalidEndpointError] to be [Function StealthCoreBrowserError] (error.constructor), api.spec.ts:89
GREEN: same spec after the fix: Test Files 14 passed, Tests 169 passed (test/unit/surface + test/unit/errors)

EXIT pnpm nx run stealth-core-browser:lint: 0
EXIT pnpm nx run stealth-core-browser:typecheck: 0
EXIT pnpm nx run stealth-core-browser:typecheck-spec: 0
EXIT pnpm nx run stealth-core-browser:test: 0
EXIT pnpm nx run stealth-core-browser:build: 0
