# conform-core — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** main-merge · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py conform-core`
**Executor:** executor=haiku tier=haiku · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

packages/stealth/stealth-core-browser/ follows main's test layout (docs/standards/testing.md): every test lives under test/{unit,helpers,fixtures}, nothing test-shaped is left under src/, every spec carries the guards/tier/cites header, and lint, typecheck, typecheck-spec and the unit lane exit 0.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/conform-core.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- MOVE with `git mv` exactly per [inv:test-layout] (the table pinned in `contexts/_shared.md`), then run a resolver-based codemod: resolve each old import target, recompute the specifier from the new location (`../lib/x` becomes `../../src/lib/x`; depth under the package drops by one); eyeball every line using `import.meta.url`, `__dirname` or `readFileSync` (they anchor on the test file).

- EXTRACT every non-spec `.ts` out of `test/unit/**` into `test/helpers/<area>/` and re-point the imports (L3); move html/pdf/json fixtures that sit beside specs into `test/fixtures/<area>/` and fix their readers.

- CONFIG: `vite.config.ts` `test.include: UNIT_FILE_INCLUDES` imported from the repo's `tools/vite-plugins/e2e-globs.mjs` (keep `exclude: [...configDefaults.exclude, ...E2E_FILE_EXCLUDES]`); drop `exclude: ['src/test/**']` from the dts options; `tsconfig.lib.json` excludes `test/**`; `tsconfig.spec.json` include is `["vite.config.ts","vitest.config.ts","vitest.config.mts","test/**/*.ts","test/**/*.tsx","src/**/*.d.ts"]`.

- HEADERS: add the header to every `*.spec.ts` by a codemod: the first comment block (first 60 lines) carries `guards: <the failure mode the spec proves>`, `tier: S`, `cites: <ticket 8468f7b1 and the [state.N] criterion ids already in the spec>`; derive guards/cites from the existing prose header. Never touch `test-headers.baseline.json`.

- DOCS: update README.md, AGENTS.md, docs/** and source comments of the package that name `src/test` (L8); CHANGELOG history lines stay.

- Evidence: write `evidence/conform-core.md` with the exit code of each scanner and nx target (`EXIT <command>: <code>`), then run the gates. A completed state's guard that is red only because it names an old location is reported to the dispatcher (plan scripts are not owned here); never edit `docs/plan/stealth-browser/scripts/`.

- `src/test/use-cases/*.spec.ts` move to `test/unit/use-cases/` (all tier S); `use-cases/scenario-kit.ts` to `test/helpers/use-cases/`; `src/test/fixtures/cdp/*.cdp.json` to `test/fixtures/cdp/`. `test/unit/capture/build-format.spec.ts` must not name a literal `src/test/` path (L8). `src/lib/lifecycle/reaper-link.ts` and `AGENTS.md` mention `src/test` and are corrected. `examples/**/*.ts` stays in the tsconfig.spec include.

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:conform-core]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py conform-core` runs every acceptance criterion below (red until the work is done); `--only conform-core.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py conform-core --only conform-core.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["packages/stealth/stealth-core-browser/", "tools/nx-plugins/build/executors/typecheck-spec/stealth-core-browser.baseline.json", "docs/plan/stealth-browser/evidence/conform-core.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/conform-core.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:conform-core]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=haiku tier=haiku; mechanical codemod. Escalate to sonnet only when typecheck-spec stays red after two attempts. [inv:test-layout]
