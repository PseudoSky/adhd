# conform-tripwire — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** main-merge · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py conform-tripwire`
**Executor:** executor=haiku tier=haiku · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

packages/resilience/resilience-core-tripwire/ follows main's test layout (docs/standards/testing.md): every test lives under test/{unit,helpers,fixtures}, nothing test-shaped is left under src/, every spec carries the guards/tier/cites header, and lint, typecheck, typecheck-spec and the unit lane exit 0.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/conform-tripwire.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- MOVE with `git mv` exactly per [inv:test-layout] (the table pinned in `contexts/_shared.md`), then run a resolver-based codemod: resolve each old import target, recompute the specifier from the new location (`../lib/x` becomes `../../src/lib/x`; depth under the package drops by one); eyeball every line using `import.meta.url`, `__dirname` or `readFileSync` (they anchor on the test file).

- EXTRACT every non-spec `.ts` out of `test/unit/**` into `test/helpers/<area>/` and re-point the imports (L3); move html/pdf/json fixtures that sit beside specs into `test/fixtures/<area>/` and fix their readers.

- CONFIG: `vite.config.ts` `test.include: UNIT_FILE_INCLUDES` imported from the repo's `tools/vite-plugins/e2e-globs.mjs` (keep `exclude: [...configDefaults.exclude, ...E2E_FILE_EXCLUDES]`); drop `exclude: ['src/test/**']` from the dts options; `tsconfig.lib.json` excludes `test/**`; `tsconfig.spec.json` include is `["vite.config.ts","vitest.config.ts","vitest.config.mts","test/**/*.ts","test/**/*.tsx","src/**/*.d.ts"]`.

- HEADERS: add the header to every `*.spec.ts` by a codemod: the first comment block (first 60 lines) carries `guards: <the failure mode the spec proves>`, `tier: S`, `cites: <ticket 8468f7b1 and the [state.N] criterion ids already in the spec>`; derive guards/cites from the existing prose header. Never touch `test-headers.baseline.json`.

- DOCS: update README.md, AGENTS.md, docs/** and source comments of the package that name `src/test` (L8); CHANGELOG history lines stay.

- Evidence: write `evidence/conform-tripwire.md` with the exit code of each scanner and nx target (`EXIT <command>: <code>`), then run the gates. A completed state's guard that is red only because it names an old location is reported to the dispatcher (plan scripts are not owned here); never edit `docs/plan/stealth-browser/scripts/`.

- `src/test/support/{explore,harness,io}.ts` move to `test/helpers/`; `src/index.ts` and README.md mention `src/test` in text and are corrected.

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:conform-tripwire]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py conform-tripwire` runs every acceptance criterion below (red until the work is done); `--only conform-tripwire.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py conform-tripwire --only conform-tripwire.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [conform-tripwire.1] The unit lane lives where main's layout puts it: `packages/resilience/resilience-core-tripwire/src/test` is gone, `test/unit` holds at least the original spec count, every file under `test/unit` is a `*.spec.ts(x)` (L3), and `test/` has only the children unit, e2e, helpers, fixtures, golden and setup.ts (L2).

- [conform-tripwire.2] Support code and fixtures moved to their homes: explore.ts, harness.ts, io.ts exist under `test/helpers/`, and no html, pdf or json fixture is left under `test/unit`.
- [conform-tripwire.3] Configs conform: `vite.config.ts` includes `UNIT_FILE_INCLUDES` from tools/vite-plugins/e2e-globs.mjs, `tsconfig.lib.json` excludes `test/**`, `tsconfig.spec.json` includes `test/**/*.ts` and `test/**/*.tsx`, and no config names `src/test`.
- [conform-tripwire.4] Every spec carries the header of docs/standards/testing.md: a comment block in its first 60 lines with `guards:`, `tier: S` and `cites:` plus the ticket 8468f7b1.
- [conform-tripwire.5] Main's scanners name nothing of this package: check-test-layout.mjs, check-test-headers.mjs and check-skip-expiry.mjs print no violation line for `packages/resilience/resilience-core-tripwire/`, and `test-headers.baseline.json` is byte-identical to main's.
- [conform-tripwire.6] No document or source comment of the package names the legacy layout: README.md, AGENTS.md, docs/** and sources contain no `src/test`, `src/__tests__` or `.e2e.test.` (CHANGELOG.md excepted).
- [conform-tripwire.7] `nx run resilience-core-tripwire:lint`, `:typecheck`, `:typecheck-spec`, `:test` and `:build` exit 0 and evidence/conform-tripwire.md records each as `EXIT <command>: 0`.
- [conform-tripwire.8] No completed state regressed: tripwire-interactive, tripwire-docs whole-state guards still exit 0 on the moved tree.
- [conform-tripwire.9] Only owned paths changed by [psm:conform-tripwire] commits (packages/resilience/resilience-core-tripwire/** and its typecheck-spec baseline).
---

## Reservations

```text
read_only:  []
mutates:    ["packages/resilience/resilience-core-tripwire/", "tools/nx-plugins/build/executors/typecheck-spec/resilience-core-tripwire.baseline.json", "docs/plan/stealth-browser/evidence/conform-tripwire.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/conform-tripwire.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:conform-tripwire]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=haiku tier=haiku; mechanical codemod. Escalate to sonnet only when typecheck-spec stays red after two attempts. [inv:test-layout]
