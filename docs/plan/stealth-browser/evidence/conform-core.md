# conform-core evidence: packages/stealth/stealth-core-browser

Layout moved to main's convention: `src/test/**` is gone; unit specs live in `test/unit/**`, support modules in `test/helpers/**`, fixtures in `test/fixtures/**`. Gate runs were fresh (`--skip-nx-cache` on every nx target).

Scanner and nx exit codes:

EXIT node tools/nx-plugins/test/executors/wiring/check-test-layout.mjs: 0
EXIT node tools/nx-plugins/test/executors/wiring/check-test-headers.mjs: 0
EXIT node tools/nx-plugins/test/executors/wiring/check-skip-expiry.mjs: 0
EXIT pnpm nx run stealth-core-browser:lint: 0
EXIT pnpm nx run stealth-core-browser:typecheck: 0
EXIT pnpm nx run stealth-core-browser:typecheck-spec: 0
EXIT pnpm nx run stealth-core-browser:test: 0
EXIT pnpm nx run stealth-core-browser:build: 0

Test lane: 126 spec files passed, 1208 tests passed (`stealth-core-browser:test`).
Header baseline: `tools/nx-plugins/test/executors/wiring/test-headers.baseline.json` is byte-identical to main.
Completed-state guards: `cdp-test-harness`, `tests-use-cases` and `failsafe-inventory` exit 0.
