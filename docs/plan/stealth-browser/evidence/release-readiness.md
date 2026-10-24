# Evidence: release-readiness (branch stealth-browser)

Worktree: `/Users/nix/dev/node/adhd/.worktrees/stealth-browser`. Start HEAD: `a345c9001`.
`origin/main` resolved to `cce416273fe6a0b85f2901cd1bf144f2d2962ded` (the affected base; it may be stale relative to the local `main`).

## Gate exit codes

EXIT pnpm check:release-ranges: 0
EXIT pnpm release:dry: 130
EXIT nx affected: 1
EXIT check-test-wiring: 1
EXIT check-skip-expiry: 0
EXIT check-lane-reachability: 0

Commands behind each line:

- `pnpm check:release-ranges`: `node tools/nx-plugins/build/executors/range-check/check-release-ranges.mjs`. Output: 69 publishable projects, 57 unique `@adhd/*` names, "OK".
- `pnpm release:dry`: build, dry-run version, range check, dry-run publish, for 69 projects. The publish phase failed in `test` for `policy`, `backlog` and `decompile-cli`, so nx did not run `publish --dryRun` for them. Full log and first failure: `docs/plan/stealth-browser/release-readiness/release-dry.log.md`.
- `npx nx affected --base=origin/main --head=HEAD --target=test` (flags from `.githooks/lib/pre-push-flags.mjs`, which excludes `e2e`). Failed task: `decompile-cli:test`. Nx flagged `backlog:test` and `policy:test` as flaky. Full log and first failure: `docs/plan/stealth-browser/release-readiness/nx-affected.log.md`.
- `node tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs`: reports `agent-store-runtime` and `agent-store-prompts` as having tests but no `test` target. Full output: `docs/plan/stealth-browser/release-readiness/check-test-wiring.log.md`.
- `node tools/nx-plugins/test/executors/wiring/check-skip-expiry.mjs`: expired 0, unannotated 843 (baseline review 2027-01-31).
- `node tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs`: lane reachability OK.

## Root causes of the non-zero gates

1. `check-test-wiring` (1). The check reads only literal keys in each project.json `targets` (`check-test-wiring.mjs` line 33). `agent-store-runtime` and `agent-store-prompts` declare no literal `test` target, and their `test` target is inferred by an Nx plugin. Evidence: in the `release:dry` run, `nx run agent-store-runtime:test` and the `agent-store-prompts` test ran successfully. The check's assumption predates the "rely on plugin inference" refactor (commit `c6d6e055f`). The two packages' tests are not unwired.
2. `decompile-cli:test` (the affected gate, 1; a publish-phase failure in `release:dry`). Thirteen tests fail with `ENOENT` on `entrypoint/decompile-cli/src/tests/fixtures/*`. That directory is absent from the worktree and is not tracked by git (`git ls-files` returns nothing). The cause of the missing fixtures is not established by this run.
3. `policy:test` (`release:dry` 130; flaky in the affected run). Thirteen failures in 4 files. The baked artifact in `entrypoint/policy/dist` was written by extractor `0.3.6`, but the live extractor is `0.3.7`. So every baked-artifact check reports "ignoring the baked operation surface" and the staleness assertions fail. The same run also shows 5000 ms timeouts in `t-r9-package-startup` and `t-r9-telemetry`.
4. `backlog:test` (`release:dry`; flaky in the affected run). Two failures in the release run, including `test/unit/c8-vocabulary.spec.ts` > "describeBacklogSurface enumerates the pinned verbs and assertSurfaceIsReal passes on the build".

The range-drift hypothesis (`@adhd/apigen-engine-runtime` pinned `^0.3.3` in `entrypoint/stealth-search/package.json` line 42) is not what failed here. `check:release-ranges` passed.

## Side effect of `pnpm release:dry` (reverted)

The publish phase runs the `version` executor as a dependency without `ADHD_NX_VERSION_DRY_RUN`, so it wrote version bumps to 64 tracked `package.json` and `CHANGELOG.md` files under `packages/` and `entrypoint/`. It also created 2 new CHANGELOG files. Those were not in the worktree before the run. They were reverted with `git restore` on the 64 tracked paths and removed for the 2 new files. The worktree again shows only the 3 pre-existing entries (`events.ndjson`, `evidence/tripwire/pack-gates.json`, untracked `evidence/gates-first.json`).

## sync-global readiness

Bins: `stealth-search` and `stealth-search-mcp`. Full analysis: `docs/plan/stealth-browser/release-readiness/sync-global.md`.

`node tools/nx-plugins/build/executors/sync-global/sync-global.mjs --dry-run --projects=stealth-search` exited 0. Summary rows:

- pnpm `/Users/nix/Library/pnpm` [stealth-search, stealth-search-mcp]: not-installed, verified=n/a
- npm `/Users/nix/.nvm/versions/node/v24.11.1` [stealth-search, stealth-search-mcp]: not-installed, verified=n/a
- nvm `v20.20.2` [stealth-search, stealth-search-mcp]: not-installed, verified=n/a

No pre-existing shim exists for either bin.

## Approval check (AGENTS.md:25)

APPROVAL-CHECK: tripwire=ok core=ok search=ok

- `@adhd/resilience-core-tripwire`: `APPROVAL-tripwire.md`, dated 2026-10-12. Verbatim request: "Implement tripwire package in this plan covering all 3".
- `@adhd/stealth-core-browser`: `APPROVAL-split.md` item 2, dated 2026-10-13. Verbatim request quoted in `APPROVAL-split.md` line 5: "port search to the entrypoint transfering all the apigen / tracing requirements over to the cli and mcps for search (which is built on top of the stealth core. Rename the entrypoint stealth search and the cdp to stealth core browser. Similar target slightly more work in the entrypoint, actual purpose. no need to do a full phase on confirming the logs just have an agent fully validate that they are being written - tests are unneeded".
- `@adhd/stealth-search`: `APPROVAL-split.md` item 3, same request and date as above.
