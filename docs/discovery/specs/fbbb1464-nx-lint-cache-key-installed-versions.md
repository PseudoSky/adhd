# Spec fbbb1464 — lint and sync-deps-check cache keys must include the installed versions of the project's declared dependencies

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
items: fbbb1464-61c4-40b0-b405-5c126943538f (bug, HIGH, project adhd)
dor: ready — check: done-state is an observable action (change a dependency's installed version, the project's lint/sync-deps-check cache entry misses), scope is two plugin files plus one shared helper, no blocking unknown except one Nx behavior to confirm in the first test (D3). Size: S.

## Observed facts (O = opened by architect; W = Nx docs fetched 2026-10-15)
- O: both cache keys carry only `externalDependencies:['eslint']`: lint target `/Users/nix/dev/node/adhd/tools/nx-plugins/lint/plugin.js:~81-88` (inputs: `default`, eslint base+root configs, project eslint config, `{externalDependencies:['eslint']}`); `sync-deps-check` and `sync-deps` share `SYNC_DEPS_INPUTS` at `/Users/nix/dev/node/adhd/tools/nx-plugins/deps/plugin.js:~19-25` (`default`, `^production`, two shared files, `{externalDependencies:['eslint']}`).
- W: per Nx docs (nx.dev/docs/reference/inputs): without an `externalDependencies` input Nx hashes ALL workspace external deps; declaring `externalDependencies` REPLACES that default for the target, and Nx "always considers external dependencies depended upon by any source code within the project". So listing only `['eslint']` removes every other installed version from the key except npm packages the project's sources import — a declared-but-not-imported dependency (e.g. a runtime-loaded or bundled-only dep) or a range check against a hoisted version never invalidates the cache. This is the mechanism behind the item's symptom (`nx lint decompile-cli` 2/2 cache hit while a clean cache fails). Not stated by the docs: behavior for a listed name that is not installed (unverified; D3 tests it).
- O: `lint` `dependsOn: ["sync-deps-check"]` (`nx.json` targetDefaults.lint), so two cache entries both go stale.
- O: the check itself runs `@nx/dependency-checks` in-process via `tools/nx-plugins/deps/eslint-check.mjs` (`executors/check/impl.js`), comparing declared ranges against installed versions.
- O: item mitigation already landed (f2e4df15: sync-deps for decompile-cli, workspace-base-tools). Part (b) of the item ("nothing reconciles ranges against the lockfile on install") is already served by `sync-deps-check` gating `lint`; fixing the key makes that gate trustworthy. No new install-time reconcile is specified.
- O: new Node-test specs under `tools/nx-plugins/**` must be added to the explicit file list in root `package.json` script `test:build-tools` (l.28). Root `package.json` is a global graph input (item: maps to ~all projects) — edit it once, last.

## Design decisions
D1 Add each project's own declared npm dependencies to both inputs: new helper `declaredExternalDeps(projectRoot, workspaceRoot)` returns sorted names from `package.json` `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` excluding `@adhd/*` workspace names (those are project-graph inputs already covered by `^production`) and excluding names already `eslint`; append `{ externalDependencies: [...'eslint', ...declared] }` (one entry, merged with `eslint`).
Rejected: (a) adding the lockfile (`pnpm-lock.yaml`) as an input — every dependency bump anywhere re-runs lint for all ~62-69 projects; (b) dropping the `externalDependencies` input entirely — Nx default then hashes ALL external deps, the same over-invalidation; (c) a hook fallback "uncached lint on mismatch" — hides the cache defect and slows the hook; (d) `nx reset` in the hook — destroys unrelated caches.
D2 Single source: one helper in `tools/nx-plugins/lib/` imported by both plugins (AGENTS §8 reuse; the repo already shares `compute-real-deps.js` and `scratch-root.js` this way). Read `package.json` at graph-construction time (createNodes already receives the path).
D3 First test is an Nx-behavior probe, not an assumption: confirm that (i) a declared name absent from the graph's external nodes does not throw, and (ii) changing an installed version flips the task hash. If (i) fails, filter the list to names present in `node_modules` at createNodes time.
D4 Not in scope: changing which projects the pre-commit hook lints (`--files` mapping), and `externalize.mjs`/`compute-real-deps.js` behavior (spec 2f3dbebc owns policy; this spec only READS `package.json`).

