## Unreleased

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