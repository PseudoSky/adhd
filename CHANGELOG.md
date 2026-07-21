## Unreleased

### Fixed — dist `package.json` version permanently stuck ahead of source for 3 packages (2026-07-20)

**BUILD-CONSIST-011 — `data-base-transforms`, `data-query-engine`, `ui-react-base-hooks` dist `package.json` reported `2.2.2` while source said `2.2.1` — and neither `npx nx reset` nor a full clean rebuild fixed it.**

Root cause (corrects the root-cause guess logged earlier the same day, which blamed Nx file-cache poisoning and predicted `nx reset` + rebuild would fix it — disproven this session): `@nx/vite:build`'s executor (`node_modules/@nx/vite/src/executors/build/build.impl.js:88`) only copies `package.json` into `dist/` when `generatePackageJson` is unset **and no `dist/.../package.json` already exists** (`!existsSync(distPackageJson)`) — a one-time seed on first build, not a sync performed on every build. `npx nx reset` clears Nx's task cache/daemon but never touches files already written to `dist/` on disk, so a stale `package.json` (mtime predating the session) survived a full `nx reset` + `npx nx run-many -t build` completely untouched — proven directly by mtime: every other file in each project's `dist/` (`index.js`/`.mjs`/`.umd.js`/`.d.ts`) got a fresh timestamp from the rebuild while `package.json` alone stayed frozen at its old one. Confirmed by contrast: `data-core-structures`, the one project already setting `generatePackageJson: true`, never drifted — that branch (`createPackageJson`) regenerates `package.json` from the live project graph unconditionally on every build.

Fix: added `"generatePackageJson": true` to the `build` target's `options` in all 3 projects' `project.json` (exact placement mirrored from `data-core-structures`), deleted the 3 stale `dist/.../package.json` files, and rebuilt just those 3 projects. Regression-checked the regenerated dist `package.json` against a captured before-fix baseline (`name`, `version`, `files`, `exports`, `main`, `module`, `types`, `dependencies`): every field preserved, and all `@adhd/*`/external dependency versions resolve to real pinned values (never `*` or missing) — `data-query-engine`'s dist `peerDependencies` in fact **improved**, now correctly populated with `@adhd/data-base-transforms: 2.2.1` (matching its own source `package.json`) instead of the old seed's empty `{}`. Verified: full-repo audit of all 53 buildable `package.json`s now shows `source == dist` version everywhere (the sole exception, `ui-react-base-storybook`, has no `build` target by design and was never in scope).

Commits: `2d51aa47261973f4fd94c345478c04a86df8c85b` (the 3 `project.json` fixes); original discovery logged at `088266df` and corrected same-day, removed from BACKLOG.md here per the completed-items convention.

### Fixed — 10 apigen packages shipped broken dist bundles (`__filename`/`timeOrigin` crash on load); generator enforcement added (2026-07-20)

**INVESTIGATION-BUILD-TOOL-001 — `@nx/vite:build` with `external: []` bundled `ts-morph`/`typescript` transitively into 10 `platform:node`/`platform:shared` apigen packages, crashing on load with `ReferenceError: __filename is not defined in ES module scope` (ESM) / `TypeError: Cannot read properties of undefined (reading 'timeOrigin')` (CJS).**

`verify-dist-load` caught this independently on `apigen-plugin-mcp`/`apigen-plugin-openapi` (a publish-preview dry-run session) and, via a full `npx nx run-many -t verify-dist-load --all` audit, on 8 more packages that all shared the same root cause: `@adhd/apigen-core-client` (imported by nearly every apigen package) declares real `ts-morph`/`typescript`/`ts-json-schema-generator` dependencies, and every downstream `@nx/vite:build` package with `rollupOptions.external: []` bundled its SOURCE (not its dist — Nx's `tsconfig.base.json` path mapping resolves `@adhd/*` straight to source at build time) directly in. Rollup's CJS→ESM interop then emitted `__filename`/`__dirname`/`require('perf_hooks')` references invalid in the resulting ESM chunk. Tarball bloat corroborated it: affected packages were ~25MB unpacked / ~6MB packed vs 2-31KB for unaffected siblings.

**Chose "keep `@nx/vite:build`, externalize real deps" over switching to `@nx/js:tsc`** — not because tsc wouldn't fix the bundling problem, but because this repo has **no yarn/npm workspace linking at all** (`node_modules/@adhd/*` doesn't exist, root `package.json` has no `workspaces` field — see `BUG-WORKSPACE-NO-LINKING-001`, filed not fixed). `@nx/js:tsc` doesn't bundle, so an unbundled `require('@adhd/x')` has nothing to resolve against at runtime; prototyping the tsc conversion on `apigen-core-client` immediately hit exactly that failure. Bundling `@adhd/*` source via `@nx/vite:build` + `nxViteTsPaths()` is the only mechanism in this repo that currently makes cross-`@adhd/*`-package runtime imports work, so it has to stay — only the real npm dependencies needed externalizing.