## Write-scope (exact, absolute)
- /Users/nix/dev/node/adhd/tools/nx-plugins/lint/plugin.js (inputs array only)
- /Users/nix/dev/node/adhd/tools/nx-plugins/deps/plugin.js (`SYNC_DEPS_INPUTS` becomes a per-project function)
- /Users/nix/dev/node/adhd/tools/nx-plugins/lib/declared-external-deps.js (new, CJS) + `declared-external-deps.spec.mjs`
- /Users/nix/dev/node/adhd/tools/nx-plugins/lint/plugin.spec.mjs and /Users/nix/dev/node/adhd/tools/nx-plugins/deps/plugin.spec.mjs (new createNodes assertions)
- /Users/nix/dev/node/adhd/package.json (append the new spec files to `test:build-tools`, last edit)
- /Users/nix/dev/node/adhd/tools/nx-plugins/deps/README.md (document the key)

## Acceptance criteria
- AC1 For a fixture project whose package.json declares `dependencies:{a:..}`, `devDependencies:{b:..}`, `@adhd/x`, the lint target's inputs include `externalDependencies` containing `eslint`, `a`, `b` and not `@adhd/x`.
- AC2 `sync-deps-check` and `sync-deps` inputs carry the same declared set for that project.
- AC3 Changing the installed version of a declared dependency changes the task hash of that project's `lint` and `sync-deps-check`, and does not change the hash of a project that does not declare it.
- AC4 A warm-cache `nx lint` of a project whose manifest range excludes its installed version fails after the installed version changes (the reported scenario), without `nx reset`.
- AC5 A project with no dependencies still yields valid inputs (`eslint` only) and no Nx error.

## Test plan (tier default S; cite `fbbb1464 AC<n>`)
AC1, AC2, AC5: S (`node --test` specs on `createNodes` output with fixture workspaces; negative control = the old plugin code makes AC1 red). AC3: tier P — drives the real hasher via `npx nx show target`/task-hash on a temp workspace copy with a bumped `node_modules/<dep>/package.json` version (needs a subprocess, so not S; isolated cwd + fake HOME, ADR-0009 D3; budget 10 s so use a 2-project fixture). AC4: P, same fixture: run `nx run proj:lint` twice, bump installed version, run again, assert the third run is a cache miss and red. Authored by `test-author`; red against current main first. Do not use `--skip-nx-cache` (AGENTS §5).

## Risks / serialization
- Wider key means more cache misses on dependency bumps — intended, bounded to the declaring project. Root `package.json` and `tools/nx-plugins/**` are global inputs: the first run after merge rebuilds everything once.
- Serialize BEFORE spec 2f3dbebc (both read `tools/nx-plugins/deps/**`); no other spec in this batch touches these files.
- gx impact: not run (plugin files are JS config modules with no indexed callers); implementer must run `nx show projects --affected` to size the one-time invalidation.

## Product revision
dor (product): ready. No open decision; architect dor stands.
- WHY now: a green cached lint that a clean cache would fail makes every lint/sync-deps gate untrustworthy for ~65 projects, and it is the first link of the serialization chain (this spec precedes 2f3dbebc).
- Scope: unchanged (D1-D4). One-time cache invalidation after merge is accepted as intended cost. No scope cut.
- Priority: P1, rank 1 of the impl-ready set (smallest S, widest trust payoff, unblocks 2f3dbebc).
- Added gate: AC3/AC4 must be shown red against current main before the fix (G6); the D3 Nx probe is the first test and its outcome is recorded in the spec's implementation note.
