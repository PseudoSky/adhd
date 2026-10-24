# release-gate-fixes evidence

## Fixes landed

1. check-test-wiring.mjs reads the resolved Nx project graph once (`nx graph --file`) and counts a plugin-inferred `test` target; a project with specs and no literal or inferred `test` target still fails with exit 1. Proof: check-test-wiring.spec.mjs (inferred case, negative control).
2. package.json `release:dry` begins with `export ADHD_NX_VERSION_DRY_RUN=1 &&`, so the build, version and publish run-many invocations all inherit it. Proof: release-dry-clean.spec.mjs. A full `pnpm release:dry` run with the variable not pre-set left `git status --porcelain` identical to its state before the run.
3. decompile-cli index.spec.ts resolves its fixtures from `test/fixtures` relative to the spec file; `nx run decompile-cli:test --skip-nx-cache` exits 0.

## Backlog

ROOT-CAUSE backlog: the non-dry `publish`->`version` chain bumped packages apigen-core-client package.json 0.3.6 to 0.3.7 mid-run, while backlog's cached baked dist/api.ir.json recorded extractorVersion 0.3.6, so readBakedIrArtifact (entrypoint/backlog/src/ir-artifact.ts, extractorVersion !== EXPECTED_EXTRACTOR_VERSION) refused the artifact and assertSurfaceIsReal threw "no valid baked IR artifact" in c8-vocabulary.spec.ts AC3.

Evidence: the failing run log shows `ignoring the baked operation surface (artifact was baked by extractor 0.3.6, this install has 0.3.7)` and the c8-vocabulary AC3 failure with `no valid baked IR artifact`; `nx run backlog:test` alone passes because nothing bumped the extractor. With fix 2 the version executor stays dry for the whole chain, no package.json is rewritten, and backlog:test passed inside the release chain (`nx run backlog:test` succeeded in the last task of the run). No change to the spec or project.json is needed: the spec correctly refuses a stale artifact.

## Open blocker (outside owned paths)

With the variable covering the whole chain, `pnpm release:dry` exits 130 at `publish --dryRun`: nine projects (apigen-core-client, agent-core-native-tooling, policy-core-client, dispatch-orchestrator, agent-generator-plugin, apigen-generator-nx, decompile-cli, ui-react-base-hooks, workspace-codegen-nx) fail in tools/nx-plugins/build/executors/publish/impl.js (~lines 391-398): "already on npm but the built content DIFFERS from it and the version was not bumped". Dry `version` cannot bump, and that branch fails before consulting `options.dryRun`. Proposed fix: in that branch, when `options.dryRun` or `ADHD_NX_VERSION_DRY_RUN=1`, report that a bump would be required and succeed.
