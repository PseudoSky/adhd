# core-scaffold — WORK STATE

**Phase:** scaffold · **Kind:** work · **Depends on:** split-plan-repair, surface-api, tests-unit-core, tests-unit-data, tests-unit-extract, mig-docs, chrome-lifecycle, capture-upgrade, cdp-test-harness, sp-reaper-load-proof · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py core-scaffold`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Rename the migrated library into its permanent home. The stealth core becomes `@adhd/stealth-core-browser` at `packages/stealth/stealth-core-browser`, built by the workspace generator in a new `stealth` group (never hand-built), the finished library tree is moved into it with `git mv`, every old name is rewritten, the old entrypoint shell is deleted, and every previously completed core state still passes. This is the ONE serialized owner of the rename mechanics; nothing else touches the old or new core directory until it completes.

---

## Semantic Distillation

- **Primitive:** MODIFY `.adhd/workspace.json` (the `stealth` group), `tsconfig.base.json` (generator writes the new alias; the old alias is removed), `pnpm-lock.yaml` (importer keys only); CREATE `packages/stealth/stealth-core-browser/` (generator output, then the moved library), the generator-created `tools/nx-plugins/build/executors/typecheck-spec/stealth-core-browser.baseline.json` and `docs/plan/stealth-browser/evidence/split/core-dry-run.txt`; DELETE the remains of `entrypoint/stealth-browser/`.

- **Reference Pattern:** `SPEC-stealth-search.md` sections 1.1 and 1.2 ([ref:stealth-search-spec]); `contexts/tripwire-scaffold.md` and `evidence/tripwire/scaffold-dry-run.txt` (same generator, same dry-run-first discipline and the same side-effect handling); ADR-0003 (CJS-only manifest).

- **Delta Spec:** Order: (1) add to `.adhd/workspace.json` `groups` `"stealth": { "description": "Stealth browsing - CDP Chrome core library and the search entrypoint built on it" }` in the shape of its siblings. (2) Run the generator DRY-RUN first and save the transcript with its CREATE list to `evidence/split/core-dry-run.txt`: `npx nx g @adhd/workspace-codegen-nx:core --name=browser --group=stealth --nxLayer=logic --platform=node --access public --publish true --dry-run` (bare names, never the package name; if the generator or a module-boundary lint rejects `logic`, use `shared`, the tripwire precedent, and record why in the transcript). (3) Run it for real. Generator side effects: `git restore nx.json eslint.config.mjs` right after generating (both must end unchanged); COMMIT the generated `typecheck-spec/stealth-core-browser.baseline.json`; rename an emitted `vite.config.mts` to `vite.config.ts`; apply the ADR-0003 library manifest (version 0.1.0, `main ./dist/index.js`, `types`, no `module`/`exports`/`bin`/`type`, `files [dist, CHANGELOG.md]`, engines `>=22.5`, publishConfig access public) with the dependencies of the old package unchanged (`@adhd/sox-service-proxy ~0.6.0`, `@adhd/sox-store-adapter`, `node-html-parser`, `xpath`, `@xmldom/xmldom`); the package is a library: no `bin/`, no `build-bin`, no bin check in `verify-dist-load`. (4) `git mv` from `entrypoint/stealth-browser/` to the new directory: `src/lib`, `src/test/unit`, `src/test/fixtures`, `src/test/support`, `src/api.ts`, `src/index.ts` (overwrite the generated stubs), `docs/reference`, `CHANGELOG.md`, `LICENSE`, `AGENTS.md`; fix the `src/api.ts` header (the verbs are projected by consumers, not mounted here). (5) Rewrite every old name: `[stealth-browser]` log prefixes in `src/lib/**` (cdp/targets.ts, chrome-manager.ts, lifecycle/*.ts, recording/*.ts) become `[@adhd/stealth-core-browser]`, `@adhd/stealth-browser` and `nx run stealth-browser:` strings in the moved docs/tests/config become the new names. The error class `StealthBrowserError` is NOT renamed here: `prod-errors` creates it, as `StealthCoreBrowserError`. Runtime artifact names that live agent Chrome processes already use (lifecycle state dir, heartbeat file names embedding `stealth-browser`) keep their VALUES unless a failsafe-inventory row says otherwise; rename identifiers only. (6) `git rm -r` the remains of `entrypoint/stealth-browser` (`project.json`, `tsconfig*.json`, `vitest.e2e.config.ts`, `eslint.config.mjs`, `README.md`, untracked `dist/`); remove the `@adhd/stealth-browser` alias from `tsconfig.base.json`; run the worktree `pnpm install` so the `pnpm-lock.yaml` importer key `entrypoint/stealth-browser:` becomes `packages/stealth/stealth-core-browser:` (lock diff confined to that importer; [inv:node-modules] symlink, never reinstall a tree). (7) Run the sweep (.8): once the legacy shell is gone, `guard.py` resolves its package path to the new directory by itself, so each completed core state's guard must exit 0 unchanged; fix the move (never the guards) when one fails.

- **Invariants:** [inv:one-new-package] ([def:pkg]) [inv:greenfield] (legacy names and paths are not constraints) [inv:no-features-removed] (the move changes names, not behavior) [inv:node-modules] [inv:typed-errors] (unchanged here). Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:core-scaffold]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py core-scaffold` — runs every acceptance criterion below (red until the work is done); `--only core-scaffold.N` runs one. `nx run stealth-core-browser:typecheck`, `:build` and `:test` are the slow gates (.4); the sweep (.8) re-runs 18 completed guards and takes the longest.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/core.py` (`python3 docs/plan/stealth-browser/scripts/guard.py core-scaffold --only core-scaffold.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [core-scaffold.1] The package is generator-built, never hand-built: evidence/split/core-dry-run.txt holds the transcript of `npx nx g @adhd/workspace-codegen-nx:core --name=browser --group=stealth ... --dry-run` with its CREATE list, .adhd/workspace.json has the `stealth` group with a description, packages/stealth/stealth-core-browser/project.json is named `stealth-core-browser` and its tags are domain:stealth, pkg-kind:core, pkg-class:foundation, platform:node, access:public and layer:logic (or layer:shared when the generator rejects logic), plus `publish:npm` and any `scope:*` tag, nothing else.
- [core-scaffold.2] The manifest has the ADR-0003 CJS-only library shape: name @adhd/stealth-core-browser, version 0.1.0, `main` ./dist/index.js, a `types` entry, `type` unset, no `module`, no `exports`, no `bin`, engines.node >= 22.5, publishConfig.access public, `files` containing dist and CHANGELOG.md; the package vite config is `vite.config.ts` (not .mts) and emits CJS only (`formats` exactly ['cjs'], and no `.mjs` in the config's output settings: import and export-from lines and comments are not inspected, because the shared tools/vite-plugins/*.mjs helpers are inputs, not build outputs); the package has no bin/ directory and no `build-bin` target.
- [core-scaffold.3] The rename is complete: `git grep` finds no `@adhd/stealth-browser`, `entrypoint/stealth-browser`, `nx run stealth-browser:` or `[stealth-browser]` log prefix in any tracked file outside docs/plan/ and CHANGELOG.md files, and no non-test source under the core package contains the `[stealth-browser]` prefix (it is `[@adhd/stealth-core-browser]`).
- [core-scaffold.4] The core package builds and passes on its own: `nx run stealth-core-browser:typecheck`, `:build` and `:test` exit 0 (the ported unit lane runs unchanged under the new project).
- [core-scaffold.5] The old shell is gone: entrypoint/stealth-browser does not exist in the tree (no tracked file and no leftover directory, including dist/), `tsconfig.base.json` maps @adhd/stealth-core-browser to packages/stealth/stealth-core-browser/src/index.ts and has no @adhd/stealth-browser alias, and pnpm-lock.yaml has the importer key `packages/stealth/stealth-core-browser:` and no `entrypoint/stealth-browser:` importer.
- [core-scaffold.6] Exactly the approved project.json files were added since main: the core package's and the tripwire package's (plus the stealth-search entrypoint's once search-scaffold has run); the legacy entrypoint/stealth-browser/project.json is not among them, and no other project or workspace group was edited (nx.json and eslint.config.mjs are unchanged since the state start; the generator-created packages/stealth/stealth-core-browser typecheck-spec baseline is committed).
- [core-scaffold.7] The move preserved the whole library: every path under the legacy shell at the state start (src/lib/**, src/test/unit/**, src/test/fixtures/**, src/test/support/**, src/api.ts, src/index.ts, docs/reference/**, CHANGELOG.md, LICENSE, AGENTS.md) exists at the same relative path under packages/stealth/stealth-core-browser; the `src/api.ts` header states that the verbs are projected by consumers and not mounted here.
- [core-scaffold.8] Regression sweep: after the move every previously completed core state's whole-state guard still exits 0 (mig-foundation, mig-cdp, mig-chrome-manager, mig-domains-storage, mig-capture-parsers, mig-queries, mig-docs, surface-api, tests-unit-core, tests-unit-data, tests-unit-extract, port-fixes, failsafe-inventory, cdp-test-harness, capture-upgrade, chrome-lifecycle, sp-reaper-load-proof, sp-link); guard.py resolves its package path to packages/stealth/stealth-core-browser once the legacy shell is gone.
- [core-scaffold.9] Only owned paths changed by [psm:core-scaffold] commits (the core package, the legacy entrypoint shell it deletes, .adhd/workspace.json, tsconfig.base.json, pnpm-lock.yaml importers, the generator-created typecheck-spec baseline and evidence/split/); the pnpm-lock.yaml diff of those commits is confined to the two importer blocks (the legacy key removed, the core key added).

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/SPEC-stealth-search.md"]
mutates:    ["packages/stealth/stealth-core-browser/", "entrypoint/stealth-browser/", ".adhd/workspace.json", "tsconfig.base.json", "pnpm-lock.yaml", "tools/nx-plugins/build/executors/typecheck-spec/stealth-core-browser.baseline.json", "docs/plan/stealth-browser/evidence/split/"]
```

---

## Contract Promise

Added: `packages/stealth/stealth-core-browser/` (generator output plus the moved library), `evidence/split/core-dry-run.txt`, the typecheck-spec baseline. Modified: `.adhd/workspace.json` (one group), `tsconfig.base.json` (alias swapped), `pnpm-lock.yaml` (importer key). Deleted: `entrypoint/stealth-browser/`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:core-scaffold]`:

- [ ] After the group and the dry-run transcript — commit: `chore(workspace): stealth group and core dry run [psm:core-scaffold]`
- [ ] After the generator run and the manifest — commit: `feat(stealth-core-browser): scaffold the core package [psm:core-scaffold]`
- [ ] After the move and the rename sweep — commit: `refactor(stealth-core-browser): move the migrated library into the core package [psm:core-scaffold]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Do the generator's `--dry-run` first; the transcript is evidence (.1). Never hand-write `project.json`, the tags or the typecheck-spec baseline.
- Use `git mv` so history follows the files (.7 compares against the tree at the state start).
- The completed states' guards are not edited by this state; if one fails after the move, the move is wrong. `split-plan-repair` already made their guards path-neutral.
- `search-scaffold` (a later state) adds the third project.json; this state's .6 allows it but does not require it.
