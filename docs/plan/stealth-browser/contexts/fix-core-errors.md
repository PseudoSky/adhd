# fix-core-errors — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** conform-core · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-core-errors`
**Executor:** executor=typescript-pro tier=sonnet/medium · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The core error surface has no instanceof trick: the `Symbol.hasInstance` invalidEndpoint bridge is gone, surface/api.spec.ts asserts the typed `code`, and docs/ERRORS.md describes the real behaviour.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/fix-core-errors.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- Remove the `Symbol.hasInstance` bridge in `src/errors.ts` (found by `rg Symbol.hasInstance`). Change `test/unit/surface/api.spec.ts` (tests-unit-surface owned it; this state now does) to assert the typed `code` of an invalid endpoint (`error.code === ...`, `isStealthCoreBrowserError(e, code)`), not `instanceof`. Update docs/ERRORS.md. Run `gx impact` on the bridge first: a consumer in entrypoint/stealth-search that relied on it is reported to the dispatcher (outside this bucket), not edited.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:fix-core-errors]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-core-errors` runs every acceptance criterion below (red until the work is done); `--only fix-core-errors.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py fix-core-errors --only fix-core-errors.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [fix-core-errors.1] `src/errors.ts` has no `Symbol.hasInstance`, and docs/ERRORS.md no longer mentions a `hasInstance` or instanceof bridge.

- [fix-core-errors.2] test/unit/surface/api.spec.ts cites [fix-core-errors.2] and asserts the typed code of an invalid endpoint (titles carry `invalidEndpoint`, `code` and `typed`), with no `instanceof` assertion on it, and is green.
- [fix-core-errors.3] evidence/fix-core-errors.md records the red-first proof: a `RED:` line with the failing assertion of each new spec on the untouched source and a `GREEN:` line with the passing run after the fix.
- [fix-core-errors.4] `nx run stealth-core-browser:lint`, `:typecheck`, `:typecheck-spec`, `:test`, `:build` exit 0 and evidence/fix-core-errors.md records each as `EXIT <command>: 0`.
- [fix-core-errors.5] Only owned paths changed by [psm:fix-core-errors] commits (errors.ts, docs/ERRORS.md, surface and errors specs).
---

## Reservations

```text
read_only:  []
mutates:    ["packages/stealth/stealth-core-browser/src/errors.ts", "packages/stealth/stealth-core-browser/docs/ERRORS.md", "packages/stealth/stealth-core-browser/test/unit/surface/", "packages/stealth/stealth-core-browser/test/unit/errors/", "docs/plan/stealth-browser/evidence/fix-core-errors.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/fix-core-errors.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:fix-core-errors]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium
