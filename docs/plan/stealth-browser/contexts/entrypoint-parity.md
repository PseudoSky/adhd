# entrypoint-parity — WORK STATE

**Phase:** scaffold · **Kind:** work · **Depends on:** scaffold · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py entrypoint-parity`
**Executor:** `platform-engineer` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

The generated package is raised to full parity with the sibling entrypoints (`dispatch-cli`, `backlog`, `apigen-cli`): the same top-level files, tags, package metadata, nx targets (including `build-bin`, `verify-dist-load`, `e2e`, `typecheck-spec`), and the e2e lane. After this state the later states only add source, never project plumbing.

---

## Semantic Distillation

- **Primitive:** MODIFY the top-level files of `entrypoint/stealth-browser/` to match the sibling structure.

- **Reference Pattern:** `entrypoint/dispatch-cli/{project.json,package.json,tsconfig*.json,vite.config.ts,vitest.e2e.config.ts,eslint.config.mjs,AGENTS.md,CHANGELOG.md,README.md,bin/cli.ts}`, `entrypoint/backlog/project.json` ([ref:entrypoint-structure]).

- **Delta Spec:** Mirror dispatch-cli: `tsconfig.build-bin.json` + the `build-bin` target override in project.json (the `bin/**` graph compiles into `dist/bin` and `dist/src`), `vitest.e2e.config.ts` via `defineE2eConfig` so `*.e2e.test.ts` files under `src/` run only in the `e2e` lane, `verify-dist-load`, `dist-manifest`, `nx-release-publish`; package.json gets `repository.directory`, `homepage`, `bugs`, `license`, `files: [dist, CHANGELOG.md]`, `main/module/types`, `publishConfig`, `description`, `keywords` and placeholder `bin` entries pointing at `./dist/bin/cli.js` and `./dist/bin/mcp.js`; copy `LICENSE`, `AGENTS.md`, `CHANGELOG.md` skeletons. Keep vite `dts.exclude` covering `bin/**` and `src/test/**`. Do NOT add runtime dependencies here (deps-install owns that). Do NOT touch `src/` (owned by later states).

- **Invariants:** [inv:one-new-package]; [inv:esm-js-specifiers]; test files live under `src/test/` (unit lane `*.spec.ts`, e2e lane `*.e2e.test.ts`). Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:entrypoint-parity]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py entrypoint-parity` — runs every acceptance criterion below (red until the work is done); `--only entrypoint-parity.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py entrypoint-parity --only entrypoint-parity.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [entrypoint-parity.1] Top-level tracked file set contains every file common to dispatch-cli, backlog and apigen-cli (eslint/vite/tsconfig.*/vitest.e2e/AGENTS/CHANGELOG/LICENSE...).

- [entrypoint-parity.2] project.json tags are a superset of the tags common to the three sibling entrypoints.
- [entrypoint-parity.3] `nx show project` lists every target present in both dispatch-cli and backlog (build, test, lint, typecheck, e2e, verify-dist-load...) and the dispatch-cli-only `build-bin`.
- [entrypoint-parity.4] package.json carries the sibling publish metadata: repository.directory == entrypoint/stealth-browser, homepage, bugs, license, files, main/module/types, publishConfig.
- [entrypoint-parity.5] `nx run stealth-browser:lint` exits 0 on the scaffold (tooling wired).
---

## Reservations

```text
read_only:  ["entrypoint/dispatch-cli/", "entrypoint/backlog/", "entrypoint/apigen-cli/"]
mutates:    ["entrypoint/stealth-browser/*", "docs/plan/stealth-browser/evidence/"]
```

---

## Contract Promise

Modified: top-level files of `entrypoint/stealth-browser/`. Added: tsconfig.build-bin.json, vitest.e2e.config.ts, LICENSE, AGENTS.md, CHANGELOG.md. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:entrypoint-parity]`:

- [ ] After project.json/tsconfig parity -- commit: `chore(stealth-browser): nx targets and tsconfig parity [psm:entrypoint-parity]`
- [ ] After package metadata and docs skeletons -- commit: `chore(stealth-browser): package metadata parity [psm:entrypoint-parity]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Compare with `git ls-files entrypoint/dispatch-cli | rg -v /` to see the top-level set. `guard.py entrypoint-parity` computes the common set across all three siblings; it is the authority.
- `nx run stealth-browser:lint` must exit 0 on the empty package before any code lands (including @nx/dependency-checks).
- Owned paths are the top-level files only (`entrypoint/stealth-browser/*`); anything inside `src/`, `bin/`, `docs/` belongs to later states.
