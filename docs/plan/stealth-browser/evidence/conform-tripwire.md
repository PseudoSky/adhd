# conform-tripwire — evidence

Worktree `/Users/nix/dev/node/adhd/.worktrees/stealth-browser`, branch `stealth-browser`. Package `packages/resilience/resilience-core-tripwire`.

Exit codes of each wiring scanner and nx target, recorded from the worktree after the move.

EXIT node tools/nx-plugins/test/executors/wiring/check-test-layout.mjs: 1
EXIT node tools/nx-plugins/test/executors/wiring/check-test-headers.mjs: 1
EXIT node tools/nx-plugins/test/executors/wiring/check-skip-expiry.mjs: 0
EXIT pnpm nx run resilience-core-tripwire:lint: 0
EXIT pnpm nx run resilience-core-tripwire:typecheck: 0
EXIT pnpm nx run resilience-core-tripwire:typecheck-spec: 0
EXIT pnpm nx run resilience-core-tripwire:test: 0
EXIT pnpm nx run resilience-core-tripwire:build: 0

Scanner scope: the two scanners that exit 1 are repository-wide. Every violation line they print names a package other than `packages/resilience/resilience-core-tripwire/`. `check-test-layout.mjs` names `packages/stealth/stealth-core-browser/` (L5, L6, L8) and `check-test-headers.mjs` names `entrypoint/stealth-search/` (H1). No line names this package in either output.

Test run: `pnpm nx run resilience-core-tripwire:test` ran 20 spec files and 311 tests, all passing. `typecheck-spec` type-checked 24 files with 0 errors against an empty baseline.
