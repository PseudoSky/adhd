# fix-core-lifecycle — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** conform-core · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-core-lifecycle`
**Executor:** executor=typescript-pro tier=sonnet/medium · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The reaper entry resolves under ESM and CJS: `defaultReaperEntry` is a real path (backlog 86a2318f), never null.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/fix-core-lifecycle.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- `src/lib/lifecycle/reaper-link.ts` `defaultReaperEntry` is null when the module is loaded as ESM. Make the entry resolution work under ESM and CJS (the published build is CJS, ADR-0003; vitest and ESM consumers load source) without `process.env` ([inv:typed-errors]; a missing entry is a typed LifecycleError, not null). Unit spec: simulate resolution from an ESM-style module URL and from a CJS `__filename`, assert an absolute path ending in the proxy reaper entry, and assert the typed error when the package cannot be resolved.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:fix-core-lifecycle]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-core-lifecycle` runs every acceptance criterion below (red until the work is done); `--only fix-core-lifecycle.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py fix-core-lifecycle --only fix-core-lifecycle.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [fix-core-lifecycle.1] (backlog 86a2318f) A spec under test/unit/lifecycle cites [fix-core-lifecycle.1] and proves `defaultReaperEntry` resolves to an absolute path under ESM and under CJS and fails with a typed error when unresolvable: titles carry `defaultReaperEntry`, `ESM`, `CJS`, `86a2318f`; the spec is green.

- [fix-core-lifecycle.2] evidence/fix-core-lifecycle.md records the red-first proof: a `RED:` line with the failing assertion of each new spec on the untouched source and a `GREEN:` line with the passing run after the fix.
- [fix-core-lifecycle.3] `nx run stealth-core-browser:lint`, `:typecheck`, `:typecheck-spec`, `:test`, `:build` exit 0 and evidence/fix-core-lifecycle.md records each as `EXIT <command>: 0`.
- [fix-core-lifecycle.4] Only owned paths changed by [psm:fix-core-lifecycle] commits (lifecycle src, specs and helpers).
---

## Reservations

```text
read_only:  []
mutates:    ["packages/stealth/stealth-core-browser/src/lib/lifecycle/", "packages/stealth/stealth-core-browser/test/unit/lifecycle/", "packages/stealth/stealth-core-browser/test/helpers/lifecycle/", "docs/plan/stealth-browser/evidence/fix-core-lifecycle.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/fix-core-lifecycle.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:fix-core-lifecycle]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium; backlog 86a2318f