Changes:
- **`tools/vite-external-deps.mjs`** (new) — `externalizeRealDeps(packageJsonDir)` walks a package's own `dependencies`/`peerDependencies`, transitively following any bundled `@adhd/*` deps (resolved via `tsconfig.base.json` paths) to their own `package.json`s, and returns every REAL npm package name found (plus every Node builtin) as the `rollupOptions.external` value. `@adhd/*` names are never externalized. The transitive walk was necessary: externalizing only a package's OWN direct deps left `ts-morph` bundled anyway for e.g. `apigen-plugin-api-express`, which doesn't depend on it directly but bundles `apigen-core-client` source, which does.
- Applied to `apigen-core-client`, `apigen-engine-naming`, `apigen-engine-runtime`, `apigen-engine-conformance`, `apigen-codegen-openapi`, `apigen-plugin-mcp`, `apigen-plugin-openapi`, `apigen-plugin-api-express`, `apigen-plugin-api-fastify`, `apigen-plugin-cli-output` (the 10 previously broken), plus normalized the 6 already-passing apigen `@nx/vite:build` packages onto the same helper for consistency (`apigen-plugin-health`, `apigen-plugin-jsonschema`, `apigen-plugin-logger`, `apigen-plugin-py-flask`, `apigen-plugin-py-grpc`, `apigen-engine-gateway`).
- **`nx.json`** — added `tools/vite-external-deps.mjs`/`tools/vite-copy-readme.mjs` to `sharedGlobals` (these files live outside every project's own root, so Nx's cache was not invalidating on changes to them — discovered when a fix to the helper silently didn't reach a cached downstream build; `npx nx reset` used to evict the stale cache, not `--skip-nx-cache`).
- **Generator enforcement** — `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts`'s `patchViteConfig` now injects `externalizeRealDeps(__dirname)` into every newly-scaffolded `platform:node`/`platform:shared` package's `vite.config.ts` (leaves `platform:browser` as `external: []` — those are consumed by an app's own bundler, not run directly under Node). Proven with a real generator-driven test + negative control: `packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts` (disabling the enforcement block made 2/3 assertions fail, confirming the test has teeth).
- `entrypoint/apigen-cli/package.json` — `sync-deps`'d an unrelated pre-existing version-drift lint failure (`@adhd/apigen-plugin-openapi` pinned `0.1.1`, disk `0.1.2`) that was blocking full-workspace verification.

Verified: `npx nx run-many -t verify-dist-load --projects=<all 16 apigen packages>` — **exit 0**, every entry loads cleanly (was 9 failing pre-fix). Tarball sizes: `apigen-plugin-mcp` 25.1MB→67.6KB unpacked (18.6KB packed), `apigen-plugin-openapi` similar drop to 9.8KB unpacked (4.0KB packed) — same order-of-magnitude reduction across all 10. `npx nx run-many -t test --projects=<all 16>` — 267/267 tests pass, 0 regressions. `npx nx test workspace-codegen-nx` — 7/7 pass (3 new).

Residual/deferred: `BUG-WORKSPACE-NO-LINKING-001` (the tsc-side sibling defect this fix does NOT address — `agent-mcp`, `decompile-cli`, `agent-engine-compiler`, `agent-engine-orchestrator` still fail `verify-dist-load` for an unrelated reason: no real workspace linking), `BUG-BUILD-TSC-STALE-DIST-METADATA-001`, `BUG-DATA-CORE-STRUCTURES-DIST-TYPE-MISMATCH-001`, `BUG-APIGEN-CLI-VERIFY-DIST-LOAD-ARGV-001` — all filed, none in scope for this fix.

### Fixed — release publish silently skipped its build/test/verify-dist-load gate for selective (`--projects=`) publishes (2026-07-20)

**BUG-RELEASE-PUBLISH-GATE-BYPASS-001 (CRITICAL) — `nx release publish --projects=<list>` bypassed the `nx-release-publish.dependsOn` gate entirely, so a broken bundle could ship.**

A publish-preview dry-run surfaced this live: `npx nx release publish --projects=apigen-plugin-mcp,apigen-plugin-openapi --dry-run` ran **zero** dependency tasks (no `build`, no `test`, no `verify-dist-load`) and would have printed "Would publish" for both even with their dist bundles broken (see the paired fix below). Direct target invocation (`npx nx run apigen-plugin-mcp:nx-release-publish --dry-run`) correctly ran all 14 dependency tasks. Root-caused to a confirmed upstream Nx limitation — `nx release publish`'s internal publish orchestration does not expand the task graph through each project's `dependsOn` the way `run-many`/`affected`/a direct `nx run` invocation does ([nrwl/nx#22720](https://github.com/nrwl/nx/issues/22720), [nrwl/nx#27749](https://github.com/nrwl/nx/issues/27749), [nrwl/nx#30552](https://github.com/nrwl/nx/issues/30552)) — narrowed specifically to the `--projects=` filter path; unfiltered `nx release publish` (the full release set, no `--projects`) was verified to correctly expand and enforce the gate.

Changes:
- **`scripts/release-publish.mjs`** — the new canonical publish entry point, replacing direct calls to `npx nx release publish`. Routes `--projects=<list>` through `npx nx run-many -t nx-release-publish --projects=<list>` (proven to honor `dependsOn`); routes an unfiltered call through plain `nx release publish` (proven safe). Propagates the real exit code — non-zero means nothing published.
- **`PUBLISHING.md`** rewritten to document `scripts/release-publish.mjs` as the required publish command everywhere it previously said `npx nx release publish`, with an explicit warning about the `--projects=` bypass and its GitHub issue citations. The "CI publish (automated)" section corrected to reflect what CI *actually* runs today (see `BUG-CI-PUBLISH-STALE-TARGETS-001`, filed not fixed — CI's `Publish` job doesn't call `nx release` at all).

Verified with teeth: **negative control** — `node scripts/release-publish.mjs --dry-run --projects=apigen-plugin-mcp,apigen-plugin-openapi` while both packages' ESM bundle was still broken → exit 1, `verify-dist-load` failure printed, zero "Would publish" occurrences, nothing published. **Positive control** — identical command after the paired `INVESTIGATION-BUILD-TOOL-001` fix landed → exit 0, both projects print "Would publish … [dry-run]" with correct tarball contents. Unfiltered `node scripts/release-publish.mjs --dry-run` (full 52-project release set) also re-verified post-fix: correctly fails non-zero on the separately-filed, out-of-scope defects (`BUG-WORKSPACE-NO-LINKING-001`, `BUG-BUILD-TSC-STALE-DIST-METADATA-001`, `BUG-DATA-CORE-STRUCTURES-DIST-TYPE-MISMATCH-001`, `BUG-APIGEN-CLI-VERIFY-DIST-LOAD-ARGV-001`), proving the gate stays honest and doesn't mask unrelated problems.

Residual/deferred: `BUG-CI-PUBLISH-STALE-TARGETS-001` (CI's actual publish job needs rewiring to call this script — separate, higher-risk change needing human sign-off).

### Fixed — test wiring: 15 projects shipped specs that could never run; nx reported silent success (2026-07-17)

**BUG-NXTEST-001 — `nx run-many -t test` reports SUCCESS for projects with no `test` target, hiding every unwired suite.**

Discovered at 4 projects / 75 cases (`dispatch-core-optimizer` 30, `agent-plugin-budget` 35, `agent-plugin-sanitize` 10, `dispatch-base-types` 1); the closing gate then found **11 more** (`ui-react-base-hooks` 10 files, `environment-builder` 9, `data-base-transforms` 10, `apigen-generator-nx` 4, + 7 others) — **15 projects total** whose tests had never executed while `nx run-many -t test` exited 0 for them (proven: naming two target-less projects → "Successfully ran target test", EXIT=0). Two published documents had cited these as passing (`docs/architecture/agent-dispatch-systems.md:267-268`, `BACKLOG.md` BUG-DISPATCH-PUBLISH-001 closure evidence). Every project already had a vitest-configured `vite.config.ts` — a scaffold-template defect omitted the nx target uniformly.

Changes:
- `test` targets added to all 15 `project.json`s (cached, `@nx/vite:test`, mirroring `agent-store-runtime`'s shape).
- **`scripts/check-test-wiring.mjs`** (+ `npm run check:test-wiring`): fails if any project carries spec files without a `test` target — negative-controlled (stripping a target turns it red).
- First-ever execution of the full set: **15/15 projects green, real exit 0** (~500 cases incl. `data-base-transforms` 104, `environment-builder` 139). Two genuine failures surfaced and fixed: `workspace-base-tools/src/get-package-info.spec.ts` (`vi.spyOn(fs,…)` on a non-configurable `node:fs` namespace export under Node 24 — spy removed, scenario real), `ui-react-base-hooks/src/lib/use-debounce/index.spec.tsx` (state update + timer advance not wrapped in `act(...)`).
- En-route repair: `node_modules` was missing `estree-walker` (broke the whole nx graph via `@nx/vite` plugin once the new targets invalidated cached nodes); restored via `npm install --legacy-peer-deps` — required because `package.json` pins `nx@18.3.4` while declaring `@nxlv/python@^22.2.1` (ERESOLVE; pre-existing manifest inconsistency, left for its own fix). Zero manifest churn.

Known residue (open, disclosed): the newly-green suites have never been proven able to fail (no red→green history); `ui-react-base-hooks` had one non-reproducible worker crash-after-green (3/3 green on rerun) and carries 11 env-conditional skips; vitest warns `cache.dir` is deprecated across the repo's vite configs; the `nx@18` vs `@nxlv/python@22` manifest conflict remains.

Commit: this one. Original discovery evidence: BACKLOG entry filed at `c250c97c`, removed here per the completed-items convention.

### Fixed — workspace tooling & agent-instruction docs (2026-07-16)

**BUG-WORKSPACE-GEN-001 — `scripts/generate-lib.sh` was a drift factory, and a stale `CLAUDE.md` made agents prefer it over the correct generator.**

Root cause, two halves:

1. `scripts/generate-lib.sh` mapped `<layer>` -> `packages/{design-system,shared,features,testing,ai,node-tools,other}`. All 7 of those directories are gone (real `packages/` holds domain folders: agent, apigen, data, decompile, dispatch, environment, ui-react, workspace). It could not emit a single valid path. Its `ai|mcp) DIR="ai"` branch is the **upstream source** of the dead `packages/ai/*` paths that stranded the `agent-*` plan corpus (BUG-REGISTRY-001).
2. The correct generator (`@adhd/workspace-codegen-nx`) already existed and was documented correctly in `AGENTS.md` — but `CLAUDE.md`, the file actually injected into every agent session, **contradicted it** with the stale `./generate-lib.sh` cheat sheet, a §1 architecture table whose directories were 4/4 nonexistent, and §3 package names that were dead. Agents followed the injected wrong answer.

The conceptual error underneath: the old doc treated `layer` as determining the **directory**. It does not — `domain` is the directory, `layer` is an orthogonal Nx tag. That conflation *is* the layer->dir mapping.

Changes:
- `scripts/generate-lib.sh` replaced with a loud deprecation shim (exits 1, prints the correct invocation); original preserved at `scripts/generate-lib.sh.deprecated`.
- **`CLAUDE.md` is now a filesystem symlink -> `AGENTS.md`** (git mode 120000). The divergence class is structurally impossible now.
- `AGENTS.md` rewritten as the corrected union of both files, making the `domain`-is-directory / `layer`-is-tag distinction explicit, pinning the bare-name rule (`--name=agent-engine-migration` yields `agent-engine-agent-engine-migration`), and adding a "should this be a package at all?" gate.
- New `docs/contributing/conventions/package-naming.md`, linked from `AGENTS.md`.

Verified: `npx nx g @adhd/workspace-codegen-nx:engine --name=migration --group=agent --nxLayer=logic --platform=node --dry-run` -> `packages/agent/agent-engine-migration`, tags `domain:agent, pkg-kind:engine, pkg-class:foundation, layer:logic, platform:node, access:domain`.

**BUG-DISPATCH-009 — superseded dispatch plans relocated into the plan that supersedes them.**

`dispatch-completion` was authored to consolidate `dispatch-optimizer` (PoC) + `dispatch-production` (deferred track) + `dispatch-backlog-fill` (debt specs) (`dispatch-completion/SCOPE.md:4`). All 12 pending `dispatch-production` operations were verified mapped op-by-op onto live `dispatch-completion` states — zero uncovered. The three dirs were `git mv`'d (history preserved) to `docs/plan/dispatch-completion/superseded/`, with a README recording provenance, the coverage table, and a **supersede-don't-re-point** warning on their dead paths (re-pointing would resurrect a superseded plan into file-reservation conflict with the live one).

Correction recorded: the original defect claimed these dirs were "treated as live plans by corpus scans." They were not — discovery keys on `state.json` (`corpus-verify.js:findAllStateDirs`), none of the three has one, and none was in `plan-index.json`. The move was for human provenance, not scan hygiene.

Verified after the move: `gap-check.js docs/plan/dispatch-completion` PASSED (exit 0, 0 warnings); `cross-plan-check.js docs/plan` emits no lines for any of the three; live plan intact (`current_state: triage`, 24 states).

## 2.2.0 (2024-12-14)

This was a version bump only, there were no code changes.

## 2.1.1 (2024-12-12)

This was a version bump only, there were no code changes.

## 2.1.0 (2024-08-13)

This was a version bump only, there were no code changes.

# 2.0.0 (2024-08-13)

This was a version bump only, there were no code changes.

## 1.1.0 (2024-05-28)

This was a version bump only, there were no code changes.

# 1.0.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.7.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.6.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.5.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.4.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.3.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.2.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.1.0 (2024-05-28)

This was a version bump only, there were no code changes.