# gates-first — WORK STATE

**Phase:** review · **Kind:** work · **Depends on:** tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, tests-use-cases, search-usecases, search-examples, tracing-log-validation, search-cutover, mig-docs, audit-fixes, sp-switch, sp-reaper-smoke, tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-first`
**Executor:** `qa` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

## Goal

Every gate is green on the migrated tree via nx: lint, typecheck, typecheck-spec, build, build-bin, test, verify-dist-load. The evidence file records each command, exit code and duration against the exact tree sha.

---

## Semantic Distillation

- **Primitive:** RUN the nx gates; WRITE `docs/plan/stealth-browser/evidence/gates-first.json`.

- **Reference Pattern:** Gate target names from `entrypoint/dispatch-cli/project.json`; the pre-push expectations in `/Users/nix/dev/node/adhd/CLAUDE.md`.

- **Delta Spec:** Run `python3 docs/plan/stealth-browser/scripts/guard.py gates-first` -- it executes the six nx targets of `stealth-core-browser` (no `build-bin`), the seven nx targets of `stealth-search` AND the six nx targets of `resilience-core-tripwire` (lint, typecheck, typecheck-spec, test, build, verify-dist-load; evidence key `tw:<target>`, tree key `tw_tree`) and caches the results by the combined code-tree sha (evidence keys `core:<target>`, `search:<target>`; [inv:gate-trees]: gate evidence is keyed by the code trees (src, bin, package.json and project.json of each package), so the docs states that follow `gates-rerun` (README, CHANGELOG, docs/, AGENTS.md, llms.txt) do not invalidate it; any later change to a package's src, bin or manifest does.); it also proves the release hygiene of the manifests (no local specifier, the proxy dependency range `~0.6.0`). Fix failures by returning to the owning state's bucket (a gate failure is a regression in this branch, not 'pre-existing'): lint/type errors in ported files are fixed in place within this state ONLY if the fix is mechanical and the file is listed below; otherwise record which state owns it and escalate.

- **Invariants:** Never run `tsc` directly (use nx). A red gate halts the plan; there is no deferral. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:gates-first]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-first` — runs every acceptance criterion below (red until the work is done); `--only gates-first.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py gates-first --only gates-first.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [gates-first.1] `nx run stealth-core-browser:lint` and `nx run stealth-search:lint` exit 0 (includes @nx/dependency-checks)
- [gates-first.2] `:typecheck` and `:typecheck-spec` of stealth-core-browser and stealth-search exit 0
- [gates-first.3] `:build` of stealth-core-browser and `:build` and `:build-bin` of stealth-search exit 0 (dist/index.js plus the search dist/bin/*)
- [gates-first.4] `:test` of stealth-core-browser and stealth-search exits 0 (unit lanes incl. the use-case suites; every spawner and third-party network call is mocked, no live Chrome, no spawned process)
- [gates-first.5] `:verify-dist-load` of stealth-core-browser and stealth-search exits 0 (the built dists load the way a consumer loads them)
- [gates-first.6] Every spec file of stealth-core-browser and stealth-search cites ticket 8468f7b1 and a valid acceptance-criterion id; evidence JSON records every gate command and exit code
- [gates-first.7] (PA10.1, PA10.2, PA10.4, PA10.5; folded from the retired publish-readiness state) both packages' package.json have description, keywords, license, files, publishConfig.access = public and engines.node >= 22.5, versions are 0.x, the built stealth-search dist/bin/cli.js and mcp.js start with a shebang and are executable (the library core declares no bin), and every @adhd/* dependency of either package is a public workspace package or recorded in published-state.json.
- [gates-first.8] (PA10.3) `npm pack --dry-run` against each built dist output lists README.md, CHANGELOG.md and the main/types targets (stealth-search also bin/cli.js and bin/mcp.js); the output is recorded in evidence/publish-dry-run.txt.
- [gates-first.9] Only owned paths changed by [psm:gates-first] commits.
- [gates-first.10] After a full build, neither owned dependency is inlined into any dist (module-format proof for ADR-0003): no dist/**/*.js file of either package defines `createStoreAdapter`, `ensureBackend`, `serveBackend` or `dialBackend`, the core dist references `@adhd/sox-service-proxy` as an external require, no file `require`s `@adhd/sox-store-adapter` (it is reached only through a dynamic `import()`), and the stealth-search dist references `@adhd/stealth-core-browser` and `@adhd/resilience-core-tripwire` as externals and defines neither package's code.
- [gates-first.11] `nx run resilience-core-tripwire:lint`, `:typecheck`, `:typecheck-spec`, `:test`, `:build` and `:verify-dist-load` exit 0 (the second approved package is gated with the first; evidence JSON records every command, its exit code and the tripwire tree sha `tw_tree`).
- [gates-first.12] Release hygiene for the service proxy and the tripwire: no @adhd/* dependency, devDependency or override in the root, stealth-core-browser, stealth-search or tripwire manifests starts with `file:`, `link:` or `portal:`, no `pnpm.overrides["@adhd/sox-service-proxy"]` remains (sp-switch removed it), pnpm-lock.yaml has no `adhd-dev-tarballs` or `file:/Users` resolution, and the stealth-browser dependency on @adhd/sox-service-proxy is `~0.6.0`.

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/evidence/"]
```

---

## Contract Promise

Added: `docs/plan/stealth-browser/evidence/gates-first.json`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:gates-first]`:

- [ ] After all gates are green -- commit the evidence file by explicit path: `chore(stealth-browser): first gates green [psm:gates-first]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- This state writes only evidence; code fixes are made by re-opening the owning state via an amendment, so ownership stays clean.
- No live-Chrome gate exists (user decision): the unit and use-case lanes are the test gates.
